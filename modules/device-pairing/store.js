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

const dir = () => path.join(J.STATE, 'm', 'device-pairing');
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
function read(name, dflt) { try { return JSON.parse(fs.readFileSync(path.join(dir(), name), 'utf8')); } catch { return dflt; } }
function write(name, v) {
  fs.mkdirSync(dir(), { recursive: true });
  const f = path.join(dir(), name), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
// Cross-process lock for every read-modify-write: an exclusive lock file ('wx'), short
// backoff, a stale lock is broken after LOCK_STALE_MS. Failing to get it throws: callers
// refuse (fail closed) instead of writing without it.
const LOCK_STALE_MS = 10 * 1000, LOCK_WAIT_MS = 3 * 1000;
const nap = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withLock(fn) {
  fs.mkdirSync(dir(), { recursive: true });
  const lock = path.join(dir(), 'store.lock');
  const t0 = Date.now();
  let fd = null;
  for (let wait = 2; fd === null; wait = Math.min(wait * 2, 50)) {
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() - t0 > LOCK_WAIT_MS) throw new Error('device-pairing store is busy');
      nap(wait);
    }
  }
  try { return fn(); } finally { try { fs.closeSync(fd); } catch { /* ignore */ } try { fs.unlinkSync(lock); } catch { /* ignore */ } }
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
  const p = pending();
  p.codes = p.codes.filter(c => c.exp > now);
  let short;
  do { short = String(crypto.randomInt(0, 1000000)).padStart(6, '0'); } while (p.codes.some(c => same(Buffer.from(c.short, 'hex'), sha(short))));
  const code = 'pc_' + crypto.randomBytes(24).toString('base64url');
  p.codes.push({ id: crypto.randomBytes(4).toString('hex'), long: sha(code).toString('hex'), short: sha(short).toString('hex'), exp: now + CODE_TTL_MS });
  p.fails = 0; // a fresh pairing: the guess counter starts over (an active lockout still stands)
  write('pending.json', p);
  journal({ type: 'device_code_minted', expires_at: new Date(now + CODE_TTL_MS).toISOString() });
  return { code, short, expiresAt: new Date(now + CODE_TTL_MS).toISOString() };
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
  if (devices().filter(d => !d.revoked).length >= MAX_DEVICES) return { ok: false, status: 409, error: 'too many devices; revoke one first' };
  p.codes = p.codes.filter(c => c !== hit && c.exp > now); // single use: spent before the token is made
  p.fails = 0;
  write('pending.json', p);
  const id = crypto.randomBytes(4).toString('hex');
  const token = `dvt_${id}.${crypto.randomBytes(32).toString('base64url')}`;
  const rec = { id, label: cleanLabel(label), hash: sha(token).toString('hex'), created: new Date(now).toISOString(), revoked: false };
  write('devices.json', [...devices(), rec]);
  journal({ type: 'device_paired', device_id: id, label: rec.label });
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
    for (const d of devices()) if (same(h, Buffer.from(d.hash, 'hex')) && m && d.id === m[1]) dev = d;
    if (!dev || dev.revoked) return null;
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
    return { id: d.id, label: d.label, created: d.created, lastSeen: last, revoked: !!d.revoked, expired: now - Date.parse(last || d.created) > DEVICE_TTL_MS };
  });
}
function revoke(id) { return withLock(() => revokeLocked(id)); }
function revokeLocked(id) {
  const all = devices();
  const hit = all.find(d => d.id === String(id));
  if (!hit) return false;
  if (!hit.revoked) { hit.revoked = true; hit.revokedAt = new Date().toISOString(); write('devices.json', all); journal({ type: 'device_revoked', device_id: hit.id, label: hit.label }); }
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
];
const allows = (method, p) => ALLOW.some(([m, re]) => m === method && re.test(String(p)));

// One journal line per state-changing call, naming the device (the owner's calls carry no such line).
function audit(device, method, p) { journal({ type: 'device_action', device_id: device.id, label: device.label, method, path: String(p).slice(0, 200) }); }

module.exports = { withLock, mintCode, redeem, authenticate, list, revoke, allows, audit, CODE_TTL_MS, MAX_FAILS, LOCK_MS, DEVICE_TTL_MS, dir };
