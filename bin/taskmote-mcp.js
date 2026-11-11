#!/usr/bin/env node
'use strict';
// Taskmote as an MCP stdio server: any Claude Code session (or other MCP client) can call the
// features Claude Code does not have. Register it with:
//   claude mcp add taskmote -- node <repo>/bin/taskmote-mcp.js
// Every tool is listed and works with no flag. --allow-write, --no-ask and env TASKMOTE_MCP_WRITE=1
// are still accepted so old launch commands do not break, but they change nothing.
// undo_task undoes at once and then tells the owner with a non-blocking info card.
// Tools (each one calls an existing module api or CLI path, no logic of its own):
//   ask_owner      raise a question card on the owner's phone and wait for the answer (question-cards)
//   queue_task     queue a task the way `taskmote do` does (server if live, else direct)
//   task_status    one task, or the recent tasks, from the journal
//   undo_task      step a task's workdir back one change, as change-card / `taskmote undo` do (checkpoint)
//   digest         the while-you-were-away summary JSON (digest)
//   search_journal full-text search over tasks, messages, rooms (search)
// A tool whose module is off answers with text naming the module to enable; nothing crashes.
// ask_owner never denies or fails the caller: no answer in time is {"answered":false}.
// The approve tool (bin/approve-mcp.js) is a separate server and is not touched.
// No dependencies; JSON-RPC 2.0, one message per line on stdin / stdout.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const J = require('../lib/journal');
const C = require('../lib/config');
const M = require('../lib/modules');
const T = require('../lib/mcp-tiers');

const NAME = 'taskmote';
const PROTOCOL = '2024-11-05';
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
// Test seams (ms): answer poll interval; how long queue_task waits to learn the new task id.
const POLL_MS = () => num(process.env.HARNESS_MCP_POLL_MS, 1000);
const QUEUE_WAIT_MS = () => num(process.env.HARNESS_MCP_QUEUE_WAIT_MS, 20000);
const DEFAULT_ASK_S = 1800;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 3) + '...' : s; };

// Config and modules, loaded once per process.
let LOADED = null;
function loaded() {
  if (LOADED) return LOADED;
  try {
    const cfg = C.load();
    const { mods, meta, errors } = M.load(cfg);
    LOADED = errors && errors.length ? { err: 'module load error: ' + clip(errors.map(e => (e && e.message) || e).join('; '), 300) } : { cfg, mods, meta };
  } catch (e) { LOADED = { err: 'run-time config unreadable: ' + clip(e && e.message, 200) }; }
  return LOADED;
}
class ToolError extends Error {}
const off = name => new ToolError(`the ${name} module is off or not installed. Enable it: set "${name}": true under "modules" in the Taskmote config (it needs a modules/${name} folder), then restart this server.`);
// -> { api, mt, ctx } for an enabled module, else throws a ToolError naming it.
function need(name) {
  const L = loaded();
  if (L.err) throw new ToolError(L.err);
  const mt = L.meta.get(name), api = M.apiOf(L.mods, name);
  if (!mt || !api) throw off(name);
  const emit = (ev, p) => M.emit(L.mods, ev, p).catch(() => {});
  return { api, mt, ctx: { state: mt.state, settings: mt.settings, config: L.cfg, emit } };
}

// ---- ask_owner ----
const cancelled = new Set(); // request ids the client cancelled
async function askOwner(a, reqId) {
  const { api, ctx } = need('question-cards');
  const timeoutS = a.timeout_s === undefined ? DEFAULT_ASK_S : num(a.timeout_s, 0);
  if (!timeoutS) throw new ToolError('timeout_s must be a positive number of seconds');
  const body = { text: a.question, options: a.choices, allow_free: false };
  if (a.locales !== undefined) body.locales = a.locales; // optional translations, validated by the module
  if (process.env.HARNESS_TASK_ID) body.task_id = process.env.HARNESS_TASK_ID;
  const v = api.validateAsk(body);
  if (!v.ok) throw new ToolError(v.error);
  const r = await api.ask.call({ ctx }, v.value);
  if (r.error) throw new ToolError(r.error);
  const id = r.question.question_id;
  const end = Date.now() + timeoutS * 1000;
  const vaultFile = path.join(ctx.state.dir, 'vault.json');
  for (;;) {
    let vault = {};
    try { vault = JSON.parse(fs.readFileSync(vaultFile, 'utf8')) || {}; } catch { /* none */ }
    const q = api.fold(J.readAll().records, vault).get(id);
    if (q && q.state === 'answered') {
      return { answered: true, question_id: id, choice: q.answer.choice, option: q.answer.option, text: q.answer.free_text };
    }
    if (q && (q.state === 'cancelled' || q.state === 'expired' || api.isExpired(q))) return { answered: false, question_id: id, state: q.state === 'pending' ? 'expired' : q.state };
    if (cancelled.has(reqId) || Date.now() >= end) return { answered: false, question_id: id, state: 'pending' };
    await sleep(Math.min(POLL_MS(), Math.max(1, end - Date.now())));
  }
}

