'use strict';
// sop-pipeline: the owner defines named standard operating procedures, an ordered list of stages
// (role label, instruction, expected output shape). Running one makes one task per stage, in order;
// a stage task gets the previous stage's output (clipped, labelled background only) plus its own
// instruction. A stage that fails, stops or times out halts the run. The run is a small state
// machine in this module's state file, advanced by a job (and by POST /advance) through ctx.tasks.
// Owner only; agents are blocked from defining, running or cancelling. Off by default.
// See README.md and DECISIONS.md.
const crypto = require('crypto');
const J = require('../../lib/journal');
const { open, err } = require('./store');
const SOP = require('./sop');

const settings = {
  max_stages: { type: 'integer', default: 8, min: 1, max: 32, description: 'most stages in one SOP' },
  max_sops: { type: 'integer', default: 50, min: 1, max: 500, description: 'most SOP definitions kept' },
  max_active_runs: { type: 'integer', default: 2, min: 1, max: 20, description: 'most runs queued or running at once' },
  max_runs_kept: { type: 'integer', default: 100, min: 5, max: 2000, description: 'finished runs kept; the oldest are dropped' },
  max_carry_chars: { type: 'integer', default: 4000, min: 200, max: 12000, description: 'most characters of one stage output handed to the next stage' },
  stage_timeout_s: { type: 'integer', default: 900, min: 10, max: 86400, description: 'a stage task running longer than this is stopped and halts the run' },
  default_bot: { type: 'string', default: '', description: 'bot that runs a stage when neither the stage nor the SOP names one' },
};

const stores = new Map(); // state dir -> store
const storeOf = ctx => { const d = ctx.state.dir; if (!stores.has(d)) stores.set(d, open(d)); return stores.get(d); };
const now = () => {
  const v = process.env.HARNESS_NOW;
  if (v) { const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v); if (Number.isFinite(n)) return n; }
  return Date.now();
};
const note = (ctx, rec) => { try { ctx.state.append(rec); } catch { /* journal is best effort */ } };
const fire = async (ctx, ev, payload) => { try { await ctx.emit(ev, payload); } catch { /* handlers never block a run */ } };
const bad = m => err('bad_input', m);
const ACTIVE = new Set(['queued', 'running']);
const TERMINAL = new Set(['done', 'failed', 'stopped']);
const RUN_RE = /^r-[0-9a-f]{12}$/;
const copy = x => JSON.parse(JSON.stringify(x));

