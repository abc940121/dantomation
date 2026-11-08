'use strict';
// Turns bot text into short speakable sentences. Pure, no I/O.
//   cleanLine(s)   markdown/URL/code-symbol stripped single string
//   Speakable      streaming: feed(text) -> sentences ready now; flush() -> the rest.
// Fenced code blocks (even across several chunks) become one spoken placeholder, URLs
// are read as their domain, paths as their last segment (see speak-text.js).
const { toSpeakable, codePlaceholder, isZh } = require('./speak-text');

const MAX_LEN = 160;

function cleanLine(s) {
  return String(s)
    .replace(/`{3,}[\s\S]*?(`{3,}|$)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~#|<>{}[\]\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Break a long sentence at a comma/space so no spoken piece is long.
function chunk(s) {
  const out = [];
  while (s.length > MAX_LEN) {
    let cut = Math.max(s.lastIndexOf(',', MAX_LEN), s.lastIndexOf('，', MAX_LEN), s.lastIndexOf(' ', MAX_LEN));
    if (cut < 40) cut = MAX_LEN;
    out.push(s.slice(0, cut + 1).trim());
    s = s.slice(cut + 1).trim();
  }
  if (s) out.push(s);
  return out;
}

const hasWord = s => /[\p{L}\p{N}]/u.test(s);

class Speakable {
  constructor() { this.buf = ''; this.inCode = false; this.pendingCode = false; this.spoke = false; this.zh = false; }
  feed(text) {
    const out = [];
    let rest = this.buf + String(text || '');
    if (!this.zh) this.zh = isZh(rest);
    this.buf = '';
    for (;;) {
      if (this.inCode) {
        const i = rest.indexOf('```');
        if (i < 0) return out;                 // still inside the block: drop
        rest = rest.slice(i + 3); this.inCode = false;
      }
      const i = rest.indexOf('```');
      const plain = i < 0 ? rest : rest.slice(0, i);
      if (i >= 0) { this.take(plain, out, true); rest = rest.slice(i + 3); this.inCode = true; this.pendingCode = true; continue; }
      this.take(plain, out, false);
      return out;
    }
  }
  // Complete sentences go to out; an unfinished tail stays in buf (unless final).
  take(plain, out, final) {
    const re = /[.!?。！？]+["')\]]*(?=\s|$|\p{Script=Han})|\n/gu;
    let last = 0, m;
    while ((m = re.exec(plain))) {
      const seg = plain.slice(last, re.lastIndex);
      last = re.lastIndex;
      this.emit(seg, out);
    }
    const tail = plain.slice(last);
    if (final) this.emit(tail, out);
    else this.buf = tail;
  }
  // One raw segment -> spoken pieces; a code block seen before it is announced first.
  emit(seg, out) {
    const pieces = chunk(toSpeakable(seg)).filter(hasWord);
    if (!pieces.length) return;
    if (this.pendingCode) { out.push(codePlaceholder(this.zh)); this.pendingCode = false; }
    this.spoke = true;
    out.push(...pieces);
  }
  flush() {
    const out = [];
    if (!this.inCode) this.emit(this.buf, out);
    if (this.pendingCode && this.spoke) out.push(codePlaceholder(this.zh));
    this.buf = ''; this.inCode = false; this.pendingCode = false; this.spoke = false; this.zh = false;
    return out;
  }
}

module.exports = { Speakable, cleanLine, chunk };
