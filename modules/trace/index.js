'use strict';
// trace: one timeline per task (start, tool calls, end, tokens, duration, cost if known) built
// from core events, plus predict-then-do: a task may record a predicted duration and result
// first, and when the elapsed time goes over overrun_factor x the prediction the module emits
// trace.overrun and shows a status line aimed at the line owner. Observe-only. Off by default.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const OWNER_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_LIST = 200;
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const okId = id => typeof id === 'string' && ID_RE.test(id);

// ---- storage: one JSON file per task in state/m/trace/tasks/ (events arrive from several processes) ----
const dirOf = ctx => { const d = path.join(ctx.state.dir, 'tasks'); fs.mkdirSync(d, { recursive: true }); return d; };
const fileOf = (ctx, id) => path.join(dirOf(ctx), `${id}.json`);
function load(ctx, id) {
  try { const r = JSON.parse(fs.readFileSync(fileOf(ctx, id), 'utf8')); return r && typeof r === 'object' ? r : null; } catch { return null; }
}
function save(ctx, rec) {
  const f = fileOf(ctx, rec.task_id), tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec)); fs.renameSync(tmp, f);
}
function all(ctx) {
  const out = [];
  let names = []; try { names = fs.readdirSync(dirOf(ctx)); } catch { /* none yet */ }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -5);
    if (okId(id)) { const r = load(ctx, id); if (r) out.push(r); }
  }
  return out;
}
function prune(ctx) {
  const rs = all(ctx), max = ctx.settings.max_tracked_tasks;
  const done = rs.filter(r => r.ended_ts).sort((a, b) => a.ended_ts - b.ended_ts);
  for (let i = 0; i < rs.length - max && i < done.length; i++) { try { fs.unlinkSync(fileOf(ctx, done[i].task_id)); } catch { /* gone */ } }
}

// ---- per-task lock (a lock file; stale after 5 s; on any other error run unlocked) ----
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOCK_STALE_MS = 5000;
async function withLock(ctx, id, fn) {
  const lock = `${fileOf(ctx, id)}.lock`, t0 = Date.now();
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); break; }
    catch (e) {
      const transient = e && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY');
      if (!e || (e.code !== 'EEXIST' && !(transient && Date.now() - t0 <= LOCK_STALE_MS))) break;
      if (!transient) {
        let age = 0; try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
        if (age > LOCK_STALE_MS || Date.now() - t0 > LOCK_STALE_MS) { try { fs.unlinkSync(lock); } catch { /* raced */ } continue; }
      }
      await sleep(5 + Math.floor(Math.random() * 15));
    }
  }
  try { return await fn(); } finally { try { fs.unlinkSync(lock); } catch { /* gone */ } }
}
// Locked read-modify-write; mut(rec|null) returns a record to save or falsy to skip.
const update = (ctx, id, mut) => withLock(ctx, id, () => { const rec = mut(load(ctx, id)); if (rec) save(ctx, rec); return rec || null; });

const fresh = (id, now) => ({ task_id: id, request: '', started_ts: now, ended_ts: null, code: null, resumed: 0,
  tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 }, cost_usd: null, tool_count: 0, tool_errors: 0, tool_ms: 0,
  events: [], dropped_events: 0, prediction: null, overrun: null });

// ---- cost: tokens x the price table of the config (same table spend-count reads) ----
function priceFor(config, model) {
  const prices = (config && config.prices_usd_per_mtok) || null;
  if (!prices) return null;
  const fam = Object.keys(prices).find(k => k !== 'default' && String(model || '').includes(k));
  return prices[fam || 'default'] || null;
}
function costOf(config, usage) {
  const p = priceFor(config, usage.model);
  if (!p) return null;
  return ((usage.input || 0) * p.input + (usage.output || 0) * p.output +
    (usage.cache_write || 0) * p.input * 1.25 + (usage.cache_read || 0) * p.input * 0.1) / 1e6;
}
// tool.done may carry `usage` later (optional): accept Claude-style names, ignore anything else.
function usageOf(p) {
  const u = p && p.usage; if (!u || typeof u !== 'object') return null;
  const out = { model: clip(u.model || p.model, 80), input: num(u.input_tokens) || 0, output: num(u.output_tokens) || 0,
    cache_write: num(u.cache_creation_input_tokens) || 0, cache_read: num(u.cache_read_input_tokens) || 0 };
  return out.input || out.output || out.cache_write || out.cache_read ? out : null;
}

