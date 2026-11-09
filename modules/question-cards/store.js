'use strict';
// Question store. The journal is the single source of truth (append-only, fsynced);
// a question's state is a fold over its records, so a crash leaves it fully there or not at all.
//   question         {question_id, task_id, text, options[], allow_free, created_at, expires_at}
//   question_answer  {question_id, choice (1-based|null), option (text|null), free_text (text|null), who, where}
//   question_cancel  {question_id, who}
//   question_expire  {question_id}
// Events (after the journal write): question.asked, question.answered, question.cancelled, question.expired.
const crypto = require('crypto');

const LIMITS = { text: 500, option: 100, free: 500, min_options: 2, max_options: 6 };
const ID_RE = /^q-[0-9a-f]{6}$/;
const TASK_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const DEVICE_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const WHERE = ['chat', 'phone', 'voice', 'cli'];
const DEFAULT_TIMEOUT_MIN = 60;
const DEFAULT_MAX_PENDING = 50;

// Clock seam for tests: HARNESS_NOW is an epoch-ms number or an ISO date.
const now = () => {
  const v = process.env.HARNESS_NOW;
  if (v) { const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v); if (Number.isFinite(n)) return n; }
  return Date.now();
};
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const clean = s => String(s).replace(/\r\n?/g, '\n').trim();

// Returns {ok: true, value} or {ok: false, error}. Never throws.
function validateAsk(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, error: 'body must be an object {text, options, allow_free?, task_id?}' };
  if (typeof b.text !== 'string' || !clean(b.text)) return { ok: false, error: 'text is required (a string)' };
  const text = clean(b.text);
  if (text.length > LIMITS.text || CTRL.test(text)) return { ok: false, error: `text must be at most ${LIMITS.text} characters, no control characters` };
  if (!Array.isArray(b.options)) return { ok: false, error: 'options must be an array of 2 to 6 strings' };
  if (b.options.length < LIMITS.min_options || b.options.length > LIMITS.max_options) return { ok: false, error: `options must hold ${LIMITS.min_options} to ${LIMITS.max_options} choices` };
  const options = [];
  for (const o of b.options) {
    if (typeof o !== 'string' || !clean(o)) return { ok: false, error: 'every option must be a non-empty string' };
    const v = clean(o);
    if (v.length > LIMITS.option || CTRL.test(v) || v.includes('\n')) return { ok: false, error: `each option must be one line of at most ${LIMITS.option} characters` };
    if (options.some(x => x.toLowerCase() === v.toLowerCase())) return { ok: false, error: 'options must be different from each other' };
    options.push(v);
  }
  if (b.allow_free !== undefined && typeof b.allow_free !== 'boolean') return { ok: false, error: 'allow_free must be true or false' };
  if (b.task_id !== undefined && b.task_id !== null && (typeof b.task_id !== 'string' || !TASK_RE.test(b.task_id))) return { ok: false, error: 'task_id is not a valid task id' };
  return { ok: true, value: { text, options, allow_free: b.allow_free === true, task_id: b.task_id || null } };
}

// Resolve an owner's answer against a question. input: {choice?: int 1..n | option text, text?: string}.
function validateAnswer(q, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'body must be an object {choice?, text?}' };
  const out = { choice: null, option: null, free_text: null };
  const c = input.choice;
  if (c !== undefined && c !== null) {
    if (Number.isInteger(c)) {
      if (c < 1 || c > q.options.length) return { ok: false, error: `choice must be 1 to ${q.options.length}` };
      out.choice = c;
    } else if (typeof c === 'string' && c.length <= LIMITS.option * 2) {
      const t = clean(c);
      const i = /^\d{1,2}$/.test(t) ? Number(t) - 1 : q.options.findIndex(o => o.toLowerCase() === t.toLowerCase());
      if (!(i >= 0 && i < q.options.length)) return { ok: false, error: 'choice is not one of the options' };
      out.choice = i + 1;
    } else return { ok: false, error: 'choice must be an option number or the option text' };
    out.option = q.options[out.choice - 1];
  }
  if (input.text !== undefined && input.text !== null) {
    if (typeof input.text !== 'string') return { ok: false, error: 'text must be a string' };
    const t = clean(input.text);
    if (t) {
      if (!q.allow_free) return { ok: false, error: 'this question does not take free text' };
      if (t.length > LIMITS.free || CTRL.test(t)) return { ok: false, error: `text must be at most ${LIMITS.free} characters` };
      out.free_text = t;
    }
  }
  if (out.choice === null && out.free_text === null) return { ok: false, error: 'give a choice' + (q.allow_free ? ' or text' : '') };
  return { ok: true, value: out };
}

// {who: 'owner'|'device', where, device_id?} or null (callers fail closed).
function source(o) {
  o = o || {};
  const who = o.who || (o.device_id ? 'device' : 'owner');
  if (who !== 'owner' && who !== 'device') return null;
  const where = o.where === undefined ? 'chat' : o.where;
  if (!WHERE.includes(where)) return null;
  if (who === 'device') { if (typeof o.device_id !== 'string' || !DEVICE_RE.test(o.device_id)) return null; return { who, where, device_id: o.device_id }; }
  if (o.device_id !== undefined) return null;
  return { who, where };
}

