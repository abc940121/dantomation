'use strict';
// task-watchdog: loop and stall guard. Watches task.* and tool.done events and
// flags a task as stalled when (a) no progress for stall_minutes, (b) the same
// tool error repeats repeat_error_limit times in a row, or (c) a task was resumed
// continuation_limit times in a row with no progress between. On a flag it
// journals, emits task-watchdog.stalled and, only if cancel_enabled, cancels the
// task through ctx.tasks. Observe-only by default. Off by default (config modules).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_LIST = 200;
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

// ---- storage: one small JSON file per task in state/m/task-watchdog/tasks/ ----
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
    if (ID_RE.test(id)) { const r = load(ctx, id); if (r) out.push(r); }
  }
  return out;
}
function prune(ctx) {
  const max = ctx.settings.max_tracked_tasks;
  const rs = all(ctx);
  const done = rs.filter(r => !r.active).sort((a, b) => (a.last_seen_ts || 0) - (b.last_seen_ts || 0));
  for (let i = 0; i < rs.length - max && i < done.length; i++) { try { fs.unlinkSync(fileOf(ctx, done[i].task_id)); } catch { /* gone */ } }
}
const fresh = (id, now) => ({ task_id: id, active: false, started_ts: now, last_seen_ts: now, last_progress_ts: now, progress_since_start: false,
  no_progress_continuations: 0, err_sig: null, err_count: 0, tool_events: 0, stalled: null, history: [] });

