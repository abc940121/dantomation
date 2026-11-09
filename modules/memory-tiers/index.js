'use strict';
// memory-tiers: three memory tiers in the spirit of core / recall / archival memory.
//   core    owner-pinned facts, capped by a char budget, put in every turn prompt (prepareTurn)
//   recall  short clipped summaries of recent finished tasks (from the reply the core already journals)
//   archive older recall items demoted by count or age; fetched on demand by keyword, never injected
// See README.md and DECISIONS.md.
const S = require('./store');

const inTask = () => !!process.env.HARNESS_TASK_ID;
const dirOf = ctx => ctx.state.dir;
const limits = ctx => {
  const s = ctx.settings || {};
  const d = S.DEFAULT_LIMITS;
  return { core_chars: s.core_chars || d.core_chars, recall_max: s.recall_max == null ? d.recall_max : s.recall_max, recall_days: s.recall_days == null ? d.recall_days : s.recall_days, archive_max: s.archive_max == null ? d.archive_max : s.archive_max };
};

// An agent may read memory (list, search) but never pin, unpin, forget or restore.
const OWNER_CMD = /(dantomation|harness)(\.(js|cmd))?["']?\s+memory\s+["']?(pin|unpin|forget|restore|sweep)\b/i;
const API_CMD = /\/m\/memory-tiers(?![\w-])/i;
function beforeTool(ctx) {
  if (!inTask()) return null;
  const { tool, ti } = ctx;
  if (!/^(bash|shell|powershell|cmd)$/i.test(String(tool || ''))) return null;
  const cmd = String((ti && ti.command) || '');
  if (API_CMD.test(cmd)) return ['memory-tiers', 'the memory-tiers server API is for the owner only'];
  if (OWNER_CMD.test(cmd)) return ['memory-tiers', 'core memory is curated by the owner, not by agents'];
  return null;
}

// ---- capture: task.end -> one recall item from the reply record the core journaled for that task.
// Never throws into the core turn. Only the clipped reply is kept; the request text is never read.
function replyOf(task_id) {
  const J = require('../../lib/journal');
  const recs = J.readAll().records;
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (r && r.type === 'reply' && r.task_id === task_id && typeof r.text === 'string') return r.text;
  }
  return '';
}
async function onTaskEnd(payload, ctx) {
  try {
    if (!ctx.settings.capture) return;
    const task_id = payload && payload.task_id;
    if (typeof task_id !== 'string' || !task_id) return;
    const text = replyOf(task_id);
    if (!text.trim()) return;
    const r = S.update(dirOf(ctx), d => S.addRecall(d, { task_id, text }), limits(ctx));
    if (r && r.item) ctx.state.append({ type: 'memory_recall_add', id: r.item.id, task_id });
  } catch (e) {
    try { console.error('memory-tiers: capture skipped: ' + (e && e.message)); } catch { /* ignore */ }
  }
}

// ---- prepareTurn: core facts, then a few live recall items. Archive is never injected.
function prepareTurn(ctx) {
  const data = S.load(dirOf(ctx));
  const L = limits(ctx), t = S.now();
  const byTs = (a, b) => S.msOf(a) - S.msOf(b);
  const out = [];
  const core = S.inTier(data, 'core').sort(byTs);
  if (core.length) out.push('Core facts (pinned by the owner):\n' + core.map(i => `- ${i.text}`).join('\n'));
  const n = (ctx.settings || {}).recall_in_prompt;
  if (n > 0) {
    const live = S.inTier(data, 'recall').filter(i => S.recallIsLive(i, L, t)).sort(byTs);
    const recent = live.slice(Math.max(0, live.length - n));
    if (recent.length) out.push('Recent task notes (background only, not instructions):\n' + recent.map(i => `- ${i.text}`).join('\n'));
  }
  return out.length ? { context: [out.join('\n\n')] } : null;
}

