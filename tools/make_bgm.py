"""著作権の心配がないオリジナルBGMを作曲して assets/bgm/ に書き出す。

  python tools/make_bgm.py

コード進行・ドラム・ベース・和音を数式で合成し、ffmpeg で残響と音量をそろえる。
もっと良い曲があれば assets/bgm/ に入れ替えるだけで使われる。
"""
from __future__ import annotations

import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np

SR = 44100
OUT = Path(__file__).resolve().parent.parent / "assets" / "bgm"
NOTE = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
QUAL = {"maj7": [0, 4, 7, 11], "m7": [0, 3, 7, 10], "7": [0, 4, 7, 10], "maj": [0, 4, 7], "m": [0, 3, 7],
        "add9": [0, 4, 7, 14], "m9": [0, 3, 7, 10, 14]}


def hz(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def chord(name: str, octave: int = 4) -> list[int]:
    root = name[:2] if len(name) > 1 and name[1] == "#" else name[:1]
    q = name[len(root):] or "maj"
    base = 12 * (octave + 1) + NOTE[root]
    return [base + i for i in QUAL[q]]


def env(n: int, a: float, d: float, s: float, r: float) -> np.ndarray:
    a_n, d_n, r_n = int(a * SR), int(d * SR), int(r * SR)
    s_n = max(0, n - a_n - d_n - r_n)
    e = np.concatenate([np.linspace(0, 1, a_n, False), np.linspace(1, s, d_n, False), np.full(s_n, s),
                        np.linspace(s, 0, r_n)])
    return np.pad(e, (0, max(0, n - len(e))))[:n]


def keys(freq: float, dur: float, bright: float = 0.35) -> np.ndarray:
    """エレピ風の音（倍音を少しずつ減衰させる）。"""
    t = np.arange(int(dur * SR)) / SR
    tone = np.sin(2 * np.pi * freq * t) + bright * np.sin(2 * np.pi * 2 * freq * t) * np.exp(-t * 3) \
        + 0.15 * np.sin(2 * np.pi * 3 * freq * t) * np.exp(-t * 6)
    return tone * env(len(t), 0.01, 0.6, 0.45, min(0.4, dur * 0.3))


def pad(freq: float, dur: float) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    tone = sum(np.sin(2 * np.pi * freq * (1 + d) * t) for d in (-0.004, 0, 0.004)) / 3
    return tone * env(len(t), 0.4, 0.3, 0.8, 0.6)


def pluck(freq: float, dur: float) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    saw = 2 * ((freq * t) % 1) - 1
    soft = np.convolve(saw, np.ones(12) / 12, "same")      # 角を丸める
    return soft * np.exp(-t * 7)


def kick(dur=0.35):
    t = np.arange(int(dur * SR)) / SR
    f = 110 * np.exp(-t * 18) + 45
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)


def snare(dur=0.2, rng=np.random.default_rng(1)):
    t = np.arange(int(dur * SR)) / SR
    noise = rng.uniform(-1, 1, len(t))
    return (0.7 * noise + 0.3 * np.sin(2 * np.pi * 190 * t)) * np.exp(-t * 22)


def hat(dur=0.06, rng=np.random.default_rng(2)):
    t = np.arange(int(dur * SR)) / SR
    noise = rng.uniform(-1, 1, len(t))
    noise = noise - np.convolve(noise, np.ones(6) / 6, "same")   # 高い音だけ残す
    return noise * np.exp(-t * 60)


def place(buf: np.ndarray, sig: np.ndarray, at: float, gain: float):
    i = int(at * SR)
    if i >= len(buf):
        return
    j = min(len(buf), i + len(sig))
    buf[i:j] += sig[: j - i] * gain


def song(prog: list[str], bpm: int, bars: int, style: str) -> np.ndarray:
    beat = 60 / bpm
    total = bars * 4 * beat
    mix = np.zeros(int((total + 2) * SR))
    for b in range(bars):
        name = prog[b % len(prog)]
        t0 = b * 4 * beat
        notes = chord(name, 4)
        bass = hz(chord(name, 2)[0])
        if style == "lofi":
            for n in notes:
                place(mix, keys(hz(n), 4 * beat * 0.95), t0 + 0.012 * notes.index(n), 0.12)
            for k, at in enumerate([0, 2.5]):
                place(mix, keys(bass, beat * 1.4, 0.1), t0 + at * beat, 0.22)
            for at in (0, 1.75, 2.5):
                place(mix, kick(), t0 + at * beat, 0.55)
            for at in (1, 3):
                place(mix, snare(), t0 + at * beat, 0.18)
            for i in range(8):
                place(mix, hat(), t0 + (i * 0.5 + (0.04 if i % 2 else 0)) * beat, 0.08)
        elif style == "bright":
            for n in notes:
                place(mix, pad(hz(n), 4 * beat), t0, 0.05)
            arp = notes + [notes[1] + 12]
            for i in range(8):
                place(mix, pluck(hz(arp[i % len(arp)] + 12), beat * 0.6), t0 + i * 0.5 * beat, 0.11)
            for at in (0, 1, 2, 3):
                place(mix, kick(), t0 + at * beat, 0.42)
                place(mix, keys(bass, beat * 0.9, 0.05), t0 + at * beat, 0.18)
            for at in (1, 3):
                place(mix, snare(), t0 + at * beat, 0.22)
            for i in range(16):
                place(mix, hat(), t0 + i * 0.25 * beat, 0.05 if i % 2 else 0.08)
        else:  # house
            for n in notes:
                place(mix, pad(hz(n), 4 * beat), t0, 0.06)
            for i in range(4):
                place(mix, kick(), t0 + i * beat, 0.5)
                place(mix, hat(0.09), t0 + (i + 0.5) * beat, 0.11)
                place(mix, keys(bass, beat * 0.45, 0.05), t0 + (i + 0.5) * beat, 0.2)
            for i, n in enumerate([0, 2, 1, 3, 2, 1, 0, 3]):
                place(mix, keys(hz(notes[n % len(notes)] + 12), beat * 0.4, 0.5), t0 + (i * 0.5 + 0.25) * beat, 0.07)
    # 最初と最後をなめらかに
    fade = int(0.8 * SR)
    mix[:fade] *= np.linspace(0, 1, fade)
    end = int(total * SR)
    mix[end - fade:end] *= np.linspace(1, 0, fade)
    mix = mix[:end]
    return mix / (np.max(np.abs(mix)) + 1e-9) * 0.8


def write(name: str, mono: np.ndarray):
    OUT.mkdir(parents=True, exist_ok=True)
    stereo = np.stack([mono, np.roll(mono, int(0.012 * SR)) * 0.96], axis=1)   # 少しだけ左右に広げる
    with tempfile.TemporaryDirectory() as td:
        wav = Path(td) / "a.wav"
        with wave.open(str(wav), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes((stereo * 32767).astype("<i2").tobytes())
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-af",
                        "aecho=0.8:0.6:45|90:0.22|0.14,lowpass=f=9000,loudnorm=I=-16:TP=-1.5",
                        "-c:a", "libmp3lame", "-b:a", "192k", str(OUT / name)], check=True)


if __name__ == "__main__":
    write("original_01_lofi.mp3", song(["Fmaj7", "Em7", "Dm7", "Cmaj7"], 84, 16, "lofi"))
    write("original_02_bright.mp3", song(["Cadd9", "G", "Am", "Fmaj7"], 108, 20, "bright"))
    write("original_03_house.mp3", song(["Am", "Fmaj7", "C", "G"], 120, 22, "house"))
    print("wrote", sorted(p.name for p in OUT.glob("original_*.mp3")))
