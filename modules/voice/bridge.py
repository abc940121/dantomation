"""Voice bridge: one warm Claude Code session on the desktop, spoken turns over HTTP.

Mac client POSTs {"text": "..."} to /turn and reads NDJSON lines back:
  {"say": "<one speakable sentence>"} ... then {"done": true, "first_text_s": .., "total_s": ..}
Auth: header "Authorization: Bearer <token>" (token from env VOICE_BRIDGE_TOKEN or bridge-token.txt).
Bind address: VOICE_BRIDGE_HOST (default 127.0.0.1; set to the Tailscale IP to reach it
from another network). Port: VOICE_BRIDGE_PORT (default 8790).
Uses the logged-in Claude Code subscription (no API key). License: MIT.
The claude argv, settings (guard hook) and env stripping come from the harness core via
modules/voice/harness_seam.js; this file never builds its own claude command. Turns are journaled
(timings only, no speech text).
"""
from __future__ import annotations

import json
import os
import queue
import re
import secrets
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SEAM = HERE / 'harness_seam.js'
TOKEN_FILE = ROOT / 'state' / 'voice-bridge-token.txt'  # state/ is gitignored
MODEL = os.environ.get('VOICE_BRIDGE_MODEL', 'sonnet')
WORKDIR = os.environ.get('VOICE_BRIDGE_CWD', str(ROOT / 'work' / 'voice'))  # work/ is gitignored
NODE = shutil.which('node') or 'node'
SENT_END = re.compile(r'[。！？!?；;]|\.(?=\s)')
CODE_FENCE = re.compile(r'```.*?(```|$)', re.S)
INLINE_CODE = re.compile(r'`[^`]*`')
URL = re.compile(r'https?://\S+')
PATH = re.compile(r'(?:\b[A-Za-z]:\\|~/|(?<![\w.])/(?=[\w.]))[\w.\-/\\]+')
MD = re.compile(r'[*_#>|]+')
BULLET = re.compile(r'^\s*(?:[-•]|\d+[.)])\s+', re.M)


def token() -> str:
    tok = os.environ.get('VOICE_BRIDGE_TOKEN')
    if tok:
        return tok
    if not TOKEN_FILE.exists():
        TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        TOKEN_FILE.write_text(secrets.token_urlsafe(24), encoding='utf-8')
    return TOKEN_FILE.read_text(encoding='utf-8').strip()


def speakable(text: str) -> str:
    """Strip what should never be read aloud (code, links, paths, markdown marks)."""
    text = CODE_FENCE.sub(' (code on screen) ', text)
    text = INLINE_CODE.sub('', text)
    text = URL.sub(' (link on screen) ', text)
    text = PATH.sub(' (path on screen) ', text)
    text = BULLET.sub('', text)
    text = MD.sub('', text)
    return re.sub(r'\s+', ' ', text).strip()


def split_sentences(buf: str) -> tuple[list[str], str]:
    """Return complete speakable sentences and the unfinished rest. Never splits inside ``` code."""
    out: list[str] = []
    while buf.count('```') % 2 == 0:
        m = SENT_END.search(buf)
        if not m:
            break
        sent, buf = speakable(buf[:m.end()]), buf[m.end():]
        if sent:
            out.append(sent)
    return out, buf


