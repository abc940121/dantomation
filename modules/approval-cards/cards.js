'use strict';
// Card store. The journal is the single source of truth (append-only, fsynced);
// state/cards/<id>.json is a readable mirror, rewritten from the journal.
//   card         {card_id, task_id, tool, input, sha256, summary, rule, created_at, expires_at}
//   card_answer  {card_id, answer: yes | no | timeout | unclear}
//   card_used    {card_id}
// Card state is a fold over those records, so a crash at any point leaves a card
// either fully there (pending) or not there; resuming never makes a second one.
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

function timeoutMs(cfg) {
  const m = Number(cfg && cfg.approval_cards && cfg.approval_cards.timeout_minutes);
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

function mirror(J, cards) {
  try {
    const dir = path.join(J.STATE, 'cards');
    fs.mkdirSync(dir, { recursive: true });
    for (const c of cards) {
      const f = path.join(dir, c.card_id + '.json');
      fs.writeFileSync(f + '.tmp', JSON.stringify({ ...c, state: isExpired(c) ? 'expired' : c.state }, null, 2));
      fs.renameSync(f + '.tmp', f);
    }
  } catch { /* the journal is authoritative; a failed mirror changes nothing */ }
}

function create(J, { task_id, tool, input, summary, rule }, cfg) {
  const card_id = 'card-' + crypto.randomBytes(3).toString('hex');
  const t = now();
  const rec = J.append({ type: 'card', card_id, task_id, tool, input, sha256: hashOf(tool, input), summary, rule,
    created_at: new Date(t).toISOString(), expires_at: new Date(t + timeoutMs(cfg)).toISOString() });
  mirror(J, [{ ...rec, state: 'pending', unclear: 0 }]);
  return rec;
}

const note = (J, task_id, text) => J.append({ type: 'history_note', task_id, note: text });

// Pending cards past their deadline become "no" (timeout), once, with a note for the resumed agent.
function sweep(J) {
  const out = [];
  for (const c of fold(J.readAll().records).values()) {
    if (!isExpired(c)) continue;
    J.append({ type: 'card_answer', card_id: c.card_id, task_id: c.task_id, answer: 'timeout' });
    note(J, c.task_id, `card ${c.card_id} denied (timeout): the owner did not answer in time (${c.summary}). Do not retry or reword it; report that it was not approved.`);
    out.push(c.card_id);
  }
  if (out.length) mirror(J, [...fold(J.readAll().records).values()].filter(c => out.includes(c.card_id)));
  return out;
}

const pending = records => [...fold(records).values()].filter(c => c.state === 'pending' && !isExpired(c));

module.exports = { fold, create, sweep, pending, note, mirror, hashOf, isExpired, now, timeoutMs, canon };
