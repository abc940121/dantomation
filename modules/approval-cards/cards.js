'use strict';
// Card store. The journal is the single source of truth (append-only, fsynced);
// <module state dir>/<id>.json (state/m/approval-cards/) is a readable mirror,
// rewritten from the journal.
//   card         {card_id, task_id, tool, input, sha256, summary, rule, created_at, expires_at, live?}
//                live: raised by the permission-prompt tool (bin/approve-mcp.js) while the engine waits
//                in the same turn; expires_at is null and the card never times out.
//   card_answer  {card_id, answer: yes | no | timeout | unclear}
//   card_used    {card_id}
// Card state is a fold over those records, so a crash at any point leaves a card
// either fully there (pending) or not there; resuming never makes a second one.
// io = { J, state, emit }: J (lib/journal) for reads, the module's ctx.state for
// every write (records carry module: "approval-cards"), ctx.emit for card.* events.
// Events go out after the journal write: card.created {card_id, task_id, summary,
// rule, expires_at} and card.answered {card_id, task_id, answer} (yes | no | timeout).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 15 minutes: long enough for an owner who is away from the desk to see a phone
// notification and answer, short enough that a stale request does not hang a task
// all afternoon (an expired card is denied for good, so too short a window costs a retry).
const DEFAULT_TIMEOUT_MIN = 0; // 0: a card waits until someone answers it (no answer is never a no)
const WHO = ['owner', 'device', 'timeout', 'system'];
const WHERE = ['chat', 'phone', 'voice', 'cli'];
const DEVICE_RE = /^[A-Za-z0-9._:-]{1,64}$/;

// Who decided and where. device_id is an opaque string (a paired phone's id). Returns
// {who, where, device_id?} or null when the pieces do not fit (callers fail closed).
function source(o) {
  o = o || {};
  const who = o.who || (o.device_id ? 'device' : 'owner');
  if (!WHO.includes(who)) return null;
  const out = { who, where: o.where === undefined || o.where === null ? (who === 'timeout' || who === 'system' ? null : 'chat') : o.where };
  if (out.where !== null && !WHERE.includes(out.where)) return null;
  if (who === 'device') { if (typeof o.device_id !== 'string' || !DEVICE_RE.test(o.device_id)) return null; out.device_id = o.device_id; }
  else if (o.device_id !== undefined) return null;
  return out;
}
const sourceText = d => d.who === 'device' ? `device ${d.device_id}` : d.who;
// "Denied · timeout", "Approved · owner via phone"
function decisionLabel(c) {
  if (!c.decided) return null;
  const verb = c.state === 'approved' || c.state === 'used' ? 'Approved' : 'Denied';
  return `${verb} · ${sourceText(c.decided)}${c.decided.where ? ' via ' + c.decided.where : ''}`;
}
// Clock seam for tests: HARNESS_NOW is an epoch-ms number or an ISO date.
const now = () => {
  const v = process.env.HARNESS_NOW;
  if (v) { const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v); if (Number.isFinite(n)) return n; }
  return Date.now();
};

const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  : JSON.stringify(v === undefined ? null : v);
const hashOf = (tool, input) => crypto.createHash('sha256').update(tool + '\n' + canon(input)).digest('hex');

// settings: the module's validated settings (core checked the config section).
function timeoutMs(settings) {
  const m = Number(settings && settings.timeout_minutes);
  return (Number.isFinite(m) && m > 0 ? m : DEFAULT_TIMEOUT_MIN) * 60000; // 0 = no deadline
}

// records -> Map card_id -> card with .state: pending | approved | denied | expired | used
function fold(records) {
  const cards = new Map();
  for (const r of records) {
    // First card with an id wins: a later record reusing it (a collision or a forgery) never replaces it.
    if (r.type === 'card') { if (!cards.has(r.card_id)) cards.set(r.card_id, { ...r, state: 'pending', unclear: 0 }); }
    else if (r.type === 'card_answer' && cards.has(r.card_id)) {
      const c = cards.get(r.card_id);
      if (r.answer === 'unclear') { c.unclear++; continue; }
      if (c.state !== 'pending') continue;
      c.state = r.answer === 'yes' ? 'approved' : r.answer === 'timeout' ? 'expired' : 'denied';
      const d = r.answer === 'timeout' ? { who: 'timeout', where: null } : (r.who ? { who: r.who, where: r.where || null, ...(r.device_id ? { device_id: r.device_id } : {}) } : { who: 'owner', where: null });
      c.decided = d; c.decided_at = r.ts || null; c.decision = decisionLabel({ ...c, decided: d });
    } else if (r.type === 'card_used' && cards.has(r.card_id)) cards.get(r.card_id).state = 'used';
  }
  return cards;
}
// A live card (expires_at null) never expires: nobody answering is not a no.
const isExpired = c => c.state === 'pending' && !!c.expires_at && now() >= Date.parse(c.expires_at);

