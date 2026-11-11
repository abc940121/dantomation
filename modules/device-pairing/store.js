'use strict';
// device-pairing store: pending pairing codes, device records, the route allowlist.
// Plain files under state/m/device-pairing/, written atomically. The CLI (mint, list,
// revoke) and the server (redeem, authenticate) are different processes, so every
// call re-reads the files: a revoke takes effect on the next request.
// Nothing here ever stores a code or a token, only their SHA-256 digests.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const J = require('../../lib/journal');

const CODE_TTL_MS = 2 * 60 * 1000;   // a pairing code lives 2 minutes
const MAX_FAILS = 5;                 // wrong guesses before every pending code is wiped
const LOCK_MS = 30 * 1000;           // redeem is refused this long after a lockout
const DEVICE_TTL_MS = 30 * 24 * 3600 * 1000; // sliding: a device unused this long must pair again
const SEEN_EVERY_MS = 60 * 1000;     // last-seen is written at most this often per device
const MAX_DEVICES = 50;
const HANDOFF_TTL_MS = 10 * 60 * 1000; // a handoff code (home-screen app) lives 10 minutes
const HANDOFF_MAX = 5, HANDOFF_WINDOW_MS = 3600 * 1000; // at most 5 handoff mints per device per hour

const dir = () => path.join(J.STATE, 'm', 'device-pairing');
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
function read(name, dflt) { try { return JSON.parse(fs.readFileSync(path.join(dir(), name), 'utf8')); } catch { return dflt; } }
let heldLock = null; // { path, nonce } while this process is inside withLock
const lockOwned = h => { try { return JSON.parse(fs.readFileSync(h.path, 'utf8')).nonce === h.nonce; } catch { return false; } };
// devices.json, pending.json and handoff.json are only written while this process holds the lock
// (a read-modify-write that was not under withLock could undo another process's change). seen.json
// is informational last-seen data and is exempt: last writer wins, no security effect.
function write(name, v) {
  if (name !== 'seen.json' && !heldLock) throw new Error(`device-pairing store: ${name} written without holding the store lock`);
  fs.mkdirSync(dir(), { recursive: true });
  const f = path.join(dir(), name), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
  // Inside withLock: only rename while the lock is still ours. A lost lock means another
  // process may have written since we read, so a late write-back must not land (callers fail closed).
  if (heldLock && !lockOwned(heldLock)) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw new Error('device-pairing store lock was lost; write refused'); }
  fs.renameSync(tmp, f);
}
// Cross-process lock for every read-modify-write. store.lock is created with its content ({ pid, nonce })
// already in it (a temp file linked into place, EEXIST = held), so an empty lock cannot exist. A
// waiter gives up after LOCK_WAIT_MS and fails closed (busy); a lock acquired after that point is
// released again and the caller gets busy. The holder is dead only when process.kill(pid, 0) says
// ESRCH; any other answer (alive, EPERM, ...) is live, so a reused pid keeps the store busy (manual way
// out: stop the server, delete store.lock). A dead holder's lock is removed only under a second
// exclusive file, store.lock.reclaim, which is never reclaimed automatically; under it the lock is
// re-read and removed only if it is still the dead holder we saw. A lock that cannot be parsed fails
// closed with an error naming the file. Release removes the file only while it still holds our nonce.
const LOCK_WAIT_MS = 3 * 1000;
const nap = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pidDead = pid => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
function reclaim(lock, seen) {
  const rl = `${lock}.reclaim`;
  try { fs.closeSync(fs.openSync(rl, 'wx', 0o600)); } catch { return; } // someone else is reclaiming, or a crashed one left it: wait
  try {
    let info; try { info = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { return; }
    if (info && info.nonce === seen.nonce && pidDead(info.pid) && pidDead(seen.pid)) { try { fs.unlinkSync(lock); } catch { /* ignore */ } }
  } finally { try { fs.unlinkSync(rl); } catch { /* ignore */ } }
}
function withLock(fn) {
  fs.mkdirSync(dir(), { recursive: true });
  const lock = path.join(dir(), 'store.lock');
  const t0 = Date.now(), nonce = crypto.randomBytes(12).toString('hex');
  const tmp = `${lock}.${process.pid}.${nonce}.new`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 });
  const mine = { path: lock, nonce }, release = () => { if (lockOwned(mine)) { try { fs.unlinkSync(lock); } catch { /* ignore */ } } };
  try {
    for (let wait = 2; ; wait = Math.min(wait * 2, 50)) {
      try { fs.linkSync(tmp, lock); break; }
      catch (e) {
        if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
        if (Date.now() - t0 > LOCK_WAIT_MS) throw new Error('device-pairing store is busy');
        let info;
        try { info = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch (e2) { if (e2.code === 'ENOENT') continue; info = null; }
        if (!info || !Number.isInteger(info.pid) || typeof info.nonce !== 'string') throw new Error(`device-pairing store lock ${lock} cannot be read; remove it once no taskmote process is running`);
        if (pidDead(info.pid)) { reclaim(lock, info); continue; }
        nap(wait);
      }
    }
  } finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
  if (Date.now() - t0 > LOCK_WAIT_MS) { release(); throw new Error('device-pairing store is busy'); }
  const prev = heldLock;
  heldLock = mine;
  try { return fn(); } finally { heldLock = prev; release(); }
}
const journal = rec => { try { J.append({ ...rec, module: 'device-pairing' }); } catch { /* the audit trail must not break a request */ } };
const pending = () => { const p = read('pending.json', null); return p && Array.isArray(p.codes) ? { fails: 0, lockedUntil: 0, ...p } : { codes: [], fails: 0, lockedUntil: 0 }; };
const devices = () => { const d = read('devices.json', null); return Array.isArray(d) ? d : []; };

