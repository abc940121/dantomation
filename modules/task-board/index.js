'use strict';
// task-board: a shared task board for parallel agents. Tasks have an id, title,
// dependencies, a status (open / claimed / done / failed), an owner and a lease.
// Claims are atomic (file lock) and expire, so a dead agent's task goes back to the
// board. Finishing a task unblocks its dependants. Optional git worktree per task.
// Off by default. See README.md and DECISIONS.md.
const path = require('path');
const J = require('../../lib/journal');
const { open, ID_RE, STATUSES } = require('./store');
const W = require('./workspace');

// ---- settings ----
const settings = {
  lease_seconds: { type: 'integer', default: 300, min: 5, max: 86400, description: 'default lease on a claim; a claim not renewed (heartbeat) in time goes back to open' },
  max_claims_per_owner: { type: 'integer', default: 0, min: 0, max: 100, description: 'most tasks one owner may hold at once; 0 = unlimited' },
  max_tasks: { type: 'integer', default: 1000, min: 10, max: 20000, description: 'board size cap; the oldest done tasks nobody waits on are dropped to make room' },
  release_on_stall: { type: 'boolean', default: true, description: 'release claims linked to a task that task-watchdog flags as stalled' },
  release_on_task_end: { type: 'boolean', default: true, description: 'release claims still held by a harness task when it ends' },
  workspace_dir: { type: 'string', default: '', description: 'folder for per-task git worktrees; empty = no workspaces' },
  workspace_repo: { type: 'string', default: '', description: 'git repository the worktrees are made from; empty = no workspaces' },
  workspace_cleanup: { type: 'string', default: 'done', enum: ['never', 'done', 'finished'], description: 'remove a task workspace when the task is done (done), done or failed (finished), or never' },
};
const DEFAULTS = Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, v.default]));

// ---- plumbing ----
const stores = new Map(); // state dir -> store
const storeOf = ctx => { const d = ctx.state.dir; if (!stores.has(d)) stores.set(d, open(d)); return stores.get(d); };
// The api has no ctx of its own. It uses the last ctx a hook gave this module (its
// settings, emit and journal) and, before any hook ran, defaults with no events.
let bound = null;
const bind = ctx => { bound = ctx; return ctx; };
const apiCtx = () => bound || { settings: DEFAULTS, state: { dir: path.join(J.STATE, 'm', 'task-board'), append() {} }, emit: async () => {} };

const note = (ctx, rec) => { try { ctx.state.append(rec); } catch { /* journal is best effort */ } };
const fire = async (ctx, ev, payload) => { try { await ctx.emit(ev, payload); } catch { /* handlers never block the board */ } };
async function flushExpired(ctx, store) {
  for (const e of store.takeExpired()) {
    note(ctx, { type: 'task_board_expired', id: e.id, owner: e.owner });
    await fire(ctx, 'task-board.expired', { id: e.id, owner: e.owner });
  }
}
// Run a store operation, then report any lease expiry it triggered.
async function run(ctx, fn) {
  bind(ctx);
  const store = storeOf(ctx);
  try { return await fn(store); } finally { await flushExpired(ctx, store); }
}
const leaseMs = (ctx, secs) => {
  const s = secs === undefined || secs === null ? ctx.settings.lease_seconds : Number(secs);
  if (!Number.isFinite(s) || s < 5 || s > 86400) throw Object.assign(new Error('lease_seconds must be 5..86400'), { code: 'bad_input' });
  return Math.floor(s * 1000);
};
const okOwner = o => typeof o === 'string' && /^[A-Za-z0-9._:@-]{1,64}$/.test(o);
const needOwner = o => { if (!okOwner(o)) throw Object.assign(new Error('bad owner (letters, digits, . _ : @ -, up to 64)'), { code: 'bad_input' }); return o; };

