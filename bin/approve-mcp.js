#!/usr/bin/env node
'use strict';
// The permission-prompt tool of the full profile: a tiny MCP stdio server with one tool,
// "approve" (Claude Code: --permission-prompt-tool mcp__taskmote__approve). Claude Code calls it
// whenever it would show a permission prompt: a tool outside the owner's allow list, or a call
// the guard hook answered with permissionDecision "ask" (a red line).
//   red line (the module chain says "ask:<kind>" for this exact input, as the guard hook does): raise a live approval card and
//     wait. The card never times out. A needs_you record goes to the journal, then card_reminder
//     records 10 minutes in and every hour after. The owner answers yes / no on the card
//     (taskmote do, the cards route, voice) or stops the task. The executor lock stays held by the
//     harness for the whole turn, so other chat messages queue meanwhile.
//   hard block (a module blocks it; the hook normally stopped it already): deny.
//   cancelled (notifications/cancelled for the request) or stdin closed (the engine is gone): the card
//     is closed as a system no and the call is denied.
//   anything else: allow at once, input unchanged.
// Result: one text block holding JSON, {"behavior":"allow","updatedInput":{...}} or
// {"behavior":"deny","message":"..."} (the Claude Code / Agent SDK permission-prompt shape).
// No dependencies; JSON-RPC 2.0, one message per line on stdin / stdout.
const J = require('../lib/journal');
const C = require('../lib/config');
const M = require('../lib/modules');

const NAME = 'taskmote', TOOL = 'approve';
const PROTOCOL = '2024-11-05';
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
// Test seams: poll interval and the reminder schedule (ms). Defaults: 1 s, 10 min, 1 h.
const POLL_MS = () => num(process.env.HARNESS_APPROVE_POLL_MS, 1000);
const FIRST_MS = () => num(process.env.HARNESS_APPROVE_REMIND_FIRST_MS, 10 * 60000);
const EVERY_MS = () => num(process.env.HARNESS_APPROVE_REMIND_EVERY_MS, 60 * 60000);

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 3) + '...' : s; };
const allow = input => ({ behavior: 'allow', updatedInput: input });
const deny = message => ({ behavior: 'deny', message });

// The run-time config's modules, loaded once per process (the hook loads them per call; this server lives
// for the whole engine turn). A config or module load error leaves no modules: every call is then denied.
let LOADED = null;
function loaded() {
  if (LOADED) return LOADED;
  try {
    const cfg = C.load();
    const { mods, meta, errors } = M.load(cfg);
    LOADED = errors && errors.length ? { err: 'module load error' } : { cfg, mods, meta };
  } catch { LOADED = { err: 'run-time config unreadable' }; }
  return LOADED;
}

// Same check the guard hook ran: every loaded module's beforeTool (lib/modules.js), first block wins,
// an ask is kept unless a later module blocks. -> ['ask'|'block', kind, why] | null
async function classify(tool, input, cwd) {
  const L = loaded();
  if (L.err) return ['block', 'config', L.err + ' (fail closed)'];
  const hit = await M.beforeTool(L.mods, { input: { tool_name: tool, tool_input: input }, tool, ti: input, cwd: cwd || process.cwd(), config: L.cfg });
  if (!hit) return null;
  return /^ask:/.test(hit[0]) ? ['ask', hit[0].slice(4), hit[1]] : ['block', hit[0], hit[1]];
}

// io for the card store: approval-cards' own state and events when the module is loaded,
// else null (no way for the owner to answer, so the red line fails closed).
function cardsIo() {
  const L = loaded();
  const mt = !L.err && L.meta && L.meta.get('approval-cards');
  if (!mt || !mt.state) return null;
  return { J, state: mt.state, settings: mt.settings, emit: (ev, p) => M.emit(L.mods, ev, p).catch(() => {}) };
}

// The card store, through the loaded approval-cards module's api (core never requires modules/).
function cardsApi() {
  const L = loaded();
  return L.err ? null : M.apiOf(L.mods, 'approval-cards');
}

// The latest hook_ask record for this tool_use_id (and task), or null. deps.records (tests) stands in for the journal.
function hookAsk(id, deps) {
  if (typeof id !== 'string' || !id) return null;
  let recs;
  try { recs = deps.records || J.readAll().records; } catch { return null; }
  const task = deps.task_id !== undefined ? deps.task_id : (process.env.HARNESS_TASK_ID || null);
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (r && r.type === 'hook_ask' && r.tool_use_id === id && (r.task_id || null) === task) return r;
  }
  return null;
}

