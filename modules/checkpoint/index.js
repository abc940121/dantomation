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

module.exports = {
  name: 'checkpoint',
  // Inside a harness task (HARNESS_TASK_ID + HARNESS_TASK_DIR, set by runEngine).
  // If the snapshot fails the call is blocked (fail closed).
  beforeTool({ tool, ti }) {
    const task = process.env.HARNESS_TASK_ID, dir = process.env.HARNESS_TASK_DIR;
    if (!(task && dir && mutating(tool, ti))) return null;
    try { ck.checkpoint(task, dir, tool); } catch (e) { return ['checkpoint', `could not snapshot the task folder (${String(e.message).split('\n')[0].slice(0, 120)})`]; }
    return null;
  },
  commands: { restore: restoreCmd },
};
