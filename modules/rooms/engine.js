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

// A member with `engine` (and an `endpoint` block) is answered by an engine module,
// not by a harness task. Safe defaults: sees only lines addressed to it (+ context_lines
// before them, default 6), never the lead unless lead_eligible, keeps no text in the
// journal or room store unless journal_text, never keeps room lines as memory.
function external(m) {
  if (typeof m.engine !== 'string' || !m.engine) return m;
  const e = m.endpoint && typeof m.endpoint === 'object' ? m.endpoint : {};
  return { ...m, bot: null, noRoomMemory: true, neverLead: e.lead_eligible !== true, addressedOnly: e.sees !== 'all',
    contextLines: Number.isInteger(e.context_lines) && e.context_lines >= 0 ? e.context_lines : 6,
    journalText: e.journal_text === true, voice: typeof e.voice === 'string' && e.voice ? e.voice : m.voice };
}
const EMOTIONS = new Set(['neutral', 'happy', 'sad', 'angry', 'surprised', 'calm', 'excited', 'worried', 'tender', 'playful']);

// rooms: { id: { lead?, window?, members: [{id, name?, bot?, voice?, neverLead?, noRoomMemory?, addressedOnly?, window?, contextLines?}] } }
function normalize(rooms) {
  const out = {}, problems = [];
  for (const [id, r] of Object.entries(rooms || {})) {
    // Room ids must be word characters or "-": the device allowlist only matches that shape (fail closed).
    if (!/^[\w-]+$/.test(id)) { problems.push(`room ${JSON.stringify(id)}: id must match [A-Za-z0-9_-]+ (room skipped)`); continue; }
    const members = (Array.isArray(r && r.members) ? r.members : []).filter(m => m && typeof m.id === 'string' && m.id)
      .map(m => external({ ...m, name: String(m.name || m.id), bot: m.bot === undefined ? m.id : m.bot }));
    if (new Set(members.map(m => m.id.toLowerCase())).size !== members.length) problems.push(`room ${id}: duplicate member id`);
    let lead = (r && r.lead) || null;
    const lm = members.find(m => m.id === lead);
    if (lead && !lm) { problems.push(`room ${id}: lead "${lead}" is not a member (room has no lead)`); lead = null; }
    else if (lm && (lm.neverLead || lm.addressedOnly)) { problems.push(`room ${id}: member "${lead}" is flagged never-lead (room has no lead)`); lead = null; }
    out[id] = { id, ...(typeof r.name === 'string' && r.name.trim() ? { name: r.name.trim().slice(0, 80) } : {}), lead, window: Number.isInteger(r.window) && r.window >= 0 ? r.window : DEFAULT_WINDOW, members };
  }
  // A voice id held by an engine member belongs to it alone: every other member loses it.
  const owner = new Map();
  for (const r of Object.values(out)) for (const m of r.members) if (m.engine && m.voice && !owner.has(m.voice)) owner.set(m.voice, r.id + '/' + m.id);
  for (const r of Object.values(out)) for (const m of r.members) {
    if (m.voice && owner.has(m.voice) && owner.get(m.voice) !== r.id + '/' + m.id) { problems.push(`room ${r.id}: member "${m.id}" uses a voice reserved for "${owner.get(m.voice)}" (voice removed)`); delete m.voice; }
  }
  return { rooms: out, problems, voiceOwner: owner };
}