// ---- journal views ----
// task_id -> {task_id, request, workdir, state, started_at} in start order.
function taskViews(records) {
  const tasks = new Map();
  for (const r of records) {
    const t = r.task_id && tasks.get(r.task_id);
    if (r.type === 'queue_add') tasks.set(r.task_id, { task_id: r.task_id, request: r.prompt || '', workdir: r.workdir || null, state: 'queued', created_at: r.ts || null });
    else if (r.type === 'task_start') {
      const x = t || tasks.set(r.task_id, { task_id: r.task_id }).get(r.task_id);
      Object.assign(x, { request: r.request, workdir: r.workdir, state: 'running', created_at: x.created_at || r.ts || null });
    } else if (r.type === 'queue_fail' && t) t.state = 'failed';
    else if (r.type === 'queue_cancel' && t) t.state = 'stopped';
    else if (r.type === 'task_done' && t) t.state = r.stopped ? 'stopped' : (r.failed || r.aborted) ? 'failed' : 'done';
  }
  return [...tasks.values()];
}
const brief = t => ({ task_id: t.task_id, state: t.state, request: clip(t.request, 200), workdir: t.workdir || null, created_at: t.created_at || null });

function taskStatus(a) {
  const all = taskViews(J.readAll().records);
  if (a.task_id !== undefined && a.task_id !== null && a.task_id !== '') {
    const t = all.find(x => x.task_id === a.task_id);
    if (!t) throw new ToolError(`no task ${clip(a.task_id, 60)}`);
    return brief(t);
  }
  const limit = Math.min(50, Math.floor(num(a.limit, 10)));
  return { tasks: all.slice(-limit).reverse().map(brief) };
}

// ---- task family (queue_task / undo_task from inside a task session) ----
// The server env carries HARNESS_TASK_ID only for a task session; the owner's own session has none and is never capped.
// A task queued from inside a task is journaled as {type:'task_parent', task_id, parent_task_id}; an owner-started task has none (depth 0).
const MAX_DEPTH = 2, MAX_CHILDREN = 5;
const parentMap = records => { const m = new Map(); for (const r of records) if (r.type === 'task_parent' && r.task_id && r.parent_task_id) m.set(r.task_id, r.parent_task_id); return m; };
const depthOf = (id, parents) => { let d = 0; for (let x = id; parents.has(x) && d < 100; x = parents.get(x)) d++; return d; };
const inFamily = (id, root, parents) => { for (let x = id, n = 0; x && n < 100; x = parents.get(x), n++) if (x === root) return true; return false; };

