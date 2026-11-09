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

// ---- per-task lock: guard, harness and server processes all touch the same file ----
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOCK_STALE_MS = 5000;
async function withLock(ctx, id, fn) {
  const lock = `${fileOf(ctx, id)}.lock`;
  const t0 = Date.now();
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); break; }
    catch (e) {
      // Windows reports EPERM/EACCES/EBUSY while the old lock file is delete-pending: retry those.
      const transient = e && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY');
      if (!e || (e.code !== 'EEXIST' && !(transient && Date.now() - t0 <= LOCK_STALE_MS))) break; // cannot lock (read-only dir etc.): run unlocked rather than block events
      if (transient) { await sleep(5 + Math.floor(Math.random() * 15)); continue; }
      let age = 0; try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS || Date.now() - t0 > LOCK_STALE_MS) { try { fs.unlinkSync(lock); } catch { /* raced */ } continue; }
      await sleep(5 + Math.floor(Math.random() * 15));
    }
  }
  try { return await fn(); } finally { try { fs.unlinkSync(lock); } catch { /* gone */ } }
}
// Locked read-modify-write. mut(rec|null) returns a record to save, or falsy to skip.
// Callers never await anything slow (cancel, emit) inside mut.
function update(ctx, id, mut) {
  return withLock(ctx, id, () => { const rec = mut(load(ctx, id)); if (rec) save(ctx, rec); return rec || null; });
}

// ---- trigger ----
// Phase 1 (locked): re-read the record, check the condition still holds, persist the flag
// and, if cancel_enabled, a cancel request. Phase 2 (unlocked): try the cancel and merge the
// outcome into a fresh read. A request that cannot be served here (guard/harness processes
// have a rejecting ctx.tasks) stays persisted and the server-side sweep services it.
async function trigger(ctx, id, reason, detail, now, still) {
  let flagged = null;
  await update(ctx, id, rec => {
    if (!rec || (still && !still(rec))) return null;
    if (rec.stalled && rec.stalled.reason === reason) return null; // already flagged for this reason
    const prev = rec.stalled && rec.stalled.cancelled;
    rec.stalled = { reason, detail: clip(detail, 200), ts: now, cancel_requested: false, cancelled: false, cancel_error: null, dismissed: false };
    rec.history = (rec.history || []).concat({ reason, ts: now }).slice(-20);
    if (ctx.settings.cancel_enabled) { rec.stalled.cancel_requested = true; if (prev) rec.stalled.cancelled = true; }
    flagged = rec.stalled; return rec;
  });
  if (!flagged) return false;
  if (flagged.cancel_requested && !flagged.cancelled) await serviceCancel(ctx, id, flagged.ts);
  const cur = load(ctx, id), st = (cur && cur.stalled) || flagged;
  try { ctx.state.append({ type: 'task_stalled', task_id: id, reason, detail: flagged.detail, cancel_requested: st.cancel_requested, cancelled: st.cancelled }); } catch { /* journal best effort */ }
  try { await ctx.emit('task-watchdog.stalled', { task_id: id, reason, detail: flagged.detail, cancelled: st.cancelled }); } catch { /* handlers never block us */ }
  return true;
}

// Try ctx.tasks.cancel for a persisted request; record the outcome on a fresh read, and only
// if the same flag (ts) is still there (progress or a restart may have cleared it meanwhile).
async function serviceCancel(ctx, id, ts) {
  let err = null;
  try { await ctx.tasks.cancel(id); } catch (e) { err = clip((e && e.message) || 'cancel failed', 200); }
  await update(ctx, id, rec => {
    if (!rec || !rec.stalled || rec.stalled.ts !== ts) return null;
    if (err) rec.stalled.cancel_error = err; else { rec.stalled.cancelled = true; rec.stalled.cancel_error = null; }
    return rec;
  });
  return !err;
}

const TERMINAL = new Set(['done', 'failed', 'stopped']);
// Server-side only (ctx.tasks works there): a force-stopped task never emits task.end, so mark
// any tracked-active task whose task state is terminal as inactive, then prune.
async function reconcile(ctx) {
  for (const r of all(ctx)) {
    if (!r.active) continue;
    let t = null; try { t = await ctx.tasks.get(r.task_id); } catch { return; } // no task service in this process
    if (!t || !TERMINAL.has(t.state)) continue;
    await update(ctx, r.task_id, rec => {
      if (!rec || !rec.active) return null;
      const now = Date.now(); return Object.assign(rec, { active: false, ended_ts: now, last_seen_ts: now });
    });
  }
  prune(ctx);
}

