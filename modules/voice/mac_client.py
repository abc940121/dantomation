"""Mac thin client for bridge.py (MIT). Stdlib only.

Per turn: utterance wav -> local Qwen3-ASR (mlx_audio server) -> POST text to the text target
-> speak each returned sentence with local Qwen3-TTS (mlx_audio) or macOS `say` as fallback.

handle_utterance(wav_path) takes one finished utterance. For hands-free use, `--listen` cuts continuous
mic audio into utterances with the energy VAD in vad.py (no push-to-talk). The wake phrase is NOT here:
with TEXT_TARGET=voice-chat the desktop module modules/voice-chat decides what to answer.
Quick test without a mic:  python3 mac_client.py --text "hello"

Text target (where ASR text goes), env TEXT_TARGET:
  turn         (default) POST {BRIDGE_URL}/turn, talks to Claude directly. Unchanged behaviour.
  voice-chat   POST {VOICE_CHAT_URL}/m/voice-chat/utterance {text, spokenAt}; also reports playback
               start/end to /m/voice-chat/playback and polls /m/voice-chat/poll for new approval cards.

Env:
  BRIDGE_URL    e.g. http://100.x.y.z:8790 (desktop Tailscale IP)
  BRIDGE_TOKEN  contents of state/voice-bridge-token.txt on the desktop
  TEXT_TARGET   turn | voice-chat (default turn)
  VOICE_CHAT_URL    server base for voice-chat, default http://127.0.0.1:7420
  VOICE_CHAT_TOKEN  bearer token for that server (empty = none; localhost needs none)
  VOICE_CAPTURE_CMD command that writes 16 kHz mono s16le raw PCM to stdout (default: sox `rec`)
  ASR_URL       default http://127.0.0.1:8001/v1/audio/transcriptions (OpenAI-style, mlx_audio)
  TTS_URL       default http://127.0.0.1:8001/v1/audio/speech; "say" = macOS say only
  ASR_MODEL / TTS_MODEL  model ids your mlx_audio server expects
  Install pins (THIRD_PARTY.md): hf download <id> --revision <commit> before starting mlx_audio.
"""
from __future__ import annotations

import json
import os
import queue
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid
import wave

from speech_pipeline import SpeechPipeline

