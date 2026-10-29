"""AI ナレーション（原稿づくり・読み上げ・場面ごとへの割り振り）。

1. 場面ごとに1文の原稿を Gemini に書かせる（その場面の長さで読み切れる文字数まで）
2. 原稿をまとめて Gemini の読み上げ音声にする（呼び出しは1回）
3. 音声を文の切れ目の無音で分け、各場面の頭に置く
音声が作れないときは原稿だけ返し、編集側で字幕だけ出す。
"""
from __future__ import annotations

import re
import wave
from dataclasses import dataclass
from pathlib import Path

from . import gemini
from .captions import facts, find_ng
from .util import audio_duration, log, run

CHARS_PER_SEC = 6.5     # 落ち着いた読み上げで1秒に読める文字数の目安


@dataclass
class Line:
    text: str
    wav: Path | None = None
    dur: float = 0.0


def max_chars(dur: float) -> int:
    return max(6, int((dur - 0.4) * CHARS_PER_SEC))


def write_script(scenes: list[dict], prop: dict, brand: dict, hook: str) -> list[str] | None:
    """scenes: [{"room","caption","dur"}]（動画の順）。場面と同じ数の文を返す。"""
    n = len(scenes)
    lines_spec = "\n".join(
        f"{i}. 場面「{s.get('room') or '室内'}」{('（' + s['caption'] + '）') if s.get('caption') else ''}"
        f" … {max_chars(s['dur'])}文字以内" for i, s in enumerate(scenes))
    prompt = (
        "あなたは大阪の不動産会社の案内役です。ルームツアー動画のナレーション原稿を書いてください。\n"
        f"## 物件情報\n{facts(prop)}\n\n## 場面（この順に流れる）\n{lines_spec}\n\n"
        "## ルール\n"
        f"- 場面ごとに1文、合計{n}文。各文は指定の文字数以内\n"
        f"- 1文目は冒頭のつかみ。「{hook}」の内容を話し言葉で\n"
        "- 2文目以降はその場面に映っているものを、住んだときの良さが伝わるように言う\n"
        "- 最後の文は「間取り図と初期費用は、プロフィールのLINEからどうぞ」の趣旨\n"
        "- です・ます調で親しみやすく。物件情報にないことや数字は作らない\n"
        "- 根拠のない最上級表現（最高・格安・完璧など）は使わない\n"
        "- 記号や絵文字、英語の略語は使わない（読み上げるため。LDKは「エルディーケー」と書く）"
    )
    schema = {"type": "OBJECT", "properties": {"lines": {"type": "ARRAY", "items": {"type": "STRING"}}},
              "required": ["lines"]}
    model = brand.get("gemini_model", "gemini-flash-latest")
    for attempt in range(2):
        try:
            out = gemini.generate_json([{"text": prompt}], schema, model, temperature=0.7)
        except Exception as e:
            log("ナレーション原稿をスキップ:", str(e)[:200])
            return None
        lines = [re.sub(r"\s+", "", str(x)) for x in out.get("lines", [])][:n]
        if len(lines) < n:
            lines += [""] * (n - len(lines))
        lines = [ln[: max_chars(s["dur"]) + 4] for ln, s in zip(lines, scenes)]
        hits = find_ng("".join(lines), brand["ng_words"])
        if not hits:
            return lines
        prompt += f"\n- 前回は使用禁止の語（{'、'.join(hits)}）が入っていました。言い換えてください"
    return None


def _write_wav(pcm: bytes, rate: int, path: Path):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)


def _silences(path: Path) -> list[tuple[float, float]]:
    p = run(["ffmpeg", "-hide_banner", "-i", str(path), "-af", "silencedetect=noise=-38dB:d=0.18",
             "-f", "null", "-"])
    s = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", p.stderr)]
    e = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", p.stderr)]
    return list(zip(s, e))


def split_points(silences, total: float, n: int) -> list[float] | None:
    """文の切れ目（長めの無音）を n-1 か所選び、時間順に返す。"""
    inner = [(s, e) for s, e in silences if s > 0.2 and e < total - 0.2]
    if len(inner) < n - 1:
        return None
    best = sorted(inner, key=lambda x: x[1] - x[0], reverse=True)[: n - 1]
    return sorted((s + e) / 2 for s, e in best)


def synth(lines: list[str], voice: str, work: Path) -> tuple[list[Line], str]:
    """原稿を読み上げ、文ごとの音声ファイルにする。空の文は音声なし。"""
    spoken = [ln for ln in lines if ln]
    text = "明るく落ち着いた声で、少しゆっくり、はっきり読み上げてください：\n" + \
        "\n".join(ln if ln.endswith(("。", "！", "？")) else ln + "。" for ln in spoken)
    pcm, rate, model = gemini.tts(text, voice)
    whole = work / "narr_all.wav"
    _write_wav(pcm, rate, whole)
    total = audio_duration(whole)
    cuts = split_points(_silences(whole), total, len(spoken))
    if cuts is None:
        raise RuntimeError("文の切れ目が見つかりませんでした")
    bounds = [0.0] + cuts + [total]
    out, k = [], 0
    for ln in lines:
        if not ln:
            out.append(Line(""))
            continue
        a, b = bounds[k], bounds[k + 1]
        seg = work / f"narr_{k:02d}.wav"
        run(["ffmpeg", "-y", "-i", str(whole), "-af",
             f"atrim={a:.3f}:{b:.3f},asetpts=PTS-STARTPTS,"
             "silenceremove=start_periods=1:start_threshold=-40dB:stop_periods=1:stop_threshold=-40dB:stop_duration=0.15",
             str(seg)])
        out.append(Line(ln, seg, audio_duration(seg)))
        k += 1
    log("ナレーション:", model, [round(x.dur, 1) for x in out])
    return out, model


def schedule(lines: list[Line], starts: list[float], durs: list[float], xf: float, tail: float):
    """各文の開始時刻と速さ（atempo）を決める。最後の文は最後の画面まで使ってよい。"""
    plan, prev_end = [], 0.0
    for k, ln in enumerate(lines):
        st = max(starts[k] + (0.25 if k == 0 else xf * 0.5), prev_end + 0.08)
        room = (starts[k] + durs[k] - xf - st) if k < len(lines) - 1 else (starts[k] + durs[k] + tail - st)
        dur = ln.dur
        tempo = 1.0
        if dur and room > 0.5 and dur > room:
            tempo = min(1.25, dur / room)
        real = dur / tempo if dur else max(1.2, min(durs[k] - xf, len(ln.text) / CHARS_PER_SEC))
        plan.append((st, real, tempo))
        prev_end = st + real
    return plan
