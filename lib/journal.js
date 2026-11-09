'use strict';
// Append-only progress journal. One JSON line per record, fsynced, so a
// power cut loses at most the line being written (a torn tail line is skipped
// on read and reported).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const STATE = process.env.HARNESS_STATE_DIR || path.join(ROOT, 'state');
const JOURNAL = path.join(STATE, 'journal.jsonl');

function newId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function append(rec) {
  fs.mkdirSync(STATE, { recursive: true });
  const line = JSON.stringify({ id: newId(), ts: new Date().toISOString(), ...rec }) + '\n';
  const fd = fs.openSync(JOURNAL, 'a+');
  try {
    // A torn tail (power cut mid-write) has no '\n'. Close it first, or this
    // record would glue onto it and both lines would be skipped on read.
    const size = fs.fstatSync(fd).size;
    let pre = '';
    if (size > 0) {
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, size - 1);
      if (b[0] !== 0x0a) pre = '\n';
    }
    fs.writeSync(fd, pre + line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return JSON.parse(line);
}

function readAll() {
  let raw = '';
  try { raw = fs.readFileSync(JOURNAL, 'utf8'); } catch (e) {
    // Only "no journal yet" means empty. Anything else fails closed: acting on
    // a journal we could not read could repeat effects.
    if (e.code === 'ENOENT') return { records: [], torn: 0 };
    process.stderr.write(`journal: cannot read ${JOURNAL} (${e.code || e.message}); stopping. Ask ${require('./config').owner()}.\n`);
    process.exit(5);
  }
  const records = [];
  let torn = 0;
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    try { records.push(JSON.parse(l)); } catch { torn++; }
  }
  return { records, torn };
}

// Latest started task with no task_done record.
function openTask(records) {
  const done = new Set(records.filter(r => r.type === 'task_done').map(r => r.task_id));
  const starts = records.filter(r => r.type === 'task_start' && !done.has(r.task_id));
  return starts.length ? starts[starts.length - 1] : null;
}

// effect_id -> { intent, done } for one task
function effectState(records, taskId) {
  const m = new Map();
  for (const r of records) {
    if (r.task_id !== taskId || !r.effect_id) continue;
    const e = m.get(r.effect_id) || { effect_id: r.effect_id };
    if (r.type === 'effect_intent') e.intent = r;
    if (r.type === 'effect_done') e.done = r;
    if (r.type === 'effect_uncertain') e.uncertain = r;
    m.set(r.effect_id, e);
  }
  return m;
}

// Pid liveness. EPERM means the process exists but belongs to someone else.
// A recycled pid looks alive; that fails safe (we wait instead of acting twice).
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const nap = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Remove a file, retrying transient Windows errors (EPERM/EBUSY/EACCES, e.g. a
// scanner or a racing reader holds it). ENOENT counts as removed. Returns true
// when the file is gone, false if it is still there after the retries.
// The synchronous nap blocks the event loop, so it is bounded: 5 tries with naps
// of 5+10+15+20 = 50 ms in total.
// stillOurs (optional) is called before EVERY attempt; if it returns false the
// file may now belong to someone else, so we stop and never unlink it: the result
// is true only if the file is already gone.
// Only an explicit ENOENT proves the file is gone; existsSync() is also false on a
// transient access error, which would end the retries with the lock still there.
function gone(file) {
  try { fs.lstatSync(file); return false; } catch (e) { return e.code === 'ENOENT'; }
}

function unlinkRetry(file, tries = 5, stillOurs) {
  for (let i = 0; i < tries; i++) {
    if (stillOurs && !stillOurs()) return gone(file);
    try { fs.unlinkSync(file); return true; } catch (e) {
      if (e.code === 'ENOENT') return true;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) return false;
      if (i < tries - 1) nap(5 * (i + 1));
    }
  }
  return false;
}

// Exclusive lock file holding { pids: [...], nonce }. Created atomically (hard
// link of a complete temp file), so a reader never sees a half-written lock.
// The random nonce makes every lock's content unique, so "is this still the
// lock I judged / the lock I own" is a content compare.
// A lock whose pids are all dead was left by a killed owner. Takeover is serialized
// by a breaker mutex <file>.break (exclusive create, held only while breaking): under it
// the lock is re-read and unlinked only if byte-identical to the content judged dead.
// A lock is never renamed back over the path, so a lock another process created
// meanwhile is never overwritten or hidden. The .break file holds { pid, t }; it is stale
// when its pid is dead or it is older than BREAK_STALE_MS (an unparseable one: by mtime).
// Residual: reclaiming a stale .break re-reads it before unlinking, but a stale-.break
// reclaim racing another reclaim can still, in a window of microseconds, remove a
// freshly created .break; the lock-content compare still protects the lock itself.
// Returns { held: true, nonce } or { held: false, holder }.
const BREAK_STALE_MS = 10000;
function breakStale(brk) {
  let raw; try { raw = fs.readFileSync(brk, 'utf8'); } catch { return; }
  let b = null; try { b = JSON.parse(raw); } catch {}
  let stale;
  if (b && Number.isInteger(b.pid)) stale = !alive(b.pid) || !(Date.now() - b.t < BREAK_STALE_MS);
  else { let age = 0; try { age = Date.now() - fs.statSync(brk).mtimeMs; } catch { return; } stale = age > BREAK_STALE_MS; }
  if (!stale) return;
  try { if (fs.readFileSync(brk, 'utf8') === raw) fs.unlinkSync(brk); } catch {}
}

