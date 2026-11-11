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
// Same limit, but cut in the middle (head + '...' + tail) so the start and the end (a file name) both show.
const { clipMid } = require('../../lib/clip');
// Ids are 6 hex digits, 12 after repeated collisions (cards.js reserveId).
const ID_RE = /\bcard-(?:[0-9a-f]{12}|[0-9a-f]{6})\b/i;

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
const ANSWER_CMD = /(taskmote|harness)(\.(js|cmd))?["']?\s+(do|answer)\s+["']?\s*(yes|y|no|n|ok|okay|approve|deny|stop|cancel|card-|是|好|可以|確定|同意|不)/i;

// The server API answers cards, stops and undoes too: an agent may not call it either.
const API_CMD = /\/api\/(cards|chat|tasks(\/[^\s\/]+\/(undo|stop|resume))?)(?![\w-])|taskmote(\.js)?["']?\s+(serve|token)/i;

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
  if (isShell(tool) && API_CMD.test(String((ti && ti.command) || ''))) return ['approval_cards', 'the taskmote server API is for the owner only'];
  if (isShell(tool) && ANSWER_CMD.test(String((ti && ti.command) || ''))) return ['approval_cards', 'answering an approval card is for the owner only'];
  const rule = classify(tool, ti || {}, settings, process.env.HARNESS_TASK_DIR, cwd);
  if (!rule) return null;
  // Full profile: the engine's permission-prompt tool (bin/approve-mcp.js) raises the card and waits on it, so
  // the hook only asks; a timed card here would block the call before the prompt tool ever saw it.
  return cardFor(ioOf(ctx), task, tool, ti || {}, rule, settings, process.env.HARNESS_PROMPT_TOOL === '1', cwd);
}

// The directory a call runs in is part of "this exact call": a yes for git push in one repo is not a yes in another.
const whereOf = cwd => (cwd ? path.resolve(String(cwd)) : null);

// The card for one exact call (task + call hash) on a red line -> a beforeTool result:
// ['allow:card', ...] uses up the owner's yes; ['approval_card', ...] blocks while a card waits or after a no;
// ['ask:<rule>', ...] only when promptTool (the prompt tool raises its own live card).
async function cardFor(io, task, tool, ti, rule, settings, promptTool, cwd) {
  const big = K.tooBig(ti);
  if (big) return ['card_input_too_big', big];
  await K.sweep(io);
  const hash = K.hashOf(tool, ti || {}), where = whereOf(cwd);
  const mine = [...K.fold(io.J.readAll().records).values()].filter(c => c.task_id === task && c.sha256 === hash && (c.cwd || null) === where);
  // A live card belongs to the prompt tool that is waiting on it; only that waiter uses its yes.
  // The claim is atomic, so two hooks racing on the same call cannot both use one yes.
  const ok = mine.find(c => c.state === 'approved' && !c.live && K.claim(io, c.card_id, task));
  // allow: tells the chain the owner said yes to this exact call, so another module's ask (guard-base
  // red lines) does not ask a second time; a block from any module still wins.
  if (ok) return ['allow:card', `approved on card ${ok.card_id}`];
  // A denied or expired card for this exact call stays closed: no new card, no re-ask.
  const last = mine[mine.length - 1];
  if (last && (last.state === 'denied' || last.state === 'expired')) {
    const d = last.decided || { who: 'owner' };
    return ['approval_card', K.denyMessage(last, d)];
  }
  if (promptTool) return ['ask:' + rule.id, rule.summary || rule.id];
  const wait = mine.find(c => c.state === 'pending' && !K.isExpired(c));
  const card = wait || await K.create(io, { task_id: task, tool, input: ti || {}, rule: rule.id, cwd: where,
    summary: `${rule.summary || rule.id}: ${clipMid(isShell(tool) ? ti.command : ti.url || JSON.stringify(ti), 160)}${where ? ` (in ${clipMid(where, 80)})` : ''}` }, settings);
  return ['approval_card', `waiting for approval card ${card.card_id} (${card.summary}); stop and end your turn, tell the owner the card id, and do not retry or reword the call`];
}

// Core's way in for a red line some other module asked about (guards/guard.js, locked profile, no prompt
// tool): the same card flow as this module's own rules. io = { J, state, settings, emit }.
// -> ['allow:card', why] (an approved card, now used) | ['approval_card', why] (block: a card waits, or a no).
async function raise(io, { task_id, tool, ti, kind, reason, cwd }) {
  if (!task_id) return null;
  return cardFor(io, String(task_id), String(tool || ''), ti && typeof ti === 'object' ? ti : {}, { id: 'redline:' + String(kind || 'ask'), summary: String(reason || kind || 'red line') }, io.settings, false, cwd);
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

// taskmote do <yes|no> [card-id]: the owner's answer. Returns {handled, resume, code}.
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
    console.log(`${open.length} cards are pending (${open.map(c => c.card_id).join(', ')}); answer one: taskmote do "yes <card id>" or "no <card id>"`);
    return { handled: true, resume: false, code: 3 };
  }
  const show = `card ${card.card_id}: ${card.summary}`;
  if (!rest) { console.log(`waiting for your answer on ${show}\nanswer with: taskmote do yes   |   taskmote do no`); return { handled: true, resume: false, code: 3 }; }
  const a = await record(io, card, rest, K.source({ where: 'cli' }));
  if (a === 'timeout') { console.log(`${show} had already expired; it was denied (timeout)`); return { handled: true, resume: true, code: 0 }; }
  if (a === 'unclear') {
    console.log(`Your answer was unclear, so nothing was approved. Still waiting on ${show}\nanswer with: taskmote do yes   |   taskmote do no`);
    return { handled: true, resume: false, code: 3 };
  }
  // A live card's task is still running and picks the answer up itself: nothing to resume.
  console.log(`${a === 'yes' ? 'approved' : 'denied'} ${show}; ${card.live ? 'the waiting task continues' : 'resuming the task'}`);
  return { handled: true, resume: !card.live, code: 0 };
}

