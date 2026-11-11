'use strict';
// corrections store: one JSON file (rules.json) in the module state dir. Pure functions over a plain
// object plus load/save. Rule texts can hold private words, so they stay in this file; the journal
// gets metadata only. No network, no model: detection is cue words, relevance is token overlap.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LIMITS = { rule: 600, why: 400, scope: 200, quote: 600, topic: 300, request: 2000 };
const ID_RE = /^c-[0-9a-f]{12}$/;
const STATUSES = ['candidate', 'active', 'review', 'off'];
const SEEN_MAX = 20;
const MAX_SENTENCE = 300, MAX_PER_REQUEST = 5, MIN_SHARED_FOR_DUP = 3;
const DAY = 86400000;
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const now = () => {
  const v = process.env.HARNESS_NOW;
  if (v) { const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v); if (Number.isFinite(n)) return n; }
  return Date.now();
};
const iso = ms => new Date(ms).toISOString();
const newId = () => 'c-' + crypto.randomBytes(6).toString('hex');
const oneLine = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const clip = (s, n) => { s = oneLine(s); return s.length > n ? s.slice(0, n - 3) + '...' : s; };

function text(v, max, name, required) {
  if (v === undefined || v === null || v === '') return required ? { error: `${name} is required` } : { value: '' };
  if (typeof v !== 'string') return { error: `${name} must be a string` };
  const c = v.replace(/\r\n?/g, '\n').trim();
  if (!c) return required ? { error: `${name} is required` } : { value: '' };
  if (c.length > max) return { error: `${name} must be at most ${max} characters` };
  if (CTRL.test(c)) return { error: `${name} has control characters` };
  return { value: c };
}