// ---- operations (used by routes, commands and the api) ----
const ops = {
  list: (ctx, f) => run(ctx, async s => {
    if (f && f.status && !STATUSES.includes(f.status)) throw Object.assign(new Error('bad status'), { code: 'bad_input' });
    return s.list(f);
  }),
  get: (ctx, id) => run(ctx, async s => s.get(id)),
  async add(ctx, spec) {
    const t = await run(ctx, async s => s.add(spec, ctx.settings.max_tasks));
    note(ctx, { type: 'task_board_added', id: t.id, deps: t.deps });
    await fire(ctx, 'task-board.added', { id: t.id, deps: t.deps, ready: t.ready });
    return t;
  },
  // -> task or null (nothing ready)
  async claim(ctx, owner, { id, lease_seconds, task_ref } = {}) {
    needOwner(owner);
    let t = await run(ctx, async s => s.claim(owner, { id, lease_ms: leaseMs(ctx, lease_seconds), task_ref, max_per_owner: ctx.settings.max_claims_per_owner }));
    if (!t) return null;
    if (W.enabled(ctx.settings)) {
      try {
        const ws = W.ensure(ctx.settings, t.id);
        t = (await run(ctx, async s => s.setWorkspace(t.id, ws))) || t;
      } catch (e) {
        await run(ctx, async s => { try { s.release(t.id, owner, false, t.claimed_at); } catch { /* already moved on */ } });
        throw Object.assign(new Error('could not create the task workspace'), { code: 'workspace_failed' });
      }
    }
    note(ctx, { type: 'task_board_claimed', id: t.id, owner, attempt: t.attempts });
    await fire(ctx, 'task-board.claimed', { id: t.id, owner, task_ref: t.task_ref, workspace: t.workspace, lease_until: t.lease_until });
    return t;
  },
  heartbeat: (ctx, id, by, secs, force) => run(ctx, async s => s.heartbeat(id, by, leaseMs(ctx, secs), force)),
  async finish(ctx, id, by, ok, noteText, force) {
    const { task, unblocked } = await run(ctx, async s => s.finish(id, by, ok, noteText, force));
    let cleaned = false;
    if (task.workspace && W.shouldClean(ctx.settings, task.status)) {
      try { cleaned = W.remove(ctx.settings, task.id); if (cleaned) await run(ctx, async s => s.setWorkspace(task.id, null)); } catch { /* leave it for the owner */ }
    }
    note(ctx, { type: ok ? 'task_board_done' : 'task_board_failed', id: task.id, owner: task.owner, unblocked, workspace_removed: cleaned });
    await fire(ctx, ok ? 'task-board.done' : 'task-board.failed', { id: task.id, owner: task.owner, task_ref: task.task_ref });
    for (const id2 of unblocked) await fire(ctx, 'task-board.unblocked', { id: id2, by: task.id });
    return { task: cleaned ? { ...task, workspace: null } : task, unblocked };
  },
  async release(ctx, id, by, force) {
    const t = await run(ctx, async s => s.release(id, by, force));
    note(ctx, { type: 'task_board_released', id });
    await fire(ctx, 'task-board.released', { id, reason: 'released' });
    return t;
  },
  retry: (ctx, id) => run(ctx, async s => s.retry(id)),
  async remove(ctx, id) {
    const { removed } = await run(ctx, async s => s.remove(id));
    if (removed.workspace) { try { W.remove(ctx.settings, id); } catch { /* leave it */ } }
    return removed;
  },
  // Release the claims of a harness task that ended or stalled.
  async releaseRef(ctx, ref, reason) {
    const out = await run(ctx, async s => s.releaseByRef(ref));
    for (const r of out) {
      note(ctx, { type: 'task_board_released', id: r.id, reason });
      await fire(ctx, 'task-board.released', { id: r.id, owner: r.owner, reason });
    }
    return out;
  },
  sweep: ctx => run(ctx, async s => { s.sweep(); }),
};

// ---- http ----
const STATUS_OF = { not_found: 404, exists: 409, not_open: 409, blocked: 409, limit: 409, not_owner: 403, not_claimed: 409, not_failed: 409, claimed: 409, has_dependants: 409, full: 409, bad_input: 400, workspace_failed: 500, busy: 503 };
const bad = (status, error) => ({ status, json: { error } });
async function guard(fn) {
  try { return await fn(); } catch (e) {
    if (e && e.code && STATUS_OF[e.code]) return bad(STATUS_OF[e.code], e.message);
    throw e;
  }
}
// A worker acts as itself; the owner may act as any named owner (default "owner").
const actorName = (actor, body) => (actor.kind === 'worker' ? actor.id : (body && body.owner) || 'owner');
const force = actor => actor.kind === 'owner';
const idOf = ctx => { const id = ctx.params && ctx.params.id; return typeof id === 'string' && ID_RE.test(id) ? id : null; };
const body = ctx => (ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {});
const BAD_ID = bad(400, 'bad task id');

