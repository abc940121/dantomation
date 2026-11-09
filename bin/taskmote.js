#!/usr/bin/env node
'use strict';
// The one user-facing command: three verbs, the agent picks its method inside.
//   taskmote do "<request>"   start a task; with no request, resume the open one
//   taskmote status           what is open, what finished, undo points, modules, warnings
//   taskmote undo             roll the latest task's folder back by one agent change
//   taskmote serve            run the local HTTP+SSE server (lib/server.js)
//   taskmote token new        write a fresh owner-only API token
// Any other verb is a module command (docs/MODULES.md, "commands"); a verb whose module is off
// prints a one-line hint naming the module that offers it.
// If a server is running for this state dir, do/status/undo talk to it; otherwise
// (or with HARNESS_NO_SERVER=1) they behave exactly as before.
// It reuses bin/harness.js (do) and the checkpoint module's `undo` command; the
// low-level `harness.js` keeps working as before.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const J = require('../lib/journal');
const C = require('../lib/config');
const M = require('../lib/modules');

const HARNESS = path.join(__dirname, 'harness.js');
const USAGE = 'usage: taskmote do "<request>" | do | status | undo | serve | token new [--worker] | <module verb>';
const fail = (msg, code = 1) => { console.error(msg); process.exit(code); };

let CONFIG;
try { CONFIG = C.load(); } catch (e) { fail(`taskmote: ${e.message}; fix or remove it (HARNESS_CONFIG / ~/.harness/config.json)`, 2); }

async function loadModules() {
  const { mods, errors } = M.load(CONFIG);
  if (errors.length) fail(`taskmote: module load error: ${errors.join('; ')}. Fix config "modules" (or the module), or turn it off.`, 2);
  const mig = await M.migrate(mods); // pending state migrations (stateVersion), once
  if (mig.errors.length) fail(`taskmote: module ${mig.errors.join('; ')}. Fix the module or its state, or turn it off.`, 2);
  return mods;
}

async function doVerb(args) {
  const { records } = J.readAll();
  const open = J.openTask(records);
  const request = args.filter((a, i) => a !== '--workdir' && args[i - 1] !== '--workdir').join(' ').trim();
  // approval-cards (if on) turns `do yes` / `do no` into the answer to a pending card.
  const answer = open && M.commands(await loadModules()).answer;
  if (answer) {
    const res = await answer(request ? [request] : [], { J, EXEC_LOCK: require('./harness').EXEC_LOCK });
    if (res && res.handled) {
      if (!res.resume) process.exit(res.code || 0);
      const r = spawnSync(process.execPath, [HARNESS, 'resume'], { stdio: 'inherit', env: process.env });
      process.exit(r.status === null ? 1 : r.status);
    }
  }
  if (open && request) fail(`task ${open.task_id} is still open ("${clip(open.request)}"). Resume it with: taskmote do   (no request). Use taskmote status to see where it stands.`);
  const info = open || !request ? null : serverInfo();
  if (info) {
    const r = await api(info, 'POST', '/api/tasks', { prompt: request });
    if (!r) return direct();
    if (r.status !== 201) fail(`taskmote: server refused: ${r.body.error || r.status}`);
    console.log(`task ${r.body.id} sent to the server (${r.body.state}). Follow it with: taskmote status`);
    return;
  }
  direct();
  function direct() {
  if (!open && !request) fail('nothing to resume. Start a task with: taskmote do "<what you want>"');
  const a = open ? ['resume'] : ['start', ...args];
  const r = spawnSync(process.execPath, [HARNESS, ...a], { stdio: 'inherit', env: process.env });
  process.exit(r.status === null ? 1 : r.status);
  }
}

// ---- client mode: a live server (server.json in this state dir) takes the request ----
function serverInfo() {
  if (process.env.HARNESS_NO_SERVER) return null;
  const S = require('../lib/server');
  const i = S.readInfo();
  return i && i.pid !== process.pid && J.alive(i.pid) ? { ...i, token: S.readToken() } : null;
}
async function api(info, method, p, body) {
  const headers = { 'content-type': 'application/json' };
  if (info.token && !process.env.HARNESS_TASK_ID) headers.authorization = `Bearer ${info.token}`;
  const host = info.host === '0.0.0.0' || info.host === '::' ? '127.0.0.1' : info.host;
  try {
    const r = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${info.port}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(130000) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } catch { return null; } // unreachable: caller falls back to the direct path
}

const clip = (s, n = 100) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 3) + '...' : s; };

