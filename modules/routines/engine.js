'use strict';
const { parse, cronDue } = require('./schedule');
const store = require('./store');

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const BOT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const FIELDS = new Set(['id', 'bot', 'prompt', 'schedule', 'paused']);
const day = ms => new Date(ms).toISOString().slice(0, 10);
const bad = m => Object.assign(new Error(m), { status: 400 });
const httpErr = (m, status) => Object.assign(new Error(m), { status });

function validate(body, { partial, settings }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be an object');
  for (const k of Object.keys(body)) if (!FIELDS.has(k)) throw bad(`unknown field "${k.slice(0, 30)}"`);
  const out = {};
  if (!partial || body.id !== undefined) { if (typeof body.id !== 'string' || !ID_RE.test(body.id)) throw bad('id must match [a-z0-9][a-z0-9_-]{0,39}'); out.id = body.id; }
  if (!partial || body.bot !== undefined) { if (typeof body.bot !== 'string' || !BOT_RE.test(body.bot)) throw bad('bot must be a short name'); out.bot = body.bot; }
  if (!partial || body.prompt !== undefined) {
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw bad('prompt required');
    if (body.prompt.length > settings.max_prompt_chars) throw bad(`prompt over ${settings.max_prompt_chars} characters`);
    out.prompt = body.prompt;
  }
  if (!partial || body.schedule !== undefined) { try { parse(body.schedule); } catch (e) { throw bad(e.message); } out.schedule = body.schedule.trim().replace(/\s+/g, ' '); }
  if (body.paused !== undefined) { if (typeof body.paused !== 'boolean') throw bad('paused must be boolean'); out.paused = body.paused; }
  return out;
}

const view = r => ({ id: r.id, bot: r.bot, prompt: r.prompt, schedule: r.schedule, paused: !!r.paused,
  created: r.created, last_run: r.last_run || null, last_task_id: r.last_task_id || null, last_error: r.last_error || null, runs: r.runs || 0 });

// Reset the per-day counter when the UTC day changed.
function rollDay(s, now) { const d = day(now); if (s.day !== d) { s.day = d; s.runs_today = 0; } }

// Arm a routine from `now`: interval = next_at, cron = cursor (last instant already evaluated).
function arm(r, now) {
  const p = parse(r.schedule);
  if (p.kind === 'interval') { r.next_at = now + p.every_s * 1000; delete r.cursor; }
  else { r.cursor = now; delete r.next_at; }
}

// Durably reserve the occurrence (quota, re-arm, pending marker) BEFORE enqueue, finalize after.
// A crash in between leaves `pending`; reconcile() clears it without re-enqueueing (at most once).
async function fire(ctx, s, r, now, why, occ) {
  rollDay(s, now);
  if (s.runs_today >= ctx.settings.max_runs_per_day) {
    r.last_error = 'daily cap reached';
    ctx.state.append({ type: 'routine_skipped', routine: r.id, reason: 'daily_cap', why });
    return { fired: false, reason: 'daily_cap' };
  }
  s.runs_today++; r.pending = String(occ);
  store.save(ctx.state.dir, s);
  try {
    const t = await ctx.tasks.enqueue(r.bot, r.prompt);
    r.runs = (r.runs || 0) + 1; r.last_run = now; r.last_task_id = (t && t.id) || null; r.last_error = null;
    delete r.pending;
    store.save(ctx.state.dir, s);
    ctx.state.append({ type: 'routine_fired', routine: r.id, bot: r.bot, task_id: r.last_task_id, why, occurrence: String(occ) });
    return { fired: true, task_id: r.last_task_id };
  } catch (e) {
    s.runs_today = Math.max(0, s.runs_today - 1); delete r.pending;
    r.last_error = String((e && e.message) || e).slice(0, 200);
    store.save(ctx.state.dir, s);
    ctx.state.append({ type: 'routine_error', routine: r.id, why, error: r.last_error });
    return { fired: false, reason: 'enqueue_failed' };
  }
}

