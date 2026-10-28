"""文字起こし（faster-whisper、無料・オフライン）。未インストールなら None を返す。"""
from __future__ import annotations

import os
from pathlib import Path

from .util import log


def get_transcriber():
    if os.environ.get("WHISPER_MODEL", "small") == "off":
        return None
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        log("faster-whisper が無いので字幕なしで進めます")
        return None
    model_name = os.environ.get("WHISPER_MODEL", "small")
    model = WhisperModel(model_name, device="cpu", compute_type="int8")

    def transcribe(path: Path) -> list[dict]:
        segs, _ = model.transcribe(str(path), language="ja", vad_filter=True, beam_size=1)
        return [{"start": s.start, "end": s.end, "text": s.text} for s in segs]

    return transcribe