function mirror(io, cards) {
  try {
    const dir = io.state.dir;
    for (const c of cards) {
      const f = path.join(dir, c.card_id + '.json');
      fs.writeFileSync(f + '.tmp', JSON.stringify({ ...c, state: isExpired(c) ? 'expired' : c.state }, null, 2));
      fs.renameSync(f + '.tmp', f);
    }
  } catch { /* the journal is authoritative; a failed mirror changes nothing */ }
}

// A short id the owner can type, unique across processes: each is reserved by an exclusive create
// of ids/<id> in the module state dir (a taken id is drawn again, longer after a few tries).
function reserveId(io) {
  const dir = path.join(io.state.dir, 'ids');
  fs.mkdirSync(dir, { recursive: true });
  // Cards from before reservations existed have journal records but no ids/ file: their ids are taken too.
  const old = new Set(io.J.readAll().records.filter(r => r && r.type === 'card').map(r => r.card_id));
  for (let i = 0; i < 32; i++) {
    const id = 'card-' + crypto.randomBytes(i < 8 ? 3 : 6).toString('hex');
    if (old.has(id)) continue;
    try { fs.closeSync(fs.openSync(path.join(dir, id), 'wx')); return id; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('no free card id');
}

// opts.live: no deadline (expires_at null), see the card record above. opts.pid: the process waiting on a live card
// (the startup sweep closes the card once that process is gone).
// The journal keeps a card's whole input, so a card for a call whose serialized input is over INPUT_MAX bytes (UTF-8, as stored) is refused
// (the call is blocked, no card): tooBig(input) -> a block reason, or null.
const INPUT_MAX = 256 * 1024;
const tooBig = input => {
  let n; try { n = Buffer.byteLength(JSON.stringify(input === undefined ? {} : input), 'utf8'); } catch { n = Infinity; }
  return n > INPUT_MAX ? `its input is ${Number.isFinite(n) ? Math.ceil(n / 1024) + ' KB' : 'not serializable'}, over the ${INPUT_MAX / 1024} KB limit for an approval card, so no card was raised and the call is refused; send a smaller input (e.g. write big content to a file in the work folder first)` : null;
};
async function create(io, { task_id, tool, input, summary, rule, cwd }, settings, opts) {
  const big = tooBig(input);
  if (big) throw new Error('approval card refused: ' + big);
  const card_id = reserveId(io);
  const t = now();
  const live = !!(opts && opts.live);
  const ms = timeoutMs(settings);
  const rec = io.state.append({ type: 'card', card_id, task_id, tool, input, sha256: hashOf(tool, input), summary, rule, ...(cwd ? { cwd } : {}),
    created_at: new Date(t).toISOString(), expires_at: live || !ms ? null : new Date(t + ms).toISOString(), ...(live ? { live: true } : {}), ...(live && Number.isInteger(opts.pid) ? { waiter_pid: opts.pid } : {}) });
  mirror(io, [{ ...rec, state: 'pending', unclear: 0 }]);
  await io.emit('card.created', { card_id, task_id, summary, rule, expires_at: rec.expires_at });
  return rec;
}

const note = (io, task_id, text) => io.state.append({ type: 'history_note', task_id, note: text });

// One answer record; yes / no / timeout also emit card.answered.
// src: {who, where, device_id?} from source(); a timeout answer always carries who=timeout.
// A yes/no that arrives at or after the deadline never counts: it is recorded as a timeout
// (late approvals are impossible). Returns the answer actually recorded.
async function answered(io, card, answer, extra, src) {
  if (answer !== 'timeout' && answer !== 'unclear' && isExpired(card)) answer = 'timeout';
  const s = answer === 'timeout' ? { who: 'timeout', where: null } : answer === 'unclear' ? {} : (src || { who: 'owner', where: 'chat' });
  io.state.append({ type: 'card_answer', card_id: card.card_id, task_id: card.task_id, answer, ...extra, ...s });
  if (answer !== 'unclear') await io.emit('card.answered', { card_id: card.card_id, task_id: card.task_id, answer, who: s.who, where: s.where || null });
  return answer;
}

// What the agent is told after a no or a timeout: skip, say why, carry on. Never a bare error.
function denyMessage(card, src) {
  const why = src.who === 'timeout' ? 'nobody answered it in time, so it expired'
    : src.who === 'system' ? 'the approval system could not reach a person (it fails closed)'
    : src.who === 'device' ? 'the person turned it down from their phone' : 'the person turned it down';
  return `card ${card.card_id} DENIED (${sourceText(src)}): ${card.summary}. Skip this step and do not retry or reword it. Tell the person this step was not done because ${why}, then continue with anything that does not depend on it, or stop.`;
}

// A fail-closed denial made by the system (broker unreachable, internal error): one closed card.
async function systemDeny(io, card, reason) {
  const r = await answered(io, card, 'no', { reason: String(reason || '').slice(0, 120) }, { who: 'system', where: null });
  note(io, card.task_id, denyMessage(card, { who: 'system' }));
  return r;
}

// Pending cards past their deadline become "no" (timeout), once, with a note for the resumed agent.
async function sweep(io) {
  const out = [];
  for (const c of fold(io.J.readAll().records).values()) {
    if (!isExpired(c)) continue;
    await answered(io, c, 'timeout');
    note(io, c.task_id, denyMessage(c, { who: 'timeout' }).replace('DENIED (timeout)', 'denied (timeout)'));
    out.push(c.card_id);
  }
  if (out.length) mirror(io, [...fold(io.J.readAll().records).values()].filter(c => out.includes(c.card_id)));
  return out;
}

const pending = records => [...fold(records).values()].filter(c => c.state === 'pending' && !isExpired(c));

// Live cards left pending when their wait ended (task stopped, engine exited, prompt cancelled): each is
// closed as a system no, so no orphan card holds the task. append: a journal append (the record carries
// module "approval-cards", as the module's own writes do). task_id null: every live card. -> closed card ids.
// Use up an approved card exactly once across processes: an exclusive create of a claim file in the module's
// state dir. true: this caller won and must act on the yes; false: another caller already used it. Any other
// error throws (beforeTool then fails closed).
function claim(io, card_id, task_id = null) {
  const dir = path.join(io.state.dir, 'used');
  fs.mkdirSync(dir, { recursive: true });
  try { fs.writeFileSync(path.join(dir, String(card_id).replace(/[^A-Za-z0-9_-]/g, '_')), '', { flag: 'wx' }); }
  catch (e) { if (e && e.code === 'EEXIST') return false; throw e; }
  io.state.append({ type: 'card_used', card_id, task_id });
  return true;
}

// Close one live card by id, if it is still pending (the startup sweep: never a task-wide close).
function closeCard(append, records, card_id, why) {
  const c = fold(records).get(card_id);
  if (!c || !c.live || c.state !== 'pending') return false;
  append({ type: 'card_answer', module: 'approval-cards', card_id: c.card_id, task_id: c.task_id, answer: 'no', who: 'system', where: null, reason: String(why || '').slice(0, 120) });
  return true;
}

function closeLive(append, records, task_id, why) {
  const out = [];
  for (const c of fold(records).values()) {
    if (!c.live || c.state !== 'pending' || (task_id != null && c.task_id !== task_id)) continue;
    append({ type: 'card_answer', module: 'approval-cards', card_id: c.card_id, task_id: c.task_id, answer: 'no', who: 'system', where: null, reason: String(why || '').slice(0, 120) });
    out.push(c.card_id);
  }
  return out;
}

module.exports = { claim, closeLive, closeCard, source, sourceText, decisionLabel, denyMessage, systemDeny, WHO, WHERE, DEFAULT_TIMEOUT_MIN, fold, create, sweep, answered, pending, note, mirror, hashOf, isExpired, now, timeoutMs, canon, tooBig, INPUT_MAX };