// ---- event handling ----
function pushEvent(rec, max, ev) {
  if (rec.events.length >= max) { rec.dropped_events++; return; }
  rec.events.push(ev);
}
async function onStart(p, ctx) {
  if (!p || !okId(p.task_id)) return;
  const now = Date.now(), id = p.task_id;
  await update(ctx, id, old => {
    let rec = old;
    // a prediction recorded before the start has started_ts null: the clock starts now
    if (!rec || (!p.resumed && rec.started_ts)) rec = Object.assign(fresh(id, now), { prediction: rec && rec.prediction && !rec.started_ts ? rec.prediction : null });
    else if (!rec.started_ts) rec.started_ts = now;
    else rec.resumed++; // a resume continues the same timeline
    rec.ended_ts = null; rec.code = null;
    if (!rec.request) rec.request = clip(p.request, 200);
    pushEvent(rec, ctx.settings.max_events_per_task, { type: 'start', ts: now, resumed: !!p.resumed });
    return rec;
  });
  prune(ctx);
}
async function onTool(p, ctx) {
  if (!p || !okId(p.task_id)) return;
  const now = Date.now(), id = p.task_id, usage = usageOf(p);
  const rec = await update(ctx, id, old => {
    const rec = old || fresh(id, now);
    if (!rec.started_ts) rec.started_ts = now;
    if (p.tool_use_id && rec.events.some(e => e.tool_use_id === p.tool_use_id)) return null; // duplicate delivery
    rec.tool_count++; if (p.ok === false) rec.tool_errors++;
    const dur = num(p.durationMs); if (dur !== null) rec.tool_ms += dur;
    if (usage) {
      rec.tokens.input += usage.input; rec.tokens.output += usage.output;
      rec.tokens.cache_write += usage.cache_write; rec.tokens.cache_read += usage.cache_read;
      const c = costOf(ctx.config, usage); if (c !== null) rec.cost_usd = (rec.cost_usd || 0) + c;
    }
    pushEvent(rec, ctx.settings.max_events_per_task, { type: 'tool', ts: now, tool: clip(p.tool, 60), ok: p.ok !== false,
      duration_ms: dur, tool_use_id: p.tool_use_id ? clip(p.tool_use_id, 80) : undefined });
    return rec;
  });
  if (rec) await checkOverrun(ctx, id, now);
}
async function onEnd(p, ctx) {
  if (!p || !okId(p.task_id)) return;
  const now = Date.now(), id = p.task_id;
  await update(ctx, id, rec => {
    if (!rec) return null;
    rec.ended_ts = now; rec.code = typeof p.code === 'number' ? p.code : null;
    pushEvent(rec, ctx.settings.max_events_per_task, { type: 'end', ts: now, code: rec.code });
    return rec;
  });
  await checkOverrun(ctx, id, now);
}

// ---- predict-then-do ----
// Elapsed time is wall clock from the first start to the end (or now). It is compared with the
// predicted duration; over overrun_factor x it, flag once per task (locked), journal, emit.
const elapsedOf = (rec, now) => (rec.started_ts ? Math.max(0, (rec.ended_ts || now) - rec.started_ts) : 0);
async function checkOverrun(ctx, id, now = Date.now()) {
  let flagged = null;
  await update(ctx, id, rec => {
    if (!rec || !rec.prediction || !rec.started_ts || rec.overrun) return null;
    const el = elapsedOf(rec, now), limit = rec.prediction.duration_ms * ctx.settings.overrun_factor;
    if (el <= limit) return null;
    rec.overrun = { ts: now, elapsed_ms: el, predicted_ms: rec.prediction.duration_ms, factor: ctx.settings.overrun_factor,
      line_owner: rec.prediction.line_owner };
    flagged = rec.overrun; return rec;
  });
  if (!flagged) return false;
  const payload = { task_id: id, line_owner: flagged.line_owner, predicted_ms: flagged.predicted_ms, elapsed_ms: flagged.elapsed_ms, factor: flagged.factor };
  try { ctx.state.append(Object.assign({ type: 'trace_overrun' }, payload)); } catch { /* journal best effort */ }
  try { await ctx.emit('trace.overrun', payload); } catch { /* handlers never block us */ }
  return true;
}
// Job: a running task that went quiet fires no event, so poll.
async function sweep(ctx, now = Date.now()) {
  let n = 0;
  for (const r of all(ctx)) if (!r.ended_ts && r.started_ts && r.prediction && !r.overrun && await checkOverrun(ctx, r.task_id, now)) n++;
  prune(ctx);
  return n;
}

