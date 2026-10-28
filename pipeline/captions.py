"""投稿文の生成。Gemini API（無料枠）を使い、使えないときはテンプレートで作る。

法令まわりの必須表記（取引態様・情報時点・徒歩分数）はAIに任せず、ここで機械的に付ける。
"""
from __future__ import annotations

import json
import os
import re

import requests

from .graphics import headline
from .util import log, walk_minutes, yen_short

FIELDS = {
    "hook": "動画冒頭に大きく出す一言。16文字以内。家賃や一番の魅力など結論から",
    "cover_title": "カルーセル1枚目のタイトル。20文字以内",
    "reel_caption": "Instagramリールの本文。冒頭1行で要点、箇条書き3〜5点、最後にLINEへの誘導",
    "carousel_caption": "Instagramカルーセルの本文。保存したくなる要点整理、最後にLINEへの誘導",
    "threads_video": "Threadsに動画と一緒に載せる文。営業担当の本音のひとこと、150字以内、URLなし、最後は問いかけ",
    "threads_tip": "この物件から得られる部屋探しのコツを、物件の宣伝をせずに書く。300字以内、URLなし、最後は問いかけ",
    "hashtags": "物件に合うハッシュタグを5個まで（#付き、エリア名・駅名・間取りを優先）",
}

# 「超える」「積極的」などの普通の言葉を禁止語と誤判定しないための除外
NG_EXCEPT = {"超": r"超(?=え|過|す|し)", "極": r"(?<=積)極|極(?=力|端|めて)"}


def facts(prop: dict) -> dict:
    wm = walk_minutes(prop.get("station_m"))
    return {
        "種別": prop.get("kind", ""),
        "物件名": prop.get("name", ""),
        "賃料または価格": yen_short(prop["price"]) if prop.get("price") else "",
        "管理費等": yen_short(prop["admin_fee"]) if prop.get("admin_fee") else "",
        "間取り": prop.get("layout", ""),
        "専有面積": f"{prop['area_m2']}㎡" if prop.get("area_m2") else "",
        "最寄駅": prop.get("station", ""),
        "徒歩": f"{wm}分（{prop.get('station_m')}m）" if wm else "",
        "所在地": prop.get("address", ""),
        "築年月": prop.get("built", ""),
        "おすすめポイント": prop.get("points", ""),
    }


def find_ng(text: str, ng_words: list[str]) -> list[str]:
    hits = []
    for w in ng_words:
        for m in re.finditer(re.escape(w), text):
            ex = NG_EXCEPT.get(w)
            if ex and any(e.start() <= m.start() < e.end() for e in re.finditer(ex, text)):
                continue
            hits.append(w)
            break
    return hits


def _prompt(prop, brand, transcript, memo, feedback):
    rules = [
        "日本の不動産広告のルール（宅建業法・不動産の表示に関する公正競争規約）を守る",
        "根拠のない最上級表現・断定表現は使わない。使用禁止の語: " + "、".join(brand["ng_words"]),
        "書かれていない設備や数値は作らない。分からないことは書かない",
        "家賃・価格・面積・徒歩分数は与えられた値をそのまま使う",
        "取引態様と情報時点の表記はシステムが末尾に付けるので書かない",
        f"LINEへの誘導は「{brand['cta_title']}{brand['cta_body']}」の趣旨で",
        "絵文字は控えめ（1投稿に3個まで）",
    ]
    p = ("あなたは不動産会社のSNS担当です。次の物件のSNS投稿文を作ってください。\n\n"
         f"## 物件情報\n{json.dumps(facts(prop), ensure_ascii=False, indent=1)}\n\n")
    if transcript:
        p += f"## 撮影者のコメント（文字起こし）\n{transcript[:1500]}\n\n"
    if memo:
        p += f"## 担当者からの修正指示（最優先）\n{memo}\n\n"
    if feedback:
        p += f"## 前回の問題点\n{feedback}\n\n"
    p += "## ルール\n" + "\n".join(f"- {r}" for r in rules) + "\n\n## 出力する項目\n"
    p += "\n".join(f"- {k}: {v}" for k, v in FIELDS.items())
    return p


