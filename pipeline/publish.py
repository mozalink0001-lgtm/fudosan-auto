"""投稿ジョブ。

1) prepare: GAS から投稿内容を受け取り、画像・動画を _site/ に置く（GitHub Pages で一時公開）
2) run:     公開URLを Instagram / Threads に渡して投稿し、結果を GAS に報告
投稿が終わったら、ワークフローの cleanup ジョブが空のサイトで上書きして公開を止める。
"""
from __future__ import annotations

import argparse
import json
import secrets
import time
from pathlib import Path

import requests

from .remote import Drive, Gas
from .util import log, mask

TIMEOUT = 600


def prepare(job_id: str, site: Path, state: Path):
    gas = Gas()
    job = gas.call("get_publish_job", job_id=job_id)
    for k in ("drive_token",):
        mask(job.get(k))
    for acc in ("ig", "threads"):
        if job.get(acc):
            mask(job[acc].get("token"))
    drive = Drive(job["drive_token"])
    site.mkdir(parents=True, exist_ok=True)
    (site / ".nojekyll").write_text("")
    (site / "index.html").write_text("<!doctype html><title>media</title>")
    base = site / "m" / secrets.token_urlsafe(16)
    base.mkdir(parents=True)
    for post in job["posts"]:
        post["paths"] = []
        for i, f in enumerate(post.get("files", [])):
            ext = Path(f["name"]).suffix.lower() or ".bin"
            dst = base / f"{post['post_id']}_{i:02d}{ext}"
            drive.download(f["id"], dst)
            post["paths"].append(str(dst.relative_to(site)))
    state.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
    log(f"{len(job['posts'])} 件の投稿素材を準備")


# ---------------- Instagram ----------------

class IG:
    def __init__(self, cfg: dict):
        self.uid = cfg["user_id"]
        self.token = cfg["token"]
        host = cfg.get("host") or "graph.instagram.com"
        self.base = f"https://{host}/{cfg.get('version') or 'v25.0'}"

    def _post(self, path, **data):
        r = requests.post(f"{self.base}/{path}", data={**data, "access_token": self.token}, timeout=120)
        if r.status_code >= 400:
            raise RuntimeError(f"Instagram {path}: {r.text[:300]}")
        return r.json()

    def _get(self, path, **params):
        r = requests.get(f"{self.base}/{path}", params={**params, "access_token": self.token}, timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"Instagram {path}: {r.text[:300]}")
        return r.json()

    def wait(self, cid: str):
        t0 = time.time()
        while time.time() - t0 < TIMEOUT:
            st = self._get(cid, fields="status_code,status")
            code = st.get("status_code")
            if code in ("FINISHED", "PUBLISHED"):
                return
            if code in ("ERROR", "EXPIRED"):
                raise RuntimeError(f"Instagram の処理に失敗: {st.get('status')}")
            time.sleep(8)
        raise RuntimeError("Instagram の処理が時間内に終わりませんでした")

    def publish(self, cid: str) -> dict:
        self.wait(cid)
        mid = self._post(f"{self.uid}/media_publish", creation_id=cid)["id"]
        link = ""
        try:
            link = self._get(mid, fields="permalink").get("permalink", "")
        except RuntimeError:
            pass
        return {"media_id": mid, "permalink": link}

    def reel(self, url, caption):
        # 表紙は冒頭の大見出しのコマ（1秒目）にする
        cid = self._post(f"{self.uid}/media", media_type="REELS", video_url=url, caption=caption,
                         share_to_feed="true", thumb_offset="1000")["id"]
        return self.publish(cid)

    def carousel(self, urls, caption):
        kids = []
        for u in urls[:10]:
            cid = self._post(f"{self.uid}/media", image_url=u, is_carousel_item="true")["id"]
            self.wait(cid)
            kids.append(cid)
        cid = self._post(f"{self.uid}/media", media_type="CAROUSEL", children=",".join(kids), caption=caption)["id"]
        return self.publish(cid)

    def story(self, url):
        kind = "video_url" if url.endswith(".mp4") else "image_url"
        cid = self._post(f"{self.uid}/media", media_type="STORIES", **{kind: url})["id"]
        return self.publish(cid)


# ---------------- Threads ----------------