// records -> Map question_id -> question with .state: pending | answered | cancelled | expired
function fold(records) {
  const qs = new Map();
  for (const r of records) {
    if (r.module !== 'question-cards') continue;
    if (r.type === 'question') qs.set(r.question_id, { question_id: r.question_id, task_id: r.task_id || null, text: r.text, options: r.options, allow_free: !!r.allow_free,
      created_at: r.created_at, expires_at: r.expires_at, state: 'pending', answer: null });
    else if (qs.has(r.question_id)) {
      const q = qs.get(r.question_id);
      if (q.state !== 'pending') continue; // first decision wins
      if (r.type === 'question_answer') q.state = 'answered', q.answer = { choice: r.choice, option: r.option, free_text: r.free_text, who: r.who, where: r.where || null, ...(r.device_id ? { device_id: r.device_id } : {}), at: r.ts || null };
      else if (r.type === 'question_cancel') q.state = 'cancelled';
      else if (r.type === 'question_expire') q.state = 'expired';
    }
  }
  return qs;
}
const isExpired = q => q.state === 'pending' && now() >= Date.parse(q.expires_at);
const pending = records => [...fold(records).values()].filter(q => q.state === 'pending' && !isExpired(q));
const view = q => ({ question_id: q.question_id, task_id: q.task_id, text: q.text, options: q.options, allow_free: q.allow_free, state: isExpired(q) ? 'expired' : q.state,
  created_at: q.created_at, expires_at: q.expires_at, answer: q.answer });

function timeoutMs(settings) {
  const m = Number(settings && settings.timeout_minutes);
  return (Number.isFinite(m) && m > 0 ? m : DEFAULT_TIMEOUT_MIN) * 60000;
}

// io = { J, state, emit }
const note = (io, task_id, text) => task_id && io.state.append({ type: 'history_note', task_id, note: text });

async function ask(io, v, settings) {
  const cap = Number(settings && settings.max_pending) || DEFAULT_MAX_PENDING;
  await sweep(io);
  if (pending(io.J.readAll().records).length >= cap) return { error: `too many pending questions (limit ${cap}); wait for answers or cancel some`, status: 429 };
  const question_id = 'q-' + crypto.randomBytes(3).toString('hex');
  const t = now();
  const rec = io.state.append({ type: 'question', question_id, task_id: v.task_id, text: v.text, options: v.options, allow_free: v.allow_free,
    created_at: new Date(t).toISOString(), expires_at: new Date(t + timeoutMs(settings)).toISOString() });
  await io.emit('question.asked', { question_id, task_id: v.task_id, text: v.text, options: v.options, allow_free: v.allow_free, expires_at: rec.expires_at });
  return { question: view({ ...rec, state: 'pending', answer: null }) };
}

function find(io, id) { return fold(io.J.readAll().records).get(String(id).toLowerCase()) || null; }
const lookup = (io, id) => ID_RE.test(String(id).toLowerCase()) ? find(io, id) : null;

// Returns {question} or {error, status}. Expired questions are closed first.
async function answer(io, id, input, src) {
  await sweep(io);
  const q = lookup(io, id);
  if (!q) return { error: 'no such question', status: 404 };
  if (q.state !== 'pending') return { error: `question is ${q.state}`, status: 409, question: view(q) };
  const v = validateAnswer(q, input);
  if (!v.ok) return { error: v.error, status: 400 };
  io.state.append({ type: 'question_answer', question_id: q.question_id, task_id: q.task_id, ...v.value, ...src });
  await io.emit('question.answered', { question_id: q.question_id, task_id: q.task_id, choice: v.value.choice, option: v.value.option, free_text: v.value.free_text, who: src.who, where: src.where });
  const said = [v.value.option && `"${v.value.option}"`, v.value.free_text && `free text "${v.value.free_text}"`].filter(Boolean).join(' and ');
  note(io, q.task_id, `question ${q.question_id} ("${q.text}") was answered by the owner: ${said}. Continue with that answer.`);
  return { question: view(find(io, q.question_id)) };
}

async function cancel(io, id, who) {
  await sweep(io);
  const q = lookup(io, id);
  if (!q) return { error: 'no such question', status: 404 };
  if (q.state !== 'pending') return { error: `question is ${q.state}`, status: 409, question: view(q) };
  io.state.append({ type: 'question_cancel', question_id: q.question_id, task_id: q.task_id, who });
  await io.emit('question.cancelled', { question_id: q.question_id, task_id: q.task_id, who });
  note(io, q.task_id, `question ${q.question_id} ("${q.text}") was withdrawn; no answer will come. Continue without it or choose a default and say so.`);
  return { question: view(find(io, q.question_id)) };
}

async function sweep(io) {
  const out = [];
  for (const q of fold(io.J.readAll().records).values()) {
    if (!isExpired(q)) continue;
    io.state.append({ type: 'question_expire', question_id: q.question_id, task_id: q.task_id });
    await io.emit('question.expired', { question_id: q.question_id, task_id: q.task_id });
    note(io, q.task_id, `question ${q.question_id} ("${q.text}") expired with no answer. Continue without it or choose a default and say so.`);
    out.push(q.question_id);
  }
  return out;
}

module.exports = { LIMITS, ID_RE, validateAsk, validateAnswer, source, fold, pending, isExpired, view, ask, answer, cancel, sweep, find, lookup, now, DEFAULT_TIMEOUT_MIN };
