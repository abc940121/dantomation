'use strict';
// Schedule parsing for routines. Two forms, both small and total:
//   "every 30s|15m|2h|1d"            interval (min 10 s, max 31 days)
//   "m h dom mon dow" (5 fields)     cron subset, evaluated in UTC: * , - / only; dow 0-7 (0 and 7 = Sunday)
// No names, no L/W/#, no seconds. Anything else is a parse error.
const FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const UNIT = { s: 1, m: 60, h: 3600, d: 86400 };
const MAX_INTERVAL_S = 31 * 86400, MIN_INTERVAL_S = 10;
const SCAN_MINUTES = 31 * 24 * 60; // longest catch-up window scanned for a cron match

function parseField(src, lo, hi) {
  const set = new Set();
  for (const part of src.split(',')) {
    const m = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) throw new Error(`bad cron field "${src.slice(0, 20)}"`);
    let a, b;
    if (m[1] === '*') { a = lo; b = hi; }
    else if (m[1].includes('-')) { [a, b] = m[1].split('-').map(Number); }
    else { a = Number(m[1]); b = m[2] ? hi : a; }
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1 || a < lo || b > hi || a > b) throw new Error(`cron field out of range "${src.slice(0, 20)}"`);
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return set;
}

function parse(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 100) throw new Error('schedule must be a short string');
  const t = text.trim().replace(/\s+/g, ' ');
  const iv = /^every (\d{1,6})([smhd])$/.exec(t);
  if (iv) {
    const s = Number(iv[1]) * UNIT[iv[2]];
    if (s < MIN_INTERVAL_S || s > MAX_INTERVAL_S) throw new Error(`interval must be ${MIN_INTERVAL_S} s to 31 d`);
    return { kind: 'interval', every_s: s, text: t };
  }
  const parts = t.split(' ');
  if (parts.length !== 5) throw new Error('schedule is "every <n><s|m|h|d>" or 5 cron fields');
  const sets = parts.map((p, i) => parseField(p, FIELDS[i][0], FIELDS[i][1]));
  if (sets[4].has(7)) { sets[4].add(0); sets[4].delete(7); }
  return { kind: 'cron', sets, dom_star: parts[2] === '*', dow_star: parts[4] === '*', text: t };
}

function matches(p, d) {
  const [mi, h, dom, mon, dow] = p.sets;
  if (!mi.has(d.getUTCMinutes()) || !h.has(d.getUTCHours()) || !mon.has(d.getUTCMonth() + 1)) return false;
  const a = dom.has(d.getUTCDate()), b = dow.has(d.getUTCDay());
  return p.dom_star || p.dow_star ? (a && b) : (a || b); // standard cron: both restricted = either
}

// Was any cron minute in (after, upTo] a match? Scans at most 31 days back from upTo.
function cronDue(p, after, upTo) {
  const end = Math.floor(upTo / 60000) * 60000;
  let start = Math.floor(after / 60000) * 60000 + 60000;
  if (end - start > SCAN_MINUTES * 60000) start = end - SCAN_MINUTES * 60000;
  for (let t = start; t <= end; t += 60000) if (matches(p, new Date(t))) return true;
  return false;
}

module.exports = { parse, cronDue, MIN_INTERVAL_S };