// A signature of a failed call: tool name + normalized input (+ result text if
// core gives one). Only a hash prefix is kept; the input itself is never stored.
function stable(v, depth = 0) {
  if (v == null || typeof v !== 'object') return typeof v === 'string' ? clip(v, 500) : v;
  if (depth > 4) return '[deep]';
  if (Array.isArray(v)) return v.slice(0, 20).map(x => stable(x, depth + 1));
  const o = {}; for (const k of Object.keys(v).sort().slice(0, 30)) o[k] = stable(v[k], depth + 1); return o;
}
function signature(p) {
  let text = '';
  try { text = JSON.stringify([p.tool, stable(p.input), clip(p.result && (p.result.error || p.result), 300)]); } catch { text = String(p.tool); }
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// ---- trigger ----
async function trigger(ctx, rec, reason, detail, now) {
  if (rec.stalled && rec.stalled.reason === reason) return false; // already flagged for this reason
  rec.stalled = { reason, detail: clip(detail, 200), ts: now, cancel_requested: false, cancelled: false, cancel_error: null, dismissed: false };
  rec.history = (rec.history || []).concat({ reason, ts: now }).slice(-20);
  if (ctx.settings.cancel_enabled) {
    rec.stalled.cancel_requested = true;
    try { await ctx.tasks.cancel(rec.task_id); rec.stalled.cancelled = true; }
    catch (e) { rec.stalled.cancel_error = clip(e && e.message, 200); }
  }
  save(ctx, rec);
  try { ctx.state.append({ type: 'task_stalled', task_id: rec.task_id, reason, detail: rec.stalled.detail, cancel_requested: rec.stalled.cancel_requested, cancelled: rec.stalled.cancelled }); } catch { /* journal best effort */ }
  try { await ctx.emit('task-watchdog.stalled', { task_id: rec.task_id, reason, detail: rec.stalled.detail, cancelled: rec.stalled.cancelled }); } catch { /* handlers never block us */ }
  return true;
}

// Time-based check of every active task (job tick and the list routes).
async function sweep(ctx, now = Date.now()) {
  const limit = ctx.settings.stall_minutes * 60000;
  let n = 0;
  for (const rec of all(ctx)) {
    if (!rec.active || (rec.stalled && rec.stalled.reason === 'no_progress')) continue;
    if (now - rec.last_progress_ts >= limit) {
      if (await trigger(ctx, rec, 'no_progress', `no progress for ${ctx.settings.stall_minutes} min`, now)) n++;
    }
  }
  return n;
}

// ---- event handlers ----
const okId = id => typeof id === 'string' && ID_RE.test(id);
async function onStart(p, ctx) {
  if (!okId(p && p.task_id)) return;
  const now = Date.now();
  let rec = load(ctx, p.task_id);
  if (!rec || !p.resumed) rec = fresh(p.task_id, now);
  else rec.no_progress_continuations = rec.progress_since_start ? 0 : (rec.no_progress_continuations || 0) + 1;
  Object.assign(rec, { active: true, ended_ts: null, last_seen_ts: now, last_progress_ts: now, progress_since_start: false, err_sig: null, err_count: 0, stalled: null });
  save(ctx, rec); prune(ctx);
  if (rec.no_progress_continuations >= ctx.settings.continuation_limit) {
    await trigger(ctx, rec, 'continuations', `${rec.no_progress_continuations} continuations without progress`, now);
  }
}
async function onTool(p, ctx) {
  if (!p || !okId(p.task_id)) return;
  const now = Date.now();
  const rec = load(ctx, p.task_id) || Object.assign(fresh(p.task_id, now), { active: true });
  rec.tool_events = (rec.tool_events || 0) + 1; rec.last_seen_ts = now;
  if (p.ok !== false) {
    Object.assign(rec, { last_progress_ts: now, progress_since_start: true, no_progress_continuations: 0, err_sig: null, err_count: 0, stalled: null });
    save(ctx, rec); return;
  }
  const sig = signature(p);
  rec.err_count = sig === rec.err_sig ? (rec.err_count || 0) + 1 : 1; rec.err_sig = sig;
  save(ctx, rec);
  if (rec.err_count >= ctx.settings.repeat_error_limit) await trigger(ctx, rec, 'repeat_error', `same ${clip(p.tool, 40)} error ${rec.err_count} times`, now);
}
function onEnd(p, ctx) {
  if (!okId(p && p.task_id)) return;
  const rec = load(ctx, p.task_id); if (!rec) return;
  Object.assign(rec, { active: false, ended_ts: Date.now(), last_seen_ts: Date.now() });
  save(ctx, rec);
}

// ---- views ----
const view = r => ({ task_id: r.task_id, active: !!r.active, started_ts: r.started_ts, last_progress_ts: r.last_progress_ts, tool_events: r.tool_events || 0,
  no_progress_continuations: r.no_progress_continuations || 0, repeat_error_count: r.err_count || 0,
  stalled: r.stalled ? { reason: r.stalled.reason, detail: r.stalled.detail, ts: r.stalled.ts, cancelled: !!r.stalled.cancelled, cancel_error: r.stalled.cancel_error, dismissed: !!r.stalled.dismissed } : null });
const flagged = r => r.stalled && !r.stalled.dismissed;
const bad = (status, error) => ({ status, json: { error } });
const byRecent = (a, b) => (b.last_seen_ts || 0) - (a.last_seen_ts || 0);

module.exports = {
  contract: 1,
  name: 'task-watchdog',
  description: 'Flags stalled or looping tasks (no progress, repeated tool error, endless continuations); optionally cancels them.',
  runsOn: 'main',
  priority: 90,

  on: { 'task.start': onStart, 'tool.done': onTool, 'task.end': onEnd },

  jobs: [{ id: 'sweep', every: 60, run: ctx => sweep(ctx) }],

  routes: [
    { method: 'GET', path: '/stalled', access: 'owner', description: 'tasks currently flagged as stalled',
      async handler(ctx) { await sweep(ctx); return { status: 200, json: { stalled: all(ctx).filter(flagged).sort(byRecent).map(view).slice(0, MAX_LIST) } }; } },
    { method: 'GET', path: '/tasks', access: 'owner', description: 'watched tasks; ?flagged=1 for flagged only; ?limit=N',
      async handler(ctx) {
        const q = ctx.query || {};
        const lim = q.limit === undefined ? 50 : Number(q.limit);
        if (!Number.isInteger(lim) || lim < 1 || lim > MAX_LIST) return bad(400, 'limit must be an integer 1..200');
        if (q.flagged !== undefined && q.flagged !== '1' && q.flagged !== '0') return bad(400, 'flagged must be 0 or 1');
        await sweep(ctx);
        let rs = all(ctx).sort(byRecent);
        if (q.flagged === '1') rs = rs.filter(flagged);
        return { status: 200, json: { tasks: rs.slice(0, lim).map(view) } };
      } },
    { method: 'GET', path: '/tasks/:id', access: 'owner', description: 'one watched task',
      handler(ctx) {
        const id = ctx.params && ctx.params.id;
        if (!okId(id)) return bad(400, 'bad task id');
        const r = load(ctx, id); return r ? { status: 200, json: view(r) } : bad(404, 'not watched');
      } },
    { method: 'POST', path: '/tasks/:id/dismiss', access: 'owner', description: 'acknowledge a flag (hides it from the stalled list)',
      handler(ctx) {
        const id = ctx.params && ctx.params.id;
        if (!okId(id)) return bad(400, 'bad task id');
        const r = load(ctx, id); if (!r) return bad(404, 'not watched');
        if (!r.stalled) return bad(409, 'not flagged');
        r.stalled.dismissed = true; save(ctx, r);
        ctx.state.append({ type: 'task_stall_dismissed', task_id: r.task_id });
        return { status: 200, json: view(r) };
      } },
    { method: 'GET', path: '/settings', access: 'owner', description: 'current watchdog settings',
      handler: ({ settings }) => ({ status: 200, json: { settings: { ...settings } } }) },
  ],

  commands: {
    async watchdog(args, ctx) {
      const sub = args[0] || 'stalled';
      if (sub === 'stalled' || sub === 'list') {
        const rs = all(ctx).filter(sub === 'list' ? () => true : flagged).sort(byRecent).slice(0, MAX_LIST);
        if (!rs.length) console.log(sub === 'list' ? 'no watched tasks' : 'no stalled tasks');
        for (const r of rs) console.log(`${r.task_id}\t${r.active ? 'active' : 'ended'}\t${r.stalled ? r.stalled.reason : '-'}`);
        return { handled: true, code: 0 };
      }
      if (sub === 'dismiss') {
        if (process.env.HARNESS_TASK_ID) { console.error('watchdog dismiss is for the owner, not inside a task'); return { handled: true, code: 2 }; }
        const id = args[1]; const r = okId(id) ? load(ctx, id) : null;
        if (!r || !r.stalled) { console.error('no such flagged task'); return { handled: true, code: 1 }; }
        r.stalled.dismissed = true; save(ctx, r); return { handled: true, code: 0 };
      }
      console.error('usage: watchdog [stalled|list|dismiss <task_id>]');
      return { handled: true, code: 1 };
    },
  },

  statusLines: (J, ctx) => {
    try { return [`task-watchdog: ${all(ctx).filter(flagged).length} stalled (${ctx.settings.cancel_enabled ? 'cancel on' : 'observe only'})`]; } catch { return []; }
  },

  stateVersion: 1,
  migrate() {},

  settings: {
    stall_minutes: { type: 'number', default: 20, min: 1, max: 1440, description: 'minutes without a successful tool call before an active task is flagged' },
    repeat_error_limit: { type: 'integer', default: 3, min: 2, max: 50, description: 'same failing tool call this many times in a row flags the task' },
    continuation_limit: { type: 'integer', default: 3, min: 1, max: 50, description: 'resumes in a row with no progress in between before the task is flagged' },
    cancel_enabled: { type: 'boolean', default: false, description: 'also cancel a flagged task through the task service (default: observe only)' },
    max_tracked_tasks: { type: 'integer', default: 200, min: 10, max: 5000, description: 'ended tasks beyond this many are forgotten, oldest first' },
  },

  api: { signature, sweep },
};