function parsePrediction(body, actor) {
  const b = body && typeof body === 'object' ? body : {};
  let ms = num(b.duration_ms);
  if (ms === null && num(b.minutes) !== null) ms = b.minutes * 60000;
  if (ms === null || ms < 1000 || ms > 7 * 86400000) return { error: 'duration_ms (or minutes) must be a number between 1 s and 7 days' };
  const owner = b.line_owner === undefined ? (actor && actor.id) || 'owner' : b.line_owner;
  if (typeof owner !== 'string' || !OWNER_RE.test(owner)) return { error: 'line_owner must match [A-Za-z0-9_.:-]{1,64}' };
  return { value: { duration_ms: Math.round(ms), result: clip(b.result, 500), line_owner: owner } };
}
async function predict(ctx, id, body, actor) {
  if (!okId(id)) return { status: 400, json: { error: 'bad task id' } };
  const p = parsePrediction(body, actor);
  if (p.error) return { status: 400, json: { error: p.error } };
  let conflict = false;
  const rec = await update(ctx, id, old => {
    const rec = old || Object.assign(fresh(id, null), { started_ts: null });
    if (rec.prediction) { conflict = true; return null; } // commit before the work: no rewriting afterwards
    rec.prediction = Object.assign(p.value, { ts: Date.now() });
    return rec;
  });
  if (conflict) return { status: 409, json: { error: 'this task already has a prediction' } };
  try { ctx.state.append({ type: 'trace_predicted', task_id: id, predicted_ms: p.value.duration_ms, line_owner: p.value.line_owner }); } catch { /* best effort */ }
  return { status: 200, json: { prediction: rec.prediction } };
}
async function recordResult(ctx, id, body) {
  if (!okId(id)) return { status: 400, json: { error: 'bad task id' } };
  const text = clip(body && body.result, 500);
  if (!text) return { status: 400, json: { error: 'result is required' } };
  const rec = await update(ctx, id, r => { if (!r) return null; r.actual_result = text; return r; });
  return rec ? { status: 200, json: { actual_result: text } } : { status: 404, json: { error: 'no such task' } };
}