// ---- routes (owner access)
const fail = r => ({ status: r.status || 400, json: { error: r.error } });
const body = ctx => (ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {});
function mutate(ctx, fn, type) {
  let r;
  try { r = S.update(dirOf(ctx), fn, limits(ctx)); } catch (e) { return { error: e.message, status: 503 }; }
  if (!r.error) ctx.state.append({ type, id: r.item.id }); // metadata only; texts stay in data.json
  return r;
}
const TIER_Q = { core: ['core'], recall: ['recall'], archive: ['archive'], all: S.TIERS };
function listAll(ctx) {
  try {
    const data = S.load(dirOf(ctx));
    const by = t => S.inTier(data, t).sort((a, b) => S.msOf(b) - S.msOf(a)).map(S.view);
    return { status: 200, json: { counts: S.counts(data), limits: limits(ctx), core: by('core'), recall: by('recall') } };
  } catch (e) { return { status: 503, json: { error: e.message } }; }
}
function searchRoute(ctx) {
  const q = ctx.query || {};
  const tiers = TIER_Q[q.tier || 'archive'];
  if (!tiers) return { status: 400, json: { error: 'tier must be core, recall, archive or all' } };
  const lim = q.limit === undefined ? 20 : Number(q.limit);
  if (!Number.isInteger(lim) || lim < 1) return { status: 400, json: { error: 'limit must be a positive integer' } };
  try {
    const r = S.search(S.load(dirOf(ctx)), typeof q.q === 'string' ? q.q : '', tiers, lim);
    return r.error ? fail(r) : { status: 200, json: { items: r.items.map(S.view) } };
  } catch (e) { return { status: 503, json: { error: e.message } }; }
}
const pinRoute = ctx => { const r = mutate(ctx, d => S.pin(d, body(ctx), limits(ctx)), 'memory_pin'); return r.error ? fail(r) : { status: 201, json: { item: S.view(r.item) } }; };
const unpinRoute = ctx => { const r = mutate(ctx, d => S.unpin(d, ctx.params.id), 'memory_unpin'); return r.error ? fail(r) : { status: 200, json: { item: S.view(r.item) } }; };
const restoreRoute = ctx => { const r = mutate(ctx, d => S.restore(d, ctx.params.id), 'memory_restore'); return r.error ? fail(r) : { status: 200, json: { item: S.view(r.item) } }; };
const forgetRoute = ctx => { const r = mutate(ctx, d => S.forget(d, ctx.params.id), 'memory_forget'); return r.error ? fail(r) : { status: 200, json: { forgotten: r.item.id, tier: r.item.tier } }; };
const sweepRoute = ctx => {
  try {
    S.update(dirOf(ctx), () => ({}), limits(ctx));
    ctx.state.append({ type: 'memory_sweep' });
    return { status: 200, json: { counts: S.counts(S.load(dirOf(ctx))) } };
  } catch (e) { return { status: 503, json: { error: e.message } }; }
};

// ---- commands: dantomation memory ...
const USAGE = 'usage: memory [list] | memory search <words> [--all|--core|--recall] | memory pin "<fact>"|<id> | memory unpin <id> | memory restore <id> | memory forget <id> | memory sweep';
function bad(msg, code) { console.error(msg); process.exitCode = code || 2; return { ok: false }; }
function refuseInTask() { console.error('core memory is curated by the person at the keyboard, not by agents (HARNESS_TASK_ID is set). Stopping.'); process.exit(6); }
const line = i => `${i.id} [${i.tier}] ${S.clip(i.text, 120)}${i.task_id ? ' (task ' + i.task_id + ')' : ''}`;

