'use strict';
// Bot-post limits for one room. The caller writes a post to the transcript only
// after check() says ok, and calls record() once it has. A refused attempt is
// never recorded. Any tripped limit closes the room to bot posts for CLOSE_MS.
const DUP_MS = 60000, RATE_MS = 60000, RATE_MAX = 10, RING_MS = 120000, CLOSE_MS = 300000;
const norm = s => String(s).trim().replace(/\s+/g, ' ').toLowerCase();

function createBudget(now = Date.now) {
  let events = [], closedUntil = 0;
  const prune = t => { events = events.filter(e => t - e.t <= RING_MS); };
  const trip = (limit, t) => { closedUntil = t + CLOSE_MS; return { ok: false, reason: limit, tripped: true, until: closedUntil }; };
  return {
    check(speaker, text) {
      const t = now();
      if (t < closedUntil) return { ok: false, reason: 'closed', until: closedUntil };
      prune(t);
      const k = norm(text);
      if (events.some(e => t - e.t <= DUP_MS && e.key === k)) return trip('duplicate', t);
      if (events.filter(e => t - e.t <= RATE_MS).length >= RATE_MAX) return trip('rate', t);
      const last = events.slice(-3).map(e => e.speaker);
      if (last.length === 3 && new Set(last).size === 3 && last[0] === speaker) return trip('ring', t);
      return { ok: true };
    },
    record(speaker, text) { events.push({ t: now(), speaker, key: norm(text) }); },
    closedUntil: () => closedUntil,
    isClosed: () => now() < closedUntil,
  };
}

module.exports = { createBudget, DUP_MS, RATE_MS, RATE_MAX, RING_MS, CLOSE_MS };
