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

// settings: this module's validated settings (config section "approval_cards").
function rules(settings) {
  const ac = settings || {};
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

function classify(tool, ti, settings, dir, cwd) {
  const cmd = isShell(tool) ? String((ti && ti.command) || '') : '';
  const url = ti && typeof ti.url === 'string' ? ti.url : '';
  for (const r of rules(settings)) {
    const text = (r.kinds.includes('shell') ? cmd : '') + '\n' + (r.kinds.includes('url') ? url : '');
    if (!r.re.test(text)) continue;
    if (r.outside_workdir && !outside(cmd, dir, cwd)) continue;
    return r;
  }
  return null;
}

// An agent spelling of the owner's answer verb is refused outright.
const ANSWER_CMD = /(dantomation|harness)(\.(js|cmd))?["']?\s+(do|answer)\s+["']?\s*(yes|y|no|n|ok|okay|approve|deny|stop|cancel|card-|是|好|可以|確定|同意|不)/i;

// The server API answers cards, stops and undoes too: an agent may not call it either.
const API_CMD = /\/api\/(cards|chat|tasks(\/[^\s\/]+\/(undo|stop|resume))?)(?![\w-])|dantomation(\.js)?["']?\s+(serve|token)/i;

// io for cards.js: journal reads, this module's state (writes) and emit.
const ioOf = ctx => ({ J: (ctx && ctx.core && ctx.core.J) || (ctx && ctx.J) || J, state: ctx.state, emit: ctx.emit });

async function beforeTool(ctx) {
  try { return await decide(ctx); }
  catch (e) { // fail closed: the call does not run, and the agent gets a reason it can pass on
    return ['approval_card', 'this step was not run: the approval system could not be reached (' + clip(e && e.message, 80) + '). Skip it, tell the person why, and continue with anything that does not depend on it.'];
  }
}
async function decide(ctx) {
  const { tool, ti, cwd, settings } = ctx;
  const task = process.env.HARNESS_TASK_ID;
  if (!task) return null;
  if (isShell(tool) && API_CMD.test(String((ti && ti.command) || ''))) return ['approval_cards', 'the dantomation server API is for the owner only'];
  if (isShell(tool) && ANSWER_CMD.test(String((ti && ti.command) || ''))) return ['approval_cards', 'answering an approval card is for the owner only'];
  const rule = classify(tool, ti || {}, settings, process.env.HARNESS_TASK_DIR, cwd);
  if (!rule) return null;
  const io = ioOf(ctx);
  await K.sweep(io);
  const hash = K.hashOf(tool, ti || {});
  const mine = [...K.fold(io.J.readAll().records).values()].filter(c => c.task_id === task && c.sha256 === hash);
  const ok = mine.find(c => c.state === 'approved');
  if (ok) { io.state.append({ type: 'card_used', card_id: ok.card_id, task_id: task }); return null; }
  // A denied or expired card for this exact call stays closed: no new card, no re-ask.
  const last = mine[mine.length - 1];
  if (last && (last.state === 'denied' || last.state === 'expired')) {
    const d = last.decided || { who: 'owner' };
    return ['approval_card', K.denyMessage(last, d)];
  }
  const wait = mine.find(c => c.state === 'pending' && !K.isExpired(c));
  const card = wait || await K.create(io, { task_id: task, tool, input: ti || {}, rule: rule.id,
    summary: `${rule.summary || rule.id}: ${clip(isShell(tool) ? ti.command : ti.url || JSON.stringify(ti), 160)}` }, settings);
  return ['approval_card', `waiting for approval card ${card.card_id} (${card.summary}); stop and end your turn, tell the owner the card id, and do not retry or reword the call`];
}

// The owner's answer text on one pending card -> 'yes' | 'no' | 'unclear', written to
// the journal. Shared by the answer command and the answer route.
// src: {who, where, device_id?} (cards.source); default the owner in the chat.
async function record(io, card, text, src) {
  src = src || K.source({ where: 'chat' });
  let a = parseAnswer(text);
  if (a === 'unclear') { await K.answered(io, card, 'unclear', { text: clip(text, 80) }); return a; }
  a = await K.answered(io, card, a === 'yes' ? 'yes' : 'no', undefined, src);
  if (a === 'timeout') { K.note(io, card.task_id, K.denyMessage(card, { who: 'timeout' }).replace('DENIED (timeout)', 'denied (timeout)')); a = 'timeout'; }
  else if (a === 'yes') K.note(io, card.task_id, `card ${card.card_id} APPROVED by ${K.sourceText(src)} (${card.summary}). Re-issue that exact call, unchanged, once; it will pass. A different call needs its own card.`);
  else K.note(io, card.task_id, K.denyMessage(card, src));
  K.mirror(io, [...K.fold(io.J.readAll().records).values()].filter(c => c.card_id === card.card_id));
  return a;
}

// dantomation do <yes|no> [card-id]: the owner's answer. Returns {handled, resume, code}.
async function answer(args, ctx) {
  const io = ioOf(ctx), j = io.J;
  await K.sweep(io);
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
  const a = await record(io, card, rest, K.source({ where: 'cli' }));
  if (a === 'timeout') { console.log(`${show} had already expired; it was denied (timeout)`); return { handled: true, resume: true, code: 0 }; }
  if (a === 'unclear') {
    console.log(`Your answer was unclear, so nothing was approved. Still waiting on ${show}\nanswer with: dantomation do yes   |   dantomation do no`);
    return { handled: true, resume: false, code: 3 };
  }
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

// Routes (mounted at /m/approval-cards/...). The server that calls them is S1;
// who may reach them (the owner only) is the server's job, not this module's.
const view = c => ({ decision: c.decision || null, card_id: c.card_id, task_id: c.task_id, summary: c.summary, rule: c.rule, created_at: c.created_at, expires_at: c.expires_at, unclear: c.unclear });
async function listCards(ctx) {
  const io = ioOf(ctx), j = io.J;
  await K.sweep(io);
  return { status: 200, json: { cards: K.pending(j.readAll().records).map(view) } };
}
// Who is answering, from the authenticated actor only (never from the body). The server
// maps a device token to {kind: 'owner', id: 'device:<id>'}; the opaque id comes from there.
// A device actor is always where=phone (voice route: voice). Anything unexpected -> null (fail closed).
function sourceOf(actor, body, deviceWhere) {
  if (!actor || actor.kind !== 'owner') return null;
  const id = typeof actor.id === 'string' ? actor.id : '';
  if (id.startsWith('device:')) return K.source({ who: 'device', device_id: id.slice(7), where: deviceWhere });
  if (id !== '') return null;
  const w = body && body.where;
  return K.source({ where: w === undefined ? 'chat' : w }); // owner: where must be one the module allows
}
async function answerCard(ctx) {
  const { params, body } = ctx;
  const io = ioOf(ctx), j = io.J;
  const text = body && typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return { status: 400, json: { error: 'body.text is required, e.g. {"text": "yes"}' } };
  await K.sweep(io);
  const card = K.pending(j.readAll().records).find(c => c.card_id === String(params.id).toLowerCase());
  if (!card) return { status: 404, json: { error: `no pending card ${params.id}` } };
  const src = sourceOf(ctx.actor, body, 'phone');
  if (!src || src.who === 'timeout' || src.who === 'system') return { status: 400, json: { error: 'bad source: where is chat | phone | voice | cli (a device is always phone)' } };
  const a = await record(io, card, text, src);
  if (a === 'timeout') return { status: 409, json: { error: 'card expired; denied (timeout)', answer: 'timeout' } };
  return { status: 200, json: { card_id: card.card_id, answer: a, resume: a !== 'unclear', decision: a === 'unclear' ? null : K.decisionLabel({ state: a === 'yes' ? 'approved' : 'denied', decided: src }) } };
}

// The hook point for voice: the voice module calls this (route POST /cards/:id/voice, or
// api.voiceAnswer with this module's ctx) with the transcript. Only a strict yes or no
// decides; anything else changes nothing and the person is asked again. Not wired here.
const REASK = 'Please answer with a clear yes or no.';
async function voiceAnswer(ctx, { card_id, text, device_id }) {
  const io = ioOf(ctx), j = io.J;
  await K.sweep(io);
  const open = K.pending(j.readAll().records);
  const card = card_id ? open.find(c => c.card_id === String(card_id).toLowerCase()) : (open.length === 1 ? open[0] : null);
  if (!card) return { status: 404, json: { error: card_id ? `no pending card ${card_id}` : 'name the card: none or several are pending' } };
  const src = K.source({ where: 'voice', device_id });
  if (!src) return { status: 400, json: { error: 'bad device_id' } };
  const a = await record(io, card, text, src);
  if (a === 'unclear') return { status: 200, json: { card_id: card.card_id, answer: 'unclear', reask: true, say: REASK } };
  if (a === 'timeout') return { status: 409, json: { error: 'card expired; denied (timeout)', answer: 'timeout' } };
  return { status: 200, json: { card_id: card.card_id, answer: a, reask: false, resume: true } };
}
// The one exception: the plain owner token (the server token voice-chat uses to talk to this
// server) may name the device it is relaying for. It already holds owner power, and K.source
// validates the id; a device actor never gets here, its id always comes from the actor.
const bodyDevice = ctx => { const d = ctx.body && ctx.body.device_id; return typeof d === 'string' && d ? d : undefined; };
const voiceRoute = ctx => {
  const id = ctx.actor && typeof ctx.actor.id === 'string' ? ctx.actor.id : '';
  if (!ctx.actor || ctx.actor.kind !== 'owner' || (id !== '' && !id.startsWith('device:'))) return { status: 403, json: { error: 'forbidden' } };
  return voiceAnswer(ctx, { card_id: ctx.params.id, text: ctx.body && ctx.body.text, device_id: id ? id.slice(7) : bodyDevice(ctx) }); // a device's id is the actor's, never the body's
};
async function decidedCards(ctx) {
  const io = ioOf(ctx);
  await K.sweep(io);
  return { status: 200, json: { cards: [...K.fold(io.J.readAll().records).values()].filter(c => c.decided).slice(-20).map(view) } };
}

module.exports = {
  contract: 1,
  name: 'approval-cards',
  description: 'Risky actions stop and ask the owner yes/no instead of running.',
  runsOn: 'main',
  priority: 50,
  beforeTool,
  emits: ['card'], // card.created, card.answered (see cards.js)
  on: { 'task.start': (_, ctx) => K.sweep(ioOf(ctx)) },
  statusLines,
  commands: { answer },
  routes: [
    { method: 'GET', path: '/cards', handler: listCards, description: 'pending cards' },
    { method: 'GET', path: '/cards/decided', handler: decidedCards, description: 'recent decided cards with who/where, e.g. "Denied · timeout"' },
    { method: 'POST', path: '/cards/:id/voice', handler: voiceRoute, description: 'voice hook: body {text}; strict yes/no, else re-ask' },
    { method: 'POST', path: '/cards/:id/answer', handler: answerCard, description: 'answer one card: body {text}' },
  ],
  panels: [{ id: 'cards', title: 'Approval cards', mount: 'chat', entry: 'ui/cards-panel.js' }],
  settings: {
    timeout_minutes: { type: 'number', default: 15, min: 1, description: 'minutes a card waits before it counts as no' },
    risky: { type: 'array', items: 'object', default: [], description: 'extra rules {id, match, pattern, flags?, summary?, outside_workdir?}' },
    skip: { type: 'array', items: 'string', default: [], description: 'ids of built-in rules to switch off' },
  },
  // fold, pending, isExpired are the pure journal helpers the server lists cards with.
  api: { parseAnswer, voiceAnswer, source: K.source, decisionLabel: K.decisionLabel, rules, listCards, answerCard, fold: K.fold, pending: K.pending, isExpired: K.isExpired },
};