// ---- views ----
function summary(rec, now = Date.now()) {
  const started = rec.started_ts, el = started ? elapsedOf(rec, now) : null, pr = rec.prediction;
  return { task_id: rec.task_id, request: rec.request, state: rec.ended_ts ? 'ended' : (started ? 'active' : 'predicted'),
    started_ts: started, ended_ts: rec.ended_ts, code: rec.code, duration_ms: el, tool_count: rec.tool_count, tool_errors: rec.tool_errors,
    tokens: rec.tokens, cost_usd: rec.cost_usd === null ? null : Number(rec.cost_usd.toFixed(6)),
    prediction: pr, ratio: pr && el !== null ? Number((el / pr.duration_ms).toFixed(2)) : null,
    overrun: rec.overrun, actual_result: rec.actual_result || null };
}
function timeline(rec, now = Date.now()) {
  const t0 = rec.started_ts || 0;
  return Object.assign(summary(rec, now), { resumed: rec.resumed, dropped_events: rec.dropped_events,
    events: rec.events.map(e => Object.assign({}, e, { offset_ms: e.ts - t0 })) });
}
const byRecent = (a, b) => (b.started_ts || (b.prediction && b.prediction.ts) || 0) - (a.started_ts || (a.prediction && a.prediction.ts) || 0);
const mmss = ms => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`; };

module.exports = {
  contract: 2,
  name: 'trace',
  description: 'One timeline per task (tools, tokens, duration, cost) and predict-then-do with an overrun alert for the line owner.',
  runsOn: ['main', 'worker'],
  emits: [],

  on: {
    'task.start': onStart,
    'tool.done': onTool,
    'task.end': onEnd,
  },

  jobs: [{ id: 'sweep', every: 30, run: ctx => sweep(ctx) }],

  commands: {
    // trace [list] | trace show <task_id> | trace predict <task_id> <minutes> [expected result words]
    async trace(args, ctx) {
      const sub = args[0];
      if (sub === 'predict') {
        const id = args[1], minutes = Number(args[2]);
        if (!id || !Number.isFinite(minutes)) { console.error('usage: trace predict <task_id> <minutes> [expected result]'); return { handled: true, code: 1 }; }
        const r = await predict(ctx, id, { minutes, result: args.slice(3).join(' '), line_owner: process.env.HARNESS_LINE_OWNER || undefined }, { id: 'owner' });
        if (r.status !== 200) { console.error(r.json.error); return { handled: true, code: 1 }; }
        console.log(`predicted ${mmss(r.json.prediction.duration_ms)} for ${id}`);
        return { handled: true, code: 0 };
      }
      if (sub === 'show') {
        const rec = okId(args[1]) ? load(ctx, args[1]) : null;
        if (!rec) { console.error('no such task'); return { handled: true, code: 1 }; }
        for (const e of timeline(rec).events) console.log(`+${mmss(e.offset_ms)}\t${e.type}\t${e.tool || ''}${e.ok === false ? ' (failed)' : ''}`);
        return { handled: true, code: 0 };
      }
      if (sub === 'list' || sub === undefined) {
        const rs = all(ctx).map(r => summary(r)).sort(byRecent).slice(0, MAX_LIST);
        if (!rs.length) console.log('no traced tasks');
        for (const s of rs) console.log(`${s.task_id}\t${s.state}\t${s.duration_ms === null ? '-' : mmss(s.duration_ms)}\t${s.tool_count} tools\t${s.cost_usd === null ? 'cost unknown' : '$' + s.cost_usd}${s.overrun ? '\tOVERRUN' : ''}`);
        return { handled: true, code: 0 };
      }
      console.error('usage: trace [list|show <task_id>|predict <task_id> <minutes> [result]]');
      return { handled: true, code: 1 };
    },
  },

  routes: [
    { method: 'GET', path: '/tasks', access: 'owner', description: 'one summary per traced task, newest first; ?limit=N',
      handler: async ctx => {
        await sweep(ctx);
        const lim = Math.min(MAX_LIST, Math.max(1, parseInt(ctx.query && ctx.query.limit, 10) || 50));
        return { status: 200, json: { tasks: all(ctx).map(r => summary(r)).sort(byRecent).slice(0, lim) } };
      } },
    { method: 'GET', path: '/tasks/:id', access: 'owner', description: 'the timeline of one task',
      handler: ctx => {
        const rec = okId(ctx.params.id) ? load(ctx, ctx.params.id) : null;
        return rec ? { status: 200, json: { task: timeline(rec) } } : { status: 404, json: { error: 'no such task' } };
      } },
    { method: 'POST', path: '/tasks/:id/predict', access: 'worker', description: 'record {duration_ms|minutes, result?, line_owner?} before the work',
      handler: ctx => predict(ctx, ctx.params.id, ctx.body, ctx.actor) },
    { method: 'POST', path: '/tasks/:id/result', access: 'worker', description: 'record the actual result text {result}',
      handler: ctx => recordResult(ctx, ctx.params.id, ctx.body) },
    { method: 'GET', path: '/overruns', access: 'owner', description: 'tasks over their predicted duration; ?line_owner=x filters',
      handler: async ctx => {
        await sweep(ctx);
        const who = ctx.query && ctx.query.line_owner;
        const rs = all(ctx).filter(r => r.overrun && (!who || r.overrun.line_owner === who)).map(r => summary(r)).slice(0, MAX_LIST);
        return { status: 200, json: { overruns: rs } };
      } },
  ],

  panels: [{ id: 'trace', title: 'Task trace', mount: 'chat', entry: 'ui/trace-panel.js' }],

  statusLines: (J, ctx) => {
    try {
      const rs = all(ctx), now = Date.now();
      const lines = [`trace: ${rs.length} tasks, ${rs.filter(r => !r.ended_ts && r.started_ts).length} running`];
      for (const r of rs.filter(x => x.overrun && !x.ended_ts).slice(0, 5)) {
        lines.push(`trace: [${r.overrun.line_owner}] task ${r.task_id} is at ${mmss(elapsedOf(r, now))}, over ${r.overrun.factor}x its ${mmss(r.overrun.predicted_ms)} prediction`);
      }
      return lines;
    } catch { return []; }
  },

  stateVersion: 1,
  migrate() {},

  settings: {
    overrun_factor: { type: 'number', default: 2, min: 1, max: 100, description: 'elapsed time over this multiple of the predicted duration raises trace.overrun' },
    max_events_per_task: { type: 'integer', default: 500, min: 10, max: 5000, description: 'timeline events kept per task; later ones are counted, not stored' },
    max_tracked_tasks: { type: 'integer', default: 200, min: 10, max: 5000, description: 'ended tasks beyond this many are forgotten, oldest first' },
  },

  api: { costOf, summary, sweep },
};