const routes = [
  { method: 'GET', path: '/tasks', access: 'worker', description: 'tasks; ?status=open|claimed|done|failed, ?owner=, ?ready=1',
    handler: ctx => guard(async () => {
      const q = ctx.query || {};
      return { status: 200, json: { tasks: await ops.list(ctx, { status: q.status, owner: q.owner, ready: q.ready === '1' }) } };
    }) },
  { method: 'GET', path: '/tasks/:id', access: 'worker', description: 'one task',
    handler: ctx => guard(async () => { const id = idOf(ctx); if (!id) return BAD_ID; const t = await ops.get(ctx, id); return t ? { status: 200, json: t } : bad(404, 'no such task'); }) },
  { method: 'POST', path: '/tasks', access: 'owner', description: 'add a task {id?, title, deps?, task_ref?}',
    handler: ctx => guard(async () => ({ status: 201, json: await ops.add(ctx, body(ctx)) })) },
  { method: 'POST', path: '/claim', access: 'worker', description: 'claim a task {id?, lease_seconds?, task_ref?}; 204-style {task:null} when nothing is ready',
    handler: ctx => guard(async () => {
      const b = body(ctx);
      const t = await ops.claim(ctx, actorName(ctx.actor, b), { id: b.id, lease_seconds: b.lease_seconds, task_ref: b.task_ref });
      return { status: 200, json: { task: t } };
    }) },
  { method: 'POST', path: '/tasks/:id/heartbeat', access: 'worker', description: 'renew the lease {lease_seconds?}',
    handler: ctx => guard(async () => { const id = idOf(ctx); if (!id) return BAD_ID; const b = body(ctx); return { status: 200, json: await ops.heartbeat(ctx, id, actorName(ctx.actor, b), b.lease_seconds, force(ctx.actor)) }; }) },
  { method: 'POST', path: '/tasks/:id/done', access: 'worker', description: 'mark done {note?}; dependants become ready',
    handler: ctx => guard(async () => { const id = idOf(ctx); if (!id) return BAD_ID; const b = body(ctx); return { status: 200, json: await ops.finish(ctx, id, actorName(ctx.actor, b), true, b.note, force(ctx.actor)) }; }) },
  { method: 'POST', path: '/tasks/:id/fail', access: 'worker', description: 'mark failed {note?}',
    handler: ctx => guard(async () => { const id = idOf(ctx); if (!id) return BAD_ID; const b = body(ctx); return { status: 200, json: await ops.finish(ctx, id, actorName(ctx.actor, b), false, b.note, force(ctx.actor)) }; }) },
  { method: 'POST', path: '/tasks/:id/release', access: 'worker', description: 'give a claim back',
    handler: ctx => guard(async () => { const id = idOf(ctx); if (!id) return BAD_ID; return { status: 200, json: await ops.release(ctx, id, actorName(ctx.actor, body(ctx)), force(ctx.actor)) }; }) },
  { method: 'POST', path: '/tasks/:id/retry', access: 'owner', description: 'reopen a failed task',
    handler: ctx => guard(async () => { const id = idOf(ctx); if (!id) return BAD_ID; return { status: 200, json: await ops.retry(ctx, id) }; }) },
  { method: 'DELETE', path: '/tasks/:id', access: 'owner', description: 'remove an unclaimed task nobody depends on',
    handler: ctx => guard(async () => { const id = idOf(ctx); if (!id) return BAD_ID; await ops.remove(ctx, id); return { status: 200, json: { removed: id } }; }) },
];

// ---- commands: `dantomation taskboard <sub>` ----
const USAGE = 'usage: taskboard [list [status]|add <title> [--id ID] [--dep ID]...|claim [id]|heartbeat <id>|done <id> [note]|fail <id> [note]|release <id>|retry <id>|remove <id>]';
const inTask = () => process.env.HARNESS_TASK_ID || null;
const me = () => (inTask() ? `task:${inTask()}` : 'owner');
const line = t => `${t.id}\t${t.status}${t.owner ? '\t' + t.owner : ''}${t.ready ? '\tready' : t.blocked_by.length ? '\tblocked-by:' + t.blocked_by.join(',') : ''}\t${t.title}`;

