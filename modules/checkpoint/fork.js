'use strict';
// Fork from step N: list the steps of a task, restore snapshot N into a NEW folder
// (never the original), diff two steps, keep a capped list of fork records.
//   - A step is a checkpoint (journal kind "checkpoint"); its snapshot is the state
//     BEFORE that tool call. Forking from step N therefore gives the folder as it was
//     just before step N ran.
//   - The fork dir is written with checkout-index --prefix from a private index, so the
//     original folder and its .git are only read, never written.
//   - Records: state/ckpt/forks/records.json. Dirs: <fork base>/<fork id>.
const fs = require('fs');
const path = require('path');
const J = require('../../lib/journal');
const C = require('./checkpoint');

const CK = path.join(J.STATE, 'ckpt');
const FORKS = path.join(CK, 'forks');
const RECORDS = path.join(FORKS, 'records.json');
const ID_RE = /^[A-Za-z0-9][\w.-]{0,119}$/; // task and fork ids; no separators, no leading dot
const same = (a, b) => process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root, p) => { const r = path.relative(root, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

function checkTask(task) {
  if (typeof task !== 'string' || !ID_RE.test(task) || task.includes('..')) throw new Error('invalid task id');
  return task;
}
function checkStep(n) {
  if (!/^[1-9]\d{0,8}$/.test(String(n))) throw new Error('step must be a positive integer');
  return Number(n);
}
const refOf = (task, n) => `refs/harness/ckpt/${C.safeId(task)}/${n}`;
const g = args => C.git(CK, path.join(CK, 'none.index'), args);

function resolveRef(task, n) {
  C.ensureRepo();
  try { return g(['rev-parse', '--verify', '-q', refOf(task, n) + '^{commit}']).trim(); } catch { throw new Error(`no step ${n} for task ${task}`); }
}

// Steps of a task, oldest first. Restore's own safety checkpoints are shown but flagged.
function steps(task) {
  checkTask(task);
  const out = [];
  for (const r of J.readAll().records) {
    if (r.type !== 'checkpoint' || r.task_id !== task) continue;
    out.push({ step: r.n, tool: r.tool, time: r.ts, ref: r.ref, sha: r.sha, files: r.files, safety: r.tool === 'restore' });
  }
  return out.sort((a, b) => a.step - b.step);
}

// Changed paths between two steps: [{status, path}] (A added, M modified, D deleted from step a to step b).
function diff(task, a, b) {
  checkTask(task);
  const sa = resolveRef(task, checkStep(a)), sb = resolveRef(task, checkStep(b));
  const parts = g(['diff-tree', '-r', '-z', '--name-status', '--no-renames', sa, sb]).split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i], path: parts[i + 1] });
  return out;
}

const readRecords = () => { try { const v = JSON.parse(fs.readFileSync(RECORDS, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } };
function writeRecords(list) {
  fs.mkdirSync(FORKS, { recursive: true });
  const tmp = RECORDS + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
  fs.renameSync(tmp, RECORDS);
}
const forks = () => readRecords();

function withLock(fn) {
  fs.mkdirSync(CK, { recursive: true });
  const file = path.join(CK, '_forks.lock');
  const until = Date.now() + 20000;
  let l;
  while (!(l = J.lock(file, { pids: [process.pid], task_id: '_forks' })).held) {
    if (Date.now() > until) throw new Error('fork lock busy');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  try { return fn(); } finally { J.unlock(file, l.nonce); }
}

// opts: {base: absolute dir for fork folders (default state/ckpt/forks/work), max: record cap, pruneDirs: bool}
function fork(task, n, opts = {}) {
  checkTask(task); n = checkStep(n);
  const sha = resolveRef(task, n);
  const base = path.resolve(opts.base || path.join(FORKS, 'work'));
  const origin = C.taskDir(task, refOf(task, n));
  if (origin && inside(path.resolve(origin), base)) throw new Error('fork base must not be inside the original task folder');
  const id = `f-${C.safeId(task).slice(0, 60)}-${n}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  if (!ID_RE.test(id)) throw new Error('invalid fork id');
  const dest = path.join(base, id);
  if (path.dirname(dest) !== base || !inside(base, dest)) throw new Error('fork path escapes the base');
  if (origin && inside(path.resolve(origin), dest)) throw new Error('fork must not be inside the original task folder');
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(dest); // fails if it exists: never write into an existing dir
  const idx = path.join(CK, `${id}.index`);
  try {
    C.git(CK, idx, ['read-tree', sha]);
    C.git(CK, idx, ['checkout-index', '-a', '-f', '--prefix=' + dest.split(path.sep).join('/') + '/']);
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw e;
  } finally { fs.rmSync(idx, { force: true }); }
  const rec = { id, parent_task: task, step: n, sha, path: dest, created: new Date().toISOString() };
  const dropped = withLock(() => {
    const list = readRecords(); list.push(rec);
    const max = Math.max(1, opts.max || 20);
    const gone = list.length > max ? list.splice(0, list.length - max) : [];
    writeRecords(list);
    return gone;
  });
  if (opts.pruneDirs) for (const d of dropped) { // only dirs this module created, inside the base
    try { if (d.path && ID_RE.test(path.basename(d.path)) && inside(base, path.resolve(d.path)) && path.resolve(d.path) !== base) fs.rmSync(d.path, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { J.append({ type: 'fork', task_id: task, step: n, fork_id: id, path: dest, pruned: dropped.length }); } catch { /* journal is best effort here */ }
  return { ...rec, pruned: dropped.map(d => d.id) };
}

// Context note for a task whose workdir is a fork dir; null otherwise. Never throws.
function noteFor(workdir) {
  try {
    if (!workdir) return null;
    const w = path.resolve(String(workdir));
    const hit = readRecords().reverse().find(r => r && r.path && same(path.resolve(r.path), w));
    if (!hit) return null;
    return `You are continuing from step ${hit.step} of task ${hit.parent_task}. This folder is a fork restored to the state just before that step ran; the original task folder is untouched. Work only in this folder.`;
  } catch { return null; }
}

module.exports = { steps, diff, fork, forks, noteFor, checkTask, checkStep, ID_RE };