// Live cards this process raised and still waits on; closed as a system no when stdin ends.
const WAITING = new Map(); // card_id -> {io, card}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// One permission prompt -> {behavior, ...}. deps (tests): {io, now, sleep, task_id, cwd, classify};
// deps.cancelled(): true once the host cancelled this request.
async function decide(params, deps = {}) {
  const tool = String((params && params.tool_name) || '');
  const input = params && params.input && typeof params.input === 'object' && !Array.isArray(params.input) ? params.input : {};
  // The guard hook's ask for this call (guards/guard.js hook_ask): its cwd is where the call runs, and its ask
  // stands even if a re-check here (another directory, a changed config) would pass the call.
  const hk = hookAsk(params && params.tool_use_id, deps);
  const cwd = deps.cwd || (hk && hk.cwd) || null;
  let c = await (deps.classify || classify)(tool, input, cwd);
  if (!c && hk) c = ['ask', String(hk.kind || 'ask'), String(hk.reason || 'red line')];
  if (!c) return allow(input);
  if (c[0] === 'block') return deny(`blocked (${c[1]}): ${c[2]}. Do not retry another way.`);
  const task_id = deps.task_id !== undefined ? deps.task_id : (process.env.HARNESS_TASK_ID || null);
  const io = deps.io || cardsIo(), K = cardsApi();
  if (!io || !K || typeof K.create !== 'function') return deny(`red line (${c[1]}): ${c[2]}. The approval-cards module is off, so nobody can approve it; skip this step and tell the person.`);
  const what = clip(tool === 'Bash' || tool === 'PowerShell' ? input.command : input.file_path || input.url || JSON.stringify(input), 160);
  const now = deps.now || K.now, wait = deps.sleep || sleep;
  const where = cwd ? require('path').resolve(String(cwd)) : null;
  const card = await K.create(io, { task_id, tool, input, rule: 'redline:' + c[1], cwd: where, summary: `${c[2]}: ${what}${where ? ` (in ${clip(where, 80)})` : ''}` }, io.settings, { live: true });
  WAITING.set(card.card_id, { io, card, K });
  try { return await waitOn(K, io, card, input, c, task_id, now, wait, deps.cancelled || (() => false)); }
  finally { WAITING.delete(card.card_id); }
}

async function waitOn(K, io, card, input, c, task_id, now, wait, cancelled) {
  J.append({ type: 'needs_you', task_id, card_id: card.card_id, kind: c[1], summary: card.summary, note: 'a waiting approval pauses all bots until answered or stopped' });
  const born = now();
  let reminders = 0;
  for (;;) {
    const records = J.readAll().records;
    // The folded card must be this one (same call hash and creation time), never another card under the same id.
    let cur = K.fold(records).get(card.card_id);
    if (cur && (cur.sha256 !== card.sha256 || cur.created_at !== card.created_at)) cur = null;
    // A stopped task or a cancelled request wins over a yes that landed in the same poll: nothing runs after a stop.
    if (task_id && records.some(r => r.type === 'task_done' && r.task_id === task_id)) {
      if (cur && cur.state === 'pending') await K.answered(io, cur, 'no', { reason: 'the task was stopped' }, { who: 'system', where: null });
      return deny(`card ${card.card_id}: the task was stopped. Do nothing more.`);
    }
    if (cancelled()) {
      if (cur && cur.state === 'pending') await K.answered(io, cur, 'no', { reason: 'the prompt was cancelled' }, { who: 'system', where: null });
      return deny(`card ${card.card_id}: the request was cancelled; this step was not run.`);
    }
    if (cur && (cur.state === 'approved' || cur.state === 'used')) {
      if (cur.state === 'approved') io.state.append({ type: 'card_used', card_id: card.card_id, task_id });
      return allow(input);
    }
    if (cur && cur.state === 'denied') return deny(K.denyMessage(cur, cur.decided || { who: 'owner' }));
    const due = FIRST_MS() + reminders * EVERY_MS();
    const waited = now() - born;
    if (waited >= due) {
      reminders++;
      J.append({ type: 'card_reminder', task_id, card_id: card.card_id, n: reminders, waited_min: Math.floor(waited / 60000) });
      continue;
    }
    await wait(POLL_MS());
  }
}

// ---- MCP stdio
const TOOLS = [{
  name: TOOL,
  description: 'Permission prompt for the Taskmote engine: allows ordinary calls, and asks the owner on an approval card for red lines.',
  inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
}];

// Request ids in flight -> {cancelled}; notifications/cancelled marks one (the waiting loop sees it on its next poll).
const INFLIGHT = new Map();

async function handle(msg) {
  const { id, method, params } = msg || {};
  if (method === 'notifications/cancelled') {
    const f = params && INFLIGHT.get(params.requestId);
    if (f) f.cancelled = true;
    return undefined;
  }
  if (method === 'initialize') return { protocolVersion: (params && params.protocolVersion) || PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: NAME, version: '1.0.0' } };
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'ping') return {};
  if (method === 'tools/call') {
    if (!params || params.name !== TOOL) throw Object.assign(new Error(`unknown tool ${params && params.name}`), { code: -32602 });
    let r;
    const f = { cancelled: false };
    if (id !== undefined) INFLIGHT.set(id, f);
    try { r = await decide(params.arguments || {}, { cancelled: () => f.cancelled }); }
    catch (e) { r = deny(`the approval tool failed (${clip(e && e.message, 80)}); this step was not run. Skip it and tell the person.`); }
    finally { if (id !== undefined) INFLIGHT.delete(id); }
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
  }
  if (id === undefined) return undefined; // a notification (notifications/initialized ...)
  throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
}

function serve(inp = process.stdin, out = process.stdout) {
  const send = o => out.write(JSON.stringify(o) + '\n');
  let buf = '';
  inp.setEncoding('utf8');
  inp.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
      handle(msg).then(result => { if (msg.id !== undefined && result !== undefined) send({ jsonrpc: '2.0', id: msg.id, result }); },
        e => { if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: clip(e.message, 200) } }); });
    }
  });
  // stdin closed: the engine is gone, so nobody will read an answer. Close this process's live cards first.
  inp.on('end', () => closeWaiting('the engine ended').finally(() => process.exit(0)));
}

async function closeWaiting(why) {
  for (const { io, card, K } of [...WAITING.values()]) {
    try {
      const cur = K.fold(J.readAll().records).get(card.card_id);
      if (cur && cur.state === 'pending') await K.answered(io, cur, 'no', { reason: why }, { who: 'system', where: null });
    } catch { /* the harness closes it when the turn ends */ }
  }
  WAITING.clear();
}

if (require.main === module) serve();
module.exports = { decide, classify, handle, closeWaiting, NAME, TOOL };
