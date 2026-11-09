'use strict';
// question-cards: a bot asks the owner a question with 2 to 6 choices (plus optional free
// text) and the answer reaches the asking task. Plain questions; risky actions are
// approval-cards' job. See README.md and DECISIONS.md.
const J = require('../../lib/journal');
const S = require('./store');

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 3) + '...' : s; };
// io for store.js: journal reads, this module's state (writes) and emit.
const ioOf = ctx => ({ J: (ctx && ctx.core && ctx.core.J) || (ctx && ctx.J) || J, state: ctx.state, emit: ctx.emit });
const inTask = () => !!process.env.HARNESS_TASK_ID;

// An agent may ask (command) but never answer, cancel or list through the shell or the server API.
const OWNER_CMD = /(dantomation|harness)(\.(js|cmd))?["']?\s+question\s+["']?(answer|cancel|list)\b/i;
const API_CMD = /\/m\/question-cards(?![\w-])/i;
function beforeTool(ctx) {
  if (!inTask()) return null;
  const { tool, ti } = ctx;
  if (!/^(bash|shell|powershell|cmd)$/i.test(String(tool || ''))) return null;
  const cmd = String((ti && ti.command) || '');
  if (API_CMD.test(cmd)) return ['question_cards', 'the question-cards server API is for the owner only; ask with: dantomation question ask'];
  if (OWNER_CMD.test(cmd)) return ['question_cards', 'answering, cancelling or listing questions is for the owner only'];
  return null;
}

// ---- who is answering: the authenticated actor only, never the body
function sourceOf(actor, body) {
  if (!actor || actor.kind !== 'owner') return null;
  const id = typeof actor.id === 'string' ? actor.id : '';
  if (id.startsWith('device:')) return S.source({ who: 'device', device_id: id.slice(7), where: 'phone' });
  if (id !== '') return null;
  return S.source({ where: body && body.where !== undefined ? body.where : 'chat' });
}
const fail = (r) => ({ status: r.status || 400, json: { error: r.error, ...(r.question ? { question: r.question } : {}) } });

// ---- routes (mounted at /m/question-cards/...; access defaults to owner)
async function listPending(ctx) {
  const io = ioOf(ctx);
  await S.sweep(io);
  return { status: 200, json: { questions: S.pendingIO(io).map(S.view) } };
}
async function listRecent(ctx) {
  const io = ioOf(ctx);
  await S.sweep(io);
  return { status: 200, json: { questions: [...S.foldIO(io).values()].filter(q => q.state !== 'pending').slice(-20).map(S.view) } };
}
async function getOne(ctx) {
  const io = ioOf(ctx);
  await S.sweep(io);
  const q = S.lookup(io, ctx.params.id);
  return q ? { status: 200, json: { question: S.view(q) } } : { status: 404, json: { error: 'no such question' } };
}
async function postAsk(ctx) {
  const v = S.validateAsk(ctx.body);
  if (!v.ok) return { status: 400, json: { error: v.error } };
  const r = await S.ask(ioOf(ctx), v.value, ctx.settings);
  return r.error ? fail(r) : { status: 201, json: { question: r.question } };
}
async function postAnswer(ctx) {
  const src = sourceOf(ctx.actor, ctx.body);
  if (!src) return { status: 400, json: { error: 'bad source: where is chat | phone | voice | cli (a device is always phone)' } };
  const r = await S.answer(ioOf(ctx), ctx.params.id, ctx.body, src);
  return r.error ? fail(r) : { status: 200, json: { question: r.question } };
}
async function postCancel(ctx) {
  if (!ctx.actor || ctx.actor.kind !== 'owner') return { status: 403, json: { error: 'forbidden' } };
  const r = await S.cancel(ioOf(ctx), ctx.params.id, 'owner');
  return r.error ? fail(r) : { status: 200, json: { question: r.question } };
}

// ---- command: dantomation question <ask|get|list|answer|cancel> ...
//   ask "<text>" <option> <option> ... [--free]      (bots and tasks; prints the question id)
//   get <id>                                         (prints JSON; a task may read only its own)
//   list | answer <id> <number|option> [free text] | cancel <id>   (owner only; refused inside a task)
const USAGE = 'usage: question ask "<text>" <option> <option> [... up to 6] [--free] | question get <id> | question list | question answer <id> <number|option> [text] | question cancel <id>';
const out = o => console.log(JSON.stringify(o));
function bad(msg, code) { console.error(msg); process.exitCode = code || 2; return { ok: false }; }

async function command(args, ctx) {
  const io = ioOf(ctx);
  const [verb, ...rest] = Array.isArray(args) ? args.map(String) : [];
  if (verb === 'ask') {
    let allow_free = false;
    const pos = rest.filter(a => (a === '--free' ? (allow_free = true, false) : true));
    const r = S.validateAsk({ text: pos[0], options: pos.slice(1), allow_free, task_id: process.env.HARNESS_TASK_ID || undefined });
    if (!r.ok) return bad(r.error + '\n' + USAGE);
    const a = await S.ask(io, r.value, ctx.settings);
    if (a.error) return bad(a.error, 3);
    out({ question_id: a.question.question_id, state: 'pending', expires_at: a.question.expires_at });
    return a;
  }
  if (verb === 'get') {
    await S.sweep(io);
    const q = S.lookup(io, rest[0] || '');
    const mine = process.env.HARNESS_TASK_ID;
    if (!q || (mine && q.task_id !== mine)) return bad('no such question', 3);
    out(S.view(q));
    return { ok: true };
  }
  if (verb === 'list' || verb === 'answer' || verb === 'cancel') {
    if (inTask()) { console.error('questions are answered by the person at the keyboard, not by agents (HARNESS_TASK_ID is set). Stopping.'); process.exit(6); }
    if (verb === 'list') {
      await S.sweep(io);
      for (const q of S.pendingIO(io)) console.log(`${q.question_id}: ${clip(q.text, 120)} [${q.options.map((o, i) => `${i + 1}) ${o}`).join(' ')}]${q.allow_free ? ' (free text ok)' : ''}`);
      return { ok: true };
    }
    if (verb === 'cancel') {
      const r = await S.cancel(io, rest[0] || '', 'owner');
      if (r.error) return bad(r.error, 3);
      console.log(`cancelled ${r.question.question_id}`);
      return r;
    }
    const [id, choice, ...txt] = rest;
    const r = await S.answer(io, id || '', { choice, text: txt.join(' ') }, S.source({ where: 'cli' }));
    if (r.error) return bad(r.error, 3);
    console.log(`answered ${r.question.question_id}`);
    return r;
  }
  return bad(USAGE);
}

