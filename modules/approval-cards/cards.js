'use strict';
// Card store. The journal is the single source of truth (append-only, fsynced);
// <module state dir>/<id>.json (state/m/approval-cards/) is a readable mirror,
// rewritten from the journal.
//   card         {card_id, task_id, tool, input, sha256, summary, rule, created_at, expires_at}
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

const DEFAULT_TIMEOUT_MIN = 10;
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
  return (Number.isFinite(m) && m > 0 ? m : DEFAULT_TIMEOUT_MIN) * 60000;
}

// records -> Map card_id -> card with .state: pending | approved | denied | expired | used
function fold(records) {
  const cards = new Map();
  for (const r of records) {
    if (r.type === 'card') cards.set(r.card_id, { ...r, state: 'pending', unclear: 0 });
    else if (r.type === 'card_answer' && cards.has(r.card_id)) {
      const c = cards.get(r.card_id);
      if (r.answer === 'unclear') { c.unclear++; continue; }
      if (c.state !== 'pending') continue;
      c.state = r.answer === 'yes' ? 'approved' : r.answer === 'timeout' ? 'expired' : 'denied';
    } else if (r.type === 'card_used' && cards.has(r.card_id)) cards.get(r.card_id).state = 'used';
  }
  return cards;
}
const isExpired = c => c.state === 'pending' && now() >= Date.parse(c.expires_at);

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

async function create(io, { task_id, tool, input, summary, rule }, settings) {
  const card_id = 'card-' + crypto.randomBytes(3).toString('hex');
  const t = now();
  const rec = io.state.append({ type: 'card', card_id, task_id, tool, input, sha256: hashOf(tool, input), summary, rule,
    created_at: new Date(t).toISOString(), expires_at: new Date(t + timeoutMs(settings)).toISOString() });
  mirror(io, [{ ...rec, state: 'pending', unclear: 0 }]);
  await io.emit('card.created', { card_id, task_id, summary, rule, expires_at: rec.expires_at });
  return rec;
}

const note = (io, task_id, text) => io.state.append({ type: 'history_note', task_id, note: text });

// One answer record; yes / no / timeout also emit card.answered.
async function answered(io, card, answer, extra) {
  io.state.append({ type: 'card_answer', card_id: card.card_id, task_id: card.task_id, answer, ...extra });
  if (answer !== 'unclear') await io.emit('card.answered', { card_id: card.card_id, task_id: card.task_id, answer });
}

// Pending cards past their deadline become "no" (timeout), once, with a note for the resumed agent.
async function sweep(io) {
  const out = [];
  for (const c of fold(io.J.readAll().records).values()) {
    if (!isExpired(c)) continue;
    note(io, c.task_id, `card ${c.card_id} denied (timeout): the owner did not answer in time (${c.summary}). Do not retry or reword it; report that it was not approved.`);
    await answered(io, c, 'timeout');
    out.push(c.card_id);
  }
  if (out.length) mirror(io, [...fold(io.J.readAll().records).values()].filter(c => out.includes(c.card_id)));
  return out;
}

const pending = records => [...fold(records).values()].filter(c => c.state === 'pending' && !isExpired(c));

module.exports = { fold, create, sweep, answered, pending, note, mirror, hashOf, isExpired, now, timeoutMs, canon };
