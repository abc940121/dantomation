'use strict';
// approval-cards: risky actions stop and ask the owner yes/no instead of running.
// Only actions the hard blockers (guard-base, private rules) allow reach a card:
// priority 50 runs after them. See README.md for the flow.
const path = require('path');
const J = require('../../lib/journal');
const { isShell } = require('../../lib/shell');
const { parseAnswer } = require('./parse');
const K = require('./cards');
const DEFAULTS = require('./default-risky.json').rules;

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 3) + '...' : s; };
const ID_RE = /\bcard-[0-9a-f]{6}\b/i;

function rules(cfg) {
  const ac = (cfg && cfg.approval_cards) || {};
  const skip = new Set(Array.isArray(ac.skip) ? ac.skip : []);
  const extra = Array.isArray(ac.risky) ? ac.risky : [];
  const out = [];
  for (const r of [...DEFAULTS, ...extra]) {
    if (!r || skip.has(r.id) || typeof r.pattern !== 'string') continue;
    try { out.push({ ...r, re: new RegExp(r.pattern, typeof r.flags === 'string' ? r.flags : 'i'), kinds: [].concat(r.match || 'shell') }); }
    catch { throw new Error(`approval_cards rule ${JSON.stringify(r.id)} has a bad pattern`); }
  }
  return out;
}

// Does any path argument of a shell command point outside the task folder?
// Unknown (variables, ~) counts as outside: when unsure, ask.
function outside(cmd, dir, cwd) {
  const base = path.resolve(dir || cwd || process.cwd());
  const args = (cmd.match(/"[^"]*"|'[^']*'|[^\s;&|]+/g) || []).map(t => t.replace(/^["']|["']$/g, ''));
  for (const a of args) {
    if (!a || /^-{1,2}[A-Za-z]/.test(a) || /^\/[A-Za-z]$/.test(a)) continue;
    if (/^(rm|del|erase|rmdir|rd|unlink|Remove-Item|ri)$/i.test(a)) continue;
    if (/[$%~]/.test(a)) return true;
    const rel = path.relative(base, path.resolve(base, a));
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return true;
  }
  return false;
}

function classify(tool, ti, cfg, dir, cwd) {
  const cmd = isShell(tool) ? String((ti && ti.command) || '') : '';
  const url = ti && typeof ti.url === 'string' ? ti.url : '';
  for (const r of rules(cfg)) {
    const text = (r.kinds.includes('shell') ? cmd : '') + '\n' + (r.kinds.includes('url') ? url : '');
    if (!r.re.test(text)) continue;
    if (r.outside_workdir && !outside(cmd, dir, cwd)) continue;
    return r;
  }
  return null;
}