async function taskboard(args, ctx) {
  const sub = args[0] || 'list';
  const out = code => ({ handled: true, code });
  try {
    if (sub === 'list') { for (const t of await ops.list(ctx, { status: args[1] })) console.log(line(t)); return out(0); }
    if (['add', 'retry', 'remove'].includes(sub) && inTask()) { console.error(`taskboard ${sub} is for the owner, not inside a task`); return out(2); }
    if (sub === 'add') {
      const spec = { deps: [], title: '' }; const words = [];
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--dep') spec.deps.push(args[++i]);
        else if (args[i] === '--id') spec.id = args[++i];
        else words.push(args[i]);
      }
      spec.title = words.join(' ');
      console.log((await ops.add(ctx, spec)).id); return out(0);
    }
    if (sub === 'claim') {
      const t = await ops.claim(ctx, me(), { id: args[1], task_ref: inTask() });
      if (!t) { console.log('nothing ready'); return out(1); }
      console.log(`${t.id}\t${t.title}${t.workspace ? '\t' + t.workspace : ''}`); return out(0);
    }
    const id = args[1];
    if (!id || !ID_RE.test(id)) { console.error(USAGE); return out(1); }
    const f = !inTask(); // the owner at the keyboard may act on any claim
    if (sub === 'heartbeat') { await ops.heartbeat(ctx, id, me(), undefined, f); return out(0); }
    if (sub === 'done' || sub === 'fail') {
      const r = await ops.finish(ctx, id, me(), sub === 'done', args.slice(2).join(' '), f);
      if (r.unblocked.length) console.log(`unblocked: ${r.unblocked.join(' ')}`);
      return out(0);
    }
    if (sub === 'release') { await ops.release(ctx, id, me(), f); return out(0); }
    if (sub === 'retry') { await ops.retry(ctx, id); return out(0); }
    if (sub === 'remove') { await ops.remove(ctx, id); return out(0); }
  } catch (e) {
    if (e && e.code && STATUS_OF[e.code]) { console.error(e.message); return out(1); }
    throw e;
  }
  console.error(USAGE);
  return out(1);
}

// ---- manifest ----
module.exports = {
  contract: 2,
  name: 'task-board',
  description: 'Shared task board for parallel agents: dependencies, atomic claims with leases, optional workspace per task.',
  runsOn: 'main',
  priority: 50,
  settings,

  on: {
    // Coordination with task-watchdog and core by event only (no module require, no shared files).
    'task-watchdog.stalled': async ({ task_id }, ctx) => { if (ctx.settings.release_on_stall && task_id) await ops.releaseRef(ctx, String(task_id), 'stalled'); },
    'task.end': async ({ task_id }, ctx) => { if (ctx.settings.release_on_task_end && task_id) await ops.releaseRef(ctx, String(task_id), 'task_end'); },
  },

  jobs: [{ id: 'sweep', every: 30, run: ctx => ops.sweep(ctx) }],
  routes,
  commands: { taskboard },

  statusLines: (Jr, ctx) => {
    try {
      const c = {}; for (const t of storeOf(ctx).list()) c[t.status] = (c[t.status] || 0) + 1;
      return [`task-board: ${STATUSES.map(s => `${c[s] || 0} ${s}`).join(', ')}`];
    } catch { return []; }
  },

  stateVersion: 1,
  migrate() {},

  // For other modules (dependsOn: ['task-board']). Failures throw Error with .code.
  api: {
    add: spec => ops.add(apiCtx(), spec),
    list: filter => ops.list(apiCtx(), filter),
    get: id => ops.get(apiCtx(), id),
    claim: (owner, opts) => ops.claim(apiCtx(), owner, opts),
    heartbeat: (id, owner, lease_seconds) => ops.heartbeat(apiCtx(), id, owner, lease_seconds, false),
    done: (id, owner, noteText) => ops.finish(apiCtx(), id, owner, true, noteText, false),
    fail: (id, owner, noteText) => ops.finish(apiCtx(), id, owner, false, noteText, false),
    release: (id, owner) => ops.release(apiCtx(), id, owner, false),
    releaseByTask: (taskId, reason) => ops.releaseRef(apiCtx(), String(taskId), reason || 'api'),
  },
};