BRIDGE_URL = os.environ.get('BRIDGE_URL', 'http://127.0.0.1:8790')
BRIDGE_TOKEN = os.environ.get('BRIDGE_TOKEN', '')
ASR_URL = os.environ.get('ASR_URL', 'http://127.0.0.1:8001/v1/audio/transcriptions')
ASR_MODEL = os.environ.get('ASR_MODEL', 'mlx-community/Qwen3-ASR-1.7B-8bit')
TTS_URL = os.environ.get('TTS_URL', 'http://127.0.0.1:8001/v1/audio/speech')
TTS_MODEL = os.environ.get('TTS_MODEL', 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit')

PREFETCH = int(os.environ.get('TTS_PREFETCH', '2'))  # sentences synthesized ahead (voice-chat target)
TAIL_S = 0.3  # the mic stays deaf this long after TTS ends
RATE = 16000
FRAME_MS = 20
CAPTURE_CMD = os.environ.get('VOICE_CAPTURE_CMD', 'rec -q -t raw -r 16000 -e signed-integer -b 16 -c 1 -')


def resolve_target(env=None) -> dict:
    """Where ASR text goes. Pure: reads only `env` (default os.environ).
    -> {kind, base, url, headers}; kind is 'turn' (default) or 'voice-chat'."""
    env = os.environ if env is None else env
    kind = (env.get('TEXT_TARGET') or 'turn').strip().lower()
    hdr = {'Content-Type': 'application/json; charset=utf-8'}
    if kind == 'voice-chat':
        base = (env.get('VOICE_CHAT_URL') or 'http://127.0.0.1:7420').rstrip('/')
        if env.get('VOICE_CHAT_TOKEN'):
            hdr['Authorization'] = 'Bearer ' + env['VOICE_CHAT_TOKEN']
        return {'kind': kind, 'base': base, 'url': base + '/m/voice-chat/utterance', 'headers': hdr}
    if kind != 'turn':
        raise ValueError(f'TEXT_TARGET must be turn or voice-chat, got {kind!r}')
    base = (env.get('BRIDGE_URL') or 'http://127.0.0.1:8790').rstrip('/')
    hdr['Authorization'] = 'Bearer ' + env.get('BRIDGE_TOKEN', '')
    return {'kind': 'turn', 'base': base, 'url': base + '/turn', 'headers': hdr}


def target_payload(target: dict, text: str, spoken_at_ms=None) -> dict:
    """/turn gets {text}; voice-chat also gets spokenAt (epoch ms on THIS machine's clock)."""
    if target['kind'] == 'voice-chat':
        return {'text': text, 'spokenAt': int(spoken_at_ms if spoken_at_ms is not None else time.time() * 1000)}
    return {'text': text}


class PlaybackGate:
    """Tracks when this machine's own TTS is audible. The mic is ignored while playing and TAIL_S after."""

    def __init__(self, clock=time.time):
        self.clock = clock
        self.playing = 0
        self.until = 0.0
        self._lock = threading.Lock()

    def start(self):
        with self._lock:
            self.playing += 1

    def end(self):
        with self._lock:
            self.playing = max(0, self.playing - 1)
            self.until = self.clock() + TAIL_S

    def muted(self) -> bool:
        return self.playing > 0 or self.clock() < self.until


GATE = PlaybackGate()


def report_playback(state: str) -> None:
    """voice-chat only: tell the desktop module TTS started/ended (client clock, same as spokenAt)."""
    try:
        t = resolve_target()
    except ValueError:
        return
    if t['kind'] != 'voice-chat':
        return
    try:
        req = urllib.request.Request(t['base'] + '/m/voice-chat/playback', method='POST',
                                     data=json.dumps({'state': state, 'at': int(time.time() * 1000)}).encode(),
                                     headers=t['headers'])
        urllib.request.urlopen(req, timeout=3).read()
    except Exception as e:  # mic is still muted locally; the module's text guard still works
        print(f'playback report failed ({type(e).__name__})', file=sys.stderr)


def transcribe(wav_path: str) -> str:
    b = uuid.uuid4().hex
    with open(wav_path, 'rb') as f:
        audio = f.read()
    body = (f'--{b}\r\nContent-Disposition: form-data; name="model"\r\n\r\n{ASR_MODEL}\r\n'
            f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="u.wav"\r\n'
            'Content-Type: audio/wav\r\n\r\n').encode() + audio + f'\r\n--{b}--\r\n'.encode()
    req = urllib.request.Request(ASR_URL, data=body,
                                 headers={'Content-Type': f'multipart/form-data; boundary={b}'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read()).get('text', '').strip()


def _synth(sentence: str):
    """TTS engine, half 1: sentence -> wav bytes from the local mlx_audio server, or None for macOS `say`."""
    if TTS_URL == 'say':
        return None
    try:
        req = urllib.request.Request(TTS_URL, data=json.dumps(
            {'model': TTS_MODEL, 'input': sentence, 'response_format': 'wav'}).encode(),
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()
    except Exception as e:  # TTS server down -> still answer out loud
        print(f'TTS server failed ({type(e).__name__}); using macOS say', file=sys.stderr)
        return None


def _play(sentence: str, wav) -> None:
    """TTS engine, half 2: play what _synth returned (None = macOS `say`)."""
    if wav is None:
        subprocess.run(['say', sentence], check=False)
        return
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        f.write(wav)
    try:
        subprocess.run(['afplay', f.name], check=False)
    finally:
        os.unlink(f.name)


def _speak(sentence: str) -> None:
    _play(sentence, _synth(sentence))


def speak(sentence: str) -> None:
    GATE.start()
    report_playback('start')
    try:
        _speak(sentence)
    finally:
        GATE.end()
        report_playback('end')


def _pipe_synth(sentence: str):
    return sentence, _synth(sentence)


def _pipe_play(item) -> None:
    sentence, wav = item
    GATE.start()
    report_playback('start')
    try:
        _play(sentence, wav)
    finally:
        GATE.end()
        report_playback('end')


# voice-chat target only: speak sentence by sentence with prefetch; a new utterance cancels the rest.
PIPE = SpeechPipeline(_pipe_synth, _pipe_play, prefetch=PREFETCH,
                      on_error=lambda e, t: print(f'speech failed ({type(e).__name__})', file=sys.stderr))


def _messages(r):
    """Replies as dicts: NDJSON lines (the /turn bridge) or one {"lines": [...]} object (voice-chat route)."""
    for line in r:
        if not line.strip():
            continue
        msg = json.loads(line)
        if isinstance(msg, dict) and isinstance(msg.get('lines'), list):
            yield from msg['lines']
        else:
            yield msg


def ask(text: str, spoken_at_ms=None) -> None:
    """Send one turn to the text target; sentences are spoken as they arrive."""
    t0 = time.time()
    target = resolve_target()
    req = urllib.request.Request(target['url'],
                                 data=json.dumps(target_payload(target, text, spoken_at_ms)).encode('utf-8'),
                                 headers=target['headers'])
    say_q: queue.Queue = queue.Queue()
    first: list[float] = []
    piped = target['kind'] == 'voice-chat'
    if piped:
        PIPE.cancel()  # a new user utterance drops whatever was still queued

    def speaker():
        while (s := say_q.get()) is not None:
            if not first:
                first.append(time.time() - t0)
            if piped:
                PIPE.push(s)
            else:
                speak(s)

    th = threading.Thread(target=speaker)
    th.start()
    try:
        with urllib.request.urlopen(req, timeout=330) as r:
            for msg in _messages(r):
                if 'say' in msg:
                    say_q.put(msg['say'])
                elif msg.get('done') and msg.get('ignored'):
                    print(f"voice-chat: ignored ({msg['ignored']})", file=sys.stderr)
                elif msg.get('done'):
                    print(f"bridge: first text {msg.get('first_text_s')} s, total {msg.get('total_s')} s"
                          + (f", error: {msg['error']}" if msg.get('error') else ''), file=sys.stderr)
    finally:
        say_q.put(None)
        th.join()
        if piped:
            PIPE.join()
    if first:
        print(f'text sent -> first sentence to TTS: {first[0]:.2f} s '
              '(true first sound = this + ASR + end-of-speech wait + TTS first audio)', file=sys.stderr)


def handle_utterance(wav_path: str, spoken_at_ms=None) -> None:
    t = time.time()
    text = transcribe(wav_path)
    print(f'ASR {time.time() - t:.2f} s', file=sys.stderr)
    if text:
        ask(text, spoken_at_ms)


# ---- hands-free loop -------------------------------------------------------------------------
# Needs a continuous raw PCM source. The standard library cannot open a microphone, so capture is a
# child process (default: sox `rec`, `brew install sox`). Everything else here is stdlib.

def capture_frames(cmd: str = CAPTURE_CMD):
    """The ONLY audio-capture call. Yields 20 ms frames of 16 kHz mono s16le from a child process."""
    size = RATE * FRAME_MS // 1000 * 2
    p = subprocess.Popen(shlex.split(cmd), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        while True:
            b = p.stdout.read(size)
            if not b or len(b) < size:
                break
            yield b
    finally:
        p.terminate()


def write_wav(pcm: bytes, path: str) -> None:
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm)


def listen(frames=None, gate: PlaybackGate = None, on_utterance=None, **vad_kw) -> None:
    """Continuous mic -> utterances -> handle_utterance. While `gate` is muted (TTS playing + 300 ms)
    frames are dropped and any half-heard utterance is discarded. `frames` / `on_utterance` are test seams."""
    from vad import Segmenter
    gate = gate or GATE
    seg = Segmenter(**vad_kw)
    jobs: queue.Queue = queue.Queue()

    def worker():
        while (job := jobs.get()) is not None:
            pcm, at_ms = job
            if on_utterance:
                on_utterance(pcm, at_ms)
                continue
            f = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
            f.close()
            try:
                write_wav(pcm, f.name)
                handle_utterance(f.name, at_ms)
            except Exception as e:
                print(f'utterance failed ({type(e).__name__}: {e})', file=sys.stderr)
            finally:
                os.unlink(f.name)

    th = threading.Thread(target=worker, daemon=True)
    th.start()
    try:
        for fr in (frames if frames is not None else capture_frames()):
            if gate.muted():
                seg.reset()
                continue
            pcm = seg.feed(fr)
            if pcm:
                # utterance started roughly (length + hangover) ago on this machine's clock
                at_ms = int((time.time() - len(pcm) / (RATE * 2)) * 1000)
                jobs.put((pcm, at_ms))
    finally:
        jobs.put(None)
        th.join(timeout=60)


def poll_loop(every_s: float = 3.0) -> None:
    """voice-chat only: ask the module to announce a newly pending approval card."""
    t = resolve_target()
    if t['kind'] != 'voice-chat':
        return
    while True:
        time.sleep(every_s)
        if GATE.muted():
            continue
        try:
            req = urllib.request.Request(t['base'] + '/m/voice-chat/poll', method='POST', data=b'{}',
                                         headers=t['headers'])
            with urllib.request.urlopen(req, timeout=10) as r:
                for msg in _messages(r):
                    if 'say' in msg:
                        PIPE.push(msg['say'])
        except Exception as e:
            print(f'poll failed ({type(e).__name__})', file=sys.stderr)


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == '--text':
        ask(sys.argv[2])
    elif len(sys.argv) >= 3 and sys.argv[1] == '--wav':
        handle_utterance(sys.argv[2])
    elif len(sys.argv) >= 2 and sys.argv[1] == '--listen':
        resolve_target()  # fail early on a bad TEXT_TARGET
        threading.Thread(target=poll_loop, daemon=True).start()
        listen()
    else:
        print(__doc__)