function statusLines(Jn, ctx) {
  const lines = [];
  for (const q of S.pending(Jn.readAll().records, S.vaultLoad({ state: ctx.state }))) lines.push(`question ${q.question_id} is waiting: ${clip(q.text, 100)}`, `  answer with: dantomation question answer ${q.question_id} <1-${q.options.length}>`);
  return lines;
}

module.exports = {
  contract: 2,
  name: 'question-cards',
  description: 'Bots ask the owner a multiple-choice question and wait for the answer.',
  runsOn: 'main',
  priority: 50,
  beforeTool,
  emits: ['question'], // question.asked, question.answered, question.cancelled, question.expired (see store.js)
  on: { 'task.start': (_, ctx) => S.sweep(ioOf(ctx)) },
  statusLines,
  commands: { question: command },
  routes: [
    { method: 'GET', path: '/questions', handler: listPending, description: 'pending questions' },
    { method: 'GET', path: '/questions/recent', handler: listRecent, description: 'last 20 answered, cancelled or expired questions' },
    { method: 'GET', path: '/questions/:id', handler: getOne, description: 'one question with its state and answer' },
    { method: 'POST', path: '/questions', handler: postAsk, description: 'ask: body {text, options[2-6], allow_free?, task_id?}' },
    { method: 'POST', path: '/questions/:id/answer', handler: postAnswer, description: 'answer: body {choice?: number|option text, text?}' },
    { method: 'POST', path: '/questions/:id/cancel', handler: postCancel, description: 'withdraw a pending question' },
  ],
  panels: [{ id: 'questions', title: 'Questions', mount: 'chat', entry: 'ui/questions-panel.js' }],
  settings: {
    timeout_minutes: { type: 'number', default: S.DEFAULT_TIMEOUT_MIN, min: 1, max: 10080, description: 'minutes a question waits before it expires' },
    max_pending: { type: 'integer', default: 50, min: 1, max: 500, description: 'most questions that may wait at once' },
  },
  api: { validateAsk: S.validateAsk, validateAnswer: S.validateAnswer, source: S.source, fold: S.fold, pending: S.pending, view: S.view, isExpired: S.isExpired },
};
