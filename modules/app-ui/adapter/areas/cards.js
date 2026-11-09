'use strict';
// Questions a bot asks the owner (multiple choice and free text). Our own file (MIT).
// Stored as module state key 'questions' (an array, capped at 200, oldest answered pruned first).
//   POST api/questions            a bot or the owner creates one
//   GET  api/questions?state=     pending (default) | all
//   GET  api/questions/:id        one question, with its answer
//   POST api/questions/:id/answer {answers:[{selected:[index...], text?}]}
const crypto = require('crypto');
const { bots, getState, setState } = require('../lib');

const KEY = 'questions';
const CAP = 200;
const LIM = { title: 200, prompt: 1000, label: 200, description: 400, text: 2000 };
const MAX_Q = 6, MAX_OPT = 12, DEFAULT_TTL = 1800, MAX_TTL = 86400;

const bad = (error, status = 400) => ({ status, json: { error } });
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const load = ctx => { const v = getState(ctx, KEY, []); return Array.isArray(v) ? v : []; };

function prune(list) {
  while (list.length > CAP) {
    let i = list.findIndex(q => q.state === 'answered');
    if (i < 0) i = list.findIndex(q => q.expiresAt <= Date.now());
    list.splice(i < 0 ? 0 : i, 1);
  }
  return list;
}

// A question as the caller sees it: a pending one past its time reads 'expired'.
function view(q, now = Date.now()) {
  return q.state === 'pending' && q.expiresAt <= now ? { ...q, state: 'expired' } : q;
}

async function emit(ctx, event, payload) {
  if (typeof ctx.emit !== 'function') return;
  try { await ctx.emit('app-ui.' + event, payload); } catch { /* an event nobody hears must not fail the call */ }
}

function parseQuestions(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_Q) return { error: `questions must have 1 to ${MAX_Q} entries` };
  const out = [];
  for (const q of raw) {
    if (!isObj(q) || typeof q.prompt !== 'string' || !q.prompt.trim()) return { error: 'each question needs a prompt' };
    if (q.prompt.length > LIM.prompt) return { error: `prompt is longer than ${LIM.prompt}` };
    const opts = q.options === undefined ? [] : q.options;
    if (!Array.isArray(opts) || opts.length > MAX_OPT) return { error: `options must have at most ${MAX_OPT} entries` };
    const options = [];
    for (const o of opts) {
      if (!isObj(o) || typeof o.label !== 'string' || !o.label.trim()) return { error: 'each option needs a label' };
      if (o.label.length > LIM.label) return { error: `label is longer than ${LIM.label}` };
      if (o.description !== undefined && typeof o.description !== 'string') return { error: 'description must be a string' };
      options.push(o.description ? { label: o.label, description: o.description.slice(0, LIM.description) } : { label: o.label });
    }
    const allowText = q.allowText === undefined ? options.length === 0 : q.allowText === true;
    if (!options.length && !allowText) return { error: 'a question needs an option or allowText' };
    out.push({ prompt: q.prompt, options, ...(q.multi === true ? { multi: true } : {}), allowText });
  }
  return { questions: out };
}

async function create(ctx) {
  const b = isObj(ctx.body) ? ctx.body : {};
  if (typeof b.bot !== 'string' || !bots(ctx).some(x => x.id === b.bot)) return bad('unknown bot');
  if (typeof b.title !== 'string' || !b.title.trim()) return bad('title is required');
  if (b.title.length > LIM.title) return bad(`title is longer than ${LIM.title}`);
  let ttl = DEFAULT_TTL;
  if (b.expiresInSec !== undefined) {
    if (!Number.isInteger(b.expiresInSec) || b.expiresInSec < 1 || b.expiresInSec > MAX_TTL) return bad(`expiresInSec must be an integer from 1 to ${MAX_TTL}`);
    ttl = b.expiresInSec;
  }
  if (b.task !== undefined && typeof b.task !== 'string') return bad('task must be a string');
  const parsed = parseQuestions(b.questions);
  if (parsed.error) return bad(parsed.error);
  const now = Date.now();
  const q = {
    id: 'q-' + crypto.randomBytes(6).toString('hex'), state: 'pending', bot: b.bot, task: (b.task || '').slice(0, 100),
    title: b.title, questions: parsed.questions, createdAt: now, expiresAt: now + ttl * 1000,
  };
  const all = load(ctx);
  all.push(q);
  setState(ctx, KEY, prune(all));
  await emit(ctx, 'question_pending', { question: q });
  return { status: 201, json: { question: q } };
}

function list(ctx) {
  const all = ctx.query && ctx.query.state === 'all';
  const now = Date.now();
  const rows = load(ctx).map(q => view(q, now)).filter(q => all || q.state === 'pending');
  return { status: 200, json: { questions: rows } };
}

function get(ctx) {
  const q = load(ctx).find(x => x.id === (ctx.params || {}).id);
  return q ? { status: 200, json: { question: view(q) } } : bad('no such question', 404);
}

async function answer(ctx) {
  const id = (ctx.params || {}).id;
  const all = load(ctx);
  const q = all.find(x => x.id === id);
  if (!q) return bad('no such question', 404);
  const now = Date.now();
  const current = view(q, now).state;
  if (current !== 'pending') return bad(`question is not pending (${current})`, 409);
  const given = isObj(ctx.body) ? ctx.body.answers : null;
  if (!Array.isArray(given) || given.length !== q.questions.length) return bad(`answers must have ${q.questions.length} entries`);
  const answers = [];
  for (let i = 0; i < given.length; i++) {
    const a = given[i], spec = q.questions[i];
    if (!isObj(a)) return bad('each answer must be an object');
    const selected = a.selected === undefined ? [] : a.selected;
    if (!Array.isArray(selected) || selected.some(n => !Number.isInteger(n) || n < 0 || n >= spec.options.length) || new Set(selected).size !== selected.length) return bad(`answer ${i + 1}: selected has an option that does not exist`);
    if (selected.length > 1 && !spec.multi) return bad(`answer ${i + 1}: only one option may be picked`);
    let text;
    if (a.text !== undefined) {
      if (typeof a.text !== 'string' || a.text.length > LIM.text) return bad(`answer ${i + 1}: text must be a string of at most ${LIM.text}`);
      if (a.text.trim()) {
        if (!spec.allowText) return bad(`answer ${i + 1}: this question takes no free text`);
        text = a.text.trim();
      }
    }
    if (!selected.length && text === undefined) return bad(`answer ${i + 1} is empty`);
    answers.push({ selected, ...(text !== undefined ? { text } : {}) });
  }
  const by = ctx.actor && ctx.actor.kind ? String(ctx.actor.kind) : 'owner';
  Object.assign(q, { state: 'answered', answers, answeredAt: now, answeredBy: by });
  setState(ctx, KEY, prune(all));
  await emit(ctx, 'question_resolved', { questionId: id, answers });
  return { status: 200, json: { question: q } };
}

module.exports = [
  { method: 'POST', path: 'api/questions', access: 'worker', handler: create },
  { method: 'GET', path: 'api/questions', access: 'owner', handler: list },
  { method: 'GET', path: 'api/questions/:id', access: 'worker', handler: get },
  { method: 'POST', path: 'api/questions/:id/answer', access: 'owner', handler: answer },
];