def _gemini(prompt: str, model: str, key: str) -> dict:
    schema = {
        "type": "OBJECT",
        "properties": {k: ({"type": "ARRAY", "items": {"type": "STRING"}} if k == "hashtags" else {"type": "STRING"})
                       for k in FIELDS},
        "required": list(FIELDS),
    }
    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        headers={"x-goog-api-key": key},
        json={"contents": [{"parts": [{"text": prompt}]}],
              "generationConfig": {"responseMimeType": "application/json", "responseSchema": schema,
                                   "temperature": 0.8}},
        timeout=90,
    )
    r.raise_for_status()
    text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(text)


def template(prop: dict, brand: dict) -> dict:
    f = facts(prop)
    head = headline(prop)
    pts = [p.strip() for p in re.split(r"[、,\n／/]", str(prop.get("points", ""))) if p.strip()]
    bullets = "\n".join(f"✔ {p}" for p in pts[:5])
    cta = f"{brand['cta_title']}\n{brand['cta_body']}"
    hook = (f"{f['賃料または価格']}で{f['間取り']}" if f["賃料または価格"] and f["間取り"] else head)[:16]
    station = f["最寄駅"]
    return {
        "hook": hook,
        "cover_title": f"{station}の{f['間取り']}をルームツアー" if station else "ルームツアー",
        "reel_caption": f"【{head}】\n{bullets}\n\n{cta}",
        "carousel_caption": f"【{head}】\n写真で間取りと設備をまとめました。\n{bullets}\n\n{cta}",
        "threads_video": f"{station}で{f['間取り']}を探している人に見てほしい部屋です。実際に歩いてみて、写真より明るく感じました。皆さんは部屋選びで何を一番重視しますか？",
        "threads_tip": "内見のときは、収納の奥行きと、窓を開けたときの音を必ず確認してください。図面だけでは分からないところで、住んでからの満足度が大きく変わります。皆さんが内見で必ず見るところはどこですか？",
        "hashtags": [f"#{station}" if station else "", f"#{f['間取り']}" if f["間取り"] else ""],
    }


def finalize(raw: dict, prop: dict, brand: dict) -> dict:
    """必須表記とハッシュタグを機械的に付ける。"""
    footer = []
    if prop.get("deal_type"):
        footer.append(f"取引態様：{prop['deal_type']}")
    if prop.get("updated"):
        footer.append(f"{prop['updated']}時点の情報です")
    foot = "｜".join(footer)
    tags = [t if str(t).startswith("#") else f"#{t}" for t in raw.get("hashtags", []) if t]
    tags = list(dict.fromkeys(tags + brand.get("base_hashtags", [])))[:8]
    tag_line = " ".join(t.replace(" ", "") for t in tags)
    out = dict(raw)
    out["hook"] = str(raw.get("hook", ""))[:18]
    for k in ("reel_caption", "carousel_caption"):
        out[k] = "\n\n".join(x for x in [str(raw.get(k, "")).strip(), foot, tag_line] if x)[:2100]
    out["threads_video"] = "\n\n".join(x for x in [str(raw.get("threads_video", "")).strip(), foot] if x)[:480]
    out["threads_tip"] = str(raw.get("threads_tip", "")).strip()[:480]
    out["threads_topic"] = brand.get("threads_topic", "")
    out["hashtags"] = tags
    return out


def generate(prop: dict, brand: dict, transcript: str = "", memo: str = "") -> tuple[dict, list[str]]:
    key = os.environ.get("GEMINI_API_KEY", "")
    model = os.environ.get("GEMINI_MODEL") or brand.get("gemini_model", "gemini-2.5-flash")
    warnings: list[str] = []
    raw = None
    if key:
        feedback = ""
        for attempt in range(2):
            try:
                cand = _gemini(_prompt(prop, brand, transcript, memo, feedback), model, key)
            except Exception as e:
                log("Gemini エラー:", type(e).__name__)
                warnings.append("AI文章の生成に失敗したため、テンプレートの文章を使いました")
                break
            hits = find_ng(json.dumps(cand, ensure_ascii=False), brand["ng_words"])
            raw = cand
            if not hits:
                break
            feedback = "使用禁止の語が含まれていました: " + "、".join(hits) + "。言い換えてください。"
    else:
        warnings.append("GEMINI_API_KEY が未設定のため、テンプレートの文章を使いました")
    if raw is None:
        raw = template(prop, brand)
    out = finalize(raw, prop, brand)
    hits = find_ng(json.dumps(out, ensure_ascii=False), brand["ng_words"])
    if hits:
        warnings.append("要確認の表現: " + "、".join(hits))
    return out, warnings
