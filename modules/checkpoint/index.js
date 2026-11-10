'use strict';
// checkpoint: snapshot the task folder before every mutating tool call, and the
// owner-only `harness.js restore <task> <n>` command (checkpoint.js has the how), and fork-from-step (fork.js).
const fs = require('fs');
const path = require('path');
const { mutating } = require('../../lib/shell');
const ck = require('./checkpoint');
const fk = require('./fork');

const forkOpts = settings => ({ base: settings && settings.fork_dir ? settings.fork_dir : undefined, max: settings && settings.max_forks, pruneDirs: !!(settings && settings.prune_fork_dirs) });
const errMsg = e => String((e && e.message) || e).split('\n')[0].slice(0, 200);
const bad = e => ({ status: 400, json: { error: errMsg(e) } });

// taskmote undo fork <task> <n> | undo fork steps <task> | undo fork diff <task> <a> <b> | undo fork list
// Not for agents: refuses when HARNESS_TASK_ID is set. It only reads the original folder.
function forkCmd(args, ctx) {
  if (process.env.HARNESS_TASK_ID) { console.error('undo fork is for the person at the keyboard, not for agents (HARNESS_TASK_ID is set). Stopping.'); process.exit(6); }
  const [a, b, c, d] = args;
  try {
    if (a === 'steps' && b) { for (const s of fk.steps(b)) console.log(`${s.step}\t${s.tool}\t${s.time}\t${s.ref}${s.safety ? '\t(restore safety point)' : ''}`); return; }
    if (a === 'diff' && b && c && d) { for (const x of fk.diff(b, c, d)) console.log(`${x.status}\t${x.path}`); return; }
    if (!a || a === 'list') { for (const f of fk.forks()) console.log(`${f.id}\t${f.parent_task} step ${f.step}\t${f.path}`); return; }
    if (a && b) {
      const r = fk.fork(a, b, forkOpts(ctx && ctx.settings));
      console.log(`forked step ${r.step} of task ${r.parent_task} into ${r.path} (fork ${r.id}); original folder untouched. Start a task there to continue.`);
      return;
    }
    console.error(UNDO_USAGE); process.exitCode = 2;
  } catch (e) { console.error(`fork failed: ${errMsg(e)}`); process.exitCode = 1; }
}

// Context for a task whose workdir is a fork. Never throws.
function prepareTurn(ctx) {
  try { const n = fk.noteFor(ctx && ctx.workdir); return n ? { context: [n] } : null; } catch { return null; }
}

const safeRoute = fn => args => { try { return { status: 200, json: fn(args) }; } catch (e) { return bad(e); } };
const routes = [
  { method: 'GET', path: '/steps/:task', description: 'steps (checkpoints) of a task', handler: safeRoute(({ params }) => ({ steps: fk.steps(params.task) })) },
  { method: 'GET', path: '/diff/:task/:a/:b', description: 'changed paths between two steps', handler: safeRoute(({ params }) => ({ changes: fk.diff(params.task, params.a, params.b) })) },
  { method: 'GET', path: '/forks', description: 'fork records', handler: safeRoute(() => ({ forks: fk.forks() })) },
  { method: 'POST', path: '/fork/:task/:n', description: 'restore step n into a new folder (never the original)', handler: safeRoute(({ params, settings }) => ({ fork: fk.fork(params.task, params.n, forkOpts(settings)) })) },
];

function restoreCmd([task, n], { J, EXEC_LOCK }) {
  if (process.env.HARNESS_OWNER !== '1') { console.error('restore is owner-only: set HARNESS_OWNER=1 in your own shell. Agents never restore.'); process.exit(6); }
  if (!task || !n) { console.error('usage: HARNESS_OWNER=1 harness restore <task> <n>'); process.exit(2); }
  const l = J.lock(EXEC_LOCK, { pids: [process.pid], task_id: task, restore: true });
  if (!l.held) { console.error('an executor is running; stop it before restoring'); process.exit(4); }
  try {
    const r = ck.restore(task, n);
    console.log(`restored ${r.ref} (${r.sha.slice(0, 12)}); removed ${r.removed.length} file(s) added since. Undo: harness restore ${task} ${r.undo.n}`);
  } catch (e) { console.error(`restore failed: ${e.message.split('\n')[0]}`); process.exitCode = 1; } finally { J.unlock(EXEC_LOCK, l.nonce); }
}

// Undo points of a task: a stack of agent checkpoints (n = state before that change).
// An undo to n pops every point >= n, so the next undo steps back one more.
function undoStack(records, task) {
  let stack = [];
  for (const r of records) {
    if (r.task_id !== task) continue;
    if (r.type === 'checkpoint' && r.tool !== 'restore') stack.push(r.n);
    else if (r.type === 'undo') stack = stack.filter(p => p < r.n);
  }
  return stack;
}
const latestTask = records => { const s = records.filter(r => r.type === 'task_start'); return s.length ? s[s.length - 1] : null; };

