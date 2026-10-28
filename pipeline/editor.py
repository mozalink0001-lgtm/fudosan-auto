"""撮影素材からリール動画とカルーセル用の写真を作る。

2つの編集モードがある。
- ツアー: 話していないルームツアー。撮影時に1秒止まった箇所（freeze）を部屋の区切りとみなし、
  各部屋の中盤を少し速めて約30秒にまとめ、BGMを主役にする。
- トーク: 話しながらの紹介。無音部分だけを詰め、文字起こしから字幕を焼き込む。
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageFilter, ImageStat

from . import graphics
from .util import ROOT, ffprobe, find_font, log, run

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".mts", ".3gp", ".webm"}
AUDIO_EXT = {".mp3", ".m4a", ".wav", ".aac", ".ogg"}

ENC_FAST = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]


@dataclass
class Clip:
    src: Path
    norm: Path
    offset: float   # full.mp4 上の開始位置
    duration: float


# ---------------- 正規化と結合 ----------------

def normalize(src: Path, dst: Path) -> float:
    info = ffprobe(src)
    w, h = info["width"], info["height"]
    if w / h > 0.75:
        # 横長・正方形はぼかし背景の上に配置
        fc = ("[0:v]split[a][b];"
              "[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,"
              "boxblur=40:6,eq=brightness=-0.08[bg];"
              "[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=30,setsar=1,format=yuv420p[v]")
    else:
        fc = ("[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,"
              "fps=30,setsar=1,format=yuv420p[v]")
    cmd = ["ffmpeg", "-y", "-i", str(src)]
    if info["has_audio"]:
        cmd += ["-filter_complex", fc + ";[0:a:0]aresample=48000,aformat=channel_layouts=stereo[a]",
                "-map", "[v]", "-map", "[a]"]
    else:
        cmd += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                "-filter_complex", fc, "-map", "[v]", "-map", "1:a", "-shortest"]
    run(cmd + ENC_FAST + [str(dst)])
    return ffprobe(dst)["duration"]


def concat_files(files: list[Path], dst: Path):
    if len(files) == 1:
        files[0].replace(dst)
        return
    lst = dst.with_suffix(".txt")
    lst.write_text("".join(f"file '{f.resolve()}'\n" for f in files), encoding="utf-8")
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(dst)])


# ---------------- 解析 ----------------

def detect_freezes(path: Path) -> list[tuple[float, float]]:
    p = run(["ffmpeg", "-hide_banner", "-i", str(path), "-vf", "freezedetect=n=-42dB:d=0.6",
             "-map", "0:v:0", "-f", "null", "-"])
    starts = [float(x) for x in re.findall(r"freeze_start: ([\d.]+)", p.stderr)]
    ends = [float(x) for x in re.findall(r"freeze_end: ([\d.]+)", p.stderr)]
    total = ffprobe(path)["duration"]
    while len(ends) < len(starts):
        ends.append(total)
    return list(zip(starts, ends))


def detect_silences(path: Path) -> list[tuple[float, float]]:
    p = run(["ffmpeg", "-hide_banner", "-i", str(path), "-af", "silencedetect=noise=-32dB:d=0.5",
             "-map", "0:a:0", "-f", "null", "-"])
    starts = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", p.stderr)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", p.stderr)]
    total = ffprobe(path)["duration"]
    while len(ends) < len(starts):
        ends.append(total)
    return [(max(0.0, s), e) for s, e in zip(starts, ends)]


def speech_ratio(silences, total) -> float:
    silent = sum(e - s for s, e in silences)
    return max(0.0, 1 - silent / total) if total else 0.0


# ---------------- 区間の選び方 ----------------

def room_segments(total: float, clips: list[Clip], freezes) -> list[tuple[float, float]]:
    """クリップの境目と静止区間で区切った「部屋ごとの区間」を返す。"""
    cuts = {0.0, total}
    for c in clips:
        cuts.add(round(c.offset, 3))
    if sum(e - s for s, e in freezes) > total * 0.4:
        # 静止判定が多すぎる（暗い部屋・三脚撮影など）ときは、区切りの目安にだけ使う
        freezes = [((s + e) / 2, (s + e) / 2) for s, e in freezes]
    for s, e in freezes:
        cuts.add(round(s, 3))
        cuts.add(round(e, 3))
    pts = sorted(cuts)
    segs = []
    for a, b in zip(pts, pts[1:]):
        # 静止区間そのものは動画には使わない（写真用に回す）
        if any(s - 0.05 <= a and b <= e + 0.05 for s, e in freezes):
            continue
        if b - a >= 1.2:
            segs.append((a, b))
    if len(segs) <= 1 and total > 12:
        step = 5.0
        segs = [(t, min(total, t + step)) for t in frange(0, total, step) if min(total, t + step) - t >= 1.2]
    return segs


def frange(a, b, step):
    t = a
    while t < b:
        yield t
        t += step


def pick_tour(segs, cfg) -> list[tuple[float, float, float]]:
    speed = float(cfg["tour_speed"])
    budget = (cfg["tour_target_seconds"] - cfg["endcard_seconds"]) * speed  # 素材上の秒数
    maxn = int(cfg["max_segments"])
    if len(segs) > maxn:
        idx = sorted({round(i * (len(segs) - 1) / (maxn - 1)) for i in range(maxn)})
        segs = [segs[i] for i in idx]
    usable = [(a + 0.25, b - 0.25) for a, b in segs if b - a > 0.8]
    if not usable:
        return []
    per = budget / len(usable)
    take = [min(b - a, per) for a, b in usable]
    left = budget - sum(take)
    if left > 0.5:
        room = [(b - a) - t for (a, b), t in zip(usable, take)]
        tot = sum(room)
        if tot > 0:
            take = [t + left * r / tot for t, r in zip(take, room)]
    out = []
    for i, ((a, b), t) in enumerate(zip(usable, take)):
        t = min(t, b - a)
        # 1本目（外観）は頭から、他は区間の中央を使う
        start = a if i == 0 else a + (b - a - t) / 2
        out.append((start, start + t, speed))
    return out


def pick_talk(total, silences, cfg) -> list[tuple[float, float, float]]:
    keep = []
    cur = 0.0
    for s, e in silences:
        if s - cur > 0.15:
            keep.append((max(0.0, cur - 0.15), min(total, s + 0.2)))
        cur = e
    if total - cur > 0.15:
        keep.append((max(0.0, cur - 0.15), total))
    merged = []
    for a, b in keep:
        if merged and a - merged[-1][1] < 0.3:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    limit = cfg["talk_max_seconds"] - cfg["endcard_seconds"]
    out, used = [], 0.0
    for a, b in merged:
        if used >= limit:
            break
        b = min(b, a + (limit - used))
        out.append((a, b, 1.0))
        used += b - a
    return out


def cut(src: Path, parts, dst: Path):
    fc, labels = [], []
    for i, (s, e, sp) in enumerate(parts):
        fc.append(f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=(PTS-STARTPTS)/{sp}[v{i}]")
        at = f",atempo={sp}" if abs(sp - 1) > 1e-3 else ""
        fc.append(f"[0:a]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS{at}[a{i}]")
        labels.append(f"[v{i}][a{i}]")
    fc.append(f"{''.join(labels)}concat=n={len(parts)}:v=1:a=1[v][a]")
    script = dst.with_suffix(".filter")
    script.write_text(";\n".join(fc), encoding="utf-8")
    run(["ffmpeg", "-y", "-i", str(src), "-filter_complex_script", str(script),
         "-map", "[v]", "-map", "[a]"] + ENC_FAST + [str(dst)])


# ---------------- 字幕 ----------------

def ass_time(t: float) -> str:
    h = int(t // 3600)
    m = int(t % 3600 // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def write_ass(subs: list[dict], dst: Path, brand: dict) -> Path:
    from PIL import ImageFont
    family = ImageFont.truetype(find_font(), 10).getname()[0]
    accent = brand["colors"]["accent"].lstrip("#")
    # ASS の色は &HAABBGGRR
    acc = f"&H00{accent[4:6]}{accent[2:4]}{accent[0:2]}"
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,{family},66,&H00FFFFFF,{acc},&H00141414,&H64000000,-1,0,0,0,100,100,0,0,1,6,0,2,60,60,720,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    for sub in subs:
        text = sub["text"].strip()
        if not text:
            continue
        chunks = [text[i:i + 30] for i in range(0, len(text), 30)]
        dur = (sub["end"] - sub["start"]) / len(chunks)
        for k, ch in enumerate(chunks):
            st = sub["start"] + k * dur
            body = ch if len(ch) <= 15 else ch[:15] + "\\N" + ch[15:]
            lines.append(f"Dialogue: 0,{ass_time(st)},{ass_time(st + dur)},Main,,0,0,0,,{body}")
    dst.write_text(head + "\n".join(lines) + "\n", encoding="utf-8")
    return dst


# ---------------- 写真の切り出し ----------------

def sharpness(img: Image.Image) -> float:
    g = img.convert("L").resize((480, int(480 * img.height / img.width)))
    return ImageStat.Stat(g.filter(ImageFilter.FIND_EDGES)).var[0]


def thumb_sig(img: Image.Image):
    return list(img.convert("L").resize((16, 16)).getdata())


def grab_frame(src: Path, t: float, dst: Path) -> bool:
    try:
        run(["ffmpeg", "-y", "-ss", f"{max(0.0, t):.3f}", "-i", str(src), "-frames:v", "1", "-q:v", "2", str(dst)])
        return dst.exists()
    except RuntimeError:
        return False


def pick_photos(clips: list[Clip], freezes, segs, work: Path, limit=7) -> list[Path]:
    cands = [(s + e) / 2 for s, e in freezes if e - s >= 0.5]       # 止めて撮ったカットを優先
    cands += [(a + b) / 2 for a, b in segs]
    cands.sort()
    chosen_t = []
    for t in cands:
        if all(abs(t - c) > 2.5 for c in chosen_t):
            chosen_t.append(t)
    photos, sigs = [], []
    for n, t in enumerate(chosen_t):
        clip = next((c for c in clips if c.offset <= t < c.offset + c.duration), clips[-1])
        local = t - clip.offset
        best, best_score = None, -1.0
        for k, dt in enumerate((-0.4, 0.0, 0.4)):
            f = work / f"cand_{n}_{k}.jpg"
            if not grab_frame(clip.src, local + dt, f):
                continue
            img = Image.open(f)
            if ImageStat.Stat(img.convert("L")).mean[0] < 28:
                continue  # 真っ暗なコマは除外
            sc = sharpness(img)
            if sc > best_score:
                best, best_score = f, sc
        if best is None:
            continue
        sig = thumb_sig(Image.open(best))
        if any(sum(abs(x - y) for x, y in zip(sig, s2)) / 256 < 10 for s2 in sigs):
            continue  # ほぼ同じ構図
        sigs.append(sig)
        photos.append(best)
        if len(photos) >= limit:
            break
    return photos


# ---------------- 仕上げ ----------------

def pick_bgm(brand: dict, key: str) -> Path | None:
    d = ROOT / brand.get("bgm_dir", "assets/bgm")
    files = sorted(p for p in d.glob("*") if p.suffix.lower() in AUDIO_EXT) if d.exists() else []
    if not files:
        return None
    h = int(hashlib.md5(key.encode()).hexdigest(), 16)
    return files[h % len(files)]


def build_reel(clip_paths: list[Path], prop: dict, brand: dict, work: Path,
               text_fn, transcriber=None) -> dict:
    """素材 → reel.mp4 と写真候補。

    text_fn(transcript) は投稿文の dict（hook を含む）を返す関数。字幕の文字起こしが
    終わってから呼ぶので、話した内容を投稿文に反映できる。
    transcriber(path)->[{start,end,text}] は任意（トークモードのときだけ使う）。
    """
    cfg = brand["reel"]
    work.mkdir(parents=True, exist_ok=True)

    clips: list[Clip] = []
    offset = 0.0
    for i, src in enumerate(clip_paths):
        norm = work / f"norm_{i:02d}.mp4"
        dur = normalize(src, norm)
        clips.append(Clip(src, norm, offset, dur))
        offset += dur
    full = work / "full.mp4"
    concat_files([c.norm for c in clips], full)
    total = ffprobe(full)["duration"]
    log(f"素材 {len(clips)}本 / 合計 {total:.1f}秒")

    freezes = detect_freezes(full)
    silences = detect_silences(full)
    ratio = speech_ratio(silences, total)
    want = str(prop.get("mode") or "自動")
    if want.startswith("ツ"):
        mode = "tour"
    elif want.startswith("ト"):
        mode = "talk"
    else:
        mode = "talk" if ratio > 0.45 and total > 8 else "tour"
    log(f"静止区間 {len(freezes)} / 発話率 {ratio:.0%} → {mode}")

    segs = room_segments(total, clips, freezes)
    parts = pick_talk(total, silences, cfg) if mode == "talk" else pick_tour(segs, cfg)
    if not parts:
        parts = [(0.0, min(total, cfg["tour_target_seconds"]), 1.0)]
    body = work / "body.mp4"
    cut(full, parts, body)
    body_dur = ffprobe(body)["duration"]

    subs, transcript = [], ""
    if transcriber is not None and mode == "talk":
        try:
            subs = transcriber(body)
            transcript = "".join(s["text"] for s in subs)
        except Exception as e:  # 字幕が作れなくても動画は作る
            log("文字起こしをスキップ:", e)
    use_subs = mode == "talk" and subs
    texts = text_fn(transcript)
    hook = texts.get("hook") or graphics.headline(prop)

    hook_png, info_png = work / "hook.png", work / "info.png"
    graphics.hook_overlay(prop, hook, brand, hook_png)
    graphics.info_overlay(prop, brand, info_png)
    hs = cfg["hook_seconds"]
    fc = (f"[0:v][1:v]overlay=0:0:enable='between(t,0,{hs})'[v1];"
          f"[v1][2:v]overlay=0:0:enable='gte(t,{hs})'[v2]")
    if use_subs:
        ass = write_ass(subs, work / "subs.ass", brand)
        fontsdir = str(Path(find_font()).parent)
        fc += f";[v2]subtitles=filename='{ass}':fontsdir='{fontsdir}'[v]"
    else:
        fc += ";[v2]null[v]"
    body_ov = work / "body_ov.mp4"
    run(["ffmpeg", "-y", "-i", str(body), "-i", str(hook_png), "-i", str(info_png),
         "-filter_complex", fc, "-map", "[v]", "-map", "0:a"] + ENC_FAST + [str(body_ov)])

    last = work / "last.jpg"
    grab_frame(body, max(0.0, body_dur - 0.2), last)
    end_jpg = work / "endcard.jpg"
    graphics.endcard(prop, brand, last, end_jpg)
    ec = cfg["endcard_seconds"]
    end_mp4 = work / "endcard.mp4"
    run(["ffmpeg", "-y", "-loop", "1", "-t", str(ec), "-i", str(end_jpg),
         "-f", "lavfi", "-t", str(ec), "-i", "anullsrc=r=48000:cl=stereo",
         "-vf", "scale=1080:1920,fps=30,format=yuv420p,fade=t=in:st=0:d=0.3",
         "-map", "0:v", "-map", "1:a"] + ENC_FAST + [str(end_mp4)])

    reel = work / "reel.mp4"
    total_out = body_dur + ec
    voice = 1.0 if mode == "talk" else float(brand.get("voice_volume_tour", 0.25))
    bgm = pick_bgm(brand, str(prop.get("id", "")))
    cmd = ["ffmpeg", "-y", "-i", str(body_ov), "-i", str(end_mp4)]
    fc = f"[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a0];[a0]volume={voice}[vo]"
    if bgm:
        bvol = float(brand.get("bgm_volume", 0.18)) * (0.45 if mode == "talk" else 1.0)
        cmd += ["-stream_loop", "-1", "-i", str(bgm)]
        fc += (f";[2:a]atrim=0:{total_out:.2f},asetpts=PTS-STARTPTS,volume={bvol},"
               f"afade=t=in:st=0:d=0.8,afade=t=out:st={max(0, total_out - 1.5):.2f}:d=1.5[bg];"
               f"[vo][bg]amix=inputs=2:duration=first:normalize=0[mx];"
               f"[mx]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]")
    else:
        fc += ";[vo]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]"
    cmd += ["-filter_complex", fc, "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-profile:v", "high",
            "-maxrate", "10M", "-bufsize", "20M", "-pix_fmt", "yuv420p", "-r", "30",
            "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
            "-movflags", "+faststart", "-t", f"{total_out:.2f}", str(reel)]
    run(cmd)

    photos = pick_photos(clips, freezes, segs, work)
    meta = {"mode": mode, "speech_ratio": round(ratio, 3), "source_seconds": round(total, 1),
            "reel_seconds": round(ffprobe(reel)["duration"], 1), "segments": len(parts),
            "photos": len(photos), "bgm": bgm.name if bgm else None, "subtitles": bool(use_subs)}
    (work / "edit.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    log("編集結果", meta)
    return {"reel": reel, "photos": photos, "transcript": transcript, "meta": meta,
            "endcard": end_jpg, "texts": texts}


def build_images(photos: list[Path], prop: dict, cover_title: str, brand: dict, out: Path) -> dict:
    """カルーセル（最大10枚）とストーリーズ画像を作る。"""
    out.mkdir(parents=True, exist_ok=True)
    slides = []
    if photos:
        p = out / "carousel_01_cover.jpg"
        graphics.carousel_cover(photos[0], prop, cover_title, brand, p)
        slides.append(p)
        for i, ph in enumerate(photos[1:7], start=2):
            p = out / f"carousel_{i:02d}.jpg"
            graphics.carousel_photo(ph, brand, p)
            slides.append(p)
    p = out / f"carousel_{len(slides) + 1:02d}_info.jpg"
    graphics.carousel_info(prop, brand, p)
    slides.append(p)
    p = out / f"carousel_{len(slides) + 1:02d}_line.jpg"
    graphics.carousel_cta(brand, p)
    slides.append(p)
    story = None
    if photos:
        story = out / "story.jpg"
        graphics.story_image(photos[0], prop, brand, story)
    return {"carousel": slides[:10], "story": story}
