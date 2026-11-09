'use strict';
// The foundation routes: GET api/snapshot, GET api/bots/:id/messages, POST api/bots/:id/messages.
const L = require('./lib');

const MAX_TEXT = 8000;
const intIn = (v, d, lo, hi) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const known = (ctx, id) => L.roster(ctx).some(b => b.id === id);

function snapshot(ctx) {
  const n = intIn(ctx.query && ctx.query.messages, 50, 0, 200);
  const list = L.bots(ctx);
  const messages = {}, threads = {};
  for (const b of list) {
    threads[b.id] = b.threadId;
    messages[b.id] = n ? L.journalMessages(ctx, b.id, { limit: n }) : [];
  }
  return { status: 200, json: { bots: list, groups: [], sections: [], computerControl: null, botQueuedMessages: {}, messages, threads } };
}

function history(ctx) {
  const id = ctx.params.id;
  if (!known(ctx, id)) return { status: 404, json: { error: 'unknown bot' } };
  const q = ctx.query || {};
  return { status: 200, json: { messages: L.journalMessages(ctx, id, { limit: intIn(q.limit, 50, 1, 200), before: typeof q.before === 'string' ? q.before : undefined }), threadId: L.threadId(id) } };
}

async function send(ctx) {
  const id = ctx.params.id;
  if (!known(ctx, id)) return { status: 404, json: { error: 'unknown bot' } };
  const text = ctx.body && ctx.body.text;
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return { status: 400, json: { error: `text must be 1 to ${MAX_TEXT} characters` } };
  let task;
  try { task = await ctx.tasks.enqueue(id, text); } catch (e) { return { status: 502, json: { error: 'could not start the task' } }; }
  const tid = task && task.id;
  if (!tid) return { status: 502, json: { error: 'could not start the task' } };
  return { status: 201, json: { message: { id: L.userMessageId(tid), role: 'user', kind: 'text', text, createdAt: Date.now() }, threadId: L.threadId(id), taskId: tid } };
}

module.exports = [
  { method: 'GET', path: 'api/snapshot', access: 'owner', handler: snapshot },
  { method: 'GET', path: 'api/bots/:id/messages', access: 'owner', handler: history },
  { method: 'POST', path: 'api/bots/:id/messages', access: 'owner', handler: send },
];
