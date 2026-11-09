'use strict';
// goals store: one JSON file (data.json) in the module state dir holds both the goal rows and
// the lesson rows. Pure functions over a plain object plus load/save; no conversation text is ever
// read from anywhere: every row comes from an explicit owner call. Texts stay in this file (they can
// hold private words); the journal gets metadata only.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LIMITS = { goal: 2000, part: 1000, what: 500, missed: 300, fix: 500 };
const ID_RE = /^(g|l)-[0-9a-f]{12}$/;
const LOCK_STALE_MS = 30000, LOCK_WAIT_MS = 5000;
const DEFAULT_RETENTION = { max_replaced_goals: 50, max_lessons: 200, max_repeats_per_lesson: 100 };
const DAY = 86400000;
const WEEK = 7 * DAY;
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const now = () => {
  const v = process.env.HARNESS_NOW;
  if (v) { const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v); if (Number.isFinite(n)) return n; }
  return Date.now();
};
const iso = ms => new Date(ms).toISOString();
const clean = s => String(s).replace(/\r\n?/g, '\n').trim();
const newId = p => `${p}-${crypto.randomBytes(6).toString('hex')}`;

function text(v, max, name, required) {
  if (v === undefined || v === null || v === '') return required ? { error: `${name} is required` } : { value: '' };
  if (typeof v !== 'string') return { error: `${name} must be a string` };
  const c = clean(v);
  if (!c) return required ? { error: `${name} is required` } : { value: '' };
  if (c.length > max) return { error: `${name} must be at most ${max} characters` };
  if (CTRL.test(c)) return { error: `${name} has control characters` };
  return { value: c };
}

