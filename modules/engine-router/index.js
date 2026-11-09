'use strict';
// engine-router: architect/editor split. A strong "planner" engine plans, cheap
// "editor" engines make mechanical edits; after N failures in a row on one step
// the router recommends another engine, but only after the journal is checked for
// half-done work. Core has no per-turn engine hook yet, so this module computes
// and journals the decision and shows it in the prompt and a route (see README,
// "Seam request"). It never starts an engine itself. Off by default.
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
const engines = s => ({ planner: s.planner_engines, editor: s.editor_engines });
const records = () => { try { return J.readAll().records; } catch { return []; } };

// Evaluate a task now: load state, decide, journal a switch once, return the decision.
function evaluate(ctx, taskId, text, opts = {}) {
  const s = ctx.settings;
  const role = opts.role || P.classifyStep(text);
  let st = load(ctx, taskId) || P.newState(text, null);
  const d = P.decide({ state: st, records: records(), taskId, engines: engines(s), role, mutating: s.mutating_tools });
  if ((d.action === 'switch' || d.action === 'switch_with_handoff') && st.switch) {
    ctx.state.append({ type: 'router_switch', task_id: taskId, from: st.engine, to: d.engine, role: d.role, half_done: d.halfDone, mutations: d.mutations.length });
    st = { ...st, switch: false, fails: 0, engine: d.engine };
    save(ctx, taskId, st);
  } else if (d.action === 'stay' && d.engine && st.engine !== d.engine) { st = { ...st, engine: d.engine }; save(ctx, taskId, st); }
  return { ...d, note: P.handoffNote(d), fails: st.fails };
}

function record(ctx, taskId, ok) {
  if (!taskId) return;
  const st = load(ctx, taskId) || P.newState('', null);
  save(ctx, taskId, P.recordOutcome(st, ok, ctx.settings.fail_limit));
}

module.exports = {
  contract: 2,
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

  prepareTurn(ctx) {
    const d = evaluate(ctx, ctx.task_id, ctx.request);
    if (!d.engine) return null;
    const lines = [`recommended engine: ${d.engine} (${d.role})`];
    if (d.note) lines.push(d.note);
    if (d.action === 'exhausted') lines.push('every configured engine has failed this step; stop and ask the owner.');
    return { context: lines };
  },

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
