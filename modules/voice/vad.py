"""Energy-based voice activity detection (MIT). Python stdlib only.

Pure functions over 16-bit little-endian mono PCM frames. No audio I/O here.

  frame_rms(frame)                 RMS of one frame (bytes of int16)
  find_utterances(frames, **kw)    list of (start, end) frame indexes, end exclusive
  Segmenter(**kw).feed(frame)      streaming form; returns finished utterance bytes or None

How it decides (all thresholds are parameters):
  - a frame is "voiced" when its RMS is above max(min_rms, noise_floor * ratio);
    the noise floor is a slow average of frames that were not voiced, so a steady
    hum raises the bar by itself
  - an utterance opens after `start_ms` of continuous voiced frames
  - it closes after `hangover_ms` of non-voiced frames (short pauses inside a
    sentence do not split it)
  - it is kept only if it holds at least `min_ms` of voiced frames (clicks are dropped)
  - it is cut at `max_ms` so a stuck noise source cannot grow without bound
  - `preroll_ms` of audio before the opening is included, so the first syllable survives
"""
from __future__ import annotations

import array
import math
import sys
from collections import deque
from typing import Iterable, Iterator, List, Optional, Tuple

RATE = 16000
FRAME_MS = 20
DEFAULTS = dict(frame_ms=FRAME_MS, min_rms=400.0, ratio=3.0, start_ms=60, hangover_ms=700,
                min_ms=250, max_ms=15000, preroll_ms=200, floor_alpha=0.05)


def frame_rms(frame: bytes) -> float:
    n = len(frame) // 2
    if n == 0:
        return 0.0
    a = array.array('h')
    a.frombytes(frame[:n * 2])
    if sys.byteorder == 'big':
        a.byteswap()
    return math.sqrt(sum(x * x for x in a) / n)


class _Core:
    """State machine shared by find_utterances and Segmenter. step(rms) -> event."""

    def __init__(self, **kw):
        p = dict(DEFAULTS); p.update(kw)
        f = p['frame_ms']
        self.min_rms, self.ratio, self.alpha = p['min_rms'], p['ratio'], p['floor_alpha']
        self.start_n = max(1, round(p['start_ms'] / f))
        self.hang_n = max(1, round(p['hangover_ms'] / f))
        self.min_n = max(1, round(p['min_ms'] / f))
        self.max_n = max(1, round(p['max_ms'] / f))
        self.pre_n = max(0, round(p['preroll_ms'] / f))
        self.floor = 0.0
        self.reset()

    def reset(self):
        self.i = 0               # index of the next frame
        self.run = 0             # consecutive voiced frames while idle
        self.active = False
        self.start = 0
        self.voiced = 0
        self.quiet = 0
        self.last_voiced = 0

    def step(self, rms: float):
        """-> None | ('end', start, end) with end exclusive. Call once per frame."""
        i = self.i; self.i += 1
        voiced = rms > max(self.min_rms, self.floor * self.ratio)
        if not voiced:
            self.floor += self.alpha * (rms - self.floor)
        if not self.active:
            self.run = self.run + 1 if voiced else 0
            if self.run >= self.start_n:
                self.active = True
                self.start = max(0, i - self.run + 1 - self.pre_n)
                self.voiced = self.run; self.quiet = 0; self.last_voiced = i
            return None
        if voiced:
            self.voiced += 1; self.quiet = 0; self.last_voiced = i
        else:
            self.quiet += 1
        if self.quiet >= self.hang_n or (i + 1 - self.start) >= self.max_n:
            return self._close(i + 1)
        return None

    def _close(self, end: int):
        ok = self.voiced >= self.min_n
        start = self.start
        self.active = False; self.run = 0; self.voiced = 0; self.quiet = 0
        return ('end', start, end) if ok else None

    def finish(self):
        if self.active:
            return self._close(self.i)
        return None


def find_utterances(frames: Iterable[bytes], **kw) -> List[Tuple[int, int]]:
    core = _Core(**kw)
    out: List[Tuple[int, int]] = []
    for fr in frames:
        ev = core.step(frame_rms(fr))
        if ev:
            out.append((ev[1], ev[2]))
    ev = core.finish()
    if ev:
        out.append((ev[1], ev[2]))
    return out


class Segmenter:
    """Streaming: feed frames, get finished utterances as raw PCM bytes.
    `last_start_frame` is the frame index where the last returned utterance began."""

    def __init__(self, **kw):
        self.core = _Core(**kw)
        self.kw = kw
        self.buf: deque = deque()   # (index, frame) from the oldest frame still needed
        self.last_start_frame = 0

    def reset(self):
        """Forget everything in flight (used while the mic is muted)."""
        self.core = _Core(**self.kw)
        self.buf.clear()

    def feed(self, frame: bytes) -> Optional[bytes]:
        idx = self.core.i
        self.buf.append((idx, frame))
        ev = self.core.step(frame_rms(frame))
        if ev:
            return self._emit(ev[1], ev[2])
        keep_from = self.core.start if self.core.active else idx - self.core.pre_n - self.core.start_n
        while self.buf and self.buf[0][0] < keep_from:
            self.buf.popleft()
        return None

    def flush(self) -> Optional[bytes]:
        ev = self.core.finish()
        return self._emit(ev[1], ev[2]) if ev else None

    def _emit(self, start: int, end: int) -> bytes:
        self.last_start_frame = start
        data = b''.join(f for i, f in self.buf if start <= i < end)
        self.buf.clear()
        return data


def chunk_frames(pcm: bytes, frame_ms: int = FRAME_MS, rate: int = RATE) -> Iterator[bytes]:
    size = rate * frame_ms // 1000 * 2
    for i in range(0, len(pcm) - size + 1, size):
        yield pcm[i:i + size]