// ---- queue_task ----
// Deliberately the exact CLI path (`taskmote do`), never a shortcut into the executor: that is what
// makes the guards, approval cards and spend counting apply as for a typed command.
// The exact CLI path (`taskmote do`): it uses a live server when there is one, else runs the task itself.
// We start it detached, then read the new task id from the journal (direct) or its output (server).
async function queueTask(a) {
  const request = typeof a.request === 'string' ? a.request.trim() : '';
  if (!request) throw new ToolError('request is required (a non-empty string)');
  if (a.cwd !== undefined && (typeof a.cwd !== 'string' || !a.cwd.trim())) throw new ToolError('cwd must be a path string');
  const caller = process.env.HARNESS_TASK_ID || null;
  if (caller) {
    const parents = parentMap(J.readAll().records);
    if (depthOf(caller, parents) + 1 > MAX_DEPTH) throw new ToolError(`task family cap: depth limit ${MAX_DEPTH} reached (an owner task is depth 0; a task at depth ${MAX_DEPTH} may not queue more tasks).`);
    const kids = [...parents.values()].filter(p => p === caller).length;
    if (kids >= MAX_CHILDREN) throw new ToolError(`task family cap: this task has already queued ${MAX_CHILDREN} tasks (limit ${MAX_CHILDREN} children per task).`);
  }
  const open = J.openTask(J.readAll().records);
  if (open) throw new ToolError(`task ${open.task_id} is still open ("${clip(open.request, 80)}"). Wait for it to finish, or check task_status.`);
  const before = J.readAll().records.length;
  fs.mkdirSync(J.STATE, { recursive: true });
  const logFile = path.join(J.STATE, `mcp-queue-${process.pid}-${Date.now()}.log`);
  const fd = fs.openSync(logFile, 'w');
  const env = { ...process.env };
  for (const k of ['HARNESS_TASK_ID', 'HARNESS_TASK_DIR', 'HARNESS_OWNER']) delete env[k];
  const args = [path.join(__dirname, 'taskmote.js'), 'do', request, ...(a.cwd ? ['--workdir', path.resolve(a.cwd)] : [])];
  const child = spawn(process.execPath, args, { stdio: ['ignore', fd, fd], env, detached: true, windowsHide: true });
  fs.closeSync(fd);
  let exit = null;
  child.on('exit', code => { exit = code === null ? 1 : code; });
  child.on('error', () => { exit = 1; });
  child.unref();
  const end = Date.now() + QUEUE_WAIT_MS();
  const tail = () => { try { return clip(fs.readFileSync(logFile, 'utf8'), 300); } catch { return ''; } };
  const done = id => { try { fs.unlinkSync(logFile); } catch { /* best effort */ } if (caller) J.append({ type: 'task_parent', task_id: id, parent_task_id: caller }); return { queued: true, task_id: id }; };
  for (;;) {
    const hit = J.readAll().records.slice(before).find(r => r.type === 'task_start' && r.request === request);
    if (hit) return done(hit.task_id);
    let m; try { m = /task (\S+) sent to the server/.exec(fs.readFileSync(logFile, 'utf8')); } catch { m = null; }
    if (m) return done(m[1]);
    if (exit !== null && exit !== 0) throw new ToolError(`could not queue the task: ${tail() || 'taskmote do exited with ' + exit}`);
    if (Date.now() >= end) throw new ToolError(`the task did not start in time; output so far: ${tail() || '(none)'}`);
    await sleep(50);
  }
}

// ---- undo_task ----
// Undoes at once, whoever queued the task, then posts a non-blocking info card to the owner (after the fact).
// As change-card does: the executor lock (held means a task runs: change nothing), then
// checkpoint.restore to the oldest-numbered non-safety undo point (the state before the agent's first change).
const EXEC_LOCK = () => path.join(J.STATE, 'executor.lock');
// Informational card, posted after the undo and never waited on. No question-cards module, or any failure: skipped quietly.
function tellOwnerUndone(t, n) {
  try {
    const { api, ctx } = need('question-cards');
    const v = api.validateAsk({ text: `Task ${t.task_id} ("${clip(t.request, 80)}") was undone: its folder is back to before the agent changed it (undo point ${n}). For your information, nothing to answer.`, options: ['OK', 'Dismiss'], allow_free: false, task_id: t.task_id,
      locales: { 'zh-TW': { text: `任務 ${t.task_id}（「${clip(t.request, 80)}」）已復原：資料夾回到 agent 修改之前的樣子（復原點 ${n}）。僅供通知，不需回覆。`, options: ['好', '關閉'] } } });
    if (v.ok) Promise.resolve(api.ask.call({ ctx }, v.value)).catch(() => {});
    J.append({ type: 'undo_notice', task_id: t.task_id, carded: v.ok });
  } catch { /* the undo already happened; the notice is best effort */ }
}
async function undoTask(a) {
  if (typeof a.task_id !== 'string' || !a.task_id) throw new ToolError('task_id is required');
  const caller = process.env.HARNESS_TASK_ID || null;
  if (caller && !inFamily(a.task_id, caller, parentMap(J.readAll().records))) throw new ToolError(`undo refused: a task may only undo itself and the tasks it queued (${clip(a.task_id, 60)} is not in the family of ${caller}).`);
  const { api: ck } = need('checkpoint');
  const t = [...J.readAll().records].reverse().find(r => r.type === 'task_start' && r.task_id === a.task_id);
  if (!t) throw new ToolError(`no task ${clip(a.task_id, 60)}`);
  const blocked = { undone: false, blocked: true, reason: 'a task is still running; nothing was changed' };
  const lock = EXEC_LOCK();
  const l = J.lock(lock, { pids: [process.pid], task_id: t.task_id, restore: true });
  if (!l.held) return blocked;
  try {
    const n = ck.steps(t.task_id).filter(s => !s.safety).map(s => s.step).sort((x, y) => x - y)[0];
    if (n === undefined) return { undone: false, blocked: false, reason: 'nothing to undo: this task has no undo points' };
    const r = ck.restore(t.task_id, n, { user: true });
    J.append({ type: 'undo', task_id: t.task_id, n: Number(n), ref: r.ref, undo_ref: r.undo.ref });
    tellOwnerUndone(t, n);
    return { undone: true, task_id: t.task_id, to_step: n, removed_files: r.removed.length, undo_ref: r.undo.ref };
  } catch (e) { throw new ToolError('undo failed: ' + clip(String((e && e.message) || e).split('\n')[0], 200)); }
  finally { if (!J.unlock(lock, l.nonce)) J.unlockLater(lock, l.nonce, undefined, 'taskmote-mcp'); }
}

