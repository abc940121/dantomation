'use strict';
// memory-tiers store: one JSON file (data.json) in the module state dir holds every item with a tier
// field (core | recall | archive). Pure functions over a plain object plus load/save and a lock.
// Texts stay in this file; the journal gets metadata only. Every tier has a retention cap.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ITEM_MAX = 400; // chars per item in any tier
const ID_RE = /^m-[0-9a-f]{12}$/;
const DAY = 86400000;
const TIERS = ['core', 'recall', 'archive'];
const HARD = { items: 2000 }; // absolute ceiling over all tiers, whatever the settings say
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const now = () => {
  const v = process.env.HARNESS_NOW;
  if (v) { const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v); if (Number.isFinite(n)) return n; }
  return Date.now();
};
const iso = ms => new Date(ms).toISOString();
const newId = () => `m-${crypto.randomBytes(6).toString('hex')}`;
const flat = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const clip = (s, n) => { s = flat(s); return s.length > n ? s.slice(0, n - 3) + '...' : s; };
const msOf = it => Date.parse(it.ts) || 0;

// Owner text: one line of plain text, no control characters, at most ITEM_MAX chars.
function ownerText(v) {
  if (typeof v !== 'string') return { error: 'text must be a string' };
  const c = flat(v);
  if (!c) return { error: 'text is required' };
  if (CTRL.test(v.replace(/[\t\r\n]/g, ' '))) return { error: 'text has control characters' };
  if (c.length > ITEM_MAX) return { error: `text must be at most ${ITEM_MAX} characters` };
  return { value: c };
}

