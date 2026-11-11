'use strict';
// Machine-wide lock so only one full gate (run-all.js all) runs at a time: two gates
// at once load the machine and make timing-sensitive suites fail for no real reason.
// The lock file holds { pid, start, nonce }. It is stale when its pid is dead or it is
// older than STALE_MS; a stale lock is taken over. A file that does not parse is treated
// as held while it is young (it may be mid-write) and as stale once it is old.
// Residual: takeover re-reads the file and renames it away; two takers racing on the same
// stale file could still hand the lock to both. That needs two gates starting within the
// same few milliseconds after a crash, and the cost is only the load this lock prevents.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_FILE = path.join(os.tmpdir(), 'harness-test-gate.lock');
const STALE_MS = 30 * 60 * 1000;

const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }

// 'free' (no file), 'held', or 'stale' (with the content that was judged)
function judge(file, staleMs) {
  const raw = read(file);
  if (raw === null) return { state: 'free' };
  let h = null; try { h = JSON.parse(raw); } catch { /* half-written */ }
  if (!h) {
    let age = 0; try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { return { state: 'free' }; }
    return age > Math.min(staleMs, 10000) ? { state: 'stale', raw } : { state: 'held', holder: null };
  }
  if (!alive(h.pid)) return { state: 'stale', raw, holder: h };
  if (Date.now() - Number(h.start) > staleMs) return { state: 'stale', raw, holder: h };
  return { state: 'held', holder: h };
}

function tryTake(file, staleMs) {
  const mine = { pid: process.pid, start: Date.now(), nonce: crypto.randomBytes(8).toString('hex') };
  try {
    fs.writeFileSync(file, JSON.stringify(mine), { flag: 'wx' });
    return mine;
  } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const j = judge(file, staleMs);
  if (j.state === 'stale' && read(file) === j.raw) {
    const aside = `${file}.${process.pid}.${mine.nonce}.old`;
    try { fs.renameSync(file, aside); fs.rmSync(aside, { force: true }); } catch { /* another taker moved it first */ }
  }
  return null; // the caller polls again; the next round creates the file
}

// Resolves to release() once the lock is ours. Releasing is idempotent and only removes a file that is still ours.
async function acquire(opts = {}) {
  const file = opts.file || DEFAULT_FILE;
  const staleMs = opts.staleMs || STALE_MS;
  const pollMs = opts.pollMs || 500;
  const logEveryMs = opts.logEveryMs || 30000;
  const log = opts.log || console.log;
  let lastLog = 0, mine = null;
  for (;;) {
    mine = tryTake(file, staleMs);
    if (mine) break;
    if (Date.now() - lastLog >= logEveryMs) { lastLog = Date.now(); log('waiting for gate lock'); }
    await sleep(pollMs);
  }
  let released = false;
  const release = () => {
    if (released) return; released = true;
    process.removeListener('exit', release); process.removeListener('SIGINT', onSig); process.removeListener('SIGTERM', onSig);
    const raw = read(file); let h = null; try { h = JSON.parse(raw); } catch { /* not ours */ }
    if (h && h.nonce === mine.nonce) fs.rmSync(file, { force: true });
  };
  const onSig = sig => { release(); process.exit(sig === 'SIGINT' ? 130 : 143); };
  if (!opts.noHooks) { process.on('exit', release); process.on('SIGINT', onSig); process.on('SIGTERM', onSig); }
  return release;
}

module.exports = { acquire, DEFAULT_FILE, STALE_MS, alive };