// Under the mutex: unlink the lock only if it still equals `seen`. hooks.afterMutex is a test seam.
function breakLock(file, seen, hooks) {
  const brk = file + '.break';
  let fd;
  try { fd = fs.openSync(brk, 'wx'); } catch (e) {
    if (e.code === 'EEXIST') breakStale(brk);
    return false;
  }
  const mine = JSON.stringify({ pid: process.pid, t: Date.now() });
  const same = (f, want) => () => { try { return fs.readFileSync(f, 'utf8') === want; } catch { return false; } };
  try {
    try { fs.writeSync(fd, mine); } catch {}
    try { fs.closeSync(fd); } catch {}
    if (hooks && hooks.afterMutex) hooks.afterMutex();
    let cur; try { cur = fs.readFileSync(file, 'utf8'); } catch { return true; }
    // re-check the bytes before EVERY unlink attempt: after a failed try (EPERM/EBUSY) a new holder may own the path
    if (cur === seen) unlinkRetry(file, 5, same(file, seen));
    return true;
  } finally { unlinkRetry(brk, 5, same(brk, mine)); }
}

function lock(file, rec, hooks) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const nonce = crypto.randomBytes(8).toString('hex');
  const tmp = `${file}.${process.pid}.${nonce}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...rec, nonce }));
  try {
    for (let i = 0; i < 50; i++) {
      try { fs.linkSync(tmp, file); return { held: true, nonce }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
      let held; try { held = fs.readFileSync(file, 'utf8'); } catch { nap(5); continue; }
      let h = null; try { h = JSON.parse(held); } catch {}
      if (!h) { // unreadable (power cut): stale only once it is clearly old
        let age = 0; try { age = Date.now() - fs.statSync(file).mtimeMs; } catch {}
        if (age < 10000) return { held: false, holder: { pids: [], note: 'unreadable lock' } };
      } else if ((h.pids || []).some(alive)) return { held: false, holder: h };
      if (hooks && hooks.afterSeen) hooks.afterSeen();
      if (!breakLock(file, held, hooks)) nap(5);
    }
    return { held: false, holder: { pids: [], note: 'lock contention' } };
  } finally { unlinkRetry(tmp); }
}

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Replace a lock we hold (atomic rename), e.g. to add the engine's pid.
function relock(file, rec, nonce) {
  const tmp = `${file}.${process.pid}.${nonce}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...rec, nonce }));
  fs.renameSync(tmp, file);
}

// Release only a lock whose content is ours.
// Residual (documented, inherent to path-based locks): between the nonce re-read and
// unlink another process could replace the file. That needs our live lock to have been
// broken as stale first, which only happens past the stale age; the pre-change code had
// the same window.
function unlock(file, nonce) {
  const ours = () => { const h = readLock(file); return !!(h && h.nonce === nonce); };
  if (!ours()) return false;
  // re-checked before every unlink attempt: the lock may be replaced during a nap
  return unlinkRetry(file, 5, ours); // false: still on disk after retries, or no longer ours
}

const HISTORY_MAX = 40;