// ---- digest / search_journal: the module's own route handler, so settings and limits apply as on the web ----
async function viaRoute(name, method, p, query) {
  const { mt, ctx } = need(name);
  const route = (mt.routes || []).find(r => r.method === method && r.path === `/m/${name}${p}`);
  if (!route) throw new ToolError(`the ${name} module has no ${p} route`);
  const r = await route.handler({ ...ctx, query, params: {}, body: undefined, actor: 'owner' });
  if (!r || r.status !== 200) throw new ToolError(clip((r && r.json && r.json.error) || 'request failed', 300));
  return r.json;
}
const digest = a => viaRoute('digest', 'GET', '/digest', a.since === undefined || a.since === null ? {} : { since: String(a.since) });
function searchJournal(a) {
  const q = { q: a.query };
  if (a.limit !== undefined && a.limit !== null) q.limit = String(a.limit);
  return viaRoute('search', 'GET', '/search', q);
}

const TOOLS = [
  { name: 'ask_owner', when: 'Need an answer from the owner before going on', tier: 1, category: 'tasks', description: 'Ask the owner a question on their phone (a question card) and wait for the answer. Returns {answered:true, choice, option, text} or, if no answer arrives in time, {answered:false}. Never an error because the owner is away.',
    inputSchema: { type: 'object', properties: { question: { type: 'string', description: 'The question.' }, choices: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 6, description: '2 to 6 short answers.' }, timeout_s: { type: 'number', description: 'How long to wait, in seconds (default 1800). The card stays open after.' } }, required: ['question', 'choices'] } },
  { name: 'queue_task', when: 'Start a separate task in a folder, like taskmote do', tier: 1, category: 'tasks', description: 'Queue a task for Taskmote to run, the way `taskmote do` does. Returns the task id. cwd is the folder the task works in (an existing folder; default: the bot folder).',
    inputSchema: { type: 'object', properties: { request: { type: 'string', description: 'What to do.' }, cwd: { type: 'string', description: 'Working directory for the task.' } }, required: ['request'] } },
  { name: 'task_status', when: 'Check how one task or the recent tasks are going', tier: 1, category: 'tasks', description: 'Status of one task, or of the recent tasks, from the journal.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, limit: { type: 'number', description: 'How many recent tasks (default 10, max 50).' } } } },
  { name: 'undo_task', when: 'Roll a task back: restore its folder to before it ran', tier: 2, category: 'tasks', description: 'Undo a task: put its workdir back to before the agent changed it. Undoes immediately, then sends the owner an informational card on their phone. If a task is running it changes nothing and returns {blocked:true}.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
  { name: 'digest', when: 'Summarize what happened while the owner was away', tier: 2, category: 'journal', description: 'The while-you-were-away summary of the journal as JSON. Card titles are left out when the digest module has include_titles off.',
    inputSchema: { type: 'object', properties: { since: { type: 'string', description: 'ISO date/time or a span like 30m, 12h, 2d. Default: the digest module default.' } } } },
  { name: 'search_journal', when: 'Find something said or done in past tasks or chats', tier: 1, category: 'journal', description: 'Full-text search over past tasks, messages and room transcripts.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
];
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k); // own keys only: "constructor" and "__proto__" are not tools
const IMPL = { ask_owner: askOwner, queue_task: queueTask, task_status: taskStatus, undo_task: undoTask, digest, search_journal: searchJournal, expand_tools: expandTools };
const CORE_CATEGORIES = {
  tasks: { title: 'Tasks', when: 'ask the owner, queue, check or undo a task' },
  journal: { title: 'Journal', when: 'search the journal, or a while-you-were-away summary' },
};

// Tools that enabled modules offer through api.mcpTools: [{name, description, inputSchema, run(args, ctx)}].
// ctx is the same module ctx the other module-backed tools get. Core tool names win a clash; a module tool is
// listed only while its module is on, and a module that fails to load adds nothing.
const droppedTools = new Set(); // log each dropped module tool once
function moduleTools() {
  const L = loaded(), out = [];
  if (L.err) return out;
  for (const name of L.meta.keys()) {
    const api = M.apiOf(L.mods, name);
    if (!api || !Array.isArray(api.mcpTools)) continue;
    for (const t of api.mcpTools) {
      if (!t || typeof t.name !== 'string' || typeof t.run !== 'function' || Object.prototype.hasOwnProperty.call(IMPL, t.name) || out.some(o => o.name === t.name)) { const k = `${name}/${t && t.name}`; if (!droppedTools.has(k)) { droppedTools.add(k); process.stderr.write(`taskmote-mcp: module ${name} tool dropped (bad shape or name taken): ${String(t && t.name).slice(0, 60)}
`); } continue; }
      out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema, run: t.run, module: name, tier: t.tier, category: t.category, when: t.when });
    }
  }
  return out;
}