// ---- agent guard: an agent never defines, runs, removes or cancels SOPs, nor calls the routes
const inTask = () => !!process.env.HARNESS_TASK_ID;
const OWNER_CMD = /(dantomation|harness)(\.(js|cmd))?["']?\s+sop\s+["']?(define|run|cancel|remove)\b/i;
const API_CMD = /\/m\/sop-pipeline(?![\w-])/i;
function beforeTool(ctx) {
  if (!inTask()) return null;
  const { tool, ti } = ctx;
  if (!/^(bash|shell|powershell|cmd)$/i.test(String(tool || ''))) return null;
  const cmd = String((ti && ti.command) || '');
  if (API_CMD.test(cmd)) return ['sop-pipeline', 'the sop-pipeline server API is for the owner only'];
  if (OWNER_CMD.test(cmd)) return ['sop-pipeline', 'SOPs are defined and run by the owner, not by agents'];
  return null;
}

// ---- views (outputs stay in the state file; lists show sizes only)
const stageView = (s, withOut) => ({ role: s.role, state: s.state, task_id: s.task_id || null, started: s.started || null, ended: s.ended || null,
  output_chars: s.output_chars || 0, clipped: !!s.clipped, ...(withOut ? { output: s.output || '' } : {}) });
const runView = (r, withOut) => ({ id: r.id, sop: r.sop, status: r.status, stage: r.stage, total: r.stages.length, reason: r.reason || null, created: r.created, updated: r.updated,
  stages: r.stages.map(s => stageView(s, withOut)) });
const sopView = s => ({ name: s.name, description: s.description, bot: s.bot || null, stages: s.stages });
const botOf = (ctx, sop, i) => sop.stages[i].bot || sop.bot || ctx.settings.default_bot || '';

// ---- operations
const ops = {
  list: ctx => Object.values(storeOf(ctx).read().sops).map(sopView),
  get(ctx, name) { const s = storeOf(ctx).read().sops[name]; if (!s) throw err('not_found', 'no such SOP'); return sopView(s); },
  define(ctx, name, spec) {
    const def = SOP.validateSop(name, spec, { maxStages: ctx.settings.max_stages });
    storeOf(ctx).update(d => {
      if (!d.sops[name] && Object.keys(d.sops).length >= ctx.settings.max_sops) throw err('full', `at most ${ctx.settings.max_sops} SOPs`);
      d.sops[name] = { ...def, created: (d.sops[name] && d.sops[name].created) || now(), updated: now() };
    });
    note(ctx, { type: 'sop_defined', sop: name, stages: def.stages.length });
    return sopView(def);
  },
  remove(ctx, name) {
    storeOf(ctx).update(d => {
      if (!d.sops[name]) throw err('not_found', 'no such SOP');
      if (d.runs.some(r => r.sop === name && ACTIVE.has(r.status))) throw err('active', 'the SOP has a run in progress');
      delete d.sops[name];
    });
    note(ctx, { type: 'sop_removed', sop: name });
    return { removed: name };
  },
  start(ctx, name, input) {
    const inp = SOP.clip(SOP.text(input, SOP.LIM.input, 'input', false), ctx.settings.max_carry_chars).text;
    const run = storeOf(ctx).update(d => {
      const sop = d.sops[name];
      if (!sop) throw err('not_found', 'no such SOP');
      if (sop.stages.length > ctx.settings.max_stages) throw bad(`the SOP has more than ${ctx.settings.max_stages} stages`);
      for (let i = 0; i < sop.stages.length; i++) if (!botOf(ctx, sop, i)) throw bad(`stage ${i + 1} has no bot: set a bot on the stage or the SOP, or the default_bot setting`);
      if (d.runs.filter(r => ACTIVE.has(r.status)).length >= ctx.settings.max_active_runs) throw err('limit', `at most ${ctx.settings.max_active_runs} runs at once`);
      const t = now();
      const r = { id: 'r-' + crypto.randomBytes(6).toString('hex'), sop: name, status: 'queued', stage: 0, input: inp, created: t, updated: t, reason: null,
        sop_def: { name, stages: sop.stages },
        stages: sop.stages.map((s, i) => ({ role: s.role, bot: botOf(ctx, sop, i), state: 'pending' })) };
      d.runs.push(r);
      // Drop the oldest finished runs over the cap.
      let over = d.runs.filter(x => !ACTIVE.has(x.status)).length - ctx.settings.max_runs_kept;
      if (over > 0) d.runs = d.runs.filter(x => ACTIVE.has(x.status) || over-- <= 0);
      return copy(r);
    });
    note(ctx, { type: 'sop_run_queued', run: run.id, sop: name });
    return runView(run);
  },
  runs: (ctx, status) => storeOf(ctx).read().runs.filter(r => !status || r.status === status).map(r => runView(r)),
  run(ctx, id, withOut = true) { const r = storeOf(ctx).read().runs.find(x => x.id === id); if (!r) throw err('not_found', 'no such run'); return runView(r, withOut); },
  async cancel(ctx, id) {
    const r = storeOf(ctx).update(d => {
      const x = d.runs.find(y => y.id === id);
      if (!x) throw err('not_found', 'no such run');
      if (!ACTIVE.has(x.status)) throw err('not_active', `the run is already ${x.status}`);
      const cur = x.stages[x.stage];
      x.status = 'cancelled'; x.reason = 'cancelled by the owner'; x.updated = now();
      if (cur && cur.task_id && cur.state === 'running') x.stop_task = cur.task_id;
      for (const s of x.stages) {
        if (s.state === 'running') { s.state = 'stopped'; s.ended = now(); } else if (s.state === 'pending' || s.state === 'starting') s.state = 'skipped';
      }
      return copy(x);
    });
    note(ctx, { type: 'sop_run_cancelled', run: id });
    await fire(ctx, 'sop-pipeline.run_cancelled', { run: id, sop: r.sop });
    await stopTasks(ctx); // best effort; the job retries when ctx.tasks is not reachable (shell command)
    return runView(r);
  },
};

// ---- the state machine
const inflight = new Set();
const commit = (ctx, id, fn) => storeOf(ctx).update(d => { const r = d.runs.find(x => x.id === id); if (!r) return null; const v = fn(r, d); r.updated = now(); return v; });

async function stopTasks(ctx) {
  for (const r of storeOf(ctx).read().runs) {
    if (!r.stop_task || inflight.has(r.id)) continue;
    try { await ctx.tasks.cancel(r.stop_task); } catch (e) { if (/not available/.test(String(e && e.message))) continue; /* already over */ }
    commit(ctx, r.id, x => { delete x.stop_task; });
  }
}

// The stage's reply text: a task view may carry it; otherwise the journal's reply / job_done records.
function readOutput(view, taskId) {
  if (view && typeof view.reply === 'string') return view.reply;
  try {
    const recs = J.readAll().records.filter(r => r.task_id === taskId);
    const rep = recs.filter(r => r.type === 'reply' && typeof r.text === 'string').pop();
    if (rep) return rep.text;
    const job = recs.filter(r => r.type === 'job_done' && r.result && typeof r.result.reply === 'string').pop();
    if (job) return job.result.reply;
  } catch { /* no journal: no output */ }
  return '';
}

async function halt(ctx, run, reason, stageState) {
  const r = commit(ctx, run.id, x => {
    if (!ACTIVE.has(x.status)) return null;
    const cur = x.stages[x.stage];
    if (cur) { cur.state = stageState; cur.ended = now(); }
    for (let i = x.stage + 1; i < x.stages.length; i++) x.stages[i].state = 'skipped';
    x.status = 'failed'; x.reason = String(reason).slice(0, 200);
    return copy(x);
  });
  if (!r) return;
  note(ctx, { type: 'sop_run_failed', run: run.id, stage: r.stage + 1, reason: r.reason });
  await fire(ctx, 'sop-pipeline.run_failed', { run: run.id, sop: run.sop, stage: r.stage + 1, reason: r.reason });
}

async function startStage(ctx, run, i, prevText) {
  // Reserve first (state "starting"); a crash before the task id is recorded fails the run on the
  // next pass instead of starting the stage twice.
  const marked = commit(ctx, run.id, x => {
    if (!ACTIVE.has(x.status)) return null;
    x.status = 'running'; x.stage = i; x.stages[i].state = 'starting';
    return copy(x);
  });
  if (!marked) return;
  const prompt = SOP.stagePrompt(marked.sop_def, i, prevText, marked.input);
  let t;
  try { t = await ctx.tasks.enqueue(marked.stages[i].bot, prompt); } catch (e) {
    await halt(ctx, marked, `could not start stage ${i + 1}: ${String((e && e.message) || e).slice(0, 120)}`, 'failed');
    return;
  }
  const id = t && t.id;
  const live = commit(ctx, run.id, x => {
    if (x.status !== 'running' || x.stage !== i) return false; // cancelled while the task was being made
    x.stages[i].state = 'running'; x.stages[i].task_id = id; x.stages[i].started = now();
    return true;
  });
  if (!live) { try { await ctx.tasks.cancel(id); } catch { /* already over */ } return; }
  note(ctx, { type: 'sop_stage_started', run: run.id, stage: i + 1, role: marked.stages[i].role, task_id: id });
  await fire(ctx, 'sop-pipeline.stage_started', { run: run.id, sop: run.sop, stage: i + 1, task_id: id });
}

async function step(ctx, run) {
  if (run.status === 'queued') return startStage(ctx, run, 0, '');
  const i = run.stage, cur = run.stages[i];
  if (!cur) return halt(ctx, run, 'run state is inconsistent', 'failed');
  if (cur.state === 'starting') return halt(ctx, run, `stage ${i + 1} was interrupted before its task was recorded`, 'failed');
  if (cur.state !== 'running') return undefined;
  let view;
  try { view = await ctx.tasks.get(cur.task_id); } catch { return undefined; } // service unreachable: try again next pass
  if (!view) return halt(ctx, run, `the task of stage ${i + 1} is gone`, 'failed');
  if (view.state === 'done') {
    const c = SOP.clip(readOutput(view, cur.task_id), ctx.settings.max_carry_chars);
    const last = i + 1 >= run.stages.length;
    const ok = commit(ctx, run.id, x => {
      if (x.status !== 'running' || x.stage !== i) return false;
      Object.assign(x.stages[i], { state: 'done', ended: now(), output: c.text, output_chars: c.chars, clipped: c.clipped });
      if (last) { x.status = 'done'; x.reason = null; }
      return true;
    });
    if (!ok) return undefined;
    note(ctx, { type: 'sop_stage_done', run: run.id, stage: i + 1, chars: c.chars, clipped: c.clipped });
    if (last) { note(ctx, { type: 'sop_run_done', run: run.id }); await fire(ctx, 'sop-pipeline.run_done', { run: run.id, sop: run.sop }); return undefined; }
    return startStage(ctx, run, i + 1, c.text);
  }
  if (TERMINAL.has(view.state)) return halt(ctx, run, `stage ${i + 1} (${cur.role}) ${view.state === 'stopped' ? 'was stopped' : 'failed'}`, view.state === 'stopped' ? 'stopped' : 'failed');
  if (now() - cur.started > ctx.settings.stage_timeout_s * 1000) {
    try { await ctx.tasks.cancel(cur.task_id); } catch { /* already over */ }
    return halt(ctx, run, `stage ${i + 1} (${cur.role}) timed out after ${ctx.settings.stage_timeout_s}s`, 'failed');
  }
  return undefined;
}

// One pass over every active run. Safe to call from the job, a route and tests; one run is never
// stepped twice at once in this process.
async function tick(ctx) {
  await stopTasks(ctx);
  let n = 0;
  for (const run of storeOf(ctx).read().runs) {
    if (!ACTIVE.has(run.status) || inflight.has(run.id)) continue;
    inflight.add(run.id);
    try { await step(ctx, run); n++; } finally { inflight.delete(run.id); }
  }
  return n;
}

// ---- http (all owner)
const STATUS_OF = { not_found: 404, full: 409, limit: 409, active: 409, not_active: 409, bad_input: 400, corrupt: 500, busy: 503 };
const reply = (status, json) => ({ status, json });
async function guard(fn) {
  try { return await fn(); } catch (e) {
    if (e && e.code && STATUS_OF[e.code]) return reply(STATUS_OF[e.code], { error: e.message });
    throw e;
  }
}
const body = ctx => (ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {});
const nameOf = ctx => (ctx.params && ctx.params.name) || '';
const runIdOf = ctx => { const id = ctx.params && ctx.params.id; return typeof id === 'string' && RUN_RE.test(id) ? id : null; };
const own = (m, p, description, handler) => ({ method: m, path: p, access: 'owner', description, handler: ctx => guard(() => handler(ctx)) });

const routes = [
  own('GET', '/sops', 'defined SOPs', async ctx => reply(200, { sops: ops.list(ctx) })),
  own('GET', '/sops/:name', 'one SOP', async ctx => reply(200, ops.get(ctx, nameOf(ctx)))),
  own('PUT', '/sops/:name', 'define or replace an SOP {description?, bot?, stages:[{role, instruction, expect?, bot?}]}', async ctx => reply(200, ops.define(ctx, nameOf(ctx), body(ctx)))),
  own('DELETE', '/sops/:name', 'remove an SOP with no run in progress', async ctx => reply(200, ops.remove(ctx, nameOf(ctx)))),
  own('POST', '/sops/:name/run', 'start a run {input?}; stage tasks are made in order', async ctx => {
    const r = ops.start(ctx, nameOf(ctx), body(ctx).input);
    try { await tick(ctx); } catch { /* the job picks it up */ }
    return reply(201, ops.run(ctx, r.id, false));
  }),
  own('GET', '/runs', 'runs; ?status=queued|running|done|failed|cancelled', async ctx => reply(200, { runs: ops.runs(ctx, (ctx.query || {}).status) })),
  own('GET', '/runs/:id', 'one run with stage outputs', async ctx => { const id = runIdOf(ctx); return id ? reply(200, ops.run(ctx, id)) : reply(400, { error: 'bad run id' }); }),
  own('POST', '/runs/:id/cancel', 'cancel a queued or running run', async ctx => { const id = runIdOf(ctx); return id ? reply(200, await ops.cancel(ctx, id)) : reply(400, { error: 'bad run id' }); }),
  own('POST', '/advance', 'advance every active run one step now', async ctx => reply(200, { advanced: await tick(ctx) })),
];

// ---- commands: `dantomation sop <sub>`
const USAGE = 'usage: sop [list|show <name>|define <name> --stage "role::instruction::expected output" [--stage ...] [--bot BOT] [--desc TEXT]|remove <name>|run <name> [input...]|status [run-id]|cancel <run-id>]';
const line = r => `${r.id}\t${r.status}\t${r.sop}\tstage ${Math.min(r.stage + 1, r.total)}/${r.total}${r.reason ? '\t' + r.reason : ''}`;
async function sop(args, ctx) {
  const sub = args[0] || 'list';
  const out = code => ({ handled: true, code });
  if (inTask() && !['list', 'show', 'status'].includes(sub)) { console.error(`sop ${sub} is for the owner, not inside a task`); return out(2); }
  try {
    if (sub === 'list') { for (const s of ops.list(ctx)) console.log(`${s.name}\t${s.stages.length} stages\t${s.stages.map(x => x.role).join(' -> ')}`); return out(0); }
    if (sub === 'show' && args[1]) {
      const s = ops.get(ctx, args[1]);
      console.log(`${s.name}${s.bot ? ' (bot ' + s.bot + ')' : ''}${s.description ? ': ' + s.description : ''}`);
      s.stages.forEach((x, i) => console.log(`${i + 1}. ${x.role}: ${x.instruction}${x.expect ? ' => ' + x.expect : ''}`));
      return out(0);
    }
    if (sub === 'define' && args[1]) {
      const spec = { stages: [] };
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--stage') {
          const [role, instruction, ...rest] = String(args[++i] || '').split('::');
          spec.stages.push({ role: (role || '').trim(), instruction, expect: rest.join('::') });
        } else if (args[i] === '--bot') spec.bot = args[++i];
        else if (args[i] === '--desc') spec.description = args[++i];
        else { console.error(USAGE); return out(1); }
      }
      ops.define(ctx, args[1], spec); console.log(`defined ${args[1]} (${spec.stages.length} stages)`); return out(0);
    }
    if (sub === 'remove' && args[1]) { ops.remove(ctx, args[1]); return out(0); }
    if (sub === 'run' && args[1]) {
      const r = ops.start(ctx, args[1], args.slice(2).join(' '));
      console.log(r.id); console.log('queued; the server starts the stage tasks'); return out(0);
    }
    if (sub === 'status') {
      if (args[1]) { const r = ops.run(ctx, args[1]); console.log(line(r)); r.stages.forEach((s, i) => console.log(`  ${i + 1}. ${s.role}\t${s.state}${s.task_id ? '\t' + s.task_id : ''}`)); } else for (const r of ops.runs(ctx)) console.log(line(r));
      return out(0);
    }
    if (sub === 'cancel' && args[1]) { await ops.cancel(ctx, args[1]); return out(0); }
  } catch (e) {
    if (e && e.code && STATUS_OF[e.code]) { console.error(e.message); return out(1); }
    throw e;
  }
  console.error(USAGE);
  return out(1);
}

module.exports = {
  contract: 2,
  name: 'sop-pipeline',
  description: 'Owner-defined standard operating procedures: stages run as tasks in order, each fed the clipped output of the one before; a failed stage halts the run.',
  runsOn: 'main',
  priority: 60,
  settings,
  beforeTool,
  routes,
  commands: { sop },
  jobs: [{ id: 'advance', every: 5, run: ctx => tick(ctx) }],
  statusLines: (Jr, ctx) => {
    try {
      const d = storeOf(ctx).read(); const c = {};
      for (const r of d.runs) c[r.status] = (c[r.status] || 0) + 1;
      return [`sop-pipeline: ${Object.keys(d.sops).length} SOPs, ${c.running || 0} running, ${c.queued || 0} queued`];
    } catch { return ['sop-pipeline: state file unreadable']; }
  },
  stateVersion: 1,
  migrate() {},
};
