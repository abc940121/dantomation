'use strict';
// Reply checks: pass detection, name/voice impersonation, secret and PII scrub.
const { redactFull } = require('../../lib/redact');

const isPass = s => { const t = String(s == null ? '' : s).trim(); return t === '' || /^\(?\s*pass\s*\)?[.!]?$/i.test(t) || /^\(\s*pass\s*\)/i.test(t); };

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A reply may speak only as its own member. A line that opens with another
// member's label ("Name:", "[Name]"), or forges a provenance label, is refused.
function impersonation(text, member, room) {
  const others = room.members.filter(m => m.id !== member.id);
  const names = others.flatMap(m => [m.id, m.name]).filter(Boolean);
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*[-*]?\s*\[id=|\bspeaker="/i.test(line)) return 'forged provenance label';
    for (const n of names) {
      if (new RegExp(String.raw`^\s*[-*>]*\s*\[\s*`+esc(n)+String.raw`\s*\]`, 'i').test(line)) return `line spoken as another member (${n})`;
      if (new RegExp(String.raw`^\s*[-*>]*\s*[\[(<*_]*\s*` + esc(n) + String.raw`\s*[\])>*_]*\s*[:\uFF1A]`, 'i').test(line)) return `line spoken as another member (${n})`;
    }
  }
  return null;
}

// Secrets always; PII (email, phone, SSN-like, card-like numbers) for members that need it.
function scrub(text, { pii } = {}) {
  let s = redactFull(text);
  if (pii) {
    s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[PII]')
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[PII]')
      .replace(/\b(?:\d[ -]?){13,19}\b/g, '[PII]')
      .replace(/(?<![\w])\+?\d[\d ()-]{8,}\d(?![\w])/g, '[PII]');
  }
  return s;
}

module.exports = { isPass, impersonation, scrub };
