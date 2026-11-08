#!/usr/bin/env node
'use strict';
// The one user-facing command: three verbs, the agent picks its method inside.
//   dantomation do "<request>"   start a task; with no request, resume the open one
//   dantomation status           what is open, what finished, undo points, modules, warnings
//   dantomation undo             roll the latest task's folder back by one agent change
// It reuses bin/harness.js (do) and the checkpoint module's `undo` command; the
// low-level `harness.js` keeps working as before.
const path = require('path');
const { spawnSync } = require('child_process');
const J = require('../lib/journal');
const C = require('../lib/config');
const M = require('../lib/modules');

const HARNESS = path.join(__dirname, 'harness.js');
const USAGE = 'usage: dantomation do "<request>" | do | status | undo';
const fail = (msg, code = 1) => { console.error(msg); process.exit(code); };

let CONFIG;
try { CONFIG = C.load(); } catch (e) { fail(`dantomation: ${e.message}; fix or remove it (HARNESS_CONFIG / ~/.harness/config.json)`, 2); }

function loadModules() {
  const { mods, errors } = M.load(CONFIG);
  if (errors.length) fail(`dantomation: module load error: ${errors.join('; ')}. Fix config "modules" (or the module), or turn it off.`, 2);
  return mods;
}

function doVerb(args) {
  const { records } = J.readAll();
  const open = J.openTask(records);
  const request = args.filter((a, i) => a !== '--workdir' && args[i - 1] !== '--workdir').join(' ').trim();
  // approval-cards (if on) turns `do yes` / `do no` into the answer to a pending card.
  const answer = open && M.commands(loadModules()).answer;
  if (answer) {
    const res = answer(request ? [request] : [], { J, EXEC_LOCK: require('./harness').EXEC_LOCK });
    if (res && res.handled) {
      if (!res.resume) process.exit(res.code || 0);
      const r = spawnSync(process.execPath, [HARNESS, 'resume'], { stdio: 'inherit', env: process.env });
      process.exit(r.status === null ? 1 : r.status);
    }
  }
  if (open && request) fail(`task ${open.task_id} is still open ("${clip(open.request)}"). Resume it with: dantomation do   (no request). Use dantomation status to see where it stands.`);
  if (!open && !request) fail('nothing to resume. Start a task with: dantomation do "<what you want>"');
  const a = open ? ['resume'] : ['start', ...args];
  const r = spawnSync(process.execPath, [HARNESS, ...a], { stdio: 'inherit', env: process.env });
  process.exit(r.status === null ? 1 : r.status);
}

const clip = (s, n = 100) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 3) + '...' : s; };

function statusVerb() {
  const warn = C.warn();
  const { records, torn } = J.readAll();
  const open = J.openTask(records);
  const lines = [];
  if (open) {
    const steps = records.filter(r => r.task_id === open.task_id && r.type === 'step');
    const done = new Set(steps.filter(s => s.status === 'done').map(s => s.step));
    const last = steps[steps.length - 1];
    lines.push(`open task: ${open.task_id}`, `  request: ${clip(open.request)}`, `  steps done: ${done.size}`,
      `  last step: ${last ? `${last.step} ${last.status}${last.note ? ' - ' + clip(last.note, 60) : ''}` : 'none yet'}`,
      '  continue with: dantomation do');
  } else lines.push('no open task');
  const finished = records.filter(r => r.type === 'task_done');
  const lastDone = finished.length && records.find(r => r.type === 'task_start' && r.task_id === finished[finished.length - 1].task_id);
  lines.push(lastDone ? `last finished task: ${lastDone.task_id} - ${clip(lastDone.request)}` : 'last finished task: none');
  const mods = loadModules();
  const ck = mods.find(m => m.name === 'checkpoint' && typeof m.undoInfo === 'function');
  if (ck) {
    const u = ck.undoInfo(J);
    lines.push(`undo points: ${u.count}${u.task ? ` (task ${u.task})` : ''}`);
  }
  for (const m of mods) if (typeof m.statusLines === 'function') lines.push(...m.statusLines(J));
  const all = Object.entries(CONFIG.modules);
  lines.push(`modules on: ${all.filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);
  const off = all.filter(([, v]) => !v).map(([k]) => k);
  if (off.length) lines.push(`modules off: ${off.join(', ')}`);
  if (warn) lines.push(`warning: ${warn}`);
  if (torn) lines.push(`warning: journal has ${torn} torn line(s), skipped`);
  console.log(lines.join('\n'));
}

function undoVerb(args) {
  // Agents run inside an engine, which always sets HARNESS_TASK_ID: they never undo.
  if (process.env.HARNESS_TASK_ID) fail('undo is for the person at the keyboard, not for agents (HARNESS_TASK_ID is set). Stopping.', 6);
  const cmds = M.commands(loadModules());
  if (!cmds.undo) fail(`undo needs the checkpoint module, which is off. Turn it on in ${CONFIG.file}:\n  "modules": { "checkpoint": true }\n(it only helps for tasks started after it is on)`);
  return cmds.undo(args, { J, EXEC_LOCK: require('./harness').EXEC_LOCK });
}

const [verb, ...rest] = process.argv.slice(2);
if (verb === 'do') doVerb(rest);
else if (verb === 'status') statusVerb();
else if (verb === 'undo') undoVerb(rest);
else fail(USAGE, 2);
