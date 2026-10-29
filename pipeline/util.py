"""共通の小さな道具: コマンド実行、ffprobe、フォント探索、ログ。"""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

FONT_CANDIDATES = [
    # GitHub Actions (fonts-noto-cjk)
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc",
    # macOS
    "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    # その他 Linux
    "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
]


def log(*args):
    print("[fudosan]", *args, file=sys.stderr, flush=True)


def mask(value: str | None):
    """GitHub Actions のログで値を伏せ字にする（公開リポジトリ対策）。"""
    if value and os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::add-mask::{value}", flush=True)


def run(cmd: list[str], quiet: bool = True, cwd=None) -> subprocess.CompletedProcess:
    if not quiet:
        log(" ".join(cmd))
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)
    if p.returncode != 0:
        log("command failed:", " ".join(cmd[:6]), "...")
        log(p.stderr[-3000:])
        raise RuntimeError(f"command failed: {cmd[0]}")
    return p


def ffprobe(path: Path) -> dict:
    p = run([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_streams", "-show_format", str(path),
    ])
    info = json.loads(p.stdout)
    v = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in info["streams"] if s["codec_type"] == "audio"), None)
    if v is None:
        raise RuntimeError(f"動画トラックがありません: {path.name}")
    w, h = int(v["width"]), int(v["height"])
    rot = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(sd["rotation"])
    if "rotate" in (v.get("tags") or {}):
        rot = int(v["tags"]["rotate"])
    if abs(rot) % 180 == 90:
        w, h = h, w
    dur = float(info["format"].get("duration") or v.get("duration") or 0)
    return {"width": w, "height": h, "duration": dur, "has_audio": a is not None}


def audio_duration(path: Path) -> float:
    p = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)])
    return float(p.stdout.strip() or 0)


HEAVY_CANDIDATES = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Black.ttc",   # fonts-noto-cjk-extra
    "/System/Library/Fonts/ヒラギノ角ゴシック W8.ttc",
]


def find_font(heavy: bool = False) -> str:
    if heavy:
        for c in HEAVY_CANDIDATES:
            if Path(c).exists():
                return c
    env = os.environ.get("FONT_PATH")
    if env and Path(env).exists():
        return env
    for c in FONT_CANDIDATES:
        if Path(c).exists():
            return c
    if shutil.which("fc-match"):
        p = subprocess.run(["fc-match", "-f", "%{file}", ":lang=ja:weight=bold"],
                           capture_output=True, text=True)
        if p.returncode == 0 and p.stdout and Path(p.stdout).exists():
            return p.stdout
    raise RuntimeError("日本語フォントが見つかりません。FONT_PATH を指定してください。")


def load_brand() -> dict:
    with open(ROOT / "config" / "brand.json", encoding="utf-8") as f:
        return json.load(f)


def walk_minutes(meters) -> int | None:
    """表示規約: 徒歩1分=80m、1分未満の端数は切り上げ。"""
    try:
        m = float(meters)
    except (TypeError, ValueError):
        return None
    if m <= 0:
        return None
    return max(1, math.ceil(m / 80))


def yen_short(value) -> str:
    """78000 -> '7.8万円'、35000000 -> '3,500万円'。数字以外はそのまま返す。"""
    try:
        v = float(str(value).replace(",", "").replace("円", ""))
    except ValueError:
        return str(value)
    if v >= 10000:
        man = v / 10000
        if man >= 100:
            return f"{man:,.0f}万円"
        s = f"{man:.2f}".rstrip("0").rstrip(".")
        return f"{s}万円"
    return f"{v:,.0f}円"