// ---- file
const fileOf = dir => path.join(dir, 'data.json');
function sane(it) {
  return it && typeof it === 'object' && ID_RE.test(it.id) && TIERS.includes(it.tier) && typeof it.text === 'string' && typeof it.ts === 'string';
}
function load(dir) {
  let d = null;
  try { d = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('memory-tiers data.json unreadable: ' + e.message);
  }
  const items = d && Array.isArray(d.items) ? d.items.filter(sane) : [];
  return { items };
}
function save(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const f = fileOf(dir), tmp = f + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  try { fs.renameSync(tmp, f); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
}

// ---- lock: owner token; unlink only our own token; a stale lock is broken by rename then verify.
const STALE_MS = 30000, WAIT_MS = 5000;
const sleep = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait available */ } };
const readTok = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
function breakStale(lock, seen) {
  // Move the stale lock aside, then check that what we moved is what we judged stale.
  const aside = lock + '.stale-' + crypto.randomBytes(4).toString('hex');
  try { fs.renameSync(lock, aside); } catch { return; } // someone else broke it first
  if (readTok(aside) === seen) { try { fs.unlinkSync(aside); } catch { /* gone */ } return; }
  // We moved a live lock that replaced the stale one: put it back if the slot is still free.
  try { if (!fs.existsSync(lock)) fs.renameSync(aside, lock); else fs.unlinkSync(aside); } catch { /* best effort */ }
}
function update(dir, fn, limits) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'lock');
  const token = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
  const end = Date.now() + WAIT_MS;
  for (;;) {
    try { fs.writeFileSync(lock, token, { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const seen = readTok(lock);
      let age = 0; try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { age = 0; }
      if (seen !== null && age > STALE_MS) { breakStale(lock, seen); continue; }
      if (Date.now() > end) throw new Error('memory-tiers store is busy');
      sleep(20);
    }
  }
  try {
    const data = load(dir);
    const r = fn(data);
    if (r && !r.error) { enforce(data, limits || DEFAULT_LIMITS, now()); save(dir, data); }
    return r;
  } finally { if (readTok(lock) === token) { try { fs.unlinkSync(lock); } catch { /* gone */ } } }
}

// ---- tiers
const DEFAULT_LIMITS = { core_chars: 1500, recall_max: 20, recall_days: 14, archive_max: 500 };
const inTier = (data, t) => data.items.filter(i => i.tier === t);
const find = (data, id) => data.items.find(i => i.id === id) || null;
const coreChars = data => inTier(data, 'core').reduce((n, i) => n + i.text.length, 0);

// Demotion and retention, run after every write: recall past its count or age goes to archive (oldest
// first); archive past its cap is deleted (oldest first); the absolute ceiling trims archive then recall.
// Core is never trimmed here: it is owner-curated and its budget is checked when pinning.
function enforce(data, L, t) {
  const rec = () => inTier(data, 'recall').sort((a, b) => msOf(a) - msOf(b));
  for (const it of rec()) if (L.recall_days > 0 && t - msOf(it) > L.recall_days * DAY) it.tier = 'archive';
  const r = rec();
  while (r.length > L.recall_max) r.shift().tier = 'archive';
  const drop = it => { data.items.splice(data.items.indexOf(it), 1); };
  let a = inTier(data, 'archive').sort((x, y) => msOf(x) - msOf(y));
  while (a.length > L.archive_max) drop(a.shift());
  while (data.items.length > HARD.items) {
    a = inTier(data, 'archive').sort((x, y) => msOf(x) - msOf(y));
    const victim = a[0] || rec()[0] || null;
    if (!victim) break;
    drop(victim);
  }
}

const recallIsLive = (it, L, t) => !(L.recall_days > 0 && t - msOf(it) > L.recall_days * DAY);

// Record a finished task's reply as a recall item (one per task; a repeat replaces the old row).
function addRecall(data, { task_id, text }) {
  const c = clip(text, ITEM_MAX);
  if (!c) return { error: 'nothing to record' };
  const tid = typeof task_id === 'string' ? clip(task_id, 80) : '';
  if (tid) data.items = data.items.filter(i => !(i.task_id === tid && i.tier !== 'core'));
  const it = { id: newId(), tier: 'recall', text: c, task_id: tid, ts: iso(now()), from: 'task' };
  data.items.push(it);
  return { item: it };
}

// pin: new text, or an existing recall/archive item by id, goes into core if it fits the budget.
function pin(data, input, L) {
  let it, text;
  if (input && input.id !== undefined) {
    if (typeof input.id !== 'string' || !ID_RE.test(input.id)) return { error: 'bad id', status: 400 };
    it = find(data, input.id);
    if (!it) return { error: 'no such item', status: 404 };
    if (it.tier === 'core') return { error: 'already pinned', status: 409 };
    text = it.text;
  } else {
    const v = ownerText(input && input.text); if (v.error) return { error: v.error, status: 400 };
    text = v.value;
  }
  if (inTier(data, 'core').some(c => c.text.toLowerCase() === text.toLowerCase())) return { error: 'that fact is already pinned', status: 409 };
  if (coreChars(data) + text.length > L.core_chars) return { error: `core budget is ${L.core_chars} chars; ${coreChars(data)} used, this needs ${text.length}. Unpin or forget something first`, status: 409 };
  const t = iso(now());
  if (it) { it.tier = 'core'; it.ts = t; it.from = 'promoted'; } else { it = { id: newId(), tier: 'core', text, task_id: '', ts: t, from: 'owner' }; data.items.push(it); }
  return { item: it };
}

// unpin: core -> recall (demotion). Fresh timestamp so it is not aged out at once.
function unpin(data, id) {
  const it = ID_RE.test(id || '') ? find(data, id) : null;
  if (!it) return { error: 'no such item', status: 404 };
  if (it.tier !== 'core') return { error: 'not pinned', status: 409 };
  it.tier = 'recall'; it.ts = iso(now()); it.from = 'demoted';
  return { item: it };
}

// restore: archive -> recall, so a fetched old item can ride along in the next prompts again.
function restore(data, id) {
  const it = ID_RE.test(id || '') ? find(data, id) : null;
  if (!it) return { error: 'no such item', status: 404 };
  if (it.tier !== 'archive') return { error: 'not in the archive', status: 409 };
  it.tier = 'recall'; it.ts = iso(now()); it.from = 'restored';
  return { item: it };
}

function forget(data, id) {
  const it = ID_RE.test(id || '') ? find(data, id) : null;
  if (!it) return { error: 'no such item', status: 404 };
  data.items.splice(data.items.indexOf(it), 1);
  return { item: it };
}

// Keyword search: every term must appear (case-insensitive substring). Rank by how often the terms
// occur, then newest first.
function search(data, query, tiers, limit) {
  const terms = flat(query).toLowerCase().split(' ').filter(Boolean).slice(0, 8);
  if (!terms.length) return { error: 'q is required', status: 400 };
  const rows = [];
  for (const it of data.items) {
    if (!tiers.includes(it.tier)) continue;
    const low = it.text.toLowerCase();
    if (!terms.every(w => low.includes(w))) continue;
    rows.push({ it, score: terms.reduce((n, w) => n + low.split(w).length - 1, 0) });
  }
  rows.sort((a, b) => b.score - a.score || msOf(b.it) - msOf(a.it));
  return { items: rows.slice(0, Math.max(1, Math.min(limit || 20, 100))).map(r => r.it) };
}

const view = it => ({ id: it.id, tier: it.tier, text: it.text, task_id: it.task_id || '', ts: it.ts, from: it.from || '' });
const counts = data => ({ core: inTier(data, 'core').length, recall: inTier(data, 'recall').length, archive: inTier(data, 'archive').length, core_chars: coreChars(data) });

module.exports = { ITEM_MAX, ID_RE, TIERS, DEFAULT_LIMITS, STALE_MS, now, iso, clip, load, save, update, enforce, inTier, find, coreChars, recallIsLive, addRecall, pin, unpin, restore, forget, search, view, counts, ownerText, msOf };
