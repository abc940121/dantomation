'use strict';
// The room engine: transcript in the journal (through an injected store),
// a per-room serial queue, routing, one hop, bot-post budget, human flush.
// deliver({room, member, prompt, messages, signal}) -> Promise<string> is injected: the
// module wires it to the server's task path (enqueue a bot task, read its reply). `signal`
// aborts when the turn is flushed (the human spoke again); deliver must then stop the task it started.
const { route } = require('./route');
const { createBudget } = require('./budget');
const { buildContext } = require('./replay');
const { isPass, impersonation, scrub } = require('./guard');

const DEFAULT_WINDOW = 20;

// rooms: { id: { lead?, window?, members: [{id, name?, bot?, voice?, neverLead?, noRoomMemory?, addressedOnly?, window?, contextLines?}] } }
function normalize(rooms) {
  const out = {}, problems = [];
  for (const [id, r] of Object.entries(rooms || {})) {
    // Room ids must be word characters or "-": the device allowlist only matches that shape (fail closed).
    if (!/^[\w-]+$/.test(id)) { problems.push(`room ${JSON.stringify(id)}: id must match [A-Za-z0-9_-]+ (room skipped)`); continue; }
    const members = (Array.isArray(r && r.members) ? r.members : []).filter(m => m && typeof m.id === 'string' && m.id)
      .map(m => ({ ...m, name: String(m.name || m.id), bot: m.bot === undefined ? m.id : m.bot }));
    if (new Set(members.map(m => m.id.toLowerCase())).size !== members.length) problems.push(`room ${id}: duplicate member id`);
    let lead = (r && r.lead) || null;
    const lm = members.find(m => m.id === lead);
    if (lead && !lm) { problems.push(`room ${id}: lead "${lead}" is not a member (room has no lead)`); lead = null; }
    else if (lm && (lm.neverLead || lm.addressedOnly)) { problems.push(`room ${id}: member "${lead}" is flagged never-lead (room has no lead)`); lead = null; }
    out[id] = { id, lead, window: Number.isInteger(r.window) && r.window >= 0 ? r.window : DEFAULT_WINDOW, members };
  }
  return { rooms: out, problems };
}