// How many undos would change the folder: the newest points equal to the folder now are
// skipped, and a point equal to the one above it changes nothing (undoCmd skips both).
// cur null (folder unknown) counts the newest point.
function distinctPoints(task, stack, cur) {
  const trees = ck.treesOf(task, stack);
  let count = 0, above = cur;
  for (let i = trees.length - 1; i >= 0; i--) { if (trees[i] !== above) count++; above = trees[i]; }
  return count;
}

// Files undo would overwrite that changed after the task's engine last exited: most likely
// edited by hand. They are not lost (restore saves a safety point first), but the person is told.
function handEdits(task, records, targetTree, cur, dir) {
  let end = NaN;
  for (const r of records) if (r.task_id === task && r.type === 'engine_exit') end = Date.parse(r.ts);
  if (!Number.isFinite(end) || !dir) return [];
  return ck.changedPaths(targetTree, cur).filter(p => { try { return fs.statSync(path.join(dir, p)).mtimeMs > end + 1000; } catch { return false; } });
}

// Undo points of the task that undo would act on, for lists polled often: no folder staging
// (cur null), so a newest point equal to the folder still counts. Falls back to the raw count.
function undoCount(records, task) {
  const stack = undoStack(records, task);
  if (!stack.length) return 0;
  try { return distinctPoints(task, stack, null); } catch { return stack.length; }
}

function undoInfo(J) {
  const t = latestTask(J.readAll().records);
  return t ? { task: t.task_id, count: undoStack(J.readAll().records, t.task_id).length } : { task: null, count: 0 };
}

const UNDO_USAGE = 'usage: taskmote undo | undo --to <n> [<task>] | undo fork <n> | undo fork <task> <n> | undo fork steps <task> | undo fork diff <task> <a> <b> | undo fork list';
const redoLine = (task, n) => `Undo this with: taskmote undo --to ${n} ${task}`;
const handWarning = hand => `warning: ${hand.length} file(s) changed after the task ended, likely by hand: ${hand.slice(0, 5).join(', ')}${hand.length > 5 ? ` and ${hand.length - 5} more` : ''}. Undo resets them too; your version is kept in a safety point (see "Undo this with" below).`;

// taskmote undo --to <n> [<task>]: put the folder back to undo point n (default: the latest
// task). Like a plain undo it first saves a safety point, so it can be undone too.
function undoTo(n, task, { J, EXEC_LOCK }) {
  const records = J.readAll().records;
  const t = task ? [...records].reverse().find(r => r.type === 'task_start' && r.task_id === task) : latestTask(records);
  if (!t) { console.error(task ? `no task ${task}` : 'nothing to undo: no task yet'); process.exit(task ? 2 : 0); }
  const l = J.lock(EXEC_LOCK, { pids: [process.pid], task_id: t.task_id, restore: true });
  if (!l.held) { console.error('a task is still running; wait for it to finish (or stop it) before undoing'); process.exit(4); }
  try {
    let hand = [];
    try { hand = handEdits(t.task_id, records, ck.treeOf(t.task_id, n), ck.currentTree(t.task_id, ck.taskDir(t.task_id)), ck.taskDir(t.task_id)); } catch { /* best effort */ }
    if (hand.length) console.log(handWarning(hand));
    const r = ck.restore(t.task_id, n, { user: true });
    J.append({ type: 'undo', task_id: t.task_id, n: Number(n), ref: r.ref, undo_ref: r.undo.ref });
    console.log(`undone: ${t.workdir} is back to undo point ${n} of task ${t.task_id}; removed ${r.removed.length} file(s) added since.`);
    console.log(redoLine(t.task_id, r.undo.n));
  } catch (e) { console.error(`undo failed: ${e.message.split(String.fromCharCode(10))[0]}`); process.exitCode = 1; } finally { J.unlock(EXEC_LOCK, l.nonce); }
}

