'use strict';
// Pure rule engine for tripwires: scan(text, opts) -> [{rule, snippet}]. No I/O, never throws.
// Snippets are built from the text AROUND a match with every match replaced by a marker, so a
// trip never carries the thing it caught.
const RULES = ['secrets', 'paths', 'private_ips', 'banned', 'oversize', 'success_claim'];

const SECRET_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-(?:proj-)?[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  new RegExp('-----BEGIN [A-Z ]*' + 'PRIVATE KEY' + '-----', 'g'),
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];
const HOME_SHAPES = [
  /(?:^|[\s"'`(=])\/(?:home|Users)\/[^\s"'`/)]+(?:\/[^\s"'`)]*)?/g,
  new RegExp('[A-Za-z]:\\\\+' + 'Users' + '\\\\+[^\\s"\'`\\\\]+(?:\\\\+[^\\s"\'`]*)?', 'g'),
];
const OCT = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
const IP_SHAPES = [
  new RegExp('\\b10\\.' + OCT + '\\.' + OCT + '\\.' + OCT + '\\b', 'g'),
  new RegExp('\\b192\\.168\\.' + OCT + '\\.' + OCT + '\\b', 'g'),
  new RegExp('\\b172\\.(?:1[6-9]|2\\d|3[01])\\.' + OCT + '\\.' + OCT + '\\b', 'g'),
  new RegExp('\\b169\\.254\\.' + OCT + '\\.' + OCT + '\\b', 'g'),
  new RegExp('\\b100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.' + OCT + '\\.' + OCT + '\\b', 'g'),
];
const CLAIM = /\b(all (?:the )?tests? (?:pass|passed|passes|are passing|green)|tests? pass(?:ed|es)?|succe(?:ss|ssful|ssfully|eded)|completed? successfully|(?:is|are|was|were|now) (?:fixed|done|working|complete[d]?)|(?:fixed|done|finished|deployed|shipped)\b|works now|all done)\b/i;
const NEGATE = /\b(not|never|fail(?:ed|s|ure)?|unable|couldn|cannot|still broken|error)\b|n't/i;

const clipStr = (s, n) => (s.length > n ? s.slice(0, n - 3) + '...' : s);
const oneLine = s => s.replace(/\s+/g, ' ').trim();
const g = re => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');

// Replace every match of every shape by a marker (a leading delimiter the shape consumed is kept).
function mask(text, shapes, marker) {
  let t = text;
  for (const re of shapes) t = t.replace(g(re), m => (/^[\s"'`(=]/.test(m) && m.length > 1 ? m[0] : '') + marker);
  return t;
}
// Context around the first match of any shape, with all matches masked.
function snippetFor(text, shapes, marker, ctxChars = 24) {
  let first = null;
  for (const re of shapes) {
    const m = g(re).exec(text);
    if (m && (!first || m.index < first.index)) first = { index: m.index, len: m[0].length };
  }
  if (!first) return marker;
  const before = text.slice(Math.max(0, first.index - ctxChars), first.index);
  const after = text.slice(first.index + first.len, first.index + first.len + ctxChars);
  return clipStr(oneLine(mask(before, shapes, marker) + marker + mask(after, shapes, marker)), 100);
}
const has = (text, shapes) => shapes.some(re => g(re).test(text));
// Every family masked in a snippet, so one snippet never leaks another family's match.
const ALL_SHAPES = [[SECRET_SHAPES, '[secret]'], [HOME_SHAPES, '[home-path]'], [IP_SHAPES, '[private-ip]']];
function safe(snippet) { let s = snippet; for (const [sh, mk] of ALL_SHAPES) s = mask(s, sh, mk); return s; }

function scan(reply, { rules = {}, bannedPhrases = [], maxChars = 3000, code = null } = {}) {
  const trips = [];
  try {
    const text = typeof reply === 'string' ? reply : '';
    if (!text) return trips;
    const on = r => rules[r] !== false;
    if (on('secrets') && has(text, SECRET_SHAPES)) trips.push({ rule: 'secrets', snippet: safe(snippetFor(text, SECRET_SHAPES, '[secret]')) });
    if (on('paths') && has(text, HOME_SHAPES)) trips.push({ rule: 'paths', snippet: safe(snippetFor(text, HOME_SHAPES, '[home-path]')) });
    if (on('private_ips') && has(text, IP_SHAPES)) trips.push({ rule: 'private_ips', snippet: safe(snippetFor(text, IP_SHAPES, '[private-ip]')) });
    if (on('banned')) {
      const low = text.toLowerCase();
      for (const p of bannedPhrases) {
        const ph = String(p || '').trim().toLowerCase();
        if (!ph) continue;
        const i = low.indexOf(ph);
        if (i < 0) continue;
        const snip = oneLine(text.slice(Math.max(0, i - 20), i)) + ' [banned] ' + oneLine(text.slice(i + ph.length, i + ph.length + 20));
        trips.push({ rule: 'banned', snippet: safe(clipStr(snip.trim(), 100)) });
        break; // one banned trip per reply; the phrase itself is not stored
      }
    }
    if (on('oversize') && text.length > maxChars) trips.push({ rule: 'oversize', snippet: `reply is ${text.length} chars, limit ${maxChars}` });
    if (on('success_claim') && typeof code === 'number' && code !== 0) {
      const hit = text.split(/(?<=[.!?\n])\s+/).find(s => CLAIM.test(s) && !NEGATE.test(s));
      if (hit) trips.push({ rule: 'success_claim', snippet: safe(clipStr(oneLine(hit), 100)) + ` (exit ${code})` });
    }
  } catch { /* a broken rule never breaks the turn */ }
  return trips;
}

// Redact a reply: secrets, home paths and private IPs replaced by markers. Banned phrases, size
// and success claims are not text spans, so they can only be flagged.
function redact(reply, rules = {}) {
  let t = typeof reply === 'string' ? reply : '';
  try {
    if (rules.secrets !== false) t = mask(t, SECRET_SHAPES, '[REDACTED]');
    if (rules.paths !== false) t = mask(t, HOME_SHAPES, '[home-path]');
    if (rules.private_ips !== false) t = mask(t, IP_SHAPES, '[private-ip]');
  } catch { /* keep what we have */ }
  return t;
}

module.exports = { RULES, scan, redact };