// Server-side check (job tick and the list routes): reconcile with task states, service cancel
// requests left by other processes (any reason), then the time-based no_progress check.
async function sweep(ctx, now = Date.now()) {
  await reconcile(ctx);
  for (const r of all(ctx)) {
    const s = r.stalled;
    if (r.active && s && s.cancel_requested && !s.cancelled) await serviceCancel(ctx, r.task_id, s.ts);
  }
  const limit = ctx.settings.stall_minutes * 60000;
  let n = 0;
  for (const rec of all(ctx)) {
    if (!rec.active || (rec.stalled && rec.stalled.reason === 'no_progress')) continue;
    if (now - rec.last_progress_ts >= limit) {
      if (await trigger(ctx, rec.task_id, 'no_progress', `no progress for ${ctx.settings.stall_minutes} min`, now,
        r => r.active && now - r.last_progress_ts >= limit)) n++;
    }
  }
  return n;
}

// ---- event handlers ----
const okId = id => typeof id === 'string' && ID_RE.test(id);
async function onStart(p, ctx) {
  if (!okId(p && p.task_id)) return;
  const now = Date.now(), id = p.task_id;
  const rec = await update(ctx, id, old => {
    let rec = old;
    if (!rec || !p.resumed) rec = fresh(id, now);
    else rec.no_progress_continuations = rec.progress_since_start ? 0 : (rec.no_progress_continuations || 0) + 1;
    return Object.assign(rec, { active: true, ended_ts: null, last_seen_ts: now, last_progress_ts: now, progress_since_start: false, err_sig: null, err_count: 0, stalled: null });
  });
  prune(ctx);
  if (rec.no_progress_continuations >= ctx.settings.continuation_limit) {
    await trigger(ctx, id, 'continuations', `${rec.no_progress_continuations} continuations without progress`, now,
      r => r.no_progress_continuations >= ctx.settings.continuation_limit);
  }
}
async function onTool(p, ctx) {
  if (!p || !okId(p.task_id)) return;
  const now = Date.now(), id = p.task_id;
  const sig = p.ok !== false ? null : signature(p);
  const rec = await update(ctx, id, old => {
    const rec = old || Object.assign(fresh(id, now), { active: true });
    rec.tool_events = (rec.tool_events || 0) + 1; rec.last_seen_ts = now;
    if (!sig) return Object.assign(rec, { last_progress_ts: now, progress_since_start: true, no_progress_continuations: 0, err_sig: null, err_count: 0, stalled: null });
    rec.err_count = sig === rec.err_sig ? (rec.err_count || 0) + 1 : 1; rec.err_sig = sig;
    return rec;
  });
  if (sig && rec.err_count >= ctx.settings.repeat_error_limit) {
    await trigger(ctx, id, 'repeat_error', `same ${clip(p.tool, 40)} error ${rec.err_count} times`, now,
      r => r.err_sig === sig && r.err_count >= ctx.settings.repeat_error_limit);
  }
}
async function onEnd(p, ctx) {
  if (!okId(p && p.task_id)) return;
  await update(ctx, p.task_id, rec => rec && Object.assign(rec, { active: false, ended_ts: Date.now(), last_seen_ts: Date.now() }));
}
// -> {rec, found}: rec is the updated record (null if missing or not flagged)
async function dismiss(ctx, id) {
  let found = false;
  const rec = await update(ctx, id, r => { found = !!r; if (!r || !r.stalled) return null; r.stalled.dismissed = true; return r; });
  return { rec, found };
}

// ---- views ----
const view = r => ({ task_id: r.task_id, active: !!r.active, started_ts: r.started_ts, last_progress_ts: r.last_progress_ts, tool_events: r.tool_events || 0,
  no_progress_continuations: r.no_progress_continuations || 0, repeat_error_count: r.err_count || 0,
  stalled: r.stalled ? { reason: r.stalled.reason, detail: r.stalled.detail, ts: r.stalled.ts, cancelled: !!r.stalled.cancelled, cancel_error: r.stalled.cancel_error, dismissed: !!r.stalled.dismissed } : null });
const flagged = r => r.stalled && !r.stalled.dismissed;
const bad = (status, error) => ({ status, json: { error } });
const byRecent = (a, b) => (b.last_seen_ts || 0) - (a.last_seen_ts || 0);

module.exports = {
  contract: 2,
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
      async handler(ctx) {
        const id = ctx.params && ctx.params.id;
        if (!okId(id)) return bad(400, 'bad task id');
        const { rec: r, found } = await dismiss(ctx, id);
        if (!r) return found ? bad(409, 'not flagged') : bad(404, 'not watched');
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
        const id = args[1]; const r = okId(id) ? (await dismiss(ctx, id)).rec : null;
        if (!r) { console.error('no such flagged task'); return { handled: true, code: 1 }; }
        return { handled: true, code: 0 };
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