async function statusVerb() {
  const info = serverInfo();
  if (info) {
    const r = await api(info, 'GET', '/api/status');
    if (r && r.status === 200) { console.log(r.body.text); return; }
  }
  return statusDirect();
}
async function statusDirect() {
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
      '  continue with: taskmote do');
  } else lines.push('no open task');
  const finished = records.filter(r => r.type === 'task_done');
  const lastDone = finished.length && records.find(r => r.type === 'task_start' && r.task_id === finished[finished.length - 1].task_id);
  lines.push(lastDone ? `last finished task: ${lastDone.task_id} - ${clip(lastDone.request)}` : 'last finished task: none');
  const mods = await loadModules();
  lines.push(...await M.statusLines(mods, J)); // e.g. checkpoint: undo points
  const all = Object.entries(CONFIG.modules);
  lines.push(`modules on: ${all.filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);
  const off = all.filter(([, v]) => !v).map(([k]) => k);
  if (off.length) lines.push(`modules off: ${off.join(', ')}`);
  if (warn) lines.push(`warning: ${warn}`);
  if (torn) lines.push(`warning: journal has ${torn} torn line(s), skipped`);
  console.log(lines.join('\n'));
}

async function undoVerb(args) {
  // Agents run inside an engine, which always sets HARNESS_TASK_ID: they never undo.
  if (process.env.HARNESS_TASK_ID) fail('undo is for the person at the keyboard, not for agents (HARNESS_TASK_ID is set). Stopping.', 6);
  const info = serverInfo();
  if (info) {
    const ck = (await loadModules()).find(m => m.api && typeof m.api.undoInfo === 'function');
    const id = ck && ck.api.undoInfo(J).task;
    if (id) {
      const r = await api(info, 'POST', `/api/tasks/${id}/undo`, {});
      if (r) {
        if (r.status !== 200) fail(`taskmote: server refused: ${r.body.error || r.status}`, r.status === 409 ? 4 : 1);
        console.log(r.body.message);
        return;
      }
    }
  }
  return undoDirect(args);
}
async function undoDirect(args) {
  const cmds = M.commands(await loadModules());
  if (!cmds.undo) fail(`undo needs the checkpoint module, which is off. Turn it on in ${CONFIG.file}:\n  "modules": { "checkpoint": true }\n(it only helps for tasks started after it is on)`);
  return await cmds.undo(args, { J, EXEC_LOCK: require('./harness').EXEC_LOCK });
}

// Any other verb: a command of an enabled module. If none claims it, look for a module folder
// that offers it, so a verb whose module is off says what to turn on.
async function moduleVerb(args) {
  const mods = await loadModules();
  const claimers = M.verbClaimers(mods, verb);
  if (claimers.length > 1) fail(`taskmote: "${verb}" is offered by more than one enabled module (${claimers.join(', ')}); turn all but one off.`, 2);
  const cmd = claimers.length ? M.commands(mods)[verb] : undefined;
  if (cmd) { const r = await cmd(args, { J, get EXEC_LOCK() { return require('./harness').EXEC_LOCK; } }); return r && r.code ? process.exit(r.code) : undefined; }
  const dir = path.join(__dirname, '..', 'modules');
  let owner = null;
  try { owner = fs.readdirSync(dir).find(n => { try { return Object.keys(require(path.join(dir, n, 'index.js')).commands || {}).includes(verb); } catch { return false; } }); } catch { /* no modules folder */ }
  fail(owner ? `taskmote: "${verb}" needs the ${owner} module, which is off: turn on the ${owner} module (add "${owner}": true under "modules" in ${CONFIG.file}).` : USAGE, 2);
}

const [verb, ...rest] = process.argv.slice(2);
// Trunk verbs are looked up first (own keys only), so a module can never shadow them.
const TRUNK = { do: doVerb, status: statusVerb, undo: undoVerb,
  serve: async () => { const w = C.warn(); if (w) console.error(w); await require('../lib/server').serve(); },
  token: async () => {
    if (rest[0] !== 'new') fail(USAGE, 2);
    const worker = rest[1] === '--worker';
    console.log(`${worker ? 'worker ' : ''}token written to ${require('../lib/server').tokenNew(worker ? 'worker' : undefined)} (owner-only); send it as: Authorization: Bearer <token>${worker ? ' (it may only call /api/worker/ and module routes marked access: worker)' : ''}`);
  } };
const run = Object.prototype.hasOwnProperty.call(TRUNK, verb) ? TRUNK[verb] : (verb && moduleVerb);
if (!run) fail(USAGE, 2);
else run(rest).catch(e => fail(`taskmote: ${e && e.stack || e}`, 1));
