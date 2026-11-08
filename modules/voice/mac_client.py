"""Mac thin client for bridge.py (MIT). Stdlib only.

Per turn: utterance wav -> local Qwen3-ASR (mlx_audio server) -> POST text to the desktop bridge
-> speak each returned sentence with local Qwen3-TTS (mlx_audio) or macOS `say` as fallback.

Wake word / VAD is left to the integrator: call handle_utterance(wav_path) once a whole utterance is recorded.
Quick test without a mic:  python3 mac_client.py --text "你好"

Env:
  BRIDGE_URL    e.g. http://100.x.y.z:8790 (desktop Tailscale IP)
  BRIDGE_TOKEN  contents of state/voice-bridge-token.txt on the desktop
  ASR_URL       default http://127.0.0.1:8001/v1/audio/transcriptions (OpenAI-style, mlx_audio)
  TTS_URL       default http://127.0.0.1:8001/v1/audio/speech; "say" = macOS say only
  ASR_MODEL / TTS_MODEL  model ids your mlx_audio server expects
  Install pins (THIRD_PARTY.md): hf download <id> --revision <commit> before starting mlx_audio.
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid

BRIDGE_URL = os.environ.get('BRIDGE_URL', 'http://127.0.0.1:8790')
BRIDGE_TOKEN = os.environ.get('BRIDGE_TOKEN', '')
ASR_URL = os.environ.get('ASR_URL', 'http://127.0.0.1:8001/v1/audio/transcriptions')
ASR_MODEL = os.environ.get('ASR_MODEL', 'mlx-community/Qwen3-ASR-1.7B-8bit')
TTS_URL = os.environ.get('TTS_URL', 'http://127.0.0.1:8001/v1/audio/speech')
TTS_MODEL = os.environ.get('TTS_MODEL', 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit')


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


def speak(sentence: str) -> None:
    if TTS_URL != 'say':
        try:
            req = urllib.request.Request(TTS_URL, data=json.dumps(
                {'model': TTS_MODEL, 'input': sentence, 'response_format': 'wav'}).encode(),
                headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=30) as r, \
                    tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
                f.write(r.read())
            subprocess.run(['afplay', f.name], check=False)
            os.unlink(f.name)
            return
        except Exception as e:  # TTS server down -> still answer out loud
            print(f'TTS server failed ({type(e).__name__}); using macOS say', file=sys.stderr)
    subprocess.run(['say', sentence], check=False)


def ask(text: str) -> None:
    """Send one turn; sentences are spoken as they arrive."""
    t0 = time.time()
    req = urllib.request.Request(f'{BRIDGE_URL}/turn', data=json.dumps({'text': text}).encode('utf-8'),
                                 headers={'Content-Type': 'application/json; charset=utf-8',
                                          'Authorization': f'Bearer {BRIDGE_TOKEN}'})
    say_q: queue.Queue = queue.Queue()
    first: list[float] = []

    def speaker():
        while (s := say_q.get()) is not None:
            if not first:
                first.append(time.time() - t0)
            speak(s)

    th = threading.Thread(target=speaker)
    th.start()
    try:
        with urllib.request.urlopen(req, timeout=330) as r:
            for line in r:
                msg = json.loads(line)
                if 'say' in msg:
                    say_q.put(msg['say'])
                elif msg.get('done'):
                    print(f"bridge: first text {msg.get('first_text_s')} s, total {msg.get('total_s')} s"
                          + (f", error: {msg['error']}" if msg.get('error') else ''), file=sys.stderr)
    finally:
        say_q.put(None)
        th.join()
    if first:
        print(f'text sent -> first sentence to TTS: {first[0]:.2f} s '
              '(true first sound = this + ASR + end-of-speech wait + TTS first audio)', file=sys.stderr)


def handle_utterance(wav_path: str) -> None:
    t = time.time()
    text = transcribe(wav_path)
    print(f'ASR {time.time() - t:.2f} s', file=sys.stderr)
    if text:
        ask(text)


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == '--text':
        ask(sys.argv[2])
    elif len(sys.argv) >= 3 and sys.argv[1] == '--wav':
        handle_utterance(sys.argv[2])
    else:
        print(__doc__)
