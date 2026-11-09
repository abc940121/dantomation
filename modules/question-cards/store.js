'use strict';
// Question store. The journal is the single source of truth for state (append-only, fsynced);
// a question's state is a fold over its records, so a crash leaves it fully there or not at all.
// Texts (question, options, free-text answers) can hold secrets, so they never enter the journal:
// they live in this module's protected vault file (state/m/question-cards/vault.json, owner-only)
// and the journal carries metadata only (ids, lengths, the chosen option number).
//   question         {question_id, task_id, text_len, option_lens[], allow_free, created_at, expires_at}
//   question_answer  {question_id, choice (1-based|null), free_len (n|null), who, where}
//   question_cancel  {question_id, who}
//   question_expire  {question_id}
// Events (after the journal write): question.asked, question.answered, question.cancelled, question.expired.
// Answer, cancel, ask and expiry run under an inter-process lock (state/m/question-cards/lock), so the
// HTTP server and the CLI never both decide the same question.
// Records written by older versions (text in the journal, 6-hex ids) still fold.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const JL = require('../../lib/journal');

const LIMITS = { text: 500, option: 100, free: 500, min_options: 2, max_options: 6 };
const ID_RE = /^q-(?:[0-9a-f]{24}|[0-9a-f]{6})$/; // new ids carry 96 random bits; 6-hex ones are legacy
const TASK_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const DEVICE_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const WHERE = ['chat', 'phone', 'voice', 'cli'];
const DEFAULT_TIMEOUT_MIN = 60;
const DEFAULT_MAX_PENDING = 50;
const LOCK_WAIT_MS = 5000;

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