class Threads:
    def __init__(self, cfg: dict):
        self.uid = cfg["user_id"]
        self.token = cfg["token"]
        self.base = "https://graph.threads.net/v1.0"

    def _post(self, path, **data):
        r = requests.post(f"{self.base}/{path}", data={**data, "access_token": self.token}, timeout=120)
        if r.status_code >= 400:
            raise RuntimeError(f"Threads {path}: {r.text[:300]}")
        return r.json()

    def _create(self, **data):
        try:
            return self._post(f"{self.uid}/threads", **data)["id"]
        except RuntimeError as e:
            if "topic_tag" in data and "topic" in str(e).lower():
                data.pop("topic_tag")
                return self._post(f"{self.uid}/threads", **data)["id"]
            raise

    def _wait_publish(self, cid):
        t0 = time.time()
        while time.time() - t0 < TIMEOUT:
            r = requests.get(f"{self.base}/{cid}", params={"fields": "status,error_message",
                                                          "access_token": self.token}, timeout=60)
            st = r.json() if r.ok else {}
            if st.get("status") in ("FINISHED", "PUBLISHED"):
                break
            if st.get("status") in ("ERROR", "EXPIRED"):
                raise RuntimeError(f"Threads の処理に失敗: {st.get('error_message')}")
            time.sleep(6)
        mid = self._post(f"{self.uid}/threads_publish", creation_id=cid)["id"]
        link = ""
        r = requests.get(f"{self.base}/{mid}", params={"fields": "permalink", "access_token": self.token}, timeout=60)
        if r.ok:
            link = r.json().get("permalink", "")
        return {"media_id": mid, "permalink": link}

    def video(self, url, text, topic=""):
        extra = {"topic_tag": topic} if topic else {}
        return self._wait_publish(self._create(media_type="VIDEO", video_url=url, text=text, **extra))

    def image(self, url, text, topic=""):
        extra = {"topic_tag": topic} if topic else {}
        return self._wait_publish(self._create(media_type="IMAGE", image_url=url, text=text, **extra))

    def text(self, text, topic=""):
        extra = {"topic_tag": topic} if topic else {}
        return self._wait_publish(self._create(media_type="TEXT", text=text, **extra))


def wait_online(urls: list[str]):
    for u in urls:
        t0 = time.time()
        while time.time() - t0 < 300:
            try:
                if requests.head(u, timeout=20).status_code == 200:
                    break
            except requests.RequestException:
                pass
            time.sleep(5)
        else:
            raise RuntimeError("GitHub Pages に素材が公開されませんでした")


def run(state: Path, base_url: str):
    job = json.loads(state.read_text(encoding="utf-8"))
    base_url = base_url.rstrip("/") + "/"
    ig = IG(job["ig"]) if job.get("ig") else None
    th = Threads(job["threads"]) if job.get("threads") else None
    results = []
    for post in job["posts"]:
        urls = [base_url + p for p in post.get("paths", [])]
        kind = post["type"]
        try:
            if kind != "threads_text" and not urls:
                raise RuntimeError("投稿する素材がありません")
            wait_online(urls)
            if kind == "ig_reel":
                out = ig.reel(urls[0], post["caption"])
            elif kind == "ig_carousel":
                out = ig.carousel(urls, post["caption"])
            elif kind == "ig_story":
                out = ig.story(urls[0])
            elif kind == "threads_video":
                out = th.video(urls[0], post["caption"], post.get("topic", ""))
            elif kind == "threads_image":
                out = th.image(urls[0], post["caption"], post.get("topic", ""))
            elif kind == "threads_text":
                out = th.text(post["caption"], post.get("topic", ""))
            else:
                raise RuntimeError(f"未対応の投稿種類: {kind}")
            results.append({"post_id": post["post_id"], "ok": True, **out})
            log("投稿しました", post["post_id"], kind)
        except Exception as e:
            msg = str(e)
            for tok in (job.get("ig") or {}).get("token"), (job.get("threads") or {}).get("token"):
                if tok:
                    msg = msg.replace(tok, "***")
            results.append({"post_id": post["post_id"], "ok": False, "error": msg[:400]})
            log("投稿に失敗", post["post_id"], kind, msg[:200])
    Gas().call("publish_done", job_id=job["job_id"], results=results)
    state.unlink(missing_ok=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--job-id", required=True)
    p.add_argument("--site", default="_site")
    p.add_argument("--state", required=True)
    r = sub.add_parser("run")
    r.add_argument("--state", required=True)
    r.add_argument("--base-url", required=True)
    a = ap.parse_args()
    if a.cmd == "prepare":
        prepare(a.job_id, Path(a.site), Path(a.state))
    else:
        run(Path(a.state), a.base_url)


if __name__ == "__main__":
    main()
