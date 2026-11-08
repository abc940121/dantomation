'use strict';
// checkpoint: snapshot the task folder before every mutating tool call, and the
// owner-only `harness.js restore <task> <n>` command (checkpoint.js has the how).
const { mutating } = require('../../lib/shell');
const ck = require('./checkpoint');

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

function undoInfo(J) {
  const t = latestTask(J.readAll().records);
  return t ? { task: t.task_id, count: undoStack(J.readAll().records, t.task_id).length } : { task: null, count: 0 };
}

// dantomation undo: the person's own command. Agents are kept out twice: it
// refuses when HARNESS_TASK_ID is set (the engine env), and guard-base blocks
// agent commands that name the verb. No HARNESS_OWNER needed.
function undoCmd(args, { J, EXEC_LOCK }) {
  if (process.env.HARNESS_TASK_ID) { console.error('undo is for the person at the keyboard, not for agents (HARNESS_TASK_ID is set). Stopping.'); process.exit(6); }
  const records = J.readAll().records;
  const t = latestTask(records);
  if (!t) { console.log('nothing to undo: no task yet'); return; }
  const stack = undoStack(records, t.task_id);
  if (!stack.length) { console.log(`nothing left to undo for task ${t.task_id}`); return; }
  const l = J.lock(EXEC_LOCK, { pids: [process.pid], task_id: t.task_id, restore: true });
  if (!l.held) { console.error('a task is still running; wait for it to finish (or stop it) before undoing'); process.exit(4); }
  try {
    const n = stack[stack.length - 1];
    // restore() takes a fresh checkpoint of the current state before it changes
    // anything (r.undo), so the undo itself can be undone.
    const r = ck.restore(t.task_id, n, { user: true });
    J.append({ type: 'undo', task_id: t.task_id, n, ref: r.ref, undo_ref: r.undo.ref });
    console.log(`undone: ${t.workdir} is back to the state before agent change ${n} of task ${t.task_id}; removed ${r.removed.length} file(s) added since. ${stack.length - 1} more undo point(s).`);
    console.log(`Undo this with: HARNESS_OWNER=1 node bin/harness.js restore ${t.task_id} ${r.undo.n}   (PowerShell: $env:HARNESS_OWNER='1'; node bin/harness.js restore ${t.task_id} ${r.undo.n})`);
  } catch (e) { console.error(`undo failed: ${e.message.split(String.fromCharCode(10))[0]}`); process.exitCode = 1; } finally { J.unlock(EXEC_LOCK, l.nonce); }
}

module.exports = {
  undoInfo,
  name: 'checkpoint',
  priority: 90, // last: snapshot only calls that nothing else blocked or held for approval
  // Inside a harness task (HARNESS_TASK_ID + HARNESS_TASK_DIR, set by runEngine).
  // If the snapshot fails the call is blocked (fail closed).
  beforeTool({ tool, ti }) {
    const task = process.env.HARNESS_TASK_ID, dir = process.env.HARNESS_TASK_DIR;
    if (!(task && dir && mutating(tool, ti))) return null;
    try { ck.checkpoint(task, dir, tool); } catch (e) { return ['checkpoint', `could not snapshot the task folder (${String(e.message).split('\n')[0].slice(0, 120)})`]; }
    return null;
  },
  commands: { restore: restoreCmd, undo: undoCmd },
};
