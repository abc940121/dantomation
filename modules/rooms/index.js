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
// a sleep that ends early when the signal aborts, so a cancelled turn stops its bot task now, not at the next poll
const nap = (ms, signal) => new Promise(res => { const done = () => { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); res(); }; const t = setTimeout(done, ms); if (signal) { if (signal.aborted) done(); else signal.addEventListener('abort', done, { once: true }); } });
const TERMINAL = new Set(['done', 'failed', 'stopped']);

// Engine modules (e.g. chat-endpoint) register a deliverer by name; a member with `engine` is answered
// only by it. No deliverer = unavailable, never a fall-back to a harness task.
const deliverers = new Map();
function registerDeliverer(name, fn) { deliverers.set(name, fn); return () => { if (deliverers.get(name) === fn) deliverers.delete(name); }; }

// Another module may supply rooms at run time: registerRoomSource(fn), fn() -> a map shaped like settings.rooms.
// It is read on every request, so a new room shows up without a restart. A config room wins an id clash.
// A source that throws or returns a non-object adds nothing.
const sources = new Set();
function registerRoomSource(fn) { if (typeof fn !== 'function') throw new Error('registerRoomSource needs a function'); sources.add(fn); return () => { sources.delete(fn); }; }
function allRooms(ctx) {
  const out = {};
  for (const fn of sources) {
    let got; try { got = fn(); } catch { continue; }
    if (got && typeof got === 'object' && !Array.isArray(got)) for (const [id, r] of Object.entries(got)) if (!Object.prototype.hasOwnProperty.call(out, id)) out[id] = r;
  }
  return { ...out, ...(ctx.settings.rooms || {}) };
}

let cached = null; // { key, engine, roomsKey }
function engineFor(ctx) {
  const s = ctx.settings;
  const rooms = allRooms(ctx), roomsKey = JSON.stringify(rooms);
  const key = JSON.stringify([s.human_label]);
  if (cached && cached.key === key) { if (cached.roomsKey !== roomsKey) { cached.engine.setRooms(rooms); cached.roomsKey = roomsKey; } return cached.engine; }
  const store = {
    append: rec => ctx.state.append(rec),
    all: () => J.readAll().records.filter(r => r.module === 'rooms'),
  };
  // Stop a bot task that is no longer wanted (flushed or timed out): it must not keep using tools.
  const stopTask = async id => { try { await ctx.tasks.cancel(id); } catch { /* already over, or no such task */ } };
  const deliver = async (args) => {
    const { member, prompt, signal } = args;
    // Is this member still in this group (read from the store now, not from what the engine captured)? A removal or an
    // archive may come from another process or after the engine was replaced, so the running task checks on every tick.
    const stillIn = () => { const r = allRooms(ctx)[args.room]; return !!r && r.members.some(m => m.id === member.id); };
    if (member.engine) {
      const d = deliverers.get(member.engine);
      if (!d) throw Object.assign(new Error(`${member.name} is unavailable`), { unavailable: true });
      return d(args);
    }
    if ((signal && signal.aborted) || !stillIn()) return '';
    const t = await ctx.tasks.enqueue(member.bot, prompt);
    const deadline = Date.now() + s.reply_timeout_s * 1000;
    let view = null;
    while (Date.now() < deadline) {
      if ((signal && signal.aborted) || !stillIn()) { await stopTask(t.id); return ''; }
      view = await ctx.tasks.get(t.id);
      if (view && TERMINAL.has(view.state)) break;
      await nap(s.poll_ms, signal);
    }
    if (signal && signal.aborted) { await stopTask(t.id); return ''; }
    if (!view || !TERMINAL.has(view.state)) { await stopTask(t.id); return ''; }
    if (view.state !== 'done') return '';
    // The journal gets task_done before the engine writes the reply (about 3 s later, then engine_exit):
    // keep reading until the reply shows up, the engine has exited, or a bounded grace runs out.
    const graceS = Math.max(0, Math.min(120, Number.isFinite(s.reply_grace_s) ? s.reply_grace_s : 15));
    const graceEnd = Math.min(deadline, Date.now() + graceS * 1000);
    for (;;) {
      const recs = J.readAll().records.filter(r => r.task_id === t.id);
      const rep = recs.filter(r => r.type === 'reply' && typeof r.text === 'string').pop();
      if (rep) return rep.text;
      const job = recs.filter(r => r.type === 'job_done' && r.result && typeof r.result.reply === 'string').pop();
      if (job) return job.result.reply;
      let lastStart = -1; recs.forEach((r, i) => { if (r.type === 'engine_start') lastStart = i; });
      if (recs.some((r, i) => i > lastStart && r.type === 'engine_exit') || Date.now() >= graceEnd) return '';
      if ((signal && signal.aborted) || !stillIn()) return '';
      await nap(s.poll_ms, signal);
    }
  };
  const engine = createEngine({ rooms, store, deliver, humanLabel: s.human_label, freshRooms: id => allRooms(ctx)[id] });
  cached = { key, engine, roomsKey };
  return engine;
}

const guard = (fn) => ctx => {
  try { return fn(engineFor(ctx), ctx); } catch (e) { return { status: /unknown room|required/.test(e.message) ? 400 : 500, json: { error: /unknown room|required/.test(e.message) ? e.message : 'internal error' } }; }
};

module.exports = {
  contract: 2,
  name: 'rooms',
  description: 'Multi-character rooms: fixed local routing, per-room queue, post limits, safe context replay.',
  runsOn: 'main',
  routes: [
    { method: 'GET', path: '/rooms', description: 'rooms, their members and flags', handler: guard(e => ({ status: 200, json: { rooms: e.rooms(), problems: e.problems } })) },
    { method: 'GET', path: '/rooms/:id/messages', description: 'transcript with speaker labels; ?since=<message id>',
      handler: guard((e, ctx) => ({ status: 200, json: { messages: e.messages(ctx.params.id, ctx.query && ctx.query.since) } })) },
    { method: 'GET', path: '/rooms/:id/status', access: 'owner', description: 'room presence {busy, speaker, queue:[member ids], lead, floor}',
      handler: guard((e, ctx) => (e.rooms().some(r => r.id === ctx.params.id) ? { status: 200, json: e.status(ctx.params.id) } : { status: 404, json: { error: 'unknown room' } })) },
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
  statusLines: (J2, ctx) => { const n = Object.keys(allRooms(ctx)).length; return [`rooms: ${n} configured`]; },
  settings: {
    rooms: { type: 'object', default: {}, description: 'rooms by id: { name?, lead?, window?, members: [{id, name?, bot?, engine?, endpoint?, voice?, neverLead?, noRoomMemory?, addressedOnly?, window?, contextLines?}] }' },
    human_label: { type: 'string', default: 'human', description: 'speaker label shown for the human' },
    reply_timeout_s: { type: 'number', default: 180, min: 1, description: 'give up on one member turn after this many seconds' },
    reply_grace_s: { type: 'number', default: 15, min: 0, max: 120, description: 'after a bot task is done, wait up to this many seconds for its reply record' },
    poll_ms: { type: 'number', default: 500, min: 10, description: 'how often to check a member task' },
  },
  api: { createEngine, registerDeliverer, registerRoomSource,
    // A group changed: drop the pending turns of removed members (members = null: all of them). Nothing to do before the first say.
    dropTurns(roomId, members) { return cached && cached.engine ? cached.engine.dropTurns(roomId, members) : 0; } },
};