function createEngine({ rooms, store, deliver, now = Date.now, humanLabel = 'human', maxHopTargets = 3 }) {
  const norm = normalize(rooms);
  const st = new Map();
  const state = id => { if (!st.has(id)) st.set(id, { queue: [], gen: 0, drain: null, inflight: new Set(), budget: createBudget(now) }); return st.get(id); };
  const room = id => norm.rooms[id] || null;
  const transcript = id => store.all().filter(r => r.type === 'room_msg' && r.room === id);

  // Who may keep a line as memory. A member flagged noRoomMemory keeps only its
  // own exchanges with the human: lines addressed to it, and its replies to those.
  const memoryFor = (r, { addressed = [], speaker = null, humanTurn = false }) =>
    r.members.filter(m => !m.noRoomMemory || addressed.includes(m.id) || (humanTurn && speaker === m.id)).map(m => m.id);

  const refuse = (member, reason, extra) => ({ posted: false, reason, member: member.id, ...extra });

  async function runTurn(r, s, turn) {
    const member = r.members.find(m => m.id === turn.member);
    if (!member || turn.gen !== s.gen) return null;
    const msgs = transcript(r.id);
    const trigger = msgs.find(m => m.id === turn.trigger);
    const summaries = store.all().filter(x => x.type === 'room_summary' && x.room === r.id);
    const ctx = buildContext({ room: r, member, messages: msgs, trigger, summary: summaries.length ? summaries[summaries.length - 1].text : null, humanLabel });
    store.append({ type: 'room_seen', room: r.id, member: member.id, ids: ctx.seen });
    let raw;
    const ac = new AbortController();
    s.inflight.add(ac);
    try { raw = await deliver({ room: r.id, member, prompt: ctx.prompt, messages: ctx.messages, signal: ac.signal }); } catch { return refuse(member, 'delivery failed'); }
    finally { s.inflight.delete(ac); }
    if (turn.gen !== s.gen) return refuse(member, 'stale'); // the human spoke meanwhile: nothing stale is delivered
    if (isPass(raw)) return refuse(member, 'pass');
    const bad = impersonation(raw, member, r);
    if (bad) return refuse(member, 'impersonation', { detail: bad });
    const text = scrub(String(raw).trim(), { pii: !!member.noRoomMemory });
    const verdict = s.budget.check(member.id, text);
    if (!verdict.ok) {
      if (verdict.tripped) store.append({ type: 'room_event', room: r.id, event: 'closed', limit: verdict.reason, until: new Date(verdict.until).toISOString() });
      return refuse(member, verdict.reason);
    }
    const humanTurn = !!(trigger && trigger.kind === 'human');
    const rec = store.append({ type: 'room_msg', room: r.id, speaker: member.id, kind: 'bot', text, reply_to: turn.trigger,
      memory_for: memoryFor(r, { speaker: member.id, humanTurn }) });
    s.budget.record(member.id, text);
    if (turn.hop === 0) { // at most one follow-up hop: replies to a hop turn wake nobody
      const hop = route(text, r, { sender: member.id, fromBot: true }).ids.slice(0, maxHopTargets);
      for (const id of hop) s.queue.push({ member: id, trigger: rec.id, hop: 1, gen: s.gen });
    }
    return { posted: true, id: rec.id, member: member.id };
  }

  function drain(r, s) {
    if (s.drain) return s.drain;
    s.drain = (async () => {
      const results = [];
      while (s.queue.length) {
        const turn = s.queue.shift();
        const res = await runTurn(r, s, turn);
        if (res) results.push(res);
      }
      return results;
    })().finally(() => { s.drain = null; });
    return s.drain;
  }

  const labelOf = (roomId, sp) => (sp === 'human' ? humanLabel : ((room(roomId).members.find(x => x.id === sp) || {}).name || sp));

  return {
    problems: norm.problems,
    rooms: () => Object.values(norm.rooms).map(r => ({ id: r.id, lead: r.lead, window: r.window,
      members: r.members.map(m => ({ id: m.id, name: m.name, neverLead: !!m.neverLead, noRoomMemory: !!m.noRoomMemory, addressedOnly: !!m.addressedOnly })) })),
    // The human speaks: every pending bot turn is flushed first, then the line is stored and routed.
    async say(roomId, text) {
      const r = room(roomId);
      if (!r) throw new Error('unknown room');
      if (typeof text !== 'string' || !text.trim()) throw new Error('text required');
      const s = state(roomId);
      s.gen++; s.queue.length = 0;
      for (const ac of s.inflight) ac.abort(); // a turn still running is stopped, not just ignored
      const routed = route(text, r);
      const rec = store.append({ type: 'room_msg', room: r.id, speaker: 'human', kind: 'human', text: scrub(text.trim()), woke: routed.ids,
        memory_for: memoryFor(r, { addressed: routed.ids }) });
      for (const id of routed.ids) s.queue.push({ member: id, trigger: rec.id, hop: 0, gen: s.gen });
      const results = await drain(r, s);
      return { id: rec.id, routed: routed.kind, woke: routed.ids, results };
    },
    messages(roomId, since) {
      if (!room(roomId)) throw new Error('unknown room');
      const all = transcript(roomId);
      const i = since ? all.findIndex(m => m.id === since) : -1;
      return all.slice(i + 1).map(m => ({ id: m.id, ts: m.ts, speaker: m.speaker, label: labelOf(roomId, m.speaker), kind: m.kind, text: m.text }));
    },
    setSummary(roomId, text) {
      if (!room(roomId)) throw new Error('unknown room');
      return store.append({ type: 'room_summary', room: roomId, text: scrub(String(text)).slice(0, 4000) });
    },
    seenIds: (roomId, memberId) => new Set(store.all().filter(x => x.type === 'room_seen' && x.room === roomId && x.member === memberId).flatMap(x => x.ids)),
    // What may be stored as this member's memory.
    memoryLines: (roomId, memberId) => transcript(roomId).filter(m => (m.memory_for || []).includes(memberId)).map(m => ({ id: m.id, speaker: m.speaker, text: m.text })),
    // A line is spoken only in its own speaker's voice; there is no way to ask for another member's voice.
    voiceFor(roomId, line) {
      const r = room(roomId);
      const m = r && line && r.members.find(x => x.id === line.speaker);
      return m && m.voice ? m.voice : null;
    },
    closedUntil: roomId => state(roomId).budget.closedUntil(),
  };
}

module.exports = { createEngine, normalize };