// taskmote undo: the person's own command. Agents are kept out twice: it
// refuses when HARNESS_TASK_ID is set (the engine env), and guard-base blocks
// agent commands that name the verb. No HARNESS_OWNER needed.
// With no arguments it steps back one agent change, as it always has.
function undoCmd(args, ctx) {
  const { J, EXEC_LOCK } = ctx;
  if (process.env.HARNESS_TASK_ID) { console.error('undo is for the person at the keyboard, not for agents (HARNESS_TASK_ID is set). Stopping.'); process.exit(6); }
  const [a, b, c, ...more] = args || [];
  const isN = x => /^[0-9]+$/.test(String(x || ''));
  if (a === 'fork') {
    if (isN(b) && c === undefined) { const t = latestTask(J.readAll().records); if (!t) { console.error('nothing to fork: no task yet'); process.exit(2); } return forkCmd([t.task_id, b], ctx); }
    return forkCmd(args.slice(1), ctx);
  }
  if (a === '--to') {
    if (!isN(b) || more.length || (c !== undefined && !/^[A-Za-z0-9._-]+$/.test(c))) { console.error(UNDO_USAGE); process.exit(2); }
    return undoTo(b, c, ctx);
  }
  if (a !== undefined) { console.error(UNDO_USAGE); process.exit(2); }
  const records = J.readAll().records;
  const t = latestTask(records);
  if (!t) { console.log('nothing to undo: no task yet'); return; }
  const stack = undoStack(records, t.task_id);
  if (!stack.length) { console.log(`nothing left to undo for task ${t.task_id}`); return; }
  const l = J.lock(EXEC_LOCK, { pids: [process.pid], task_id: t.task_id, restore: true });
  if (!l.held) { console.error('a task is still running; wait for it to finish (or stop it) before undoing'); process.exit(4); }
  try {
    // Skip points whose snapshot equals the folder now (e.g. taken before a tool that changed
    // nothing): restoring one would change nothing, and the person would see "removed 0 file(s)".
    let cur = null;
    try {
      cur = ck.currentTree(t.task_id, ck.taskDir(t.task_id));
      while (stack.length && ck.treeOf(t.task_id, stack[stack.length - 1]) === cur) stack.pop();
    } catch { /* cannot compare: undo the top point as before */ }
    if (!stack.length) { console.log(`nothing left to undo for task ${t.task_id}: ${t.workdir} already matches every undo point`); return; }
    const n = stack[stack.length - 1];
    let hand = [];
    try { if (cur) hand = handEdits(t.task_id, records, ck.treeOf(t.task_id, n), cur, ck.taskDir(t.task_id)); } catch { /* the warning is best effort */ }
    if (hand.length) console.log(handWarning(hand));
    // restore() takes a fresh checkpoint of the current state before it changes
    // anything (r.undo), so the undo itself can be undone.
    const r = ck.restore(t.task_id, n, { user: true });
    J.append({ type: 'undo', task_id: t.task_id, n, ref: r.ref, undo_ref: r.undo.ref });
    let left = stack.length - 1;
    try { left = distinctPoints(t.task_id, stack.slice(0, -1), ck.treeOf(t.task_id, n)); } catch { /* raw count */ }
    console.log(`undone: ${t.workdir} is back to the state before agent change ${n} of task ${t.task_id}; removed ${r.removed.length} file(s) added since. ${left} more undo point(s).`);
    console.log(redoLine(t.task_id, r.undo.n));
  } catch (e) { console.error(`undo failed: ${e.message.split(String.fromCharCode(10))[0]}`); process.exitCode = 1; } finally { J.unlock(EXEC_LOCK, l.nonce); }
}

// taskmote status line.
// The count matches what undo will do: points that would change nothing are not counted.
function statusLines(Jn) {
  const u = undoInfo(Jn);
  if (u.task && u.count) {
    try {
      let cur = null;
      try { cur = ck.currentTree(u.task, ck.taskDir(u.task), { wait: false }); } catch { /* checkpoint in progress: count without the folder */ }
      u.count = distinctPoints(u.task, undoStack(Jn.readAll().records, u.task), cur);
    } catch { /* raw count */ }
  }
  return [`undo points: ${u.count}${u.task ? ` (task ${u.task})` : ''}`];
}

// Snapshots live in state/ckpt (a git dir per task), not state/m/checkpoint/: a
// documented exception (docs/MODULES.md); restore needs them at a fixed place.
module.exports = {
  contract: 2,
  name: 'checkpoint',
  runsOn: ['main', 'worker'],
  description: 'Snapshots the task folder before every mutating tool call; owner commands restore, undo and fork from step N.',
  priority: 90, // last: snapshot only calls that nothing else blocked or held for approval
  statusLines,
  api: { undoInfo, undoStack, undoCount, distinctPoints, checkpoint: ck.checkpoint, restore: ck.restore, diffstat: ck.diffstat, steps: fk.steps, diff: fk.diff, fork: fk.fork, forks: fk.forks },
  settings: {
    fork_dir: { type: 'string', default: '', description: 'absolute folder for forks; empty = under the harness state dir' },
    max_forks: { type: 'integer', default: 20, min: 1, max: 1000, description: 'fork records kept; the oldest are dropped' },
    prune_fork_dirs: { type: 'boolean', default: false, description: 'also delete the folders of dropped fork records' },
  },
  prepareTurn,
  routes,
  // Inside a harness task (HARNESS_TASK_ID + HARNESS_TASK_DIR, set by runEngine).
  // If the snapshot fails the call is blocked (fail closed).
  beforeTool({ tool, ti }) {
    const task = process.env.HARNESS_TASK_ID, dir = process.env.HARNESS_TASK_DIR;
    if (!(task && dir && mutating(tool, ti))) return null;
    try { ck.checkpoint(task, dir, tool); } catch (e) { return ['checkpoint', `could not snapshot the task folder (${String(e.message).split('\n')[0].slice(0, 120)})`]; }
    return null;
  },
  commands: { restore: restoreCmd, undo: undoCmd, fork: forkCmd },
};