function cleanLabel(l) {
  const s = typeof l === 'string' ? l.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 40) : '';
  return s || 'phone';
}
const normShort = c => String(c).replace(/[\s-]/g, '');

// Owner action. -> { code, short, expiresAt }. The long code is for the QR or link, the six
// digits are the typed fallback; either one redeems the same single pairing.
function mintCode(now = Date.now()) { return withLock(() => mintLocked(now)); }
function mintLocked(now) {
  return mintCodeLocked(now, null);
}
// opts null: an ordinary owner code (long + six digits, 2 minutes). opts {parent, ttl}: a handoff code, long form only,
// tied to the device that asked for it. The six-digit slot gets a random digest nothing can match.
function mintCodeLocked(now, opts) {
  const p = pending();
  p.codes = p.codes.filter(c => c.exp > now);
  const ttl = opts ? opts.ttl : CODE_TTL_MS;
  let short;
  do { short = String(crypto.randomInt(0, 1000000)).padStart(6, '0'); } while (p.codes.some(c => same(Buffer.from(c.short, 'hex'), sha(short))));
  const code = 'pc_' + crypto.randomBytes(24).toString('base64url');
  p.codes.push({ id: crypto.randomBytes(4).toString('hex'), long: sha(code).toString('hex'), short: opts ? crypto.randomBytes(32).toString('hex') : sha(short).toString('hex'), exp: now + ttl, ...(opts ? { handoff: true } : {}), ...(opts && opts.parent ? { parent: opts.parent } : {}) });
  if (!opts) p.fails = 0; // a fresh pairing: the guess counter starts over (an active lockout still stands)
  write('pending.json', p);
  if (!opts) journal({ type: 'device_code_minted', expires_at: new Date(now + ttl).toISOString() });
  return opts ? { code, expiresAt: new Date(now + ttl).toISOString() } : { code, short, expiresAt: new Date(now + ttl).toISOString() };
}

// Caller: a paired device (by) or the owner (by null). -> { ok: true, code, expiresAt } or { ok: false, status, error }.
// A device that was itself made from a handoff cannot make another (depth 1). The code is never logged or journaled.
function mintHandoff(by, now = Date.now()) {
  try { return withLock(() => handoffLocked(by, now)); }
  catch { return { ok: false, status: 503, error: 'pairing is busy; try again' }; }
}
function handoffLocked(by, now) {
  const key = by ? String(by) : 'owner';
  if (by) {
    const dev = devices().find(d => d.id === String(by));
    if (!dev || dev.revoked) return { ok: false, status: 403, error: 'forbidden' };
    if (dev.parent || dev.handoff) return { ok: false, status: 403, error: 'a device made from a handoff cannot make another' };
  }
  const log = read('handoff.json', {});
  const recent = (Array.isArray(log[key]) ? log[key] : []).filter(t => now - t < HANDOFF_WINDOW_MS);
  if (recent.length >= HANDOFF_MAX) { journal({ type: 'device_handoff_limited', device_id: key }); return { ok: false, status: 429, error: 'too many handoff codes this hour; try again later' }; }
  const m = mintCodeLocked(now, { parent: by ? String(by) : null, ttl: HANDOFF_TTL_MS });
  recent.push(now); log[key] = recent;
  for (const k of Object.keys(log)) if (k !== key) { log[k] = (Array.isArray(log[k]) ? log[k] : []).filter(t => now - t < HANDOFF_WINDOW_MS); if (!log[k].length) delete log[k]; }
  write('handoff.json', log);
  journal({ type: 'device_handoff_minted', device_id: key });
  return { ok: true, code: m.code, expiresAt: m.expiresAt };
}

