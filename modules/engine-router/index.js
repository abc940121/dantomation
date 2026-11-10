'use strict';
// engine-router: architect/editor split. A strong "planner" engine plans, cheap
// "editor" engines make mechanical edits; after N failures in a row on one step
// the router recommends another engine, but only after the journal is checked for
// half-done work. chooseEngine(turn) (contract 6) names the engine; it only takes
// effect for a config "engines" entry with turn:true. The failure-aware decision is still
// advisory (prompt line, route). It never starts an engine itself. Off by default.
const fs = require('fs');
const path = require('path');
const P = require('./lib/policy');
const J = require('../../lib/journal');

const safe = id => String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || '_';
const file = (ctx, id) => path.join(ctx.state.dir, `task-${safe(id)}.json`);
function load(ctx, id) { try { return JSON.parse(fs.readFileSync(file(ctx, id), 'utf8')); } catch { return null; } }
function save(ctx, id, st) {
  fs.mkdirSync(ctx.state.dir, { recursive: true });
  const f = file(ctx, id), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st)); fs.renameSync(tmp, f);
}
// Only engines core can really run for a turn count: a config "engines" entry with a string bin and
// turn:true (bin/harness.js ignores any other choice and runs the default engine). Listing an engine
// the config cannot run must not let its "failures" exhaust the step.
function runnable(config) {
  const t = config && config.engines;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return () => false;
  return id => Object.prototype.hasOwnProperty.call(t, id) && !!t[id] && typeof t[id].bin === 'string' && !!t[id].bin && t[id].turn === true;
}
const engines = (s, config) => {
  const ok = runnable(config), f = l => (Array.isArray(l) ? l : []).filter(ok);
  return { planner: f(s.planner_engines), editor: f(s.editor_engines) };
};
const records = () => { try { return J.readAll().records; } catch { return []; } };

// Evaluate a task now: load state, decide, journal a switch once, return the decision.
function evaluate(ctx, taskId, text, opts = {}) {
  const s = ctx.settings;
  const role = opts.role || P.classifyStep(text);
  let st = load(ctx, taskId) || P.newState(text, null);
  const conf = engines(s, ctx.config), known = [].concat(conf.planner, conf.editor);
  // the config may have changed since the state was saved (resume): an engine core can no longer run
  // is dropped with its failure streak, so nothing is recommended for it or charged to it.
  if (st.engine && !known.includes(st.engine)) { st = { ...st, engine: null, fails: 0, switch: false }; save(ctx, taskId, st); }
  const d = P.decide({ state: st, records: records(), taskId, engines: conf, role, mutating: s.mutating_tools });
  if ((d.action === 'switch' || d.action === 'switch_with_handoff') && st.switch) {
    ctx.state.append({ type: 'router_switch', task_id: taskId, from: st.engine, to: d.engine, role: d.role, half_done: d.halfDone, mutations: d.mutations.length });
    st = { ...st, switch: false, fails: 0, engine: d.engine };
    save(ctx, taskId, st);
  } else if (d.action === 'stay' && d.engine && st.engine !== d.engine) { st = { ...st, engine: d.engine }; save(ctx, taskId, st); }
  if ((d.action === 'exhausted') !== !!st.exhausted) { st = { ...st, exhausted: d.action === 'exhausted' }; save(ctx, taskId, st); }
  return { ...d, note: P.handoffNote(d), fails: st.fails };
}

function record(ctx, taskId, ok) {
  if (!taskId) return;
  const st = load(ctx, taskId) || P.newState('', null);
  save(ctx, taskId, P.recordOutcome(st, ok, ctx.settings.fail_limit));
}

module.exports = {
  contract: 2,
  hookTimeoutMs: 1000,
  name: 'engine-router',
  description: 'Architect/editor split: planner engine plans, cheap editors edit; switch engine after repeated failures, journal checked first.',
  runsOn: 'main',
  priority: 60,
  dependsOn: [],
  emits: [],

  settings: {
    planner_engines: { type: 'array', items: 'string', default: [], description: 'engine ids for planning steps, preferred first' },
    editor_engines: { type: 'array', items: 'string', default: [], description: 'engine ids for mechanical edit steps, preferred first' },
    fail_limit: { type: 'integer', default: 2, min: 1, max: 10, description: 'consecutive failures on one step before switching engine' },
    mutating_tools: { type: 'array', items: 'string', default: P.DEFAULT_MUTATING, description: 'tool names that count as changing the working tree for the half-done check' },
  },

  provides: { engines: [{ id: 'engine-router', description: 'policy only: recommends a planner or editor engine per step; needs the engine-per-turn seam to take effect' }] },

  on: {
    'task.start': ({ task_id, request, resumed }, ctx) => {
      if (!task_id) return;
      save(ctx, task_id, P.startStep(resumed ? load(ctx, task_id) : null, request || '', null));
    },
    'tool.done': ({ task_id, ok }, ctx) => { record(ctx, task_id, ok !== false); },
    'task.end': ({ task_id, code }, ctx) => { if (code) record(ctx, task_id, false); },
  },

  // Contract 6 hook: sync, reads only this task's small state file. prepareTurn runs first
  // and records a failure-driven switch there, so the engine it settled on wins while it is
  // still configured; otherwise the first configured engine of the step's role; null when none.
  chooseEngine(turn, ctx) {
    const s = (ctx && ctx.settings) || {};
    const conf = engines(s, ctx && ctx.config);
    const st = turn && turn.task_id && ctx && ctx.state ? load(ctx, turn.task_id) : null;
    const known = [].concat(conf.planner || [], conf.editor || []);
    if (st && st.exhausted) return null; // every engine failed this step: no pick, the default engine runs and prepareTurn asks for the owner
    if (st && typeof st.engine === 'string' && known.includes(st.engine)) return st.engine;
    const r = P.pickEngine(P.classifyStep(turn && turn.request), conf, []);
    return r.engine || null;
  },

  prepareTurn(ctx) {
    const d = evaluate(ctx, ctx.task_id, ctx.request);
    // exhausted yields no engine (chooseEngine returns null) but the default engine must still be told to
    // stop; with no engines configured at all there is nothing to exhaust and no note.
    const conf = engines((ctx && ctx.settings) || {}, ctx && ctx.config);
    const any = [].concat(conf.planner || [], conf.editor || []).length > 0;
    if (d.action === 'exhausted' && any) return { context: ['every configured engine has failed this step; stop and ask the owner.'] };
    if (!d.engine) return null;
    const lines = [`recommended engine: ${d.engine} (${d.role})`];
    if (d.note) lines.push(d.note);
    return { context: lines };
  },

  verbs: { 'engine-router': { under: 'dev', order: 2 } }, // taskmote dev engine-router
  commands: {
    async 'engine-router'(args, ctx) {
      if (process.env.HARNESS_TASK_ID) { console.error('engine-router: owner only'); return { handled: true, code: 2 }; }
      const [id, ...rest] = args;
      if (!id) { console.error('usage: engine-router <task_id> [step text]'); return { handled: true, code: 2 }; }
      console.log(JSON.stringify(evaluate(ctx, id, rest.join(' ')), null, 2));
      return { handled: true, code: 0 };
    },
  },

  routes: [{
    method: 'GET', path: '/decide', access: 'owner', description: 'engine decision for a task: ?task_id=&step=',
    handler: ctx => {
      const q = ctx.query || {};
      if (!q.task_id) return { status: 400, json: { error: 'task_id required' } };
      return { status: 200, json: evaluate(ctx, q.task_id, q.step || '', { role: q.role }) };
    },
  }],

  api: { ...P },
};