// ---- file
const fileOf = dir => path.join(dir, 'rules.json');
function load(dir) {
  let d;
  try { d = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('corrections rules.json unreadable: ' + e.message); d = null; }
  if (!d || typeof d !== 'object') d = {};
  return { rules: Array.isArray(d.rules) ? d.rules : [], seen: Array.isArray(d.seen) ? d.seen : [] };
}
function save(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const f = fileOf(dir), tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
// read, change, write. fn returns an object; {error} leaves the file untouched.
function update(dir, fn) {
  const d = load(dir);
  const r = fn(d);
  if (!r || !r.error) save(dir, d);
  return r;
}

// ---- detection: cue words, English and Traditional Chinese
const CUE = new RegExp([
  "\\b(never|don'?t|do not|stop|always|i told you|told you|again|remember|from now on|instead|no longer|must not|must always|should not|shouldn'?t|not allowed)\\b",
  '不要|別(?!人|的|處|名)|不准|不可以|不能|不應該|不是.+而是|說過|講過|又.+了|第二次|記住|以後|一律|必須|千萬',
].join('|'), 'i');
const SELF = /\b(my mistake|i was wrong|i meant|sorry|my bad|i misspoke)\b|我說錯|說錯了|我錯了|我的錯/i;
const QUESTION = /[?？]\s*$|嗎|為什麼|為何/;

function detect(request) {
  const body = String(request || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  const parts = body.match(/[^.!?。！？\n]+[.!?。！？]*/g) || [];
  const out = [];
  for (const p of parts) {
    const s = oneLine(p);
    if (s.length < 4 || s.length > MAX_SENTENCE) continue;
    if (QUESTION.test(s) || SELF.test(s) || !CUE.test(s)) continue;
    out.push({ sentence: s });
    if (out.length >= MAX_PER_REQUEST) break;
  }
  return out;
}

// ---- tokens: lowercase words (crude plural strip) and CJK bigrams
const STOP = new Set(('the a an and or to of in on for with is are be it you i me my we this that do does did not never always ' +
  'dont don t stop again please some task time third now so as at by from up if then when where what how why can could would should ' +
  'will just also into out onto over under about have has had was were been your our its their them they he she his her but no yes ' +
  '不要 不准 不可 不能 記住 以後 一律 必須 千萬 同樣 說過 講過 第二 二次').split(/\s+/));
function tokens(s) {
  const t = String(s || '').toLowerCase();
  const out = [];
  for (const w of t.match(/[a-z0-9_]+/g) || []) {
    let x = w;
    if (x.length > 3 && x.endsWith('s') && !x.endsWith('ss')) x = x.slice(0, -1);
    if (x.length >= 2 && !STOP.has(x)) out.push(x);
  }
  for (const run of t.match(/[㐀-鿿]+/g) || []) {
    for (let i = 0; i + 1 < run.length; i++) { const b = run.slice(i, i + 2); if (!STOP.has(b)) out.push(b); }
  }
  return out;
}
const isCjk = tok => /[㐀-鿿]/.test(tok);
const tset = s => new Set(tokens(s));
const ruleTokens = r => tset([r.rule, r.why, /^task:/.test(r.scope || '') ? '' : r.scope, r.topic].join(' '));
// a Latin word is one point of evidence, a CJK bigram two
function overlap(reqSet, ruleSet) { let n = 0; for (const x of ruleSet) if (reqSet.has(x)) n += isCjk(x) ? 2 : 1; return n; }
function similarity(a, b) {
  if (!a.size || !b.size) return { inter: 0, sim: 0 };
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return { inter, sim: inter / Math.min(a.size, b.size) };
}

// ---- seen requests: a ring of the last owner requests (hash + clipped text)
const hashOf = s => crypto.createHash('sha1').update(oneLine(s)).digest('hex').slice(0, 16);
function recordSeen(d, request, ms) {
  const h = hashOf(request);
  if (d.seen.some(x => x.h === h)) return false;
  d.seen.push({ h, at: iso(ms), text: oneLine(request).slice(0, LIMITS.request) });
  while (d.seen.length > SEEN_MAX) d.seen.shift();
  return true;
}
const quoteSeen = (d, q) => { const n = oneLine(q).toLowerCase(); return n.length >= 4 && d.seen.some(x => x.text.toLowerCase().includes(n)); };

// ---- rows
function evict(d, cap) {
  while (d.rules.length > cap) {
    const rank = r => ({ off: 0, candidate: 1, review: 2, active: 3 }[r.status] ?? 3);
    let w = 0;
    for (let i = 1; i < d.rules.length; i++) {
      const a = d.rules[i], b = d.rules[w];
      if (rank(a) < rank(b) || (rank(a) === rank(b) && Date.parse(a.last_hit || a.created) < Date.parse(b.last_hit || b.created))) w = i;
    }
    d.rules.splice(w, 1);
  }
}
// spec: {rule, quote?, source: heuristic|agent|owner, why?, scope?, topic?, task_id?, workdir?}
// heuristic and agent rows are merged into a near-duplicate (a repeat); owner rows are always new.
function addRule(d, spec, cfg, ms) {
  const rule = clip(spec.rule, LIMITS.rule);
  if (spec.source !== 'owner') {
    const mine = tset(rule);
    let best = null, bestSim = 0;
    for (const r of d.rules) {
      const { inter, sim } = similarity(mine, tset(r.rule));
      if (inter >= MIN_SHARED_FOR_DUP && sim >= cfg.repeat_similarity && sim > bestSim) { best = r; bestSim = sim; }
    }
    if (best) {
      best.repeats = (best.repeats || 0) + 1;
      best.last_repeat = iso(ms);
      if (best.status !== 'active') best.status = 'active';
      return { dup: true, repeats: best.repeats, escalate: best.repeats >= 3, rule: best };
    }
  }
  const row = {
    id: newId(), rule, why: clip(spec.why, LIMITS.why), scope: clip(spec.scope, LIMITS.scope),
    topic: clip(spec.topic, LIMITS.topic), task_id: spec.task_id || '', workdir: spec.workdir || '',
    quote: clip(spec.quote, LIMITS.quote), created: iso(ms), source: spec.source,
    hits: 0, last_hit: '', repeats: 0, last_checked: '',
    status: spec.source === 'heuristic' ? 'candidate' : 'active',
  };
  d.rules.push(row);
  evict(d, cfg.max_rules);
  return { dup: false, repeats: 0, escalate: false, rule: row };
}

// agent proposal: the quote must be a substring of a recorded owner request
function propose(d, p, cfg, ms) {
  const q = text(p.quote, LIMITS.quote, 'quote', true); if (q.error) return q;
  const rl = text(p.rule, LIMITS.rule, 'rule', true); if (rl.error) return rl;
  const why = text(p.why, LIMITS.why, 'why', true); if (why.error) return why;
  const sc = text(p.scope, LIMITS.scope, 'scope', false); if (sc.error) return sc;
  if (!quoteSeen(d, q.value)) return { error: 'quote is not found in a recent owner request: quote the owner\'s own words exactly' };
  const nq = oneLine(q.value).toLowerCase();
  const hit = d.rules.find(r => r.source === 'heuristic' && r.quote && (oneLine(r.quote).toLowerCase().includes(nq) || nq.includes(oneLine(r.quote).toLowerCase())));
  if (hit) {
    hit.why = clip(why.value, LIMITS.why);
    if (sc.value) hit.scope = clip(sc.value, LIMITS.scope);
    hit.source = 'agent'; hit.status = 'active';
    return { rule: hit, merged: true };
  }
  const r = addRule(d, { rule: rl.value, quote: q.value, source: 'agent', why: why.value, scope: sc.value }, cfg, ms);
  if (r.dup) { if (!r.rule.why) r.rule.why = clip(why.value, LIMITS.why); if (sc.value) r.rule.scope = clip(sc.value, LIMITS.scope); }
  return { rule: r.rule, merged: r.dup };
}

function addOwner(d, b, cfg, ms) {
  const rl = text(b.rule, LIMITS.rule, 'rule', true); if (rl.error) return rl;
  const why = text(b.why, LIMITS.why, 'why', false); if (why.error) return why;
  const sc = text(b.scope, LIMITS.scope, 'scope', false); if (sc.error) return sc;
  return { rule: addRule(d, { rule: rl.value, why: why.value, scope: sc.value, source: 'owner' }, cfg, ms).rule };
}
function find(d, id) { return ID_RE.test(String(id)) ? d.rules.find(r => r.id === id) : null; }
function edit(d, id, b) {
  const r = find(d, id); if (!r) return { error: 'no such rule', status: 404 };
  const parts = {};
  for (const [k, max] of [['rule', LIMITS.rule], ['why', LIMITS.why], ['scope', LIMITS.scope]]) {
    if (b[k] === undefined) continue;
    const t = text(b[k], max, k, k === 'rule'); if (t.error) return t;
    parts[k] = clip(t.value, max);
  }
  if (b.status !== undefined && !STATUSES.includes(b.status)) return { error: `status must be one of ${STATUSES.join(', ')}` };
  if (!Object.keys(parts).length && b.status === undefined) return { error: 'nothing to change: give rule, why, scope or status' };
  Object.assign(r, parts);
  if (b.status !== undefined) r.status = b.status;
  return { rule: r };
}
function keep(d, id, ms) {
  const r = find(d, id); if (!r) return { error: 'no such rule', status: 404 };
  r.status = 'active'; r.last_checked = iso(ms);
  return { rule: r };
}
function remove(d, id) {
  const r = find(d, id); if (!r) return { error: 'no such rule', status: 404 };
  d.rules.splice(d.rules.indexOf(r), 1);
  return { rule: r };
}
function view(r) { return { id: r.id, rule: r.rule, why: r.why, scope: r.scope, quote: r.quote, created: r.created, source: r.source, hits: r.hits, last_hit: r.last_hit, repeats: r.repeats, last_checked: r.last_checked, status: r.status }; }

// ---- lifecycle and relevance
// candidates not relevant for candidate_days go off; active rules not checked for review_days go to review.
function age(d, cfg, ms) {
  let changed = false;
  for (const r of d.rules) {
    if (r.status === 'candidate' && ms - Date.parse(r.last_hit || r.created) > cfg.candidate_days * DAY) { r.status = 'off'; changed = true; }
    else if (r.status === 'active' && ms - Date.parse(r.last_checked || r.created) > cfg.review_days * DAY) { r.status = 'review'; changed = true; }
  }
  return changed;
}
function relevant(d, request, cfg) {
  const req = tset(request);
  const out = [];
  for (const r of d.rules) {
    if (r.status === 'off') continue;
    const n = overlap(req, ruleTokens(r));
    if (n >= cfg.min_overlap) out.push({ r, n });
  }
  out.sort((a, b) => ((b.r.repeats >= 2) - (a.r.repeats >= 2)) || (b.n - a.n) || (Date.parse(b.r.created) - Date.parse(a.r.created)));
  return out.slice(0, cfg.max_inject).map(x => x.r);
}
function search(d, q) {
  const req = tset(q);
  return d.rules.map(r => ({ r, n: overlap(req, ruleTokens(r)) })).filter(x => x.n >= 1).sort((a, b) => b.n - a.n).map(x => x.r);
}

module.exports = { LIMITS, ID_RE, STATUSES, now, iso, clip, oneLine, text, load, save, update, detect, tokens, recordSeen, quoteSeen, addRule, propose, addOwner, edit, keep, remove, find, view, age, relevant, search };
