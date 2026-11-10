'use strict';
// arena: run one request two ways in two git worktrees, judge, the owner keeps one.
// Off by default. See README.md and DECISIONS.md.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const A = require('./core');
const J = require('../../lib/journal');

const ROOT = path.resolve(__dirname, '..', '..');
const BIN = n => path.join(ROOT, 'bin', n);

// ---- default deps (tests replace them through api.inject)
let injected = null;
function defaultDeps(ctx) {
  const s = ctx.settings;
  return {
    // the existing engine runner, one run at a time: it takes the executor lock itself and exits 4 when busy
    runTask: (prompt, o) => new Promise((resolve, reject) => {
      if (process.env.HARNESS_TASK_ID) return reject(new Error('arena cannot be started from inside a task'));
      const c = spawn(process.execPath, [BIN('harness.js'), 'start', prompt, '--workdir', o.dir], { stdio: 'ignore', windowsHide: true });
      const t = setTimeout(() => { try { c.kill(); } catch { /* gone */ } reject(new Error('run timed out')); }, s.run_timeout_minutes * 60000);
      c.on('error', e => { clearTimeout(t); reject(e); });
      c.on('exit', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`engine run ended with code ${code}`)); });
    }),
    judge: async (prompt, o) => (await ctx.engines.run(o.engine, prompt, { timeoutMs: 120000 })).output,
    runTests: async (dir, cmd) => spawnSync(cmd, { cwd: dir, shell: true, stdio: 'ignore', timeout: s.test_timeout_seconds * 1000, windowsHide: true }).status === 0,
    // only when question-cards is on: the trunk `ask` verb prints {question_id}
    ask: (ctx.config && ctx.config.modules && ctx.config.modules['question-cards'] === true) ? (text, options) => new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [BIN('taskmote.js'), 'ask', text, ...options], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      let out = ''; c.stdout.on('data', d => { out += d; });
      c.on('error', reject);
      c.on('exit', () => { try { resolve(JSON.parse(out.trim().split('\n').pop()).question_id); } catch { reject(new Error('could not ask the question')); } });
    }) : undefined,
  };
}
const depsOf = ctx => (injected ? injected(ctx) : defaultDeps(ctx));
const coreCtx = ctx => ({ dir: ctx.state.dir, settings: ctx.settings, log: r => { try { ctx.state.append(r); } catch { /* journal is best effort */ } } });

const USAGE = 'usage: taskmote arena "<request>" [--engines a,b] [--dir <repo>] [--queue] [--json] | arena keep <id> A|B|none | arena list | arena queue';

// ---- queue (for an agent inside a running task): the request is recorded, and a detached drainer starts it
// once the executor lock is free. The drainer only waits for the lock; the engine runner still takes it itself.
let kickFn = null; // test seam
function kick(ctx) {
  if (kickFn) return kickFn(ctx);
  const env = { ...process.env }; delete env.HARNESS_TASK_ID; delete env.HARNESS_TASK_DIR;
  const c = spawn(process.execPath, [BIN('taskmote.js'), 'arena', 'drain'], { detached: true, stdio: 'ignore', env, windowsHide: true });
  c.on('error', () => { /* drained on the next task end */ });
  c.unref();
}
const execLockFree = () => { const h = J.readLock(path.join(J.STATE, 'executor.lock')); return !h || !(Array.isArray(h.pids) ? h.pids : []).some(J.alive); };

