"""Sentence-by-sentence speech with prefetch (MIT). Stdlib only. Mirrors modules/voice-chat/pipeline.js.

Engine seam: two plain callables, no base class.
  synth(text) -> audio     any opaque value (here: wav bytes); may raise
  play(audio) -> None      returns when playback has ended; may raise
SpeechPipeline(synth, play, prefetch=2): push(sentence) queues in order; the first one starts at
once while the next `prefetch` are synthesized ahead. cancel() stops what is queued (a sentence
already playing is let finish unless play() itself checks `pipeline.cancelled()`), and a synth
result that arrives after cancel() is discarded. join() waits until the queue is drained.
"""
from __future__ import annotations

import collections
import concurrent.futures
import threading
from concurrent.futures import ThreadPoolExecutor


class SpeechPipeline:
    def __init__(self, synth, play, prefetch=2, on_error=None):
        self._synth, self._play = synth, play
        self.prefetch = max(0, int(prefetch))
        self._on_error = on_error or (lambda e, text: None)
        self._pool = ThreadPoolExecutor(max_workers=self.prefetch + 1)
        self._lock = threading.Lock()
        self._queue = collections.deque()   # [text, future|None]
        self._gen = 0
        self._current = False
        self._thread = None

    def cancelled(self, gen=None):
        return gen is not None and gen != self._gen

    def push(self, text):
        text = (text or '').strip()
        if not text:
            return
        with self._lock:
            self._queue.append([text, None])
            self._fill()
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, daemon=True)
                self._thread.start()

    def cancel(self):
        with self._lock:
            self._gen += 1
            for _, fut in self._queue:
                if fut is not None:
                    fut.cancel()
            self._queue.clear()

    def join(self, timeout=None):
        t = self._thread
        if t is not None:
            t.join(timeout)

    def pending(self):
        with self._lock:
            return len(self._queue) + (1 if self._current else 0)

    def _fill(self):  # lock held
        room = self.prefetch + (0 if self._current else 1)
        for item in list(self._queue)[:room]:
            if item[1] is None:
                item[1] = self._pool.submit(self._synth, item[0])

    def _wait(self, fut, gen):
        # A synth that never returns must not hold the loop past cancel(): poll the future and
        # give up on it once the generation moves on (the worker thread itself cannot be killed).
        while True:
            try:
                return fut.result(timeout=0.1)
            except concurrent.futures.TimeoutError:
                if gen != self._gen:
                    raise RuntimeError('cancelled')

    def _run(self):
        while True:
            with self._lock:
                if not self._queue:
                    self._thread = None
                    self._current = False
                    return
                gen = self._gen
                item = self._queue.popleft()
                self._current = True
                if item[1] is None:
                    item[1] = self._pool.submit(self._synth, item[0])
                self._fill()
            try:
                audio = self._wait(item[1], gen)
            except Exception as e:  # synth failed or was cancelled: skip this sentence
                if gen == self._gen:
                    self._on_error(e, item[0])
                continue
            if gen != self._gen:
                continue
            try:
                self._play(audio)
            except Exception as e:
                self._on_error(e, item[0])