// The resume prompt. "Current task" holds the live request verbatim and comes
// first; "History" is a separate, bounded section after it. History text is
// never used to wrap or re-quote the request.
function buildPrompt(records, task) {
  const steps = records.filter(r => r.task_id === task.task_id && r.type === 'step');
  const effects = [...effectState(records, task.task_id).values()];
  const hist = [];
  for (const s of steps) hist.push(`- step ${s.step} ${s.status}: ${s.note || ''}`.trim());
  for (const e of effects) {
    if (e.done) hist.push(`- effect ${e.effect_id} DONE (${e.done.mode}) ${e.intent ? e.intent.kind + ' ' + (e.intent.target || '') : ''} -- do NOT redo`);
    else if (e.uncertain) hist.push(`- effect ${e.effect_id} UNCERTAIN -- stop and ask ${require('./config').owner()} before retrying`);
    else if (e.intent) hist.push(`- effect ${e.effect_id} STARTED, not confirmed -- re-run the same effect.js command; it reconciles instead of repeating`);
  }
  // history_note: a line a module wants the resumed agent to see (e.g. an owner's answer).
  for (const n of records) if (n.task_id === task.task_id && n.type === 'history_note' && n.note) hist.push('- note: ' + n.note);
  const shown = hist.slice(-HISTORY_MAX);
  const omitted = hist.length - shown.length;
  return [
    `## Current task (task_id: ${task.task_id})`,
    task.request,
    '',
    '## History (journal record for this task; read-only)',
    task.resumed ? 'This is a resumed run after an interruption.' : 'Fresh start; no history yet.',
    omitted > 0 ? `(${omitted} older entries omitted)` : '',
    ...(shown.length ? shown : ['- none']),
  ].filter(l => l !== '').join('\n');
}

// For long-lived processes: when unlock() fails (file held open), retry off the
// request path so a stranded lock carrying our live pid cannot block others until
// restart. unlock() re-checks the nonce each time. Timers are unref'd; reports once.
function unlockLater(file, nonce, delays = [100, 500, 2000], label = 'lock') {
  const step = i => {
    if (i >= delays.length) { console.error(`${label}: could not release ${file}; remove it or restart`); return; }
    const t = setTimeout(() => {
      let done = false; try { done = unlock(file, nonce); } catch {}
      if (done) return;
      // stop only on proof: file gone (ENOENT) or a parsed lock with another nonce.
      // A transient read error or a half-written file is not proof; keep retrying.
      let raw = null;
      try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return; }
      if (raw !== null) { let h = null; try { h = JSON.parse(raw); } catch {} if (h && h.nonce !== nonce) return; }
      step(i + 1);
    }, delays[i]);
    if (t.unref) t.unref();
  };
  step(0);
}


// Approval waiter heartbeat: bin/approve-mcp.js rewrites state/waiters/<pid>.json while it polls a live card. A pid
// alone is not proof (pids get reused), so a live card's waiter counts as present only while its pid is alive AND
// this file is fresh. A forged or stale-but-fresh file only keeps a card pending, which fails safe.
const WAITERS = () => path.join(STATE, 'waiters');
const waiterFile = pid => path.join(WAITERS(), `${pid}.json`);
// A waiter's stale window from its poll interval: ten polls, at least 30 s. The waiter writes its own window into the
// beat (stale_ms), so a reader with a different poll setting still waits long enough; capped at a day.
const staleFor = pollMs => Math.max(30000, 10 * (Number(pollMs) > 0 ? Number(pollMs) : 1000));
const STALE_CAP_MS = 24 * 3600 * 1000;
// Written to a temp file and renamed into place, so a reader never sees a half-written beat. Returns whether it landed.
function waiterBeat(pid = process.pid, staleMs = staleFor(process.env.HARNESS_APPROVE_POLL_MS)) {
  try {
    fs.mkdirSync(WAITERS(), { recursive: true });
    const tmp = `${waiterFile(pid)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ pid, t: Date.now(), stale_ms: staleMs }));
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, waiterFile(pid)); return true; }
      catch { if (i >= 2) { try { fs.unlinkSync(tmp); } catch { /* best effort */ } return false; } }
    }
  } catch { return false; }
}
function waiterDone(pid = process.pid) { try { fs.unlinkSync(waiterFile(pid)); } catch { /* gone already */ } }
// Missing file: not fresh. A file that cannot be read or parsed right now (a rename in flight, a Windows sharing
// error) is retried once and then counted as fresh: unknown never sweeps a card.
function waiterFresh(pid, staleMs, nowMs = Date.now()) {
  for (let i = 0; i < 2; i++) {
    let raw;
    try { raw = fs.readFileSync(waiterFile(pid), 'utf8'); }
    catch (e) { if (e && e.code === 'ENOENT') return false; continue; }
    let h;
    try { h = JSON.parse(raw); } catch { continue; }
    if (!h || h.pid !== pid || !Number.isFinite(h.t)) return false;
    const own = Number.isFinite(h.stale_ms) && h.stale_ms > 0 ? Math.min(h.stale_ms, STALE_CAP_MS) : 0;
    return nowMs - h.t <= Math.max(staleMs, own);
  }
  return true;
}

module.exports = { staleFor, STALE_CAP_MS, waiterBeat, waiterDone, waiterFresh, unlockLater, ROOT, STATE, JOURNAL, append, readAll, openTask, effectState, buildPrompt, newId, alive, lock, relock, unlock, unlinkRetry, readLock };