// Phone action. -> { ok: true, token, id, label } or { ok: false, status, error }.
function redeem(code, label, now = Date.now()) {
  try { return withLock(() => redeemLocked(code, label, now)); }
  catch { return { ok: false, status: 503, error: 'pairing is busy; try again' }; }
}
function redeemLocked(code, label, now) {
  const p = pending();
  if (now < p.lockedUntil) return { ok: false, status: 429, error: 'too many wrong codes; ask the owner for a new code and try again shortly' };
  if (typeof code !== 'string' || !code || code.length > 80) return fail(p, now);
  const h = sha(/^[\d\s-]+$/.test(code) ? normShort(code) : code.trim());
  let hit = null;
  for (const c of p.codes) { // no early exit: every entry is compared
    const a = same(h, Buffer.from(c.long, 'hex')), b = same(h, Buffer.from(c.short, 'hex'));
    if ((a || b) && c.exp > now && !hit) hit = c;
  }
  if (!hit) return fail(p, now);
  if (hit.parent) { const pd = devices().find(d => d.id === hit.parent); if (!pd || pd.revoked) { p.codes = p.codes.filter(c => c !== hit && c.exp > now); write('pending.json', p); return { ok: false, status: 401, error: 'wrong or expired code' }; } }
  if (devices().filter(d => !d.revoked).length >= MAX_DEVICES) return { ok: false, status: 409, error: 'too many devices; revoke one first' };
  p.codes = p.codes.filter(c => c !== hit && c.exp > now); // single use: spent before the token is made
  if (!hit.handoff) p.fails = 0; // only an ordinary pairing resets the guess counter; a handoff redeem must not
  write('pending.json', p);
  const id = crypto.randomBytes(4).toString('hex');
  const token = `dvt_${id}.${crypto.randomBytes(32).toString('base64url')}`;
  const rec = { id, label: cleanLabel(label), hash: sha(token).toString('hex'), created: new Date(now).toISOString(), revoked: false, ...(hit.handoff ? { handoff: true } : {}), ...(hit.parent ? { parent: hit.parent } : {}) };
  write('devices.json', [...devices(), rec]);
  journal({ type: 'device_paired', device_id: id, label: rec.label, ...(hit.parent ? { parent: hit.parent } : {}) });
  return { ok: true, token, id, label: rec.label };
}
function fail(p, now) {
  p.fails = (p.fails || 0) + 1;
  if (p.fails >= MAX_FAILS) { p.codes = []; p.fails = 0; p.lockedUntil = now + LOCK_MS; journal({ type: 'device_pair_lockout' }); }
  write('pending.json', p);
  return { ok: false, status: 401, error: 'wrong or expired code' };
}

// -> { id, label } for a live device token, else null. Never throws.
function authenticate(token, now = Date.now()) {
  try {
    const m = /^dvt_([0-9a-f]{8})\.[\w-]{20,100}$/.exec(String(token));
    const h = sha(token);
    let dev = null;
    const all = devices();
    for (const d of all) if (same(h, Buffer.from(d.hash, 'hex')) && m && d.id === m[1]) dev = d;
    if (!dev || dev.revoked) return null;
    if (dev.parent) { const pd = all.find(d => d.id === dev.parent); if (!pd || pd.revoked) return null; } // a handoff child needs its parent live
    const seen = read('seen.json', {});
    const last = Date.parse(seen[dev.id] || dev.created);
    if (now - last > DEVICE_TTL_MS) return null;
    if (!seen[dev.id] || now - last > SEEN_EVERY_MS) { seen[dev.id] = new Date(now).toISOString(); write('seen.json', seen); }
    return { id: dev.id, label: dev.label };
  } catch { return null; }
}

