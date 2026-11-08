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

// Exclusive lock file holding { pids: [...], nonce }. Created atomically (hard
// link of a complete temp file), so a reader never sees a half-written lock.
// The random nonce makes every lock's content unique, so "is this still the
// lock I judged / the lock I own" is a content compare.
// A lock whose pids are all dead was left by a killed owner. Takeover: rename
// it to a unique name (only one renamer can win), check the renamed content is
// the one judged dead (else put it back), delete it, retry the link.
// Returns { held: true, nonce } or { held: false, holder }.
function lock(file, rec) {
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
      const grave = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`;
      try { fs.renameSync(file, grave); } catch { nap(5); continue; } // lost the rename, or file busy
      let moved = null; try { moved = fs.readFileSync(grave, 'utf8'); } catch {}
      if (moved !== held) { try { fs.linkSync(grave, file); } catch {} } // not the dead lock: put it back
      try { fs.unlinkSync(grave); } catch {}
    }
    return { held: false, holder: { pids: [], note: 'lock contention' } };
  } finally { try { fs.unlinkSync(tmp); } catch {} }
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
function unlock(file, nonce) {
  const h = readLock(file);
  if (h && h.nonce === nonce) { try { fs.unlinkSync(file); } catch {} return true; }
  return false;
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

module.exports = { ROOT, STATE, JOURNAL, append, readAll, openTask, effectState, buildPrompt, newId, alive, lock, relock, unlock, readLock };