// Start queued requests one by one. One drainer at a time (drain.lock). Returns {started, waited_out}.
async function drain(ctx, o = {}) {
  const dir = ctx.state.dir;
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, 'drain.lock');
  const l = J.lock(lockFile, { pids: [process.pid], task_id: null });
  if (!l.held) return { started: 0, busy: true };
  const isFree = o.isFree || execLockFree, waitMs = o.waitMs === undefined ? 15 * 60000 : o.waitMs, pollMs = o.pollMs || 2000;
  let started = 0, waitedOut = false;
  try {
    while (A.readQueue(dir).length) {
      const until = Date.now() + waitMs;
      while (!isFree() && Date.now() < until) await new Promise(r => setTimeout(r, pollMs));
      if (!isFree()) { waitedOut = true; break; } // still busy: leave the queue for the next task end
      const e = A.dequeue(dir);
      if (!e) break;
      try { await A.start(coreCtx(ctx), depsOf(ctx), e.request, { dir: e.dir || undefined, engines: e.engines || undefined }); started++; }
      catch (err) { try { ctx.state.append({ type: 'arena', kind: 'arena_queue_failed', qid: e.qid, error: String((err && err.message) || err).slice(0, 200) }); } catch { /* best effort */ } }
    }
  } finally { if (!J.unlock(lockFile, l.nonce)) J.unlockLater(lockFile, l.nonce, undefined, 'arena drain'); }
  return { started, waited_out: waitedOut };
}
const onTaskEnd = (p, ctx) => { try { if (A.readQueue(ctx.state.dir).length) kick(ctx); } catch { /* the next task end retries */ } };
async function command(args, ctx) {
  const a = Array.isArray(args) ? args.map(String) : [];
  const fail = m => { console.error(m); process.exitCode = 2; return { handled: true, code: 2 }; };
  if (a[0] === 'list') { for (const r of A.list(ctx.state.dir)) { const v = A.view(r); console.log(`${v.id}\t${v.state}\twinner ${v.winner}\tkept ${v.kept || '-'}\t${v.request}`); } return { handled: true, code: 0 }; }
  if (a[0] === 'keep') {
    const r = A.keep(coreCtx(ctx), a[1] || '', a[2] === 'none' ? 'none' : String(a[2] || '').toUpperCase());
    if (!r.ok) { console.error(r.error); process.exitCode = 3; return { handled: true, code: 3 }; }
    console.log(`arena ${r.run.id}: kept ${r.run.kept}; worktrees removed`);
    return { handled: true, code: 0 };
  }
  if (a[0] === 'queue') {
    const q = A.readQueue(ctx.state.dir);
    for (const e of q) console.log(`${e.qid}\t${e.queued_at}\t${e.request.slice(0, 80)}`);
    return { handled: true, code: 0 };
  }
  if (a[0] === 'drain') {
    if (process.env.HARNESS_TASK_ID) return fail('arena drain cannot run inside a task; it runs by itself after the task ends');
    const r = await drain(ctx);
    console.log(`arena drain: started ${r.started}${r.busy ? ' (another drainer is running)' : ''}${r.waited_out ? ' (executor still busy; left in the queue)' : ''}`);
    return { handled: true, code: 0 };
  }
  let dir, engines, queue = false, json = false;
  const words = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--queue') queue = true; else if (a[i] === '--json') json = true; else if (a[i] === '--dir') dir = a[++i]; else if (a[i] === '--engines') engines = String(a[++i] || '').split(',').map(x => x.trim()).filter(Boolean); else words.push(a[i]);
  }
  const request = words.join(' ').trim();
  if (!request) return fail(USAGE);
  const inTask = !!process.env.HARNESS_TASK_ID;
  if (queue || inTask) {
    const refuse = m => { if (json) console.log(JSON.stringify({ queued: false, error: m })); return fail(m); };
    if (inTask && !queue) return refuse('arena cannot run inside a task (it needs the executor lock this task holds). Add --queue to start it after this task ends.');
    const r = A.enqueue(ctx.state.dir, { request, dir: dir || process.cwd(), engines, task_id: process.env.HARNESS_TASK_ID });
    if (!r.ok) return refuse(r.error);
    ctx.state.append({ type: 'arena', kind: 'arena_queued', qid: r.entry.qid, task_id: r.entry.task_id });
    if (!inTask) kick(ctx); // no task running: the drainer starts it as soon as the lock is free
    const note = inTask ? 'starts after this task releases the executor lock' : 'starts as soon as the executor lock is free';
    console.log(json ? JSON.stringify({ queued: true, id: r.entry.qid, position: r.position, note }) : `arena queued ${r.entry.qid} (position ${r.position}): ${note}`);
    return { handled: true, code: 0 };
  }
  try {
    const run = await A.start(coreCtx(ctx), depsOf(ctx), request, { dir, engines });
    console.log(`arena ${run.id}: ${A.questionText(run)}`);
    console.log(run.question_id ? `asked ${run.question_id}; no answer changes nothing` : `keep one with: taskmote arena keep ${run.id} A|B|none`);
    if (run.errors.length) console.log('notes: ' + run.errors.join(' | '));
    return { handled: true, code: 0 };
  } catch (e) { console.error('arena failed: ' + e.message); process.exitCode = 1; return { handled: true, code: 1 }; }
}

// The owner answered an arena question (any surface): apply it. Other questions are ignored.
async function onAnswered(p, ctx) {
  if (!p || !p.question_id) return;
  const run = A.list(ctx.state.dir).find(r => r.question_id === p.question_id && !r.kept);
  if (!run) return;
  const choice = { 1: 'A', 2: 'B', 3: 'none' }[p.choice];
  if (choice) A.keep(coreCtx(ctx), run.id, choice);
}

module.exports = {
  contract: 2,
  name: 'arena',
  description: 'Run a request two ways in two worktrees, judge, the owner keeps one.',
  runsOn: 'main',
  priority: 60,
  dependsOn: [],
  emits: [],
  commands: { arena: command },
  on: { 'question.answered': onAnswered, 'task.end': onTaskEnd },
  routes: [{
    method: 'GET', path: '/runs', access: 'owner', description: 'arena runs',
    handler: ctx => ({ status: 200, json: { runs: A.list(ctx.state.dir).map(A.view) } }),
  }],
  statusLines(_, ctx) {
    try { const q = A.readQueue(ctx.state.dir).length; return [...(q ? [`arena: ${q} queued request${q === 1 ? '' : 's'} waiting for the executor lock`] : []), ...A.list(ctx.state.dir).filter(r => !r.kept).map(r => `arena ${r.id} waits: keep A|B|none (taskmote arena keep ${r.id} A)`)]; } catch { return []; }
  },
  settings: {
    test_cmd: { type: 'string', default: '', description: 'command run in each worktree; exit 0 = pass; a pass beats a fail over the judge. Empty = no tests' },
    engines: { type: 'string', default: '', description: 'two engine names, comma separated (empty = the default engine twice)' },
    judge_engine: { type: 'string', default: '', description: 'config "engines" entry that judges (empty = the first engine); none listed = tie' },
    diff_cap: { type: 'integer', default: 12000, min: 500, max: 60000, description: 'most characters of each diff shown to the judge' },
    run_timeout_minutes: { type: 'integer', default: 30, min: 1, max: 600, description: 'time limit for each of the two runs' },
    test_timeout_seconds: { type: 'integer', default: 300, min: 5, max: 3600, description: 'time limit for each test run' },
  },
  api: { inject: f => { injected = f; }, injectKick: f => { kickFn = f; }, drain, enqueue: A.enqueue, readQueue: A.readQueue }, // test seam: f(ctx) returns {runTask, judge, runTests, ask}
};