function list(now = Date.now()) {
  const seen = read('seen.json', {});
  return devices().map(d => {
    const last = seen[d.id] || null;
    return { id: d.id, label: d.label, created: d.created, lastSeen: last, revoked: !!d.revoked, ...(d.parent ? { parent: d.parent } : {}), expired: now - Date.parse(last || d.created) > DEVICE_TTL_MS };
  });
}
function revoke(id) { return withLock(() => revokeLocked(id)); }
function revokeLocked(id) {
  const all = devices();
  const hit = all.find(d => d.id === String(id));
  if (!hit) return false;
  // The device and every handoff child go in ONE write, and a repeat revoke still sweeps the children,
  // so a crash or a lost write is repaired by revoking again.
  const at = new Date().toISOString(), marked = [];
  for (const d of all) if ((d === hit || d.parent === hit.id) && !d.revoked) { d.revoked = true; d.revokedAt = at; marked.push(d); }
  if (marked.length) {
    write('devices.json', all);
    for (const d of marked) journal({ type: 'device_revoked', device_id: d.id, label: d.label, ...(d === hit ? {} : { parent: hit.id }) });
  }
  return true;
}

// Deny by default. A device token may do exactly this: read the roster, tasks, cards, status
// and the event stream; send chat; answer an approval card; stop a task; talk to voice-chat; read rooms and speak in one (never the summary); use the app-ui module's snapshot, config, questions
// and bot-message routes (never its bot settings, and never creating a question).
// No task creation outside chat, undo, resume, config, module settings, worker routes,
// pairing admin, or any other module route.
const ALLOW = [
  ['GET', /^\/api\/(bots|tasks|cards|status|events)$/],
  ['GET', /^\/api\/tasks\/[\w-]+$/],
  ['POST', /^\/api\/chat$/],
  ['POST', /^\/m\/device-pairing\/handoff$/], // a paired device asks for a 10-minute code to carry into the home-screen app (depth 1, 5 an hour)
  ['POST', /^\/api\/cards\/card-[0-9a-f]+$/i],
  ['POST', /^\/api\/tasks\/[\w-]+\/stop$/],
  ['POST', /^\/m\/voice-chat\/(utterance|poll|playback)$/],
  ['GET', /^\/m\/rooms\/rooms$/],
  ['GET', /^\/m\/rooms\/rooms\/[\w-]+\/messages$/],
  ['POST', /^\/m\/rooms\/rooms\/[\w-]+\/say$/],
  ['GET', /^\/m\/rooms\/rooms\/[\w-]+\/status$/],
  ['GET', /^\/m\/app-ui\/api\/(snapshot|config|instances|questions)$/],
  ['GET', /^\/m\/app-ui\/api\/bots\/[\w-]+\/messages$/],
  ['GET', /^\/m\/app-ui\/api\/questions\/[\w-]+$/],
  ['POST', /^\/m\/app-ui\/api\/bots\/[\w-]+\/messages$/],
  ['POST', /^\/m\/app-ui\/api\/config$/],
  ['POST', /^\/m\/app-ui\/api\/questions\/[\w-]+\/answer$/],
  // question-cards: list pending questions and answer one (the undo card); never ask, cancel or read history
  ['GET', /^\/m\/question-cards\/questions$/],
  ['POST', /^\/m\/question-cards\/questions\/[\w-]+\/answer$/],
  // roles: make a group chat from the chat page (create only; the route validates and journals who made it)
  ['POST', /^\/m\/roles\/groups$/],
  ['GET', /^\/m\/roles\/main$/],
  // roles: make a role from the chat page (create only; the route validates, takes only name, job and an optional picture, and caps the total)
  ['POST', /^\/m\/roles\/roles$/],
  // roles: read a role's card and avatar (read-only; editing a card is done from the computer)
  ['GET', /^\/m\/roles\/avatar\/r-[0-9a-f]{8}$/],
  ['GET', /^\/m\/roles\/cards\/r-[0-9a-f]{8}$/],
];
const allows = (method, p) => ALLOW.some(([m, re]) => m === method && re.test(String(p)));

// One journal line per state-changing call, naming the device (the owner's calls carry no such line).
function audit(device, method, p) { journal({ type: 'device_action', device_id: device.id, label: device.label, method, path: String(p).slice(0, 200) }); }

module.exports = { withLock, mintCode, mintHandoff, HANDOFF_TTL_MS, HANDOFF_MAX, redeem, authenticate, list, revoke, allows, audit, CODE_TTL_MS, MAX_FAILS, LOCK_MS, DEVICE_TTL_MS, dir, _write: write, _reclaim: reclaim };
