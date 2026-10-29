"""Gemini API の呼び出し（文章生成と画像判定で共通）。

モデルが使えない（廃止・名前違い）ときは次の候補で自動的にやり直し、
失敗したときは Google のエラー内容を短くまとめて返す（シートの「注意」欄に出すため）。
"""
from __future__ import annotations

import json
import os
import re

import requests

API = "https://generativelanguage.googleapis.com/v1beta"
FALLBACK_MODELS = ["gemini-flash-latest"]
_available: list[str] | None = None


class GeminiError(RuntimeError):
    pass


def _version(name: str) -> tuple:
    m = re.search(r"gemini-(\d+(?:\.\d+)?)", name)
    return (float(m.group(1)) if m else 0.0,)


def available_flash_models(key: str) -> list[str]:
    """このキーで今使える Flash 系モデルを新しい順に返す（モデルの提供終了に自動で追従するため）。"""
    global _available
    if _available is not None:
        return _available
    names: list[str] = []
    try:
        page = ""
        for _ in range(5):
            r = requests.get(f"{API}/models", headers={"x-goog-api-key": key},
                             params={"pageSize": 200, **({"pageToken": page} if page else {})}, timeout=30)
            if not r.ok:
                break
            j = r.json()
            for m in j.get("models", []):
                n = m.get("name", "").removeprefix("models/")
                if ("generateContent" in m.get("supportedGenerationMethods", []) and "flash" in n
                        and not re.search(r"lite|image|tts|live|audio|thinking|exp", n)):
                    names.append(n)
            page = j.get("nextPageToken", "")
            if not page:
                break
    except requests.RequestException:
        pass
    stable = [n for n in names if "preview" not in n]
    _available = sorted(stable, key=_version, reverse=True) + sorted(
        [n for n in names if "preview" in n], key=_version, reverse=True)
    return _available


def generate_json(parts: list[dict], schema: dict, model: str, temperature: float = 0.7, timeout: int = 120):
    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        raise GeminiError("GEMINI_API_KEY が未設定です")
    preferred = os.environ.get("GEMINI_MODEL") or model
    models = [m for m in dict.fromkeys([preferred] + FALLBACK_MODELS) if m]
    tried: set[str] = set()
    last = ""
    i = 0
    while i < len(models) and len(tried) < 6:
        m = models[i]
        i += 1
        if m in tried:
            continue
        tried.add(m)
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
            # モデルの提供終了など → 案内されたモデルと、今使えるモデルの一覧から選び直す
            hint = re.findall(r"models/([\w.\-]+)", msg)
            models += [h for h in hint if h != m] + available_flash_models(key)
            continue
        if r.status_code in (429, 500, 503):
            continue          # 混雑・上限 → 次の候補へ
        break                 # キーの問題などは何度やっても同じ
    raise GeminiError(last.replace(key, "***"))
