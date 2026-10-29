"""撮影素材からリール動画とカルーセル用の写真を作る（v2）。

2つの編集モードがある。
- ツアー: 話していないルームツアー。撮影時に止まった箇所（freeze）を部屋の区切りとみなし、
  AI が各場面の部屋名・見どころ・写りを判定する。一番見栄えのする場面を冒頭に置き、
  残りを撮影順に 2〜3 秒ずつ、等倍速・スワイプの切り替えでつなぐ。音は BGM。
- トーク: 話しながらの紹介。無音部分だけを詰め、文字起こしから字幕を焼き込む。

どちらも、手ぶれ補正・明るさと色の補正・ゆっくり寄るズームをかける。
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageFilter, ImageStat

from . import graphics, vision
from .util import ROOT, ffprobe, find_font, log, run

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".mts", ".3gp", ".webm"}
AUDIO_EXT = {".mp3", ".m4a", ".wav", ".aac", ".ogg"}

ENC_FAST = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]
ENC_V = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-an"]

# 室内は暗く色が浅くなりがちなので、少し明るく・鮮やかに・くっきりさせる
GRADE = "eq=contrast=1.06:brightness=0.03:saturation=1.2:gamma=1.05,unsharp=5:5:0.45:5:5:0"
XF = 0.3            # 場面の切り替え（スワイプ）の秒数
ZOOM_PER_FRAME = 0.0007   # ゆっくり寄るズーム（3秒で約6%）


@dataclass
class Clip:
    src: Path
    norm: Path
    offset: float   # full.mp4 上の開始位置
    duration: float


# ---------------- 正規化（縦型化・手ぶれ補正・色補正） ----------------

def _frame_chain(w: int, h: int) -> tuple[str, bool]:
    """縦 1080x1920 にする filter。横長はぼかし背景の上に置く（filter_complex が必要）。"""
    if w / h > 0.75:
        return ("[0:v]split[a][b];"
                "[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,"
                "boxblur=40:6,eq=brightness=-0.08[bg];"
                "[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=30,setsar=1"), True
    return "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1", True


def normalize(src: Path, dst: Path, stabilize: bool = True) -> float:
    info = ffprobe(src)
    base, _ = _frame_chain(info["width"], info["height"])
    trf = dst.with_suffix(".trf")
    stab = ""
    if stabilize:
        try:
            run(["ffmpeg", "-y", "-i", str(src), "-filter_complex",
                 base + f",vidstabdetect=shakiness=6:accuracy=12:result={trf.name}[v]",
                 "-map", "[v]", "-f", "null", "-"], cwd=dst.parent)
            stab = f",vidstabtransform=input={trf.name}:smoothing=20:optzoom=1:interpol=bicubic"
        except RuntimeError:
            log("手ぶれ補正をスキップ:", src.name)
    fc = base + stab + "," + GRADE + ",format=yuv420p[v]"
    cmd = ["ffmpeg", "-y", "-i", str(src)]
    if info["has_audio"]:
        cmd += ["-filter_complex", fc + ";[0:a:0]aresample=48000,aformat=channel_layouts=stereo[a]",
                "-map", "[v]", "-map", "[a]"]
    else:
        cmd += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                "-filter_complex", fc, "-map", "[v]", "-map", "1:a", "-shortest"]
    run(cmd + ENC_FAST + [dst.name], cwd=dst.parent)
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
        if any(s - 0.05 <= a and b <= e + 0.05 for s, e in freezes if e > s):
            continue  # 静止区間そのものは動画に使わない（写真に回す）
        if b - a >= 1.2:
            segs.append((a, b))
    if len(segs) <= 1 and total > 12:
        step = 4.0
        segs = [(t, min(total, t + step)) for t in frange(0, total, step) if min(total, t + step) - t >= 1.2]
    return segs


def frange(a, b, step):
    t = a
    while t < b:
        yield t
        t += step


# ---------------- 場面の選び方 ----------------

@dataclass
class Part:
    start: float
    end: float
    room: str = ""
    caption: str = ""

    @property
    def dur(self):
        return self.end - self.start


def plan_tour(segs, labels, cfg) -> list[Part]:
    """冒頭＝一番見栄えのする場面、その後は撮影順。各場面 2〜3 秒。"""
    idx = list(range(len(segs)))
    if labels:
        good = [i for i in idx if labels[i]["quality"] >= 2] or idx
    else:
        good = idx
    maxn = int(cfg["max_segments"])
    if len(good) > maxn:  # 多すぎるときは写りの良い順に残す（並びは撮影順のまま）
        rank = sorted(good, key=lambda i: -(labels[i]["quality"] if labels else 0))[:maxn]
        good = sorted(rank)
    hero = None
    if labels:
        heroes = [i for i in good if labels[i]["hero"]]
        hero = heroes[0] if heroes else max(good, key=lambda i: labels[i]["quality"])
    if hero is None:
        hero = max(good, key=lambda i: segs[i][1] - segs[i][0])   # 一番長く映した場面
    order = [hero] + [i for i in good if i != hero]
    hook_len = float(cfg.get("hook_seconds", 2.6)) + XF
    body = float(cfg["tour_target_seconds"]) - float(cfg["endcard_seconds"])
    rest = max(1, len(order) - 1)
    per = min(3.6, max(1.8, (body - hook_len) / rest + XF))
    parts = []
    for n, i in enumerate(order):
        a, b = segs[i][0] + 0.2, segs[i][1] - 0.2
        want = hook_len if n == 0 else per
        t = min(want, b - a)
        if t < 1.0:
            continue
        mid = (a + b) / 2
        s = max(a, min(mid - t / 2, b - t))
        lab = labels[i] if labels else {}
        parts.append(Part(s, s + t, lab.get("room", ""), lab.get("caption", "")))
    return parts


def plan_talk(total, silences, cfg) -> list[Part]:
    keep, cur = [], 0.0
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
        out.append(Part(a, b))
        used += b - a
    return out


# ---------------- 切り出しとつなぎ ----------------

def render_part(src: Path, p: Part, dst: Path, zoom: bool = True):
    vf = f"trim=start={p.start:.3f}:end={p.end:.3f},setpts=PTS-STARTPTS"
    if zoom:
        vf += (f",zoompan=z='min(pzoom+{ZOOM_PER_FRAME},1.08)':d=1:s=1080x1920:fps=30"
               ":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'")
    run(["ffmpeg", "-y", "-i", str(src), "-vf", vf + ",format=yuv420p"] + ENC_V + [str(dst)])


def join_swipe(parts: list[Path], durs: list[float], dst: Path) -> list[float]:
    """スワイプでつなぎ、各場面が完成動画の何秒から始まるかを返す。"""
    if len(parts) == 1:
        parts[0].replace(dst)
        return [0.0]
    cmd = ["ffmpeg", "-y"]
    for p in parts:
        cmd += ["-i", str(p)]
    fc, starts, acc, prev = [], [0.0], 0.0, "[0:v]"
    for k in range(1, len(parts)):
        acc += durs[k - 1] - XF
        starts.append(acc)
        trans = "smoothleft"
        out = f"[x{k}]"
        fc.append(f"{prev}[{k}:v]xfade=transition={trans}:duration={XF}:offset={acc:.3f}{out}")
        prev = out
    run(cmd + ["-filter_complex", ";".join(fc), "-map", prev] + ENC_V + [str(dst)])
    return starts


# ---------------- 字幕（トーク） ----------------

def ass_time(t: float) -> str:
    h = int(t // 3600)
    m = int(t % 3600 // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def write_ass(subs: list[dict], dst: Path, brand: dict) -> Path:
    from PIL import ImageFont
    family = ImageFont.truetype(find_font(True), 10).getname()[0]
    accent = brand["colors"]["accent"].lstrip("#")
    acc = f"&H00{accent[4:6]}{accent[2:4]}{accent[0:2]}"   # ASS の色は &HAABBGGRR
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,{family},72,&H00FFFFFF,{acc},&H00000000,&H78000000,-1,0,0,0,100,100,0,0,1,7,2,2,70,70,700,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    for sub in subs:
        text = re.sub(r"[。、]$", "", sub["text"].strip())
        if not text:
            continue
        chunks = [text[i:i + 26] for i in range(0, len(text), 26)]
        dur = (sub["end"] - sub["start"]) / len(chunks)
        for k, ch in enumerate(chunks):
            st = sub["start"] + k * dur
            body = ch if len(ch) <= 13 else ch[:13] + "\\N" + ch[13:]
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


def slide_in(start: float, x_end: int = 60, dur: float = 0.3) -> str:
    """左から滑り込む x 座標の式。"""
    return f"'if(lt(t-{start:.3f},{dur}),-w+(t-{start:.3f})/{dur}*(w+{x_end}),{x_end})'"


def build_reel(clip_paths: list[Path], prop: dict, brand: dict, work: Path,
               text_fn, transcriber=None) -> dict:
    """素材 → reel.mp4 と写真候補。

    text_fn(transcript) は投稿文の dict（hook を含む）を返す関数。字幕の文字起こしが
    終わってから呼ぶので、話した内容を投稿文に反映できる。
    transcriber は引数なしで呼ぶと文字起こし関数を返すもの（トークのときだけ読み込む）。
    """
    cfg = brand["reel"]
    work.mkdir(parents=True, exist_ok=True)
    warnings: list[str] = []

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

    labels = None
    if mode == "tour":
        frames = []
        for i, (a, b) in enumerate(segs):
            f = work / f"seg_{i:02d}.jpg"
            if grab_frame(full, (a + b) / 2, f):
                frames.append(f)
        if len(frames) == len(segs):
            labels = vision.label_scenes(frames, prop, brand.get("gemini_model", "gemini-2.5-flash"))
        parts = plan_tour(segs, labels, cfg)
        if labels is None:
            # AI が使えないときは、物件台帳の「おすすめポイント」を場面ごとに順番に出す
            points = [x.strip() for x in re.split(r"[、,\n／/・]", str(prop.get("points", ""))) if x.strip()]
            for p, pt in zip(parts[1:], points):
                p.caption = pt[:14]
            warnings.append("場面の自動判定ができなかったため、テロップは物件台帳のおすすめポイントを順に使いました")
    else:
        parts = plan_talk(total, silences, cfg)
    if not parts:
        parts = [Part(0.0, min(total, cfg["tour_target_seconds"]))]

    # 場面ごとに切り出し → つなぐ
    subs, transcript = [], ""
    if mode == "tour":
        files = []
        for k, p in enumerate(parts):
            f = work / f"part_{k:02d}.mp4"
            render_part(full, p, f)
            files.append(f)
        body = work / "body.mp4"
        starts = join_swipe(files, [p.dur for p in parts], body)
    else:
        body = work / "body.mp4"
        fc = []
        for k, p in enumerate(parts):
            fc.append(f"[0:v]trim=start={p.start:.3f}:end={p.end:.3f},setpts=PTS-STARTPTS[v{k}]")
            fc.append(f"[0:a]atrim=start={p.start:.3f}:end={p.end:.3f},asetpts=PTS-STARTPTS[a{k}]")
        fc.append("".join(f"[v{k}][a{k}]" for k in range(len(parts))) + f"concat=n={len(parts)}:v=1:a=1[v][a]")
        script = work / "talk.filter"
        script.write_text(";\n".join(fc), encoding="utf-8")
        run(["ffmpeg", "-y", "-i", str(full), "-filter_complex_script", str(script),
             "-map", "[v]", "-map", "[a]"] + ENC_FAST + [str(body)])
        starts = []
        if transcriber is not None:
            try:
                fn = transcriber()
                if fn:
                    subs = fn(body)
                    transcript = "".join(s["text"] for s in subs)
            except Exception as e:  # 字幕が作れなくても動画は作る
                log("文字起こしをスキップ:", e)
    body_dur = ffprobe(body)["duration"]

    texts = text_fn(transcript)
    hook = texts.get("hook") or graphics.headline(prop)

    # テロップを重ねる
    hs = parts[0].dur - XF if mode == "tour" else float(cfg["hook_seconds"])
    ov = [("hook.png", f"between(t,0,{hs:.2f})", "0", "0")]
    graphics.hook_overlay_v2(prop, hook, brand, work / "hook.png")
    graphics.brand_mark(brand, work / "brand.png")
    ov.append(("brand.png", f"gte(t,{hs:.2f})", "0", "0"))
    graphics.info_card(prop, brand, work / "info.png")
    last_start = starts[-1] if starts else max(hs, body_dur - 4)
    # 物件情報の札は最後の場面だけ（冒頭の大見出しにも家賃と間取りは出ている）
    end_t = body_dur - XF
    ov.append(("info.png", f"between(t,{last_start + XF:.2f},{end_t:.2f})", "0", "0"))
    if mode == "tour":
        for k, p in enumerate(parts[1:], start=1):
            if not (p.room or p.caption):
                continue
            name = f"label_{k:02d}.png"
            graphics.room_label(p.room, p.caption, brand, work / name)
            st = starts[k] + XF
            en = starts[k] + p.dur - XF
            ov.append((name, f"between(t,{st:.2f},{en:.2f})", slide_in(st), "1120"))
    cmd = ["ffmpeg", "-y", "-i", str(body)]
    for name, *_ in ov:
        cmd += ["-i", str(work / name)]
    fc, prev = [], "[0:v]"
    for k, (name, enable, x, y) in enumerate(ov, start=1):
        out = f"[o{k}]"
        fc.append(f"{prev}[{k}:v]overlay=x={x}:y={y}:enable='{enable}':eval=frame{out}")
        prev = out
    if mode == "talk" and subs:
        ass = write_ass(subs, work / "subs.ass", brand)
        fontsdir = str(Path(find_font(True)).parent)
        fc.append(f"{prev}subtitles=filename='{ass}':fontsdir='{fontsdir}'[vout]")
        prev = "[vout]"
    script = work / "overlay.filter"
    script.write_text(";\n".join(fc), encoding="utf-8")
    body_ov = work / "body_ov.mp4"
    maps = ["-map", prev] + (["-map", "0:a"] if mode == "talk" else [])
    run(cmd + ["-filter_complex_script", str(script)] + maps +
        (ENC_FAST if mode == "talk" else ENC_V) + [str(body_ov)])

    # 最後の画面
    hero_photo = work / "hero.jpg"
    grab_frame(full, (parts[0].start + parts[0].end) / 2, hero_photo)
    end_jpg = work / "endcard.jpg"
    graphics.endcard_v2(prop, brand, hero_photo, end_jpg)
    ec = float(cfg["endcard_seconds"])
    end_mp4 = work / "endcard.mp4"
    run(["ffmpeg", "-y", "-loop", "1", "-t", str(ec), "-i", str(end_jpg),
         "-vf", "scale=1080:1920,fps=30,format=yuv420p"] + ENC_V + [str(end_mp4)])

    # つないで音を付ける
    total_out = body_dur + ec - XF
    reel = work / "reel.mp4"
    bgm = pick_bgm(brand, str(prop.get("id", "")))
    cmd = ["ffmpeg", "-y", "-i", str(body_ov), "-i", str(end_mp4)]
    fc = f"[0:v][1:v]xfade=transition=fade:duration={XF}:offset={body_dur - XF:.3f},format=yuv420p[v]"
    if mode == "talk":
        if bgm:
            cmd += ["-stream_loop", "-1", "-i", str(bgm)]
            fc += (f";[0:a]apad[vo];[2:a]atrim=0:{total_out:.2f},asetpts=PTS-STARTPTS,"
                   f"volume={float(brand.get('bgm_volume', 0.18)) * 0.45}[bg];"
                   f"[vo][bg]amix=inputs=2:duration=longest:normalize=0,atrim=0:{total_out:.2f}[mx];"
                   "[mx]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]")
        else:
            fc += f";[0:a]apad,atrim=0:{total_out:.2f},loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]"
    elif bgm:
        cmd += ["-stream_loop", "-1", "-i", str(bgm)]
        fc += (f";[2:a]atrim=0:{total_out:.2f},asetpts=PTS-STARTPTS,"
               f"afade=t=in:st=0:d=0.5,afade=t=out:st={max(0, total_out - 1.2):.2f}:d=1.2,"
               "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]")
    else:
        warnings.append("BGMが入っていません（assets/bgm に曲を入れると自動で付きます）")
        cmd += ["-f", "lavfi", "-t", f"{total_out:.2f}", "-i", "anullsrc=r=48000:cl=stereo"]
        fc += ";[2:a]anull[a]"
    cmd += ["-filter_complex", fc, "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-profile:v", "high",
            "-maxrate", "12M", "-bufsize", "24M", "-pix_fmt", "yuv420p", "-r", "30",
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
            "-movflags", "+faststart", "-t", f"{total_out:.2f}", str(reel)]
    run(cmd)

    photos = pick_photos(clips, freezes, segs, work)
    meta = {"mode": mode, "speech_ratio": round(ratio, 3), "source_seconds": round(total, 1),
            "reel_seconds": round(ffprobe(reel)["duration"], 1), "segments": len(parts),
            "rooms": [p.room for p in parts], "photos": len(photos),
            "bgm": bgm.name if bgm else None, "subtitles": bool(subs),
            "cover_ms": int(min(1.2, hs * 0.6) * 1000)}
    (work / "edit.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    log("編集結果", meta)
    return {"reel": reel, "photos": photos, "transcript": transcript, "meta": meta,
            "endcard": end_jpg, "texts": texts, "warnings": warnings}


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
