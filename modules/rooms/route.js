'use strict';
// Fixed local routing. No model, no cloud: @everyone, then unambiguous @mentions,
// then the room's lead (a room may have none), else nobody.
const EVERYONE = 'everyone';

// Code spans and fenced blocks are masked so a quoted "@name" does not wake anyone.
const maskCode = s => String(s).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');

function mentionTokens(text) {
  const out = [];
  const re = /(^|[^\w@])@([A-Za-z0-9_][A-Za-z0-9_.-]*)/g;
  let m;
  while ((m = re.exec(maskCode(text)))) out.push(m[2].replace(/[.-]+$/, '').toLowerCase());
  return out;
}

// token -> ids of every member whose id or name equals it (case-insensitive).
function candidates(token, members) {
  const ids = new Set();
  for (const m of members) if (m.id.toLowerCase() === token || String(m.name).toLowerCase() === token) ids.add(m.id);
  return [...ids];
}

// Unambiguous mentions only: a token that names two members (a same-name tie) is dropped.
function mentioned(text, members) {
  const ids = [];
  for (const t of mentionTokens(text)) {
    if (t === EVERYONE) continue;
    const c = candidates(t, members);
    if (c.length === 1 && !ids.includes(c[0])) ids.push(c[0]);
  }
  return ids;
}

function leadOf(room) {
  const m = room.members.find(x => x.id === room.lead);
  return m && !m.neverLead && !m.addressedOnly ? m : null;
}

// -> { kind: 'everyone'|'mention'|'lead'|'none', ids: [member id, in room order] }
// opts.sender: a bot id whose own wake is skipped. opts.fromBot: bot text never uses @everyone or the lead.
function route(text, room, opts = {}) {
  const others = room.members.filter(m => m.id !== opts.sender);
  const inOrder = ids => room.members.filter(m => ids.includes(m.id) && m.id !== opts.sender).map(m => m.id);
  if (!opts.fromBot && mentionTokens(text).includes(EVERYONE)) return { kind: 'everyone', ids: others.map(m => m.id) };
  const ids = inOrder(mentioned(text, room.members));
  if (ids.length) return { kind: 'mention', ids };
  if (opts.fromBot) return { kind: 'none', ids: [] };
  const lead = leadOf(room);
  return lead && lead.id !== opts.sender ? { kind: 'lead', ids: [lead.id] } : { kind: 'none', ids: [] };
}

module.exports = { route, mentioned, mentionTokens };
