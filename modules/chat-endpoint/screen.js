'use strict';
// Secret / PII screen. Pure, no I/O. Kinds: private_key, secret, password, email, phone, card.
//   dropLines(text) -> { text, hits }   outgoing: every line with a hit is removed whole
//   redact(text)    -> { text, hits }   incoming: only the matching part is replaced
// hits is { kind: count }; it never carries any of the text.
const { SECRET_LITERAL } = require('../../lib/redact');

// Any PEM block (key, certificate, ...) is removed whole: BEGIN to END, or BEGIN to the end of the text when unterminated.
const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]+-----/;
const KEY_END = /-----END [A-Z0-9 ]+-----/;
const KEY_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g;
const SECRET_ASSIGN = /\b(?:api[_-]?key|access[_-]?key|auth[_-]?token|token|secret)[\w-]*\s*[=:]\s*\S+/gi;
const BEARER = /\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi;
const PASSWORD = /\b(?:passw(?:or)?d|passwd|pwd)\s*(?:[=:]|\bis\b)\s*\S+/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const DIGITS = /(?<![\w.-])\+?\d[\d ()-]{8,}\d(?![\w])/g;
const lit = new RegExp(SECRET_LITERAL.source, 'g');

function luhn(d) {
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return sum % 10 === 0;
}
const isCard = run => { const d = run.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d); };
const isPhone = run => { if (/^\d{4}-\d{2}-\d{2}/.test(run)) return false; const d = run.replace(/\D/g, ''); return d.length >= 10 && d.length <= 15; };

// [kind, regex, replacement (string, or fn returning string / null for "not a hit")]
const RULES = [
  ['secret', lit, '[REDACTED]'],
  ['secret', BEARER, 'Bearer [REDACTED]'],
  ['secret', SECRET_ASSIGN, m => m.replace(/([=:]\s*)\S+$/, '$1[REDACTED]')],
  ['password', PASSWORD, m => m.replace(/(\s*(?:[=:]|\bis\b)\s*)\S+$/i, '$1[REDACTED]')],
  ['email', EMAIL, '[email]'],
  ['card', DIGITS, m => (isCard(m) ? '[card]' : null)],
  ['phone', DIGITS, m => (!isCard(m) && isPhone(m) ? '[phone]' : null)],
];

function kindsIn(line) {
  const out = [];
  for (const [kind, re, rep] of RULES) {
    re.lastIndex = 0;
    let m, hit = false;
    while ((m = re.exec(line))) {
      if (typeof rep === 'function' && rep(m[0]) === null) continue;
      hit = true; break;
    }
    re.lastIndex = 0;
    if (hit) out.push(kind);
  }
  return out;
}

const bump = (hits, k, n = 1) => { hits[k] = (hits[k] || 0) + n; };

function dropLines(text) {
  const hits = {}, keep = [];
  let inKey = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (inKey) { if (KEY_END.test(line)) inKey = false; continue; }
    if (KEY_BEGIN.test(line)) { bump(hits, 'private_key'); if (!KEY_END.test(line)) inKey = true; continue; }
    const k = kindsIn(line);
    if (k.length) { k.forEach(x => bump(hits, x)); continue; }
    keep.push(line);
  }
  return { text: keep.join('\n'), hits };
}

function redact(text) {
  const hits = {};
  let s = String(text).replace(KEY_BLOCK, () => { bump(hits, 'private_key'); return '[REDACTED]'; });
  for (const [kind, re, rep] of RULES) {
    re.lastIndex = 0;
    s = s.replace(re, m => {
      const r = typeof rep === 'function' ? rep(m) : rep;
      if (r === null) return m;
      bump(hits, kind); return r;
    });
  }
  return { text: s, hits };
}

// The one helper every speaker name / label goes through before it is placed in any request field:
// one line, redacted in place, at most 80 chars. -> { text, hits }
function screenName(s) {
  const r = redact(String(s == null ? '' : s).replace(/\s+/g, ' ').trim());
  return { text: r.text.slice(0, 80), hits: r.hits };
}

const total = hits => Object.values(hits).reduce((a, b) => a + b, 0);

module.exports = { dropLines, redact, screenName, total, luhn };