// An agent spelling of the owner's answer verb is refused outright.
const ANSWER_CMD = /(dantomation|harness)(\.(js|cmd))?["']?\s+(do|answer)\s+["']?\s*(yes|y|no|n|ok|okay|approve|deny|stop|cancel|card-|是|好|可以|確定|同意|不)/i;

function beforeTool({ tool, ti, cwd, config }) {
  const task = process.env.HARNESS_TASK_ID;
  if (!task) return null;
  if (isShell(tool) && ANSWER_CMD.test(String((ti && ti.command) || ''))) return ['approval_cards', 'answering an approval card is for the owner only'];
  const rule = classify(tool, ti || {}, config, process.env.HARNESS_TASK_DIR, cwd);
  if (!rule) return null;
  K.sweep(J);
  const hash = K.hashOf(tool, ti || {});
  const mine = [...K.fold(J.readAll().records).values()].filter(c => c.task_id === task && c.sha256 === hash);
  const ok = mine.find(c => c.state === 'approved');
  if (ok) { J.append({ type: 'card_used', card_id: ok.card_id, task_id: task }); return null; }
  const wait = mine.find(c => c.state === 'pending' && !K.isExpired(c));
  const card = wait || K.create(J, { task_id: task, tool, input: ti || {}, rule: rule.id,
    summary: `${rule.summary || rule.id}: ${clip(isShell(tool) ? ti.command : ti.url || JSON.stringify(ti), 160)}` }, config);
  return ['approval_card', `waiting for approval card ${card.card_id} (${card.summary}); stop and end your turn, tell the owner the card id, and do not retry or reword the call`];
}

// dantomation do <yes|no> [card-id]: the owner's answer. Returns {handled, resume, code}.
function answer(args, core) {
  const j = (core && core.J) || J;
  K.sweep(j);
  const text = args.join(' ').trim();
  const open = K.pending(j.readAll().records);
  if (!open.length) return { handled: false };
  if (process.env.HARNESS_TASK_ID) { console.error('approval cards are answered by the person at the keyboard, not by agents (HARNESS_TASK_ID is set). Stopping.'); process.exit(6); }
  const idm = text.match(ID_RE);
  const rest = text.replace(ID_RE, '').trim();
  let card = open[open.length - 1];
  if (idm) {
    card = open.find(c => c.card_id === idm[0].toLowerCase());
    if (!card) { console.log(`no pending card ${idm[0]}. Pending: ${open.map(c => c.card_id).join(', ')}`); return { handled: true, resume: false, code: 3 }; }
  } else if (open.length > 1) {
    console.log(`${open.length} cards are pending (${open.map(c => c.card_id).join(', ')}); answer one: dantomation do "yes <card id>" or "no <card id>"`);
    return { handled: true, resume: false, code: 3 };
  }
  const show = `card ${card.card_id}: ${card.summary}`;
  if (!rest) { console.log(`waiting for your answer on ${show}\nanswer with: dantomation do yes   |   dantomation do no`); return { handled: true, resume: false, code: 3 }; }
  const a = parseAnswer(rest);
  if (a === 'unclear') {
    j.append({ type: 'card_answer', card_id: card.card_id, task_id: card.task_id, answer: 'unclear', text: clip(rest, 80) });
    console.log(`Your answer was unclear, so nothing was approved. Still waiting on ${show}\nanswer with: dantomation do yes   |   dantomation do no`);
    return { handled: true, resume: false, code: 3 };
  }
  j.append({ type: 'card_answer', card_id: card.card_id, task_id: card.task_id, answer: a });
  if (a === 'yes') K.note(j, card.task_id, `card ${card.card_id} APPROVED by the owner (${card.summary}). Re-issue that exact call, unchanged, once; it will pass. A different call needs its own card.`);
  else K.note(j, card.task_id, `card ${card.card_id} DENIED by the owner (${card.summary}). Do not retry or reword it; report that it was not approved and continue with anything else, or stop.`);
  K.mirror(j, [...K.fold(j.readAll().records).values()].filter(c => c.card_id === card.card_id));
  console.log(`${a === 'yes' ? 'approved' : 'denied'} ${show}; resuming the task`);
  return { handled: true, resume: true, code: 0 };
}

// status: pending cards, with how to answer.
function statusLines(Jn) {
  const lines = [];
  for (const c of K.fold(Jn.readAll().records).values()) {
    if (c.state !== 'pending') continue;
    if (K.isExpired(c)) { lines.push(`card ${c.card_id}: expired, counts as no (${c.summary}); resume with: dantomation do`); continue; }
    lines.push(`approval card ${c.card_id} is waiting: ${c.summary}`, `  expires: ${c.expires_at}`);
    if (c.unclear) lines.push(`  last answer was unclear (${c.unclear}x); nothing is approved`);
    lines.push('  answer with: dantomation do yes   |   dantomation do no');
  }
  return lines;
}

module.exports = {
  name: 'approval-cards',
  priority: 50,
  beforeTool,
  onTaskStart() { K.sweep(J); },
  statusLines,
  parseAnswer,
  commands: { answer },
};