// ---- file
const fileOf = dir => path.join(dir, 'data.json');
function load(dir) {
  let d;
  try { d = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('goals data.json unreadable: ' + e.message); d = null; }
  if (!d || typeof d !== 'object') d = {};
  return { goals: Array.isArray(d.goals) ? d.goals : [], lessons: Array.isArray(d.lessons) ? d.lessons : [] };
}
function save(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const f = fileOf(dir), tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
// Lock with an owner token. The lock file holds "<pid>.<random>"; only its holder removes it.
// A stale lock is broken by renaming it aside, confirming the renamed file is still the stale
// content that was seen (not a successor's fresh lock), and only then deleting it.
function lockAcquire(lockFile, { staleMs, waitMs, transient, sleepMs, busyError }) {
  const token = `${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  const start = Date.now();
  for (;;) {
    try { fs.writeFileSync(lockFile, token, { flag: 'wx' }); return token; } catch (e) {
      if (e.code !== 'EEXIST' && !transient.has(e.code)) throw e;
    }
    try {
      if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) {
        const seen = fs.readFileSync(lockFile, 'utf8');
        const aside = `${lockFile}.${token}.stale`;
        fs.renameSync(lockFile, aside);
        let same = false;
        try { same = fs.readFileSync(aside, 'utf8') === seen && Date.now() - fs.statSync(aside).mtimeMs > staleMs; } catch { /* gone */ }
        if (same) { try { fs.unlinkSync(aside); } catch { /* gone */ } continue; }
        // We moved a live successor's lock: put it back without clobbering, then retry.
        try { fs.linkSync(aside, lockFile); } catch { /* someone else took the name */ }
        try { fs.unlinkSync(aside); } catch { /* gone */ }
        continue;
      }
    } catch { /* raced */ }
    if (Date.now() - start > waitMs) throw busyError();
    sleepMs(5);
  }
}
function lockRelease(lockFile, token) {
  try { if (fs.readFileSync(lockFile, 'utf8') === token) fs.unlinkSync(lockFile); } catch { /* gone or not ours */ }
}

// Read-modify-write under a simple lock file so the server and the CLI do not lose each other's rows.
function update(dir, fn) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'lock');
  const token = lockAcquire(lock, { staleMs: LOCK_STALE_MS, waitMs: LOCK_WAIT_MS, transient: new Set(['EPERM', 'EACCES', 'EBUSY']), sleepMs: ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), busyError: () => new Error('goals store is busy') });
  try {
    const data = load(dir);
    const r = fn(data);
    if (r && !r.error) save(dir, data);
    return r;
  } finally { lockRelease(lock, token); }
}

// ---- retention (settings override DEFAULT_RETENTION)
const limit = (ret, k) => { const v = ret && ret[k]; return Number.isInteger(v) && v >= 1 ? v : DEFAULT_RETENTION[k]; };
// Keep the active goal and the newest closed ones; drop the oldest beyond the cap.
function pruneGoals(data, ret) {
  const cap = limit(ret, 'max_replaced_goals');
  const closed = data.goals.filter(g => g.state !== 'active');
  if (closed.length <= cap) return;
  const drop = new Set(closed.slice(0, closed.length - cap)); // rows are in creation order
  data.goals = data.goals.filter(g => !drop.has(g));
}
// Over the cap: drop stale lessons oldest first, then the oldest of the rest. The lesson just added stays.
function pruneLessons(data, fresh, ret, windowWeeks) {
  const cap = limit(ret, 'max_lessons');
  let over = data.lessons.length - cap;
  if (over <= 0) return;
  const t = now(), w = windowWeeks || 2;
  const old = data.lessons.filter(l => l !== fresh);
  const stale = old.filter(l => status(l, w, t) === 'stale');
  const order = [...stale, ...old.filter(l => !stale.includes(l))];
  const drop = new Set(order.slice(0, over));
  data.lessons = data.lessons.filter(l => !drop.has(l));
}

// ---- goals
const activeGoal = data => data.goals.find(g => g.state === 'active') || null;

// Interview: what is still missing before the owner can confirm. Questions only; nothing is guessed.
function missing(g) {
  const q = [];
  if (!g) return ['What is the goal, in your own words?'];
  if (!g.done) q.push('What does done look like? Name something you could check (a file, a test, a screen).');
  if (!g.out_of_scope) q.push('What is out of scope? Name what must not change or be added.');
  if (!g.confirmed) q.push('Is this card right? Confirm it once (goal confirm) and work is checked against it.');
  return q;
}

function setGoal(data, input, ret) {
  const v = text(input && input.verbatim, LIMITS.goal, 'verbatim', true); if (v.error) return v;
  const d = text(input && input.done, LIMITS.part, 'done', false); if (d.error) return d;
  const o = text(input && input.out_of_scope, LIMITS.part, 'out_of_scope', false); if (o.error) return o;
  const t = now();
  for (const g of data.goals) if (g.state === 'active') { g.state = 'replaced'; g.closed_at = iso(t); }
  const g = { goal_id: newId('g'), verbatim: v.value, done: d.value, out_of_scope: o.value, confirmed: false, confirmed_at: null, state: 'active', created_at: iso(t), closed_at: null };
  data.goals.push(g);
  pruneGoals(data, ret);
  return { goal: g };
}
function editGoal(data, input) {
  const g = activeGoal(data); if (!g) return { error: 'no active goal', status: 404 };
  const t = {};
  if (input && input.done !== undefined) { t.done = text(input.done, LIMITS.part, 'done', false); if (t.done.error) return t.done; }
  if (input && input.out_of_scope !== undefined) { t.out = text(input.out_of_scope, LIMITS.part, 'out_of_scope', false); if (t.out.error) return t.out; }
  if (!t.done && !t.out) return { error: 'give done and/or out_of_scope' };
  if (t.done) g.done = t.done.value;
  if (t.out) g.out_of_scope = t.out.value;
  // An edit changes what the owner agreed to, so it needs a new confirmation.
  g.confirmed = false; g.confirmed_at = null;
  return { goal: g };
}
function confirmGoal(data) {
  const g = activeGoal(data); if (!g) return { error: 'no active goal', status: 404 };
  if (!g.done || !g.out_of_scope) return { error: 'cannot confirm yet: ' + missing(g).filter(x => !/Confirm it once/.test(x)).join(' '), status: 409 };
  if (!g.confirmed) { g.confirmed = true; g.confirmed_at = iso(now()); }
  return { goal: g };
}
function closeGoal(data, how) {
  const g = activeGoal(data); if (!g) return { error: 'no active goal', status: 404 };
  g.state = how === 'dropped' ? 'dropped' : 'done'; g.closed_at = iso(now());
  return { goal: g };
}

// ---- lessons
function addLesson(data, input, ret, windowWeeks) {
  const w = text(input && input.what, LIMITS.what, 'what', true); if (w.error) return w;
  const m = text(input && input.missed_by, LIMITS.missed, 'missed_by', true); if (m.error) return m;
  const f = text(input && input.fix, LIMITS.fix, 'fix', true); if (f.error) return f;
  const l = { lesson_id: newId('l'), what: w.value, missed_by: m.value, fix: f.value, created_at: iso(now()), repeats: [] };
  data.lessons.push(l);
  pruneLessons(data, l, ret, windowWeeks);
  return { lesson: l };
}
function repeatLesson(data, id, ret) {
  const l = data.lessons.find(x => x.lesson_id === id);
  if (!l) return { error: 'no such lesson', status: 404 };
  l.repeats.push(iso(now()));
  const cap = limit(ret, 'max_repeats_per_lesson');
  if (l.repeats.length > cap) l.repeats = l.repeats.slice(l.repeats.length - cap);
  return { lesson: l };
}

// Monday 00:00 UTC of the week holding ms, as YYYY-MM-DD.
function weekStart(ms) { const d = new Date(ms); const dow = (d.getUTCDay() + 6) % 7; return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)).slice(0, 10); }
function weekly(l) {
  const out = {};
  for (const r of l.repeats) { const k = weekStart(Date.parse(r)); out[k] = (out[k] || 0) + 1; }
  return out;
}
// A lesson is kept only if its repeats drop. Compare the last `window` weeks with the `window` weeks
// before. Younger than two windows: 'new' (too early to judge, still injected). Then:
//   recent < prior            kept (repeats dropped)
//   recent = 0 and prior = 0  kept (never repeated)
//   otherwise                 stale (repeats did not drop: the lesson does not work, rewrite or drop it)
function status(l, windowWeeks, t) {
  const w = windowWeeks * WEEK;
  const created = Date.parse(l.created_at);
  if (t - created < 2 * w) return 'new';
  let recent = 0, prior = 0;
  for (const r of l.repeats) { const age = t - Date.parse(r); if (age < w) recent++; else if (age < 2 * w) prior++; }
  if (recent < prior || (recent === 0 && prior === 0)) return 'kept';
  return 'stale';
}
function lessonView(l, windowWeeks, t) {
  return { lesson_id: l.lesson_id, what: l.what, missed_by: l.missed_by, fix: l.fix, created_at: l.created_at, repeat_count: l.repeats.length, weekly: weekly(l), status: status(l, windowWeeks, t === undefined ? now() : t) };
}

module.exports = { lockAcquire, lockRelease, DEFAULT_RETENTION, LIMITS, ID_RE, load, save, update, now, activeGoal, missing, setGoal, editGoal, confirmGoal, closeGoal, addLesson, repeatLesson, weekly, weekStart, status, lessonView };