// A leftover `pending` means a crash between reserve and confirm: the quota stays spent, nothing is re-enqueued.
function reconcile(ctx, s) {
  let changed = false;
  for (const r of Object.values(s.routines)) {
    if (r.pending === undefined) continue;
    ctx.state.append({ type: 'routine_error', routine: r.id, why: 'reconcile', error: 'interrupted before confirmation', occurrence: String(r.pending) });
    r.last_error = 'interrupted before confirmation'; delete r.pending; changed = true;
  }
  if (changed) store.save(ctx.state.dir, s);
}

// One scheduler pass. A routine that is due (including runs missed while the server was down)
// fires once, then is re-armed from `now`; nothing is replayed.
function tick(ctx, now = Date.now()) {
  return store.locked(async () => {
    const dir = ctx.state.dir, s = store.load(dir), fired = [];
    reconcile(ctx, s);
    for (const r of Object.values(s.routines)) {
      if (r.paused) continue;
      let p; try { p = parse(r.schedule); } catch { continue; }
      const due = p.kind === 'interval' ? now >= (r.next_at || 0) : cronDue(p, r.cursor ?? now, now);
      if (!due) { if (p.kind === 'cron') r.cursor = now; continue; }
      const occ = `${r.id}@${p.kind === 'interval' ? (r.next_at || 0) : now}`;
      arm(r, now); // re-arm is persisted together with the reservation
      const res = await fire(ctx, s, r, now, 'schedule', occ);
      if (res.fired) fired.push(r.id);
    }
    store.save(dir, s);
    return fired;
  });
}

// Routine ids come from URLs: shape-check and own-property-check every lookup.
const lookup = (s, id) => (typeof id === 'string' && ID_RE.test(id) && Object.prototype.hasOwnProperty.call(s.routines, id)) ? s.routines[id] : undefined;

const api = {
  list: ctx => store.locked(async () => Object.values(store.load(ctx.state.dir).routines).map(view)),
  get: (ctx, id) => store.locked(async () => { const r = lookup(store.load(ctx.state.dir), id); return r ? view(r) : null; }),
  create: (ctx, body, now = Date.now()) => store.locked(async () => {
    const v = validate(body, { partial: false, settings: ctx.settings });
    const s = store.load(ctx.state.dir);
    if (lookup(s, v.id)) throw httpErr('id exists', 409);
    if (Object.keys(s.routines).length >= ctx.settings.max_routines) throw bad(`at most ${ctx.settings.max_routines} routines`);
    const r = { ...v, paused: !!v.paused, created: now, runs: 0 };
    arm(r, now); s.routines[r.id] = r; store.save(ctx.state.dir, s);
    ctx.state.append({ type: 'routine_created', routine: r.id, bot: r.bot, schedule: r.schedule });
    return view(r);
  }),
  update: (ctx, id, body, now = Date.now()) => store.locked(async () => {
    const v = validate(body, { partial: true, settings: ctx.settings });
    if (v.id !== undefined && v.id !== id) throw bad('id cannot change');
    const s = store.load(ctx.state.dir), r = lookup(s, id);
    if (!r) throw httpErr('not found', 404);
    Object.assign(r, v);
    if (v.schedule !== undefined || v.paused === false) arm(r, now); // resuming never fires a backlog
    store.save(ctx.state.dir, s);
    ctx.state.append({ type: 'routine_updated', routine: id, fields: Object.keys(v) });
    return view(r);
  }),
  remove: (ctx, id) => store.locked(async () => {
    const s = store.load(ctx.state.dir);
    if (!lookup(s, id)) throw httpErr('not found', 404);
    delete s.routines[id]; store.save(ctx.state.dir, s);
    ctx.state.append({ type: 'routine_deleted', routine: id });
  }),
  runNow: (ctx, id, now = Date.now()) => store.locked(async () => {
    const s = store.load(ctx.state.dir); reconcile(ctx, s);
    const r = lookup(s, id);
    if (!r) throw httpErr('not found', 404);
    const res = await fire(ctx, s, r, now, 'run_now', `${r.id}@run_now:${now}`); // does not move the schedule
    store.save(ctx.state.dir, s);
    return { ...res, routine: view(r) };
  }),
  usage: ctx => store.locked(async () => { const s = store.load(ctx.state.dir); rollDay(s, Date.now()); return { day: s.day, runs_today: s.runs_today, cap: ctx.settings.max_runs_per_day }; }),
};

module.exports = { api, tick, validate };
