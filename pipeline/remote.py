"""Google Apps Script（司令塔）と Google ドライブとのやり取り。"""
from __future__ import annotations

import json
import mimetypes
import os
from pathlib import Path

import requests

from .util import mask

DRIVE = "https://www.googleapis.com/drive/v3"
UPLOAD = "https://www.googleapis.com/upload/drive/v3"


class Gas:
    """GAS ウェブアプリへの POST。秘密の合言葉（GAS_SECRET）で本人確認する。"""

    def __init__(self):
        self.url = os.environ["GAS_URL"]
        self.secret = os.environ["GAS_SECRET"]
        mask(self.url)
        mask(self.secret)

    def call(self, action: str, **data) -> dict:
        r = requests.post(self.url, data=json.dumps({"key": self.secret, "action": action, **data}),
                          headers={"Content-Type": "application/json"}, timeout=180)
        r.raise_for_status()
        try:
            j = r.json()
        except ValueError:
            raise RuntimeError("GAS の応答が JSON ではありません。ウェブアプリのデプロイ設定を確認してください。")
        if not j.get("ok"):
            raise RuntimeError(f"GAS エラー: {j.get('error')}")
        return j


class Drive:
    def __init__(self, token: str):
        mask(token)
        self.h = {"Authorization": f"Bearer {token}"}

    def download(self, file_id: str, dst: Path):
        with requests.get(f"{DRIVE}/files/{file_id}", params={"alt": "media", "supportsAllDrives": "true"},
                          headers=self.h, stream=True, timeout=600) as r:
            r.raise_for_status()
            with open(dst, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)

    def folder(self, name: str, parent: str) -> str:
        r = requests.post(f"{DRIVE}/files", params={"supportsAllDrives": "true"}, headers=self.h,
                          json={"name": name, "mimeType": "application/vnd.google-apps.folder", "parents": [parent]},
                          timeout=60)
        r.raise_for_status()
        return r.json()["id"]

    def upload(self, path: Path, parent: str, name: str | None = None) -> str:
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        meta = {"name": name or path.name, "parents": [parent]}
        r = requests.post(f"{UPLOAD}/files", params={"uploadType": "resumable", "supportsAllDrives": "true"},
                          headers={**self.h, "X-Upload-Content-Type": mime,
                                   "Content-Type": "application/json; charset=UTF-8"},
                          data=json.dumps(meta), timeout=60)
        r.raise_for_status()
        loc = r.headers["Location"]
        with open(path, "rb") as f:
            r = requests.put(loc, data=f, headers={"Content-Type": mime}, timeout=900)
        r.raise_for_status()
        return r.json()["id"]