class Claude:
    """One persistent `claude -p` stream-json process (warm: ~1-1.5 s to first text)."""

    def __init__(self) -> None:
        Path(WORKDIR).mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.proc: subprocess.Popen | None = None
        self.out: queue.Queue[str] = queue.Queue()

    def start(self) -> None:
        self.task_id = 'v' + secrets.token_hex(4)
        seam = json.loads(subprocess.run([NODE, str(SEAM), 'argv', self.task_id, MODEL, WORKDIR], cwd=ROOT,
                                         capture_output=True, text=True, check=True).stdout)
        env = {k: v for k, v in os.environ.items() if k not in set(seam['strip'])}
        env['HARNESS_VOICE'] = '1'  # guard.js: no tools while a harness task holds the executor lock
        env.update(seam.get('env', {}))  # after the strip: HARNESS_TASK_ID/DIR -> guard checkpoints WORKDIR
        if not (Path(WORKDIR) / '.git').exists():
            subprocess.run(['git', 'init', '-q'], cwd=WORKDIR, check=False)
        self.proc = subprocess.Popen([seam['claude'], *seam['args']], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=WORKDIR,
                                     env=env, text=True, encoding='utf-8')
        self.out = queue.Queue()
        threading.Thread(target=lambda p=self.proc, q=self.out: [q.put(l) for l in p.stdout],
                         daemon=True).start()

    def journal(self, rec: dict) -> None:
        rec = {'type': 'voice_turn', 'task_id': self.task_id, **rec}
        threading.Thread(target=subprocess.run, args=([NODE, str(SEAM), 'log', json.dumps(rec)],),
                         kwargs={'cwd': ROOT, 'capture_output': True}, daemon=True).start()

    def seam(self, *args: str) -> str:
        return subprocess.run([NODE, str(SEAM), *args], cwd=ROOT, capture_output=True,
                              text=True, check=True).stdout

    def turn(self, text: str):
        """Yield speakable sentences, then a stats dict.

        Each turn takes state/executor.lock (via the seam) for its duration, so a
        voice turn and a harness task never act at the same time. If a harness
        task holds it, the turn still answers, but without tools (guard.js blocks
        them) and says a task is running."""
        with self.lock:
            if self.proc is None or self.proc.poll() is not None:
                self.start()
            begin = json.loads(self.seam('turn-begin', self.task_id, str(os.getpid()), str(self.proc.pid)))
            try:
                note = begin['status']
                if not begin['locked']:
                    note += (' A harness task is running right now, so you have no tools this turn:'
                             ' answer from what you know, and say a task is running.')
                yield from self._turn('[' + note + '] ' + text)
            finally:
                if begin.get('nonce'):
                    self.seam('turn-end', begin['nonce'])

    def _turn(self, text: str):
        t0 = time.time()
        first = None
        self.proc.stdin.write(json.dumps({'type': 'user', 'message': {'role': 'user', 'content': text}}) + '\n')
        self.proc.stdin.flush()
        buf = ''
        while True:
            try:
                ev = json.loads(self.out.get(timeout=300))
            except queue.Empty:
                self.proc.kill()
                yield {'error': 'claude gave no answer within 300 s; process restarted'}
                return
            except ValueError:
                continue
            kind = ev.get('type')
            if kind == 'stream_event':
                e = ev.get('event', {})
                if e.get('type') == 'content_block_delta' and e.get('delta', {}).get('type') == 'text_delta':
                    if first is None:
                        first = time.time() - t0
                    sents, buf = split_sentences(buf + e['delta']['text'])
                    yield from sents
                elif e.get('type') == 'message_stop' and buf.strip():
                    tail, buf = speakable(buf), ''
                    if tail:
                        yield tail
            elif kind == 'result':
                tail = speakable(buf)
                if tail:
                    yield tail
                stats = {'first_text_s': first and round(first, 2), 'total_s': round(time.time() - t0, 2)}
                self.journal(stats)
                yield stats
                return


CLAUDE = Claude()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/health':
            self.send_error(404)
            return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"ok": true}')

    def do_POST(self):
        if self.path != '/turn':
            self.send_error(404)
            return
        if not secrets.compare_digest(self.headers.get('Authorization', ''), f'Bearer {token()}'):
            self.send_error(401, 'missing or wrong bridge token (Authorization: Bearer <bridge-token.txt>)')
            return
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        text = (body.get('text') or '').strip()
        if not text:
            self.send_error(400, 'empty text')
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        self.end_headers()
        for item in CLAUDE.turn(text):
            line = {'say': item} if isinstance(item, str) else {'done': True, **item}
            self.wfile.write((json.dumps(line, ensure_ascii=False) + '\n').encode('utf-8'))
            self.wfile.flush()

    def log_message(self, *a):  # never log spoken text
        pass


def main() -> None:
    host = os.environ.get('VOICE_BRIDGE_HOST', '127.0.0.1')
    port = int(os.environ.get('VOICE_BRIDGE_PORT', '8790'))
    token()
    CLAUDE.start()  # warm the session before the first spoken turn
    print(f'voice bridge on http://{host}:{port} (token: state/{TOKEN_FILE.name} or VOICE_BRIDGE_TOKEN)')
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == '__main__':
    main()
