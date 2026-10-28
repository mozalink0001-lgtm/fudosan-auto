"""編集ジョブ: 素材をダウンロード → 動画・画像・投稿文を作る → ドライブに保存 → GAS に報告。

GitHub Actions から:  python -m pipeline.render --job-id J0001
手元で試す:          python -m pipeline.render --local --clips a.mp4 b.mp4 --property samples/property.sample.json --out out
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import traceback
from pathlib import Path

from . import captions, editor
from .remote import Drive, Gas
from .transcribe import get_transcriber
from .util import load_brand, log


def produce(clips: list[Path], prop: dict, memo: str, out: Path) -> dict:
    brand = load_brand()
    work = out / "_work"
    state = {}

    def text_fn(transcript: str) -> dict:
        texts, warnings = captions.generate(prop, brand, transcript=transcript, memo=memo)
        state["warnings"] = warnings
        return texts

    res = editor.build_reel(clips, prop, brand, work, text_fn, transcriber=get_transcriber())
    texts = res["texts"]
    imgs = editor.build_images(res["photos"], prop, texts.get("cover_title") or "", brand, out)
    reel = out / "reel.mp4"
    shutil.move(str(res["reel"]), reel)
    files = {"reel": reel, "carousel": imgs["carousel"], "story": imgs["story"]}
    (out / "captions.json").write_text(json.dumps(texts, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"files": files, "texts": texts, "warnings": state.get("warnings", []), "meta": res["meta"]}


def remote(job_id: str):
    gas = Gas()
    job = gas.call("get_render_job", job_id=job_id)
    try:
        drive = Drive(job["drive_token"])
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            src = td / "src"
            src.mkdir()
            clips = []
            for i, f in enumerate(sorted(job["files"], key=lambda x: x["name"])):
                suffix = Path(f["name"]).suffix.lower() or ".mp4"
                dst = src / f"{i:02d}{suffix}"
                drive.download(f["id"], dst)
                clips.append(dst)
            log(f"素材 {len(clips)} 本をダウンロード")
            out = td / "out"
            out.mkdir()
            r = produce(clips, job["property"], job.get("memo", ""), out)
            folder = drive.folder(f"{job_id}_{job['property'].get('id', '')}", job["output_parent_id"])
            ids = {"reel": drive.upload(r["files"]["reel"], folder),
                   "carousel": [drive.upload(p, folder) for p in r["files"]["carousel"]],
                   "story": drive.upload(r["files"]["story"], folder) if r["files"]["story"] else ""}
            drive.upload(out / "captions.json", folder)
        gas.call("render_done", job_id=job_id, folder_id=folder, files=ids, texts=r["texts"],
                 warnings=r["warnings"], meta=r["meta"])
        log("完了", job_id)
    except Exception as e:
        traceback.print_exc()
        gas.call("render_failed", job_id=job_id, error=f"{type(e).__name__}: {str(e)[:300]}")
        sys.exit(1)


def local(args):
    prop = json.loads(Path(args.property).read_text(encoding="utf-8"))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    r = produce([Path(c) for c in args.clips], prop, args.memo or "", out)
    print(json.dumps({"meta": r["meta"], "warnings": r["warnings"], "texts": r["texts"]},
                     ensure_ascii=False, indent=2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-id")
    ap.add_argument("--local", action="store_true")
    ap.add_argument("--clips", nargs="*")
    ap.add_argument("--property")
    ap.add_argument("--memo")
    ap.add_argument("--out", default="out")
    args = ap.parse_args()
    if args.local:
        local(args)
    elif args.job_id:
        remote(args.job_id)
    else:
        ap.error("--job-id か --local を指定してください")


if __name__ == "__main__":
    main()