function createEngine({ rooms, store, deliver, now = Date.now, humanLabel = 'human', maxHopTargets = 3 }) {
  let norm = normalize(rooms);
  const st = new Map();
  const state = id => { if (!st.has(id)) st.set(id, { queue: [], current: null, gen: 0, drain: null, inflight: new Set(), budget: createBudget(now), floorUntil: 0 }); return st.get(id); };
  const room = id => norm.rooms[id] || null;
  const canUse = (voice, roomId, memberId) => !norm.voiceOwner.has(voice) || norm.voiceOwner.get(voice) === roomId + '/' + memberId;
  // Text of members flagged journalText:false lives only here, in this process; the store keeps metadata.
  const live = new Map();
  const withText = r => (r.text_kept === false ? { ...r, text: live.has(r.id) ? live.get(r.id) : '[text not kept]' } : r);
  const rawLines = id => store.all().filter(r => r.type === 'room_msg' && r.room === id);
  const transcript = id => rawLines(id).map(withText);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Who may keep a line as memory. A member flagged noRoomMemory keeps only its
  // own exchanges with the human: lines addressed to it, and its replies to those.
  const memoryFor = (r, { addressed = [], speaker = null, humanTurn = false }) =>
    r.members.filter(m => !m.noRoomMemory || addressed.includes(m.id) || (humanTurn && speaker === m.id)).map(m => m.id);

  const refuseBase = (member, reason, extra) => ({ posted: false, reason, member: member.id, ...extra });

  async function runTurn(r, s, turn) {
    const member = r.members.find(m => m.id === turn.member);
    if (!member || turn.gen !== s.gen) return null;
    // A turn that is not posted leaves a small record (no text) so drops are visible.
    const refuse = (m, reason, extra) => { store.append({ type: 'room_turn_skipped', room: r.id, member: m.id, reason }); return refuseBase(m, reason, extra); };
    const msgs = transcript(r.id);
    const trigger = msgs.find(m => m.id === turn.trigger);
    const summaries = store.all().filter(x => x.type === 'room_summary' && x.room === r.id);
    // An engine member gets the original lines as they are; a summary never stands in for them.
    const ctx = buildContext({ room: r, member, messages: msgs, trigger, summary: !member.engine && summaries.length ? summaries[summaries.length - 1].text : null, humanLabel });
    store.append({ type: 'room_seen', room: r.id, member: member.id, ids: ctx.seen });
    let raw;
    const ac = new AbortController();
    s.inflight.add(ac);
    try {
      // While the owner is still speaking (floor held), no bot takes the floor.
      while (now() < s.floorUntil && turn.gen === s.gen) await sleep(25);
      if (turn.gen !== s.gen) return refuse(member, 'stale');
      raw = await deliver({ room: r.id, member, prompt: ctx.prompt, messages: ctx.messages, lines: ctx.lines, mentions: ctx.mentions, trigger: ctx.trigger, via: turn.via || (turn.hop ? 'hop' : null), signal: ac.signal });
    } catch (e) {
      if (turn.gen === s.gen && e && e.unavailable) {
        const rec = store.append({ type: 'room_msg', room: r.id, speaker: 'system', kind: 'system', text: scrub(String(e.message || 'unavailable')).slice(0, 200), reply_to: turn.trigger, memory_for: [] });
        return refuse(member, 'unavailable', { id: rec.id });
      }
      return refuse(member, 'delivery failed');
    } finally { s.inflight.delete(ac); }
    // The owner may have started speaking while the reply was coming: wait (bounded) for the floor, then recheck gen.
    const floorT0 = now();
    while (now() < s.floorUntil && turn.gen === s.gen && now() - floorT0 < 20000) await sleep(25);
    // A dropped engine reply leaves a journal record (never its text) so the member's side can see it was dropped.
    const dropped = (reason, why) => { if (member.engine) store.append({ type: 'room_event', kind: 'reply_dropped', event: 'reply_dropped', room: r.id, member: member.id, reason: why, at: new Date(now()).toISOString() }); return refuse(member, reason); };
    if (now() < s.floorUntil && turn.gen === s.gen) return dropped('floor', 'floor_held');
    if (turn.gen !== s.gen) return dropped('stale', 'human_spoke'); // the human spoke meanwhile: nothing stale is delivered
    let cue = null;
    if (raw && typeof raw === 'object') { // { text, voice?, emotion? } from an engine
      // A reply voice is kept only if it is the member's own configured voice; otherwise ignored.
      cue = { voice: member.voice && raw.voice === member.voice ? member.voice : null, emotion: typeof raw.emotion === 'string' && EMOTIONS.has(raw.emotion) ? raw.emotion : null };
      // intensity rides with a kept emotion only: a finite number, clamped to [0,1]
      cue.intensity = cue.emotion && typeof raw.intensity === 'number' && Number.isFinite(raw.intensity) ? Math.min(1, Math.max(0, raw.intensity)) : null;
      raw = raw.text;
    }
    if (isPass(raw)) return refuse(member, 'pass');
    const bad = impersonation(raw, member, r);
    if (bad) return refuse(member, 'impersonation', { detail: bad });
    const text = scrub(String(raw).trim(), { pii: !!member.noRoomMemory });
    const keep = member.engine ? member.journalText : true;
    const verdict = s.budget.check(member.id, text);
    if (!verdict.ok) {
      if (verdict.tripped) store.append({ type: 'room_event', room: r.id, event: 'closed', limit: verdict.reason, until: new Date(verdict.until).toISOString() });
      return refuse(member, verdict.reason);
    }
    const humanTurn = !!(trigger && trigger.kind === 'human');
    const meta = keep ? {} : { text_kept: false, text_len: text.length };
    const rec = store.append({ type: 'room_msg', room: r.id, speaker: member.id, kind: 'bot', text: keep ? text : '', reply_to: turn.trigger,
      memory_for: memoryFor(r, { speaker: member.id, humanTurn }), ...meta, ...(keep && cue && cue.emotion ? { emotion: cue.emotion, ...(cue.intensity !== null ? { intensity: cue.intensity } : {}) } : {}), ...(cue && cue.voice ? { voice: cue.voice } : {}) });
    if (!keep) { live.set(rec.id, text); if (live.size > 200) live.delete(live.keys().next().value); }
    s.budget.record(member.id, text);
    if (turn.hop === 0) { // at most one follow-up hop: replies to a hop turn wake nobody
      const hop = route(text, r, { sender: member.id, fromBot: true }).ids.slice(0, maxHopTargets);
      for (const id of hop) s.queue.push({ member: id, trigger: rec.id, hop: 1, via: 'hop', gen: s.gen });
    }
    return { posted: true, id: rec.id, member: member.id };
  }

  function drain(r, s) {
    if (s.drain) return s.drain;
    s.drain = (async () => {
      const results = [];
      while (s.queue.length) {
        const turn = s.queue.shift();
        s.current = turn.member;
        let res;
        try { res = await runTurn(r, s, turn); } finally { s.current = null; }
        if (res) results.push(res);
      }
      return results;
    })().finally(() => { s.drain = null; });
    return s.drain;
  }

  const labelOf = (roomId, sp) => (sp === 'human' ? humanLabel : ((room(roomId).members.find(x => x.id === sp) || {}).name || sp));

  return {
    get problems() { return norm.problems; },
    // Swap the room table at run time (rooms from a source module); queues, budgets and transcripts of kept rooms stay.
    setRooms(next) { norm = normalize(next); },
    rooms: () => Object.values(norm.rooms).map(r => ({ id: r.id, ...(r.name ? { name: r.name } : {}), lead: r.lead, window: r.window,
      members: r.members.map(m => ({ id: m.id, name: m.name, neverLead: !!m.neverLead, noRoomMemory: !!m.noRoomMemory, addressedOnly: !!m.addressedOnly })) })),
    // The human speaks: every pending bot turn is flushed first, then the line is stored and routed.
    async say(roomId, text, opts = {}) {
      const r = room(roomId);
      if (!r) throw new Error('unknown room');
      if (typeof text !== 'string' || !text.trim()) throw new Error('text required');
      const s = state(roomId);
      s.gen++; s.queue.length = 0; s.floorUntil = 0;
      for (const ac of s.inflight) ac.abort(); // a turn still running is stopped, not just ignored
      const routed = route(text, r);
      const rec = store.append({ type: 'room_msg', room: r.id, speaker: 'human', kind: 'human', text: scrub(text.trim()), woke: routed.ids, ...(opts && opts.type === 'voice_transcript' ? { input: 'voice_transcript' } : {}),
        memory_for: memoryFor(r, { addressed: routed.ids }) });
      for (const id of routed.ids) s.queue.push({ member: id, trigger: rec.id, hop: 0, via: routed.kind, gen: s.gen });
      const results = await drain(r, s);
      return { id: rec.id, routed: routed.kind, woke: routed.ids, results };
    },
    messages(roomId, since) {
      if (!room(roomId)) throw new Error('unknown room');
      const all = transcript(roomId);
      const i = since ? all.findIndex(m => m.id === since) : -1;
      return all.slice(i + 1).map(m => ({ id: m.id, ts: m.ts, speaker: m.speaker, label: labelOf(roomId, m.speaker), kind: m.kind, text: m.text, ...(m.emotion ? { emotion: m.emotion, ...(typeof m.intensity === 'number' ? { intensity: m.intensity } : {}) } : {}) }));
    },
    // Read-only view for UIs: who is answering, who waits, the lead and whether the owner holds the floor.
    status(roomId) {
      const r = room(roomId);
      if (!r) throw new Error('unknown room');
      const s = state(roomId);
      const queue = s.queue.map(t => t.member);
      return { busy: !!s.drain || s.current !== null || queue.length > 0, speaker: s.current, queue, lead: r.lead, floor: now() < s.floorUntil };
    },
    setSummary(roomId, text) {
      if (!room(roomId)) throw new Error('unknown room');
      return store.append({ type: 'room_summary', room: roomId, text: scrub(String(text)).slice(0, 4000) });
    },
    seenIds: (roomId, memberId) => new Set(store.all().filter(x => x.type === 'room_seen' && x.room === roomId && x.member === memberId).flatMap(x => x.ids)),
    // What may be stored as this member's memory.
    memoryLines: (roomId, memberId) => rawLines(roomId).filter(m => (m.memory_for || []).includes(memberId)).map(m => ({ id: m.id, speaker: m.speaker, text: m.text })),
    // A line is spoken only in its own speaker's voice; there is no way to ask for another member's voice.
    voiceFor(roomId, line) {
      const r = room(roomId);
      const m = r && line && r.members.find(x => x.id === line.speaker);
      return m && m.voice && canUse(m.voice, roomId, m.id) ? m.voice : null;
    },
    // The owner is speaking (client VAD): hold every bot turn in this room until released or ttlMs passes.
    holdFloor(roomId, speaking, ttlMs = 15000) { if (!room(roomId)) throw new Error('unknown room'); state(roomId).floorUntil = speaking ? now() + ttlMs : 0; },
    // A voice held by an engine member is usable by that member only.
    canUseVoice: (voice, memberId, roomId) => canUse(voice, roomId, memberId),
    closedUntil: roomId => state(roomId).budget.closedUntil(),
  };
}

module.exports = { createEngine, normalize };
