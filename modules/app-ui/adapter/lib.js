'use strict';
// Server-side helpers shared by the foundation routes and the area route files.
// bots(ctx)               WireBot list: the config roster plus the owner's botOverrides
// journalMessages(...)    a bot's chat history as WireMessage rows, read from the journal
// threadId(botId)         'main:' + botId
// getState / setState     small JSON values kept in this module's state folder
const fs = require('fs');
const path = require('path');
const J = require('../../../lib/journal');
const { redact } = require('../../../lib/redact');

const threadId = botId => 'main:' + botId;
const userMessageId = task => task + ':u';
const replyMessageId = (task, bot) => task + ':' + bot + ':a';

function roster(ctx) {
  const cfg = (ctx && ctx.config) || {};
  const list = Array.isArray(cfg.bots) && cfg.bots.length ? cfg.bots : [{ id: 'main', name: 'main', engine: (cfg.engine && cfg.engine.name) || 'claude', runsOn: 'main' }];
  return list.filter(b => b && b.id !== undefined).map(b => ({ id: String(b.id), name: String(b.name || b.id), engine: String(b.engine || 'claude'), runsOn: b.runsOn === 'worker' ? 'worker' : 'main' }));
}

// ---- small state values (state/m/app-ui/values.json), written whole and renamed into place
function valuesFile(ctx) { return path.join(ctx.state.dir, 'values.json'); }
function readValues(ctx) {
  try { const v = JSON.parse(fs.readFileSync(valuesFile(ctx), 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
function getState(ctx, key, fallback) { const v = readValues(ctx); return Object.prototype.hasOwnProperty.call(v, key) ? v[key] : fallback; }
function setState(ctx, key, value) {
  const v = readValues(ctx); v[key] = value;
  const f = valuesFile(ctx), tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v));
  fs.renameSync(tmp, f);
  return value;
}

const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

// Which bots have a task that has started and not finished.
function busyBots(records) {
  const bot = new Map(), open = new Set();
  const START = ['queue_add', 'task_start', 'job_queued'];
  const END = ['task_done', 'queue_fail', 'queue_cancel', 'job_result', 'job_cancel'];
  for (const r of records) {
    if (!r.task_id) continue;
    if (START.includes(r.type)) { if (r.bot) bot.set(r.task_id, r.bot); open.add(r.task_id); }
    if (END.includes(r.type)) open.delete(r.task_id);
  }
  return new Set([...open].map(t => bot.get(t)).filter(Boolean));
}

function bots(ctx) {
  const over = getState(ctx, 'botOverrides', {}) || {};
  let busy = new Set();
  try { busy = busyBots(J.readAll().records); } catch { /* no journal yet */ }
  return roster(ctx).map(b => {
    const o = over[b.id] && typeof over[b.id] === 'object' ? over[b.id] : {};
    const bot = {
      id: b.id, threadId: threadId(b.id),
      name: clip(o.name, 80) || b.name, title: '', description: clip(o.description, 500),
      status: busy.has(b.id) ? 'busy' : 'idle', runsOn: b.runsOn, engine: b.engine,
    };
    if (typeof o.color === 'string' && o.color) bot.color = o.color.slice(0, 40);
    if (o.hidden === true) bot.hidden = true;
    return bot;
  });
}

// One user row and one reply row per task of this bot, oldest first.
// before: a message id; only rows older than it. limit: at most this many (the newest).
function journalMessages(ctx, botId, opts = {}) {
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  const tasks = new Map(); // task -> { bot, prompt, reply, ts }
  const order = [];
  for (const r of J.readAll().records) {
    const id = r.task_id;
    if (!id) continue;
    let t = tasks.get(id);
    if (!t) { t = { bot: null, prompt: null, reply: null, ts: r.ts }; tasks.set(id, t); order.push(id); }
    if (r.bot) t.bot = r.bot;
    if (r.type === 'queue_add' && typeof r.prompt === 'string' && t.prompt === null) t.prompt = r.prompt;
    else if (r.type === 'task_start' && typeof r.request === 'string' && t.prompt === null) t.prompt = r.request;
    else if (r.type === 'job_queued' && r.payload && typeof r.payload.prompt === 'string' && t.prompt === null) t.prompt = r.payload.prompt;
    else if (r.type === 'reply' && typeof r.text === 'string') t.reply = { text: r.text, ts: r.ts };
    else if (r.type === 'job_result' && r.result && typeof r.result.reply === 'string') t.reply = { text: r.result.reply, ts: r.ts };
  }
  const at = s => { const n = Date.parse(s); return Number.isFinite(n) ? n : undefined; };
  const rows = [];
  for (const id of order) {
    const t = tasks.get(id);
    if (t.bot !== botId) continue;
    if (t.prompt !== null) rows.push({ id: userMessageId(id), role: 'user', kind: 'text', text: redact(clip(t.prompt, 8000)), createdAt: at(t.ts) });
    if (t.reply) rows.push({ id: replyMessageId(id, botId), role: 'bot', kind: 'text', text: redact(clip(t.reply.text, 20000)), createdAt: at(t.reply.ts) });
  }
  let end = rows.length;
  if (opts.before) { const i = rows.findIndex(m => m.id === opts.before); if (i >= 0) end = i; }
  return rows.slice(Math.max(0, end - limit), end);
}

module.exports = { bots, roster, journalMessages, threadId, userMessageId, replyMessageId, getState, setState };
