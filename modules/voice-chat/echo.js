'use strict';
// Half-duplex echo guard. Pure state machine, injectable clock.
//   Rule 1 (timing): an utterance that starts inside a TTS playback window, or up to
//     TAIL_MS after it ends, is the system hearing itself.
//   Rule 2 (text): an utterance that closely matches what was spoken in the last
//     RECENT_MS is an echo, even if the timing was missed.
// Times in playback()/utterance spokenAt are one clock (the client's); `now` is the
// module's own clock, used for the text memory and for "playing right now".

const TAIL_MS = 300;
const RECENT_MS = 10000;

const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const tokens = s => norm(s).split(' ').filter(Boolean);

// Dice coefficient over character bigrams of the normalized text (works for Latin and CJK).
function similarity(a, b) {
  a = norm(a).replace(/\s/g, ''); b = norm(b).replace(/\s/g, '');
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const A = grams(a), B = grams(b);
  let hit = 0;
  for (const [g, n] of A) hit += Math.min(n, B.get(g) || 0);
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

// Tokens of a contiguous run of a's tokens appear in b (a fragment of a spoken sentence).
function isFragment(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (ta.length < 2 || ta.length > tb.length) return false;
  for (let i = 0; i + ta.length <= tb.length; i++) if (ta.every((t, j) => tb[i + j] === t)) return true;
  return false;
}

class EchoGuard {
  constructor({ now = Date.now, threshold = 0.6 } = {}) {
    this.now = now; this.threshold = threshold;
    this.windows = [];        // {start, end|null} in client time
    this.spoken = [];         // {text, at} in module time
    this.lastSpeechEnd = 0;   // module time of last playback end or last say
  }
  say(text) { const t = this.now(); this.spoken.push({ text, at: t }); this.lastSpeechEnd = t; this.trim(); }
  playback(state, at) {
    const t = Number.isFinite(at) ? at : this.now();
    if (state === 'start') {
      const open = this.windows[this.windows.length - 1];
      if (!open || open.end !== null) this.windows.push({ start: t, end: null });
    } else if (state === 'end') {
      let open = this.windows[this.windows.length - 1];
      if (!open || open.end !== null) { open = { start: t, end: null }; this.windows.push(open); }
      open.end = Math.max(t, open.start);
      this.lastSpeechEnd = this.now();
    } else return false;
    this.trim();
    return true;
  }
  get playing() { const w = this.windows[this.windows.length - 1]; return !!w && w.end === null; }
  trim() {
    const t = this.now();
    this.spoken = this.spoken.filter(s => t - s.at <= RECENT_MS * 3);
    if (this.windows.length > 50) this.windows.splice(0, this.windows.length - 50);
  }
  // -> null (not an echo) | 'playing' | 'timing' | 'text'
  check(text, spokenAt) {
    if (this.playing) return 'playing';
    if (Number.isFinite(spokenAt)) {
      for (const w of this.windows) if (spokenAt >= w.start && (w.end === null || spokenAt <= w.end + TAIL_MS)) return 'timing';
    }
    const t = this.now();
    for (const s of this.spoken) {
      if (t - s.at > RECENT_MS) continue;
      if (similarity(text, s.text) >= this.threshold || isFragment(text, s.text)) return 'text';
    }
    return null;
  }
}

module.exports = { EchoGuard, similarity, isFragment, norm, TAIL_MS, RECENT_MS };