// ---- vault: the texts, kept out of the journal. Written atomically, only under the lock.
const vaultFile = io => path.join(io.state.dir, 'vault.json');
function vaultLoad(io) {
  try { const v = JSON.parse(fs.readFileSync(vaultFile(io), 'utf8')); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* none yet */ }
  return {};
}
function vaultSave(io, v) {
  const f = vaultFile(io), tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

// ---- inter-process lock (the HTTP server and the CLI are separate processes). fn runs while it is held.
// Returns fn's result, or {error, status: 409} when the lock could not be had in time.
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withLock(io, fn) {
  const file = path.join(io.state.dir, 'lock');
  const end = Date.now() + LOCK_WAIT_MS;
  let got;
  for (;;) {
    got = JL.lock(file, { pids: [process.pid], module: 'question-cards' });
    if (got.held || Date.now() >= end) break;
    await sleep(10 + Math.floor(Math.random() * 20));
  }
  if (!got.held) return { error: 'busy: another question operation is in progress; try again', status: 409 };
  try { return await fn(); } finally { if (!JL.unlock(file, got.nonce)) JL.unlockLater(file, got.nonce, undefined, 'question-cards'); }
}

// records (+ vault) -> Map question_id -> question with .state: pending | answered | cancelled | expired
function fold(records, vault) {
  vault = vault || {};
  const qs = new Map();
  for (const r of records) {
    if (r.module !== 'question-cards') continue;
    if (r.type === 'question') {
      const v = vault[r.question_id] || {};
      qs.set(r.question_id, { question_id: r.question_id, task_id: r.task_id || null, text: v.text !== undefined ? v.text : (r.text || ''), options: v.options || r.options || [],
        allow_free: !!r.allow_free, created_at: r.created_at, expires_at: r.expires_at, state: 'pending', answer: null });
    } else if (qs.has(r.question_id)) {
      const q = qs.get(r.question_id);
      if (q.state !== 'pending') continue; // first decision wins
      if (r.type === 'question_answer') {
        const v = vault[r.question_id] || {};
        const choice = r.choice === undefined ? null : r.choice;
        q.state = 'answered';
        q.answer = { choice, option: choice ? (q.options[choice - 1] || null) : null, free_text: v.free_text !== undefined ? v.free_text : (r.free_text || null), who: r.who, where: r.where || null,
          ...(r.device_id ? { device_id: r.device_id } : {}), at: r.ts || null };
      } else if (r.type === 'question_cancel') q.state = 'cancelled';
      else if (r.type === 'question_expire') q.state = 'expired';
    }
  }
  return qs;
}
const isExpired = q => q.state === 'pending' && now() >= Date.parse(q.expires_at);
const pending = (records, vault) => [...fold(records, vault).values()].filter(q => q.state === 'pending' && !isExpired(q));
const view = q => ({ question_id: q.question_id, task_id: q.task_id, text: q.text, options: q.options, allow_free: q.allow_free, state: isExpired(q) ? 'expired' : q.state,
  created_at: q.created_at, expires_at: q.expires_at, answer: q.answer });
// io-level helpers: journal + vault together
const foldIO = io => fold(io.J.readAll().records, vaultLoad(io));
const pendingIO = io => pending(io.J.readAll().records, vaultLoad(io));

function timeoutMs(settings) {
  const m = Number(settings && settings.timeout_minutes);
  return (Number.isFinite(m) && m > 0 ? m : DEFAULT_TIMEOUT_MIN) * 60000;
}

// io = { J, state, emit }
// Notes reach the journal and the task's history: ids and the option number only, never texts.
const note = (io, task_id, text) => task_id && io.state.append({ type: 'history_note', task_id, note: text });
const flush = async (io, ev) => { for (const [name, p] of ev) await io.emit(name, p); };
const newId = taken => { for (;;) { const id = 'q-' + crypto.randomBytes(12).toString('hex'); if (!taken(id)) return id; } };

// Caller holds the lock. Returns the events to emit once it is released.
function sweepLocked(io) {
  const ev = [];
  for (const q of foldIO(io).values()) {
    if (!isExpired(q)) continue;
    io.state.append({ type: 'question_expire', question_id: q.question_id, task_id: q.task_id });
    ev.push(['question.expired', { question_id: q.question_id, task_id: q.task_id }]);
    note(io, q.task_id, `question ${q.question_id} expired with no answer. Continue without it or choose a default and say so.`);
  }
  return ev;
}

// fn(ev) runs under the lock after expired questions are closed; returns {res}. Events flush after release.
async function locked(io, fn) {
  const r = await withLock(io, () => { const ev = sweepLocked(io); return { ev, ...fn(ev) }; });
  if (!r.ev) return r; // lock timeout: {error, status}
  await flush(io, r.ev);
  return r.res;
}

async function ask(io, v, settings) {
  const cap = Number(settings && settings.max_pending) || DEFAULT_MAX_PENDING;
  return locked(io, ev => {
    if (pendingIO(io).length >= cap) return { res: { error: `too many pending questions (limit ${cap}); wait for answers or cancel some`, status: 429 } };
    const vault = vaultLoad(io), known = new Set(io.J.readAll().records.filter(x => x.type === 'question').map(x => x.question_id));
    const question_id = newId(id => known.has(id) || vault[id]);
    const t = now();
    vault[question_id] = { text: v.text, options: v.options };
    vaultSave(io, vault); // texts first: a journaled question always has its text
    const rec = io.state.append({ type: 'question', question_id, task_id: v.task_id, text_len: v.text.length, option_lens: v.options.map(o => o.length), allow_free: v.allow_free,
      created_at: new Date(t).toISOString(), expires_at: new Date(t + timeoutMs(settings)).toISOString() });
    ev.push(['question.asked', { question_id, task_id: v.task_id, text: v.text, options: v.options, allow_free: v.allow_free, expires_at: rec.expires_at }]);
    return { res: { question: view({ question_id, task_id: v.task_id, text: v.text, options: v.options, allow_free: v.allow_free, created_at: rec.created_at, expires_at: rec.expires_at, state: 'pending', answer: null }) } };
  });
}

function find(io, id) { return foldIO(io).get(String(id).toLowerCase()) || null; }
const lookup = (io, id) => ID_RE.test(String(id).toLowerCase()) ? find(io, id) : null;

// Returns {question} or {error, status}. Lookup, commit and note run under the lock, so exactly one
// answer / cancel / expiry wins; the loser gets 409.
async function answer(io, id, input, src) {
  return locked(io, ev => {
    const q = lookup(io, id);
    if (!q) return { res: { error: 'no such question', status: 404 } };
    if (q.state !== 'pending') return { res: { error: `question is ${q.state}`, status: 409, question: view(q) } };
    const v = validateAnswer(q, input);
    if (!v.ok) return { res: { error: v.error, status: 400 } };
    if (v.value.free_text !== null) { const vault = vaultLoad(io); vault[q.question_id] = { ...vault[q.question_id], free_text: v.value.free_text }; vaultSave(io, vault); }
    io.state.append({ type: 'question_answer', question_id: q.question_id, task_id: q.task_id, choice: v.value.choice, free_len: v.value.free_text === null ? null : v.value.free_text.length, ...src });
    ev.push(['question.answered', { question_id: q.question_id, task_id: q.task_id, choice: v.value.choice, option: v.value.option, free_text: v.value.free_text, who: src.who, where: src.where }]);
    const said = [v.value.choice !== null && `option ${v.value.choice}`, v.value.free_text !== null && `free text (${v.value.free_text.length} characters)`].filter(Boolean).join(' and ');
    note(io, q.task_id, `question ${q.question_id} was answered by the owner: ${said}. Read the answer with: dantomation question get ${q.question_id}. Continue with that answer.`);
    return { res: { question: view(find(io, q.question_id)) } };
  });
}

async function cancel(io, id, who) {
  return locked(io, ev => {
    const q = lookup(io, id);
    if (!q) return { res: { error: 'no such question', status: 404 } };
    if (q.state !== 'pending') return { res: { error: `question is ${q.state}`, status: 409, question: view(q) } };
    io.state.append({ type: 'question_cancel', question_id: q.question_id, task_id: q.task_id, who });
    ev.push(['question.cancelled', { question_id: q.question_id, task_id: q.task_id, who }]);
    note(io, q.task_id, `question ${q.question_id} was withdrawn; no answer will come. Continue without it or choose a default and say so.`);
    return { res: { question: view(find(io, q.question_id)) } };
  });
}

async function sweep(io) {
  if (![...foldIO(io).values()].some(isExpired)) return []; // common case: nothing to close, no lock
  const r = await withLock(io, () => ({ ev: sweepLocked(io) }));
  if (!r.ev) return [];
  await flush(io, r.ev);
  return r.ev.map(e => e[1].question_id);
}

module.exports = { withLock, LIMITS, ID_RE, validateAsk, validateAnswer, source, fold, pending, foldIO, pendingIO, vaultLoad, isExpired, view, ask, answer, cancel, sweep, find, lookup, now, DEFAULT_TIMEOUT_MIN };
