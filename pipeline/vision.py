"""各場面のコマを Gemini（無料枠）に見せて、部屋の名前・見どころ・使えるカットかを判断する。

使えないとき（キーなし・エラー）は None を返し、編集側は撮影順のまま進める。
"""
from __future__ import annotations

import base64
import io
import json
import os
from pathlib import Path

from PIL import Image

from . import gemini
from .util import log

ROOMS = ["外観", "エントランス", "玄関", "廊下", "LDK", "リビング", "ダイニング", "キッチン", "洋室", "和室",
         "寝室", "収納", "洗面所", "浴室", "トイレ", "バルコニー", "眺望", "共用部", "設備", "その他"]


def _thumb_b64(path: Path, size=512) -> str:
    img = Image.open(path).convert("RGB")
    img.thumbnail((size, size))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80)
    return base64.b64encode(buf.getvalue()).decode()


def label_scenes(frames: list[Path], prop: dict, model: str) -> list[dict] | None:
    key = os.environ.get("GEMINI_API_KEY", "")
    if not key or not frames:
        return None
    points = prop.get("points", "")
    prompt = (
        "不動産のルームツアー動画の場面ごとのコマです（撮影順）。各コマについて判断してください。\n"
        f"- room: 次から1つ選ぶ {'・'.join(ROOMS)}\n"
        "- caption: その場面に出すテロップ。12文字以内。写っているもの、または物件の特徴メモに書かれている"
        "ことだけを書く（例：「LDK 12帖」「2口コンロ」「独立洗面台」）。分からなければ部屋名だけ\n"
        "- quality: 1〜5（5=明るくぶれが少なく構図が良い。天井・床だけ、真っ暗、極端なぶれは1）\n"
        "- hero: 動画の冒頭に一番ふさわしい1枚だけ true（広く明るい部屋、眺望など）\n"
        f"物件の特徴メモ: {points}\n"
        "根拠のない誇張（最高・格安など）は書かない。"
    )
    parts = [{"text": prompt}]
    for i, f in enumerate(frames):
        parts.append({"text": f"コマ{i}"})
        parts.append({"inline_data": {"mime_type": "image/jpeg", "data": _thumb_b64(f)}})
    schema = {
        "type": "ARRAY",
        "items": {"type": "OBJECT", "properties": {
            "index": {"type": "INTEGER"}, "room": {"type": "STRING"}, "caption": {"type": "STRING"},
            "quality": {"type": "INTEGER"}, "hero": {"type": "BOOLEAN"}},
            "required": ["index", "room", "caption", "quality", "hero"]},
    }
    try:
        items = gemini.generate_json(parts, schema, model, temperature=0.2)
    except Exception as e:
        log("場面の判定をスキップ:", str(e)[:200])
        return None
    out = [{"room": "", "caption": "", "quality": 3, "hero": False} for _ in frames]
    for it in items:
        i = it.get("index")
        if isinstance(i, int) and 0 <= i < len(frames):
            out[i] = {"room": str(it.get("room", ""))[:8], "caption": str(it.get("caption", ""))[:14],
                      "quality": int(it.get("quality", 3)), "hero": bool(it.get("hero"))}
    log("場面の判定:", [(o["room"], o["quality"]) for o in out])
    return out
