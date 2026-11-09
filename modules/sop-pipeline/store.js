'use strict';
// sop-pipeline store: one JSON file (sop.json) in the module state dir, written atomically
// (unique tmp + rename). Every read-modify-write holds sop.lock, a lock file with an owner
// token: only the holder removes it, and a stale lock is broken under a breaker mutex (<lock>.break) after re-verifying it. A file that
// exists but cannot be parsed is an error (code "corrupt"), never an empty store, so a bad file
// is not silently overwritten.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const err = (code, msg) => Object.assign(new Error(msg), { code });
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const BREAK_STALE_MS = 10000;
function lockAcquire(lockFile, { staleMs, waitMs, hooks }) {
  const token = `${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  const brk = lockFile + '.break';
  const start = Date.now();
  for (;;) {
    try { fs.writeFileSync(lockFile, token, { flag: 'wx' }); return token; } catch (e) {
      if (e.code !== 'EEXIST' && !TRANSIENT.has(e.code)) throw e;
    }
    try {
      if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) {
        const seen = fs.readFileSync(lockFile, 'utf8');
        if (hooks && hooks.afterSeen) hooks.afterSeen();
        let held = false;
        try { fs.closeSync(fs.openSync(brk, 'wx')); held = true; } catch (e) {
          if (e.code === 'EEXIST') {
            try { if (Date.now() - fs.statSync(brk).mtimeMs > BREAK_STALE_MS) fs.unlinkSync(brk); } catch { /* gone */ }
          } else if (!TRANSIENT.has(e.code)) throw e;
        }
        if (held) {
          try {
            if (fs.readFileSync(lockFile, 'utf8') === seen) fs.unlinkSync(lockFile);
          } catch { /* gone */ } finally { try { fs.unlinkSync(brk); } catch { /* gone */ } }
          continue;
        }
      }
    } catch { /* raced */ }
    if (Date.now() - start > waitMs) throw err('busy', 'sop-pipeline store busy');
    sleep(5);
  }
}
// True while the lock file still holds our token (checked before the final write).
function lockHeld(lockFile, token) {
  try { return fs.readFileSync(lockFile, 'utf8') === token; } catch { return false; }
}
function lockRelease(lockFile, token) {
  try { if (fs.readFileSync(lockFile, 'utf8') === token) fs.unlinkSync(lockFile); } catch { /* gone or not ours */ }
}

function open(dir, opts = {}) {
  const file = path.join(dir, 'sop.json');
  const lockFile = path.join(dir, 'sop.lock');
  const staleMs = opts.staleMs || 10000, waitMs = opts.waitMs || 15000;

  const read = () => {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') raw = null; else throw e; }
    let d = {};
    if (raw !== null) {
      try { d = JSON.parse(raw); } catch { throw err('corrupt', 'sop-pipeline state file is unreadable; fix or remove it'); }
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw err('corrupt', 'sop-pipeline state file is unreadable; fix or remove it');
    }
    if (!d.sops || typeof d.sops !== 'object' || Array.isArray(d.sops)) d.sops = {};
    if (!Array.isArray(d.runs)) d.runs = [];
    return d;
  };
  const write = d => {
    fs.mkdirSync(dir, { recursive: true });
    const t = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(t, JSON.stringify(d), { mode: 0o600 });
      for (let i = 0; ; i++) {
        try { fs.renameSync(t, file); break; } catch (e) { if (!TRANSIENT.has(e.code) || i >= 50) throw e; sleep(5); }
      }
    } catch (e) { try { fs.unlinkSync(t); } catch { /* gone */ } throw e; }
  };
  return {
    file, lockFile,
    read,
    // fn(d) may mutate d and return a value; d is saved unless fn throws.
    update(fn) {
      fs.mkdirSync(dir, { recursive: true });
      const token = lockAcquire(lockFile, { staleMs, waitMs });
      try {
        const d = read();
        const value = fn(d);
        if (!lockHeld(lockFile, token)) throw err('lock_lost', 'sop-pipeline lock was lost; not writing');
        write(d);
        return value;
      } finally { lockRelease(lockFile, token); }
    },
  };
}

module.exports = { open, err, lockAcquire, lockRelease, lockHeld };
