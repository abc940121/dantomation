'use strict';
// The chat package's route: GET api/bots/:id/history returns one page of older messages and whether
// more remain, so the thread can stop offering "load older". Our own file (MIT).
const L = require('../lib');

const intIn = (v, d, lo, hi) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const known = (ctx, id) => L.roster(ctx).some(b => b.id === id);

let helper;
const pageOf = async (rows, limit) => { helper = helper || (await import('./chat-history.mjs')); return helper.pageOf(rows, limit); };

async function history(ctx) {
  const id = ctx.params.id;
  if (!known(ctx, id)) return { status: 404, json: { error: 'unknown bot' } };
  const q = ctx.query || {};
  const limit = intIn(q.limit, 50, 1, 100);
  const rows = L.journalMessages(ctx, id, { limit: limit + 1, before: typeof q.before === 'string' ? q.before : undefined });
  const page = await pageOf(rows, limit);
  return { status: 200, json: { messages: page.messages, hasMore: page.hasMore, threadId: L.threadId(id) } };
}

module.exports = [
  { method: 'GET', path: 'api/bots/:id/history', access: 'owner', handler: history },
];
