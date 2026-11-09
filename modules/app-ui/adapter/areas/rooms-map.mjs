// Pure helpers for the rooms area: map the rooms module's JSON to the wire shapes the UI uses.
// Our own file (MIT). Shared by the browser bundle and the Node tests, so no imports and no I/O.
//
// Input shapes (modules/rooms):
//   room     {id, lead, window, members:[{id, name, neverLead, noRoomMemory, addressedOnly}]}
//   status   {busy, speaker, queue:[memberId], lead, floor}
//   message  {id, ts, speaker, label, kind: 'human'|'bot'|'system', text, emotion?}

/** Most messages one room keeps in the client. */
export const ROOM_MESSAGE_CAP = 500;
export const POLL_VISIBLE_MS = 3000;
export const POLL_BACKGROUND_MS = 15000;
export const POLL_MAX_MS = 60000;

const str = v => (typeof v === 'string' ? v : '');

/**
 * A room as the UI's group. Rooms are static config, so the name is the id.
 * @param {any} room
 * @param {any} [status]
 */
export function roomToWireGroup(room, status) {
  const members = (Array.isArray(room && room.members) ? room.members : []).filter(m => m && str(m.id)).map(m => ({
    id: String(m.id),
    name: str(m.name) || String(m.id),
    neverLead: !!m.neverLead,
    addressedOnly: !!m.addressedOnly,
  }));
  const ids = new Set(members.map(m => m.id));
  const s = status && typeof status === 'object' ? status : {};
  const queue = (Array.isArray(s.queue) ? s.queue : []).filter(id => typeof id === 'string' && ids.has(id));
  const speaker = typeof s.speaker === 'string' && ids.has(s.speaker) ? s.speaker : null;
  return {
    id: String(room.id),
    name: String(room.id),
    threadId: 'room:' + room.id,
    lead: room.lead && ids.has(room.lead) ? room.lead : null,
    members,
    busy: !!s.busy,
    speaker,
    queue,
    floor: !!s.floor,
  };
}

/**
 * A transcript line as a wire message. The id is stable across polls and reloads:
 * 'room:<roomId>:<messageId>' (the journal id never changes). The raw id stays in extra.rawId
 * because the server's ?since= cursor wants it.
 * @param {any} msg
 * @param {string} roomId
 */
export function roomMessageToWireMessage(msg, roomId) {
  const human = msg.kind === 'human' || msg.speaker === 'human';
  const created = Date.parse(str(msg.ts));
  return {
    id: 'room:' + roomId + ':' + msg.id,
    role: human ? 'user' : 'bot',
    kind: 'text',
    text: str(msg.text),
    ...(Number.isFinite(created) ? { createdAt: created } : {}),
    extra: {
      roomId,
      rawId: String(msg.id),
      speaker: str(msg.speaker),
      label: str(msg.label) || str(msg.speaker),
      lineKind: str(msg.kind) || (human ? 'human' : 'bot'),
      ...(msg.emotion ? { emotion: String(msg.emotion) } : {}),
    },
  };
}

/**
 * Add incoming messages to a list: a known id replaces its row in place, a new id goes on the end in the
 * order given. Keeps the last `cap` rows.
 * @template {{id: string}} T
 * @param {T[]|undefined} list
 * @param {T[]|undefined} incoming
 * @param {number} [cap]
 * @returns {T[]}
 */
export function mergeMessages(list, incoming, cap = ROOM_MESSAGE_CAP) {
  const out = (list || []).slice();
  const at = new Map(out.map((m, i) => [m.id, i]));
  for (const m of incoming || []) {
    if (!m || typeof m.id !== 'string') continue;
    const i = at.get(m.id);
    if (i === undefined) { at.set(m.id, out.length); out.push(m); } else out[i] = m;
  }
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/**
 * The ?since= cursor for a room's list: the raw id of its last message, or undefined.
 * @param {any[]|undefined} list
 * @returns {string|undefined}
 */
export function cursorOf(list) {
  const last = list && list[list.length - 1];
  return last && last.extra && typeof last.extra.rawId === 'string' ? last.extra.rawId : undefined;
}

/**
 * Milliseconds until the next poll: 3 s while a group is on screen, 15 s otherwise;
 * every consecutive failure doubles it, up to 60 s.
 * @param {boolean} visible
 * @param {number} failures
 */
export function pollDelay(visible, failures) {
  const base = visible ? POLL_VISIBLE_MS : POLL_BACKGROUND_MS;
  const n = Number.isFinite(failures) && failures > 0 ? Math.min(Math.floor(failures), 10) : 0;
  return Math.min(base * 2 ** n, POLL_MAX_MS);
}
