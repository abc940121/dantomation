'use strict';
// rooms: several bots (members) share one chat room. Off by default. Routing is
// fixed and local (@everyone, then @mentions, then the lead); see README.md.
// Transcript records (room_msg, room_seen, room_summary, room_event) live in the
// journal. A member's turn is delivered through the server's task path
// (ctx.tasks.enqueue, as POST /api/chat does) and its reply is read from the
// same journal record the chat UI shows.
const J = require('../../lib/journal');
const { createEngine } = require('./engine');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TERMINAL = new Set(['done', 'failed', 'stopped']);

// Engine modules (e.g. chat-endpoint) register a deliverer by name; a member with `engine` is answered
// only by it. No deliverer = unavailable, never a fall-back to a harness task.
const deliverers = new Map();
function registerDeliverer(name, fn) { deliverers.set(name, fn); return () => { if (deliverers.get(name) === fn) deliverers.delete(name); }; }

let cached = null; // { key, engine }
function engineFor(ctx) {
  const s = ctx.settings;
  const key = JSON.stringify([s.rooms, s.human_label]);
  if (cached && cached.key === key) return cached.engine;
  const store = {
    append: rec => ctx.state.append(rec),
    all: () => J.readAll().records.filter(r => r.module === 'rooms'),
  };
  // Stop a bot task that is no longer wanted (flushed or timed out): it must not keep using tools.
  const stopTask = async id => { try { await ctx.tasks.cancel(id); } catch { /* already over, or no such task */ } };
  const deliver = async (args) => {
    const { member, prompt, signal } = args;
    if (member.engine) {
      const d = deliverers.get(member.engine);
      if (!d) throw Object.assign(new Error(`${member.name} is unavailable`), { unavailable: true });
      return d(args);
    }
    if (signal && signal.aborted) return '';
    const t = await ctx.tasks.enqueue(member.bot, prompt);
    const deadline = Date.now() + s.reply_timeout_s * 1000;
    let view = null;
    while (Date.now() < deadline) {
      if (signal && signal.aborted) { await stopTask(t.id); return ''; }
      view = await ctx.tasks.get(t.id);
      if (view && TERMINAL.has(view.state)) break;
      await sleep(s.poll_ms);
    }
    if (signal && signal.aborted) { await stopTask(t.id); return ''; }
    if (!view || !TERMINAL.has(view.state)) { await stopTask(t.id); return ''; }
    if (view.state !== 'done') return '';
    const recs = J.readAll().records.filter(r => r.task_id === t.id);
    const rep = recs.filter(r => r.type === 'reply' && typeof r.text === 'string').pop();
    if (rep) return rep.text;
    const job = recs.filter(r => r.type === 'job_done' && r.result && typeof r.result.reply === 'string').pop();
    return job ? job.result.reply : '';
  };
  const engine = createEngine({ rooms: s.rooms, store, deliver, humanLabel: s.human_label });
  cached = { key, engine };
  return engine;
}

const guard = (fn) => ctx => {
  try { return fn(engineFor(ctx), ctx); } catch (e) { return { status: /unknown room|required/.test(e.message) ? 400 : 500, json: { error: /unknown room|required/.test(e.message) ? e.message : 'internal error' } }; }
};

module.exports = {
  contract: 1,
  name: 'rooms',
  description: 'Multi-character rooms: fixed local routing, per-room queue, post limits, safe context replay.',
  runsOn: 'main',
  routes: [
    { method: 'GET', path: '/rooms', description: 'rooms, their members and flags', handler: guard(e => ({ status: 200, json: { rooms: e.rooms(), problems: e.problems } })) },
    { method: 'GET', path: '/rooms/:id/messages', description: 'transcript with speaker labels; ?since=<message id>',
      handler: guard((e, ctx) => ({ status: 200, json: { messages: e.messages(ctx.params.id, ctx.query && ctx.query.since) } })) },
    { method: 'POST', path: '/rooms/:id/say', description: 'the human speaks {text, type?: "voice_transcript"}; flushes pending bot turns; answers 202, read the transcript for replies',
      handler: guard((e, ctx) => {
        const text = ctx.body && ctx.body.text;
        if (!e.rooms().some(r => r.id === ctx.params.id)) throw new Error('unknown room');
        if (typeof text !== 'string' || !text.trim()) throw new Error('text required');
        e.say(ctx.params.id, text, { type: ctx.body && ctx.body.type }).catch(err => ctx.state.append({ type: 'room_event', room: ctx.params.id, event: 'error', error: String(err && err.message).slice(0, 200) }));
        return { status: 202, json: { accepted: true } };
      }) },
    { method: 'POST', path: '/rooms/:id/floor', description: 'the owner is speaking {speaking: bool}: bot turns wait (auto-release after 15 s; saying a line releases it)',
      handler: guard((e, ctx) => {
        if (!e.rooms().some(r => r.id === ctx.params.id)) throw new Error('unknown room');
        e.holdFloor(ctx.params.id, !!(ctx.body && ctx.body.speaking));
        return { status: 200, json: { ok: true } };
      }) },
    { method: 'POST', path: '/rooms/:id/summary', description: 'set the room summary {text}: shown to members only as a labeled data block',
      handler: guard((e, ctx) => {
        const text = ctx.body && ctx.body.text;
        if (typeof text !== 'string' || !text.trim()) throw new Error('text required');
        return { status: 200, json: { id: e.setSummary(ctx.params.id, text).id } };
      }) },
  ],
  statusLines: (J2, ctx) => { const n = Object.keys(ctx.settings.rooms || {}).length; return [`rooms: ${n} configured`]; },
  settings: {
    rooms: { type: 'object', default: {}, description: 'rooms by id: { lead?, window?, members: [{id, name?, bot?, engine?, endpoint?, voice?, neverLead?, noRoomMemory?, addressedOnly?, window?, contextLines?}] }' },
    human_label: { type: 'string', default: 'human', description: 'speaker label shown for the human' },
    reply_timeout_s: { type: 'number', default: 180, min: 1, description: 'give up on one member turn after this many seconds' },
    poll_ms: { type: 'number', default: 500, min: 10, description: 'how often to check a member task' },
  },
  api: { createEngine, registerDeliverer },
};