// status: pending cards, with how to answer.
function statusLines(Jn) {
  const lines = [];
  for (const c of K.fold(Jn.readAll().records).values()) {
    if (c.state !== 'pending') continue;
    if (K.isExpired(c)) { lines.push(`card ${c.card_id}: expired, counts as no (${c.summary}); resume with: taskmote do`); continue; }
    lines.push(`approval card ${c.card_id} is waiting: ${c.summary}`, c.live ? '  never expires; a waiting approval pauses all bots until answered or stopped' : c.expires_at ? `  expires: ${c.expires_at}` : '  no time limit; it waits until answered');
    if (c.unclear) lines.push(`  last answer was unclear (${c.unclear}x); nothing is approved`);
    lines.push('  answer with: taskmote do yes   |   taskmote do no');
  }
  return lines;
}

// Routes (mounted at /m/approval-cards/...). The server that calls them is S1;
// who may reach them (the owner only) is the server's job, not this module's.
const view = c => ({ decision: c.decision || null, card_id: c.card_id, task_id: c.task_id, tool: c.tool, input: c.input, summary: c.summary, rule: c.rule, created_at: c.created_at, expires_at: c.expires_at, live: !!c.live, unclear: c.unclear });
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
  return { status: 200, json: { card_id: card.card_id, answer: a, resume: a !== 'unclear' && !card.live, decision: a === 'unclear' ? null : K.decisionLabel({ state: a === 'yes' ? 'approved' : 'denied', decided: src }) } };
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
  return { status: 200, json: { card_id: card.card_id, answer: a, reask: false, resume: !card.live } };
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
  contract: 2,
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
    timeout_minutes: { type: 'number', default: 0, min: 0, description: 'minutes a card waits before it counts as no; 0 (default): it waits until answered' },
    risky: { type: 'array', items: 'object', default: [], description: 'extra rules {id, match, pattern, flags?, summary?, outside_workdir?}' },
    skip: { type: 'array', items: 'string', default: [], description: 'ids of built-in rules to switch off' },
  },
  // fold, pending, isExpired are the pure journal helpers the server lists cards with.
  api: { raise, parseAnswer, voiceAnswer, source: K.source, decisionLabel: K.decisionLabel, rules, listCards, answerCard, fold: K.fold, pending: K.pending, closeLive: K.closeLive, closeCard: K.closeCard, isExpired: K.isExpired, create: K.create, answered: K.answered, denyMessage: K.denyMessage, now: K.now },
};