// ---- tiers (lib/mcp-tiers.js) ----
// Tier 1 tools are listed; tier 2 are folded into the expand_tools menu; tier 3 are reachable by exact name only.
// expanded = tools this session has asked to see (listed from then on). tools/call works for any registered tool, listed or not;
// the client's own permission rules apply to it. A tool shown by expand_tools reaches the client through tools/list (list_changed).
const expanded = new Set();
const notes = []; // notifications waiting to be written after the next reply
const extraTools = []; // test seam: more core-like tools, never used in production
const warn = msg => process.stderr.write('taskmote-mcp: ' + msg + String.fromCharCode(10));
const allTools = () => [...TOOLS.map(t => ({ ...t, module: 'core' })), ...extraTools, ...moduleTools()];
function categoryMap() {
  const out = { ...CORE_CATEGORIES }, L = loaded();
  if (L.err) return out;
  for (const name of L.meta.keys()) {
    const api = M.apiOf(L.mods, name), mc = api && api.mcpCategories;
    if (!mc || typeof mc !== 'object') continue;
    for (const id of Object.keys(mc)) if (mc[id] && typeof mc[id].title === 'string') out[id] = { title: mc[id].title, when: typeof mc[id].when === 'string' ? mc[id].when : '' };
  }
  return out;
}
const listPublic = () => T.listTools(allTools(), { categories: categoryMap(), expanded, warn });
const taskIdNow = () => process.env.HARNESS_TASK_ID || null;
function expandTools(a) {
  const tools = allTools(), r = T.expand(tools, a, categoryMap(), warn);
  if (r.error) throw new ToolError(r.error);
  let grew = false;
  for (const x of r.reveal) {
    if (x.tier === 3) J.append({ type: 'tool_expand', tool: x.name, tier: 3, task_id: taskIdNow() });
    if (!expanded.has(x.name)) { expanded.add(x.name); grew = true; }
  }
  if (grew) notes.push({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  const out = { tools: r.tools, hint: 'Call these by their own name; they are listed from now on.' };
  if (r.categories) out.categories = r.categories;
  if (r.matches) out.matches = r.matches;
  return out;
}
// Runs any registered tool by name (the same code path as tools/call). Tier 3 calls are journaled.
// Block-only call-time check: the pure content rules of guard-base and guard-private-rules, under the registered server name.
// A block refuses and is journaled; an ask or anything else passes through (the engine hook owns approvals). No other module runs here.
const CALL_SERVER = 'taskmote-tools';
function callTimeBlock(name, a) {
  const L = loaded();
  if (L.err) return null;
  const tool = 'mcp__' + CALL_SERVER + '__' + name;
  const run = (mod, fn) => {
    let api; try { api = M.apiOf(L.mods, mod); } catch { return null; }
    if (!api || typeof api[fn] !== 'function') return null;
    try { return fn === 'beforeTool' ? api.beforeTool({ tool, ti: a, cwd: process.cwd() }) : api.privateRules(tool, a); } catch { return null; }
  };
  // Evaluate both: an ask/allow answer from one must not hide a block from the other. First block wins.
  const isBlock = g => Array.isArray(g) && typeof g[0] === 'string' && !/^(ask|allow):/.test(g[0]);
  const a1 = run('guard-base', 'beforeTool'), a2 = run('guard-private-rules', 'privateRules');
  return isBlock(a1) ? a1 : isBlock(a2) ? a2 : null;
}
async function runTool(name, a, reqId) {
  const t = T.find(allTools(), name);
  if (!t && has(IMPL, name)) return IMPL[name](a, reqId);
  if (!t) throw new ToolError(`unknown tool ${clip(name, 40)}`);
  const blk = callTimeBlock(name, a);
  if (blk) { J.append({ type: 'tool_blocked', tool: name, kind: clip(blk[0], 40), task_id: taskIdNow() }); throw new ToolError(`${clip(name, 40)} refused: ${clip(blk[1], 160)} (${clip(blk[0], 40)})`); }
  if (T.tierOf(allTools(), name, warn) === 3) J.append({ type: 'tool_call', tool: name, tier: 3, task_id: taskIdNow() });
  if (t.module === 'core') return has(IMPL, name) ? IMPL[name](a, reqId) : t.run(a, reqId);
  if (!t.module) return t.run(a, reqId); // in-process test seam (extraTools)
  return t.run(a, need(t.module).ctx);
}
async function callTool(name, args, reqId) {
  try {
    const a = args && typeof args === 'object' ? args : {};
    const out = await runTool(name, a, reqId);
    return { content: [{ type: 'text', text: JSON.stringify(out) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e instanceof ToolError ? e.message : 'tool failed: ' + clip((e && e.message) || e, 300) }] };
  }
}

async function handle(msg) {
  const { method, params = {}, id } = msg;
  if (method === 'notifications/cancelled') { if (params.requestId !== undefined) cancelled.add(params.requestId); return null; }
  if (id === undefined) return null; // other notifications: no reply
  try {
    let result;
    if (method === 'initialize') result = { protocolVersion: params.protocolVersion || PROTOCOL, capabilities: { tools: { listChanged: true } }, serverInfo: { name: NAME, version: '1' } };
    else if (method === 'ping') result = {};
    else if (method === 'tools/list') result = { tools: listPublic() };
    else if (method === 'tools/call') {
      if (!has(IMPL, params.name) && !T.find(allTools(), params.name)) throw Object.assign(new Error(`unknown tool ${clip(params.name, 40)}`), { code: -32602 });
      result = await callTool(params.name, params.arguments, id);
    } else throw Object.assign(new Error(`method not found: ${clip(method, 40)}`), { code: -32601 });
    return { jsonrpc: '2.0', id, result };
  } catch (e) { return { jsonrpc: '2.0', id, error: { code: e.code || -32603, message: e.message } }; }
}

function serve(inp = process.stdin, out = process.stdout) {
  let buf = '';
  inp.setEncoding('utf8');
  inp.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { out.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); continue; }
      handle(msg).then(res => { if (res) out.write(JSON.stringify(res) + '\n'); while (notes.length) out.write(JSON.stringify(notes.shift()) + '\n'); });
    }
  });
  inp.on('end', () => { setTimeout(() => process.exit(0), 50); });
}

if (require.main === module) serve();
module.exports = { handle, serve, TOOLS, taskViews, extraTools, notes, allTools };