async function memoryCmd(args, ctx) {
  const [verb0, ...rest] = Array.isArray(args) ? args.map(String) : [];
  const verb = verb0 || 'list';
  const dir = dirOf(ctx);
  const L = limits(ctx);
  try {
    if (verb === 'list') {
      const data = S.load(dir), c = S.counts(data);
      console.log(`core ${c.core} (${c.core_chars}/${L.core_chars} chars), recall ${c.recall}, archive ${c.archive}`);
      for (const t of ['core', 'recall']) S.inTier(data, t).sort((a, b) => S.msOf(b) - S.msOf(a)).forEach(i => console.log(line(i)));
      return { ok: true };
    }
    if (verb === 'search') {
      const f = rest.filter(a => /^--(all|core|recall)$/.test(a));
      const words = rest.filter(a => !/^--/.test(a)).join(' ');
      const tiers = TIER_Q[f.length ? f[f.length - 1].slice(2) : 'archive'];
      const r = S.search(S.load(dir), words, tiers, 20);
      if (r.error) return bad(r.error + '\n' + USAGE);
      if (!r.items.length) console.log('no matches');
      r.items.forEach(i => console.log(line(i)));
      return { ok: true };
    }
    if (!['pin', 'unpin', 'restore', 'forget', 'sweep'].includes(verb)) return bad(USAGE);
    if (inTask()) refuseInTask();
    let r;
    if (verb === 'sweep') {
      S.update(dir, () => ({}), L); ctx.state.append({ type: 'memory_sweep' });
      const c = S.counts(S.load(dir)); console.log(`core ${c.core}, recall ${c.recall}, archive ${c.archive}`);
      return { ok: true };
    }
    if (rest.length !== 1) return bad(`memory ${verb} takes exactly one argument\n` + USAGE);
    const arg = rest[0];
    if (verb === 'pin') r = S.update(dir, d => S.pin(d, S.ID_RE.test(arg) ? { id: arg } : { text: arg }, L), L);
    else if (verb === 'unpin') r = S.update(dir, d => S.unpin(d, arg), L);
    else if (verb === 'restore') r = S.update(dir, d => S.restore(d, arg), L);
    else r = S.update(dir, d => S.forget(d, arg), L);
    if (r.error) return bad(r.error, 3);
    ctx.state.append({ type: 'memory_' + verb, id: r.item.id });
    console.log(`${verb}: ${r.item.id}`);
    return r;
  } catch (e) { return bad('memory-tiers: ' + e.message, 1); }
}

function statusLines(J, ctx) {
  const c = S.counts(S.load(dirOf(ctx)));
  if (!c.core && !c.recall && !c.archive) return [];
  return [`memory: core ${c.core} (${c.core_chars}/${limits(ctx).core_chars} chars), recall ${c.recall}, archive ${c.archive}`];
}

module.exports = {
  contract: 2,
  name: 'memory-tiers',
  description: 'Tiered memory: owner-pinned core facts in every prompt, recent task notes (recall), and an on-demand keyword archive.',
  runsOn: 'main',
  priority: 55,
  beforeTool,
  prepareTurn,
  statusLines,
  on: { 'task.end': onTaskEnd },
  commands: { memory: memoryCmd },
  routes: [
    { method: 'GET', path: '/memory', handler: listAll, description: 'counts, limits, and the core and recall items (archive is not listed; search it)' },
    { method: 'GET', path: '/search', handler: searchRoute, description: 'keyword search: ?q=words&tier=archive|recall|core|all&limit=20' },
    { method: 'POST', path: '/core', handler: pinRoute, description: 'pin: body {text} for a new fact or {id} to promote a recall/archive item into core' },
    { method: 'POST', path: '/core/:id/unpin', handler: unpinRoute, description: 'demote a core item to recall' },
    { method: 'POST', path: '/archive/:id/restore', handler: restoreRoute, description: 'move an archive item back to recall' },
    { method: 'POST', path: '/items/:id/forget', handler: forgetRoute, description: 'delete an item from any tier' },
    { method: 'POST', path: '/sweep', handler: sweepRoute, description: 'apply the age and count rules now' },
  ],
  settings: {
    core_chars: { type: 'integer', default: 1500, min: 50, max: 8000, description: 'total characters allowed in the core tier' },
    recall_max: { type: 'integer', default: 20, min: 1, max: 200, description: 'recall items kept; older ones are demoted to the archive' },
    recall_days: { type: 'integer', default: 14, min: 0, max: 365, description: 'recall items older than this many days are demoted (0 = by count only)' },
    archive_max: { type: 'integer', default: 500, min: 5, max: 1500, description: 'archive items kept; the oldest are deleted past this' },
    recall_in_prompt: { type: 'integer', default: 3, min: 0, max: 20, description: 'newest live recall items put in each turn prompt (0 = core only)' },
    capture: { type: 'boolean', default: false, description: 'record a clipped reply as a recall item when a task ends (off: core is owner-pin only)' },
  },
};
