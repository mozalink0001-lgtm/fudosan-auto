"""Gemini API の呼び出し（文章生成と画像判定で共通）。

モデルが使えない（廃止・名前違い）ときは次の候補で自動的にやり直し、
失敗したときは Google のエラー内容を短くまとめて返す（シートの「注意」欄に出すため）。
"""
from __future__ import annotations

import json
import os

import requests

FALLBACK_MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"]


class GeminiError(RuntimeError):
    pass


def generate_json(parts: list[dict], schema: dict, model: str, temperature: float = 0.7, timeout: int = 120):
    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        raise GeminiError("GEMINI_API_KEY が未設定です")
    models = [m for m in dict.fromkeys([os.environ.get("GEMINI_MODEL") or model] + FALLBACK_MODELS) if m]
    last = ""
    for m in models:
        r = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent",
            headers={"x-goog-api-key": key},
            json={"contents": [{"parts": parts}],
                  "generationConfig": {"responseMimeType": "application/json", "responseSchema": schema,
                                       "temperature": temperature}},
            timeout=timeout,
        )
        if r.ok:
            try:
                return json.loads(r.json()["candidates"][0]["content"]["parts"][0]["text"])
            except (KeyError, IndexError, ValueError) as e:
                last = f"{m}: 応答を読めませんでした（{type(e).__name__}）"
                continue
        try:
            msg = r.json().get("error", {}).get("message", "")
        except ValueError:
            msg = r.text[:200]
        last = f"{m}: HTTP {r.status_code} {msg[:160]}"
        if r.status_code in (404, 400) and "model" in msg.lower():
            continue          # モデル名の問題 → 次の候補へ
        if r.status_code in (429, 500, 503):
            continue          # 混雑・上限 → 次の候補へ
        break                 # キーの問題などは何度やっても同じ
    raise GeminiError(last.replace(key, "***"))
