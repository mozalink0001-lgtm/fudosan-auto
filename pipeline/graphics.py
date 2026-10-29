"""テロップ・物件カード・カルーセル・ストーリーズの画像を Pillow で描く。"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps, ImageEnhance

from .util import ROOT, find_font, walk_minutes, yen_short

W, H = 1080, 1920          # リール・ストーリーズ
CW, CH = 1080, 1350        # カルーセル (4:5)

_font_cache: dict[tuple[int, bool], ImageFont.FreeTypeFont] = {}


def font(size: int, heavy: bool = False) -> ImageFont.FreeTypeFont:
    if (size, heavy) not in _font_cache:
        _font_cache[(size, heavy)] = ImageFont.truetype(find_font(heavy), size)
    return _font_cache[(size, heavy)]


def hex_rgba(h: str, a: int = 255) -> tuple[int, int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a


NO_START = set("、。，．・：；？！ー－～」』）】〕ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々分円万帖畳㎡m%")
GOOD_AFTER = set("、。！？｜・ 　をにではがとのへもや")


def _kind(ch: str) -> str:
    o = ord(ch)
    if ch.isascii() and (ch.isalnum() or ch in ".,"):
        return "a"
    if 0x30A0 <= o <= 0x30FF:
        return "k"   # カタカナ
    return "o"


def _is_kanji(ch: str) -> bool:
    return 0x4E00 <= ord(ch) <= 0x9FFF


def _can_break(text: str, i: int) -> bool:
    """text[i-1] と text[i] の間で改行してよいか。"""
    a, b = text[i - 1], text[i]
    if b in NO_START:
        return False
    if _kind(a) == _kind(b) and _kind(a) in ("a", "k"):
        return False   # 英数字・カタカナの途中では切らない
    return True


def wrap(draw: ImageDraw.ImageDraw, text: str, f, max_w: int) -> list[str]:
    """日本語の折り返し。助詞や句読点の後ろを優先し、単語・数字+単位の途中では切らない。"""
    lines: list[str] = []
    for para in str(text).split("\n"):
        if draw.textlength(para, font=f) <= max_w:
            lines.append(para)
            continue
        # 必要な行数で均等に近くなるよう、1行の目標幅を決める
        n = int(draw.textlength(para, font=f) // max_w) + 1
        target = draw.textlength(para, font=f) / n
        start = 0
        while start < len(para):
            rest = para[start:]
            if draw.textlength(rest, font=f) <= max_w:
                lines.append(rest)
                break
            best, best_score = None, None
            for i in range(start + 1, len(para)):
                w = draw.textlength(para[start:i], font=f)
                if w > max_w:
                    break
                if not _can_break(para, i):
                    continue
                score = abs(w - target) - (target * 0.35 if para[i - 1] in GOOD_AFTER else 0)
                if _is_kanji(para[i - 1]) and _is_kanji(para[i]):
                    score += target * 0.3   # 熟語の途中はなるべく避ける
                if best_score is None or score < best_score:
                    best, best_score = i, score
            if best is None:  # どうしても切れないときは幅いっぱいで切る
                best = start + 1
                while best < len(para) and draw.textlength(para[start:best + 1], font=f) <= max_w:
                    best += 1
            lines.append(para[start:best])
            start = best
    return lines


def text_block(draw, xy, text, size, fill, max_w, line_gap=1.3, align="left", stroke=0, stroke_fill=None):
    f = font(size)
    x, y = xy
    for line in wrap(draw, text, f, max_w):
        lw = draw.textlength(line, font=f)
        lx = x + (max_w - lw) / 2 if align == "center" else x
        draw.text((lx, y), line, font=f, fill=fill, stroke_width=stroke, stroke_fill=stroke_fill)
        y += int(size * line_gap)
    return y


def headline(prop: dict) -> str:
    """'7.8万円｜1LDK｜○○駅 徒歩8分' のような1行の要約。"""
    parts = []
    if prop.get("price"):
        parts.append(yen_short(prop["price"]))
    if prop.get("layout"):
        parts.append(str(prop["layout"]))
    st = prop.get("station")
    wm = walk_minutes(prop.get("station_m"))
    if st:
        parts.append(f"{st} 徒歩{wm}分" if wm else str(st))
    return "｜".join(parts)


def _store_mark(draw, brand, x, y, size=30, fill=(255, 255, 255, 230)):
    draw.text((x, y), brand.get("store_name", ""), font=font(size), fill=fill,
              stroke_width=2, stroke_fill=(0, 0, 0, 120))


def _paste_logo(img: Image.Image, brand: dict, box_h: int, xy: tuple[int, int]) -> bool:
    p = ROOT / brand.get("logo", "")
    if not brand.get("logo") or not p.is_file():
        return False
    logo = Image.open(p).convert("RGBA")
    ratio = box_h / logo.height
    logo = logo.resize((int(logo.width * ratio), box_h), Image.LANCZOS)
    img.alpha_composite(logo, xy)
    return True


# ---------- リール用オーバーレイ（透過PNG） ----------

def hook_overlay(prop: dict, hook: str, brand: dict, out: Path):
    c = brand["colors"]
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 上部に大きなフック
    pad = 64
    f = font(92)
    lines = wrap(d, hook, f, W - pad * 2 - 40)
    box_h = len(lines) * int(92 * 1.25) + 60
    top = 300
    d.rounded_rectangle((pad, top, W - pad, top + box_h), radius=28, fill=hex_rgba(c["primary"], 235))
    y = top + 30
    for line in lines:
        lw = d.textlength(line, font=f)
        d.text(((W - lw) / 2, y), line, font=f, fill=hex_rgba(c["primary_text"]))
        y += int(92 * 1.25)
    # その下に要約
    sub = headline(prop)
    if sub:
        sf = font(46)
        sw = d.textlength(sub, font=sf)
        sx = (W - min(sw, W - 2 * pad)) / 2
        d.rounded_rectangle((sx - 24, top + box_h + 20, sx + min(sw, W - 2 * pad) + 24, top + box_h + 100),
                            radius=20, fill=hex_rgba(c["dark"], 200))
        text_block(d, (sx, top + box_h + 34), sub, 46, hex_rgba(c["accent"]), W - 2 * pad)
    img.save(out)


def info_overlay(prop: dict, brand: dict, out: Path):
    """動画の下部に常に出す物件情報と店舗名。"""
    c = brand["colors"]
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    line = headline(prop)
    if line:
        f = font(44)
        lw = min(d.textlength(line, font=f), W - 120)
        x0 = (W - lw) / 2 - 28
        y0 = H - 600
        d.rounded_rectangle((x0, y0, x0 + lw + 56, y0 + 84), radius=42, fill=hex_rgba(c["dark"], 190))
        text_block(d, (x0 + 28, y0 + 14), line, 44, hex_rgba("#FFFFFF"), int(lw) + 4)
    if not _paste_logo(img, brand, 64, (48, 140)):
        _store_mark(d, brand, 52, 150, 34)
    img.save(out)


def endcard(prop: dict, brand: dict, bg_frame: Path | None, out: Path):
    c = brand["colors"]
    if bg_frame and bg_frame.exists():
        bg = ImageOps.fit(Image.open(bg_frame).convert("RGB"), (W, H))
        bg = bg.filter(ImageFilter.GaussianBlur(28))
        bg = ImageEnhance.Brightness(bg).enhance(0.45).convert("RGBA")
    else:
        bg = Image.new("RGBA", (W, H), hex_rgba(c["dark"]))
    d = ImageDraw.Draw(bg)
    pad = 90
    y = 560
    y = text_block(d, (pad, y), brand["cta_title"], 64, hex_rgba("#FFFFFF"), W - pad * 2, align="center")
    y = text_block(d, (pad, y + 10), brand["cta_body"], 56, hex_rgba(c["accent"]), W - pad * 2, align="center")
    # LINE ボタン風
    by = y + 70
    d.rounded_rectangle((pad + 60, by, W - pad - 60, by + 150), radius=75, fill=hex_rgba(c["primary"]))
    text_block(d, (pad + 60, by + 40), f"LINE  {brand.get('line_id', '')}", 60,
               hex_rgba(c["primary_text"]), W - pad * 2 - 120, align="center")
    foot = legal_footer(prop)
    text_block(d, (pad, H - 330), foot, 34, hex_rgba("#FFFFFF", 220), W - pad * 2, align="center")
    bg.convert("RGB").save(out, quality=95)


def legal_footer(prop: dict) -> str:
    bits = []
    if prop.get("deal_type"):
        bits.append(f"取引態様：{prop['deal_type']}")
    if prop.get("updated"):
        bits.append(f"{prop['updated']}時点の情報")
    return "　".join(bits)


# ---------- 静止画（カルーセル・ストーリーズ） ----------

def enhance_photo(img: Image.Image) -> Image.Image:
    img = ImageOps.autocontrast(img.convert("RGB"), cutoff=1)
    img = ImageEnhance.Brightness(img).enhance(1.04)
    img = ImageEnhance.Color(img).enhance(1.06)
    return img


def carousel_cover(photo: Path, prop: dict, title: str, brand: dict, out: Path):
    c = brand["colors"]
    img = ImageOps.fit(enhance_photo(Image.open(photo)), (CW, CH)).convert("RGBA")
    shade = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    for i in range(520):  # 下からのグラデーション
        a = int(215 * ((520 - i) / 520) ** 1.2)
        sd.line([(0, CH - i), (CW, CH - i)], fill=(0, 0, 0, a))
    img = Image.alpha_composite(img, shade)
    d = ImageDraw.Draw(img)
    pad = 72
    tf = font(80)
    lines = wrap(d, title, tf, CW - pad * 2)
    y = CH - 120 - len(lines) * int(80 * 1.25) - 90
    d.rounded_rectangle((pad, y - 74, pad + 260, y - 14), radius=30, fill=hex_rgba(c["accent"]))
    d.text((pad + 30, y - 68), "ROOM TOUR", font=font(36), fill=hex_rgba(c["dark"]))
    for line in lines:
        d.text((pad, y), line, font=tf, fill=(255, 255, 255, 255))
        y += int(80 * 1.25)
    text_block(d, (pad, y + 10), headline(prop), 44, hex_rgba(c["accent"]), CW - pad * 2)
    _store_mark(d, brand, pad, 60, 32)
    img.convert("RGB").save(out, quality=94)


def carousel_photo(photo: Path, brand: dict, out: Path, label: str | None = None):
    img = ImageOps.fit(enhance_photo(Image.open(photo)), (CW, CH)).convert("RGBA")
    d = ImageDraw.Draw(img)
    if label:
        f = font(40)
        lw = d.textlength(label, font=f)
        d.rounded_rectangle((48, 48, 48 + lw + 48, 120), radius=36, fill=(0, 0, 0, 150))
        d.text((72, 58), label, font=f, fill=(255, 255, 255, 255))
    _store_mark(d, brand, CW - 40 - int(d.textlength(brand.get("store_name", ""), font=font(28))), CH - 70, 28)
    img.convert("RGB").save(out, quality=94)


def carousel_info(prop: dict, brand: dict, out: Path):
    c = brand["colors"]
    img = Image.new("RGB", (CW, CH), hex_rgba(c["light"])[:3])
    d = ImageDraw.Draw(img)
    pad = 80
    d.text((pad, 90), "物件概要", font=font(72), fill=hex_rgba(c["dark"])[:3])
    d.rectangle((pad, 190, pad + 120, 198), fill=hex_rgba(c["primary"])[:3])
    kind_label = "価格" if str(prop.get("kind", "")).startswith("売") else "賃料"
    wm = walk_minutes(prop.get("station_m"))
    rows = [
        (kind_label, yen_short(prop["price"]) if prop.get("price") else ""),
        ("管理費等", yen_short(prop["admin_fee"]) if prop.get("admin_fee") else ""),
        ("間取り", prop.get("layout", "")),
        ("専有面積", f"{prop['area_m2']}㎡" if prop.get("area_m2") else ""),
        ("交通", f"{prop.get('station', '')} 徒歩{wm}分" if wm else prop.get("station", "")),
        ("所在地", prop.get("address", "")),
        ("築年月", prop.get("built", "")),
        ("取引態様", prop.get("deal_type", "")),
    ]
    y = 260
    for k, v in rows:
        if not v:
            continue
        d.text((pad, y), k, font=font(40), fill=hex_rgba(c["primary"])[:3])
        y2 = text_block(d, (pad + 260, y), str(v), 44, hex_rgba(c["dark"])[:3], CW - pad * 2 - 260)
        y = max(y + 70, y2) + 18
        d.line((pad, y - 12, CW - pad, y - 12), fill=(210, 214, 212), width=2)
    if prop.get("updated"):
        d.text((pad, CH - 110), f"{prop['updated']}時点の情報です。最新の空室状況はお問い合わせください。",
               font=font(28), fill=(110, 118, 114))
    img.save(out, quality=95)


def carousel_cta(brand: dict, out: Path):
    c = brand["colors"]
    img = Image.new("RGB", (CW, CH), hex_rgba(c["primary"])[:3])
    d = ImageDraw.Draw(img)
    pad = 90
    y = text_block(d, (pad, 360), brand["cta_title"], 70, (255, 255, 255), CW - pad * 2, align="center")
    y = text_block(d, (pad, y + 20), brand["cta_body"], 54, hex_rgba(c["accent"])[:3], CW - pad * 2, align="center")
    d.rounded_rectangle((pad + 40, y + 80, CW - pad - 40, y + 220), radius=70, fill=(255, 255, 255))
    text_block(d, (pad + 40, y + 118), f"LINE  {brand.get('line_id', '')}", 58,
               hex_rgba(c["primary"])[:3], CW - pad * 2 - 80, align="center")
    text_block(d, (pad, CH - 200), "保存しておくと内見のときに見返せます", 38, (255, 255, 255), CW - pad * 2, align="center")
    img.save(out, quality=95)


def story_image(photo: Path, prop: dict, brand: dict, out: Path):
    c = brand["colors"]
    img = ImageOps.fit(enhance_photo(Image.open(photo)), (W, H)).convert("RGBA")
    shade = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    for i in range(900):
        sd.line([(0, H - i), (W, H - i)], fill=(0, 0, 0, int(205 * ((900 - i) / 900) ** 1.1)))
    img = Image.alpha_composite(img, shade)
    d = ImageDraw.Draw(img)
    pad = 80
    d.rounded_rectangle((pad, 1060, pad + 300, 1140), radius=40, fill=hex_rgba(c["accent"]))
    d.text((pad + 52, 1072), "新着物件", font=font(48), fill=hex_rgba(c["dark"]))
    y = text_block(d, (pad, 1180), headline(prop), 64, (255, 255, 255, 255), W - pad * 2)
    y = text_block(d, (pad, y + 30), "▶ 部屋の中は最新のリールでチェック", 46, hex_rgba(c["accent"]), W - pad * 2)
    text_block(d, (pad, y + 20), "間取り図・初期費用はプロフィールのLINEから", 40, (255, 255, 255, 230), W - pad * 2)
    _store_mark(d, brand, pad, 200, 34)
    img.convert("RGB").save(out, quality=94)


# ---------- リール v2（よく見られている不動産リールの型に合わせたテロップ） ----------
# 画面の安全域: Instagram の UI（右のボタン・下の説明文）に隠れないよう、
# 文字は x=60〜940、y=250〜1500 に収める。プロフィールの一覧は中央の 4:5（y=285〜1635）だけ見える。

def _stroke_text(d, xy, text, f, fill, stroke=10, stroke_fill=(0, 0, 0, 255), anchor="la"):
    d.text(xy, text, font=f, fill=fill, stroke_width=stroke, stroke_fill=stroke_fill, anchor=anchor)


def hook_overlay_v2(prop: dict, hook: str, brand: dict, out: Path):
    """冒頭2〜3秒の大見出し。一覧のサムネイルにもなるので画面の中央寄りに置く。"""
    c = brand["colors"]
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    badge = "ROOM TOUR" + (f"｜{prop['station']}" if prop.get("station") else "")
    bf = font(40, True)
    bw = d.textlength(badge, font=bf)
    d.rounded_rectangle(((W - bw) / 2 - 30, 560, (W + bw) / 2 + 30, 630), radius=35, fill=hex_rgba(c["accent"]))
    d.text((W / 2, 595), badge, font=bf, fill=hex_rgba(c["dark"]), anchor="mm")
    hf = font(112, True)
    sf = font(52, True)
    rows = [(line, hf, (255, 255, 255, 255), 12, 132) for line in wrap(d, hook, hf, W - 120)[:2]]
    sub = headline(prop)
    price = yen_short(prop["price"]) if prop.get("price") else ""
    if price and price in hook:   # 見出しに家賃が入っているときは、下の行は駅と徒歩だけにする
        wm = walk_minutes(prop.get("station_m"))
        sub = f"{prop.get('station', '')} 徒歩{wm}分" if wm else str(prop.get("station", ""))
    if sub:
        rows += [(line, sf, hex_rgba(c["accent"]), 8, 66) for line in wrap(d, sub, sf, W - 140)[:2]]
    # 明るい部屋でも読めるよう、文字の形にぼかした影を敷く
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    y = 690
    for line, f, _, st, step in rows:
        sd.text((W / 2, y + 8), line, font=f, fill=(0, 0, 0, 200), stroke_width=st + 6, stroke_fill=(0, 0, 0, 200),
                anchor="ma")
        y += step
    img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(14)))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle(((W - bw) / 2 - 30, 560, (W + bw) / 2 + 30, 630), radius=35, fill=hex_rgba(c["accent"]))
    d.text((W / 2, 595), badge, font=bf, fill=hex_rgba(c["dark"]), anchor="mm")
    y = 690
    for line, f, fill, st, step in rows:
        _stroke_text(d, (W / 2, y), line, f, fill, st, anchor="ma")
        y += step
    img.save(out)


def room_label(room: str, caption: str, brand: dict, out: Path) -> tuple[int, int]:
    """場面ごとの部屋名テロップ（左から滑り込む札）。画像の大きさを返す。"""
    c = brand["colors"]
    rf, cf = font(58, True), font(46, True)
    tmp = ImageDraw.Draw(Image.new("RGBA", (10, 10)))
    room = room or caption
    cap = caption if caption and caption != room else ""
    rw = tmp.textlength(room, font=rf)
    cw = tmp.textlength(cap, font=cf) if cap else 0
    w = int(rw + 64 + (cw + 48 if cap else 0))
    h = 104
    img = Image.new("RGBA", (w + 12, h + 12), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((8, 8, w + 8, h + 8), radius=20, fill=(0, 0, 0, 70))          # 影
    d.rounded_rectangle((0, 0, w, h), radius=20, fill=hex_rgba(c["primary"]))
    d.text((32, h / 2), room, font=rf, fill=(255, 255, 255, 255), anchor="lm")
    if cap:
        x = rw + 64
        d.rounded_rectangle((x - 8, 0, w, h), radius=20, fill=(255, 255, 255, 245))
        d.rectangle((x - 8, 0, x + 12, h), fill=(255, 255, 255, 245))
        d.text((x + 16, h / 2), cap, font=cf, fill=hex_rgba(c["dark"]), anchor="lm")
    img.save(out)
    return img.size


def info_card(prop: dict, brand: dict, out: Path, y0: int = 230):
    """家賃・間取り・駅の札。最後の場面でだけ、画面の上側に出す（下側はナレーション字幕）。"""
    c = brand["colors"]
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x0, x1 = 60, 940
    y1 = y0 + 250
    d.rounded_rectangle((x0 + 8, y0 + 10, x1 + 8, y1 + 10), radius=28, fill=(0, 0, 0, 80))
    d.rounded_rectangle((x0, y0, x1, y1), radius=28, fill=(255, 255, 255, 245))
    d.rounded_rectangle((x0, y0, x1, y0 + 64), radius=28, fill=hex_rgba(c["primary"]))
    d.rectangle((x0, y0 + 36, x1, y0 + 64), fill=hex_rgba(c["primary"]))
    kind = "価格" if str(prop.get("kind", "")).startswith("売") else "家賃"
    d.text((x0 + 36, y0 + 32), f"{kind}・物件情報", font=font(34, True), fill=(255, 255, 255, 255), anchor="lm")
    price = yen_short(prop["price"]) if prop.get("price") else ""
    pf = font(92, True)
    d.text((x0 + 36, y0 + 150), price, font=pf, fill=hex_rgba(c["dark"]), anchor="ls")
    if prop.get("admin_fee"):
        d.text((x0 + 52 + d.textlength(price, font=pf), y0 + 146), f"＋管理費等 {yen_short(prop['admin_fee'])}",
               font=font(32, True), fill=(90, 98, 94), anchor="ls")
    wm = walk_minutes(prop.get("station_m"))
    line2 = "｜".join(x for x in [str(prop.get("layout", "")),
                                 f"{prop['area_m2']}㎡" if prop.get("area_m2") else "",
                                 f"{prop.get('station', '')} 徒歩{wm}分" if wm else str(prop.get("station", ""))] if x)
    lf = font(42, True)
    if d.textlength(line2, font=lf) > x1 - x0 - 72:
        lf = font(34, True)
    d.text((x0 + 36, y0 + 214), line2, font=lf, fill=hex_rgba(c["dark"]), anchor="ls")
    img.save(out)


def brand_mark(brand: dict, out: Path):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    if not _paste_logo(img, brand, 56, (48, 150)):
        d = ImageDraw.Draw(img)
        _stroke_text(d, (52, 156), brand.get("store_name", ""), font(36, True), (255, 255, 255, 235), 4,
                     (0, 0, 0, 150))
    img.save(out)


def endcard_v2(prop: dict, brand: dict, photo: Path | None, out: Path):
    """最後の2.5秒。保存とLINEを促す。"""
    c = brand["colors"]
    if photo and photo.exists():
        bg = ImageOps.fit(Image.open(photo).convert("RGB"), (W, H)).filter(ImageFilter.GaussianBlur(18))
        bg = Image.blend(bg, Image.new("RGB", (W, H), hex_rgba(c["primary"])[:3]), 0.72).convert("RGBA")
    else:
        bg = Image.new("RGBA", (W, H), hex_rgba(c["primary"]))
    d = ImageDraw.Draw(bg)
    d.text((W / 2, 520), "この部屋が気になったら", font=font(54, True), fill=(255, 255, 255, 230), anchor="ma")
    y = 610
    for line in wrap(d, brand["cta_title"].rstrip("は"), font(84, True), W - 140):
        _stroke_text(d, (W / 2, y), line, font(84, True), (255, 255, 255, 255), 0, anchor="ma")
        y += 104
    _stroke_text(d, (W / 2, y + 10), "無料でLINEにお送りします", font(60, True), hex_rgba(c["accent"]), 0, anchor="ma")
    by = y + 150
    d.rounded_rectangle((150, by, W - 150, by + 150), radius=75, fill=(255, 255, 255, 255))
    d.text((W / 2, by + 75), f"LINE  {brand.get('line_id', '')}", font=font(62, True), fill=hex_rgba(c["primary"]),
           anchor="mm")
    d.text((W / 2, by + 210), "プロフィールのリンクから友だち追加", font=font(40, True), fill=(255, 255, 255, 235),
           anchor="ma")
    d.text((W / 2, by + 300), "保存して内見のときに見返せます", font=font(38),
           fill=(255, 255, 255, 210), anchor="ma")
    foot = legal_footer(prop)
    if foot:
        d.text((W / 2, H - 330), foot, font=font(32), fill=(255, 255, 255, 200), anchor="ma")
    bg.convert("RGB").save(out, quality=95)
