'use strict';
// notifications store: JSON files in the module's state dir, written atomically
// (unique tmp + rename). Every read-modify-write runs under an inter-process lock
// file in the state dir, so concurrent processes cannot lose each other's updates. Bounded: add() prunes to the cap, read entries first, oldest first.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KINDS = ['card_pending', 'question_asked', 'task_failed', 'task_finished', 'room_mention'];
const MAX_TEXT = 200;
const MAX_ID = 64;

// Notification text may come from card summaries or room lines. Hide anything
// that looks like a credential before it is stored.
function redact(s) {
  return String(s == null ? '' : s)
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/=-]{8,}/gi, '$1[hidden]')
    .replace(/((?:secret|token|password|passwd|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, '$1[hidden]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[hidden]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[hidden]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim().slice(0, MAX_TEXT);
}
const cleanId = v => (typeof v === 'string' ? v.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, MAX_ID) : null) || null;

function open(dir, { now = () => Date.now() } = {}) {
  const file = path.join(dir, 'notifications.json');
  const prefsFile = path.join(dir, 'prefs.json');
  const readJson = (f, fallback) => { try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); return v && typeof v === 'object' ? v : fallback; } catch { return fallback; } };
  const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
  const writeJson = (f, v) => {
    fs.mkdirSync(dir, { recursive: true });
    const t = `${f}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(t, JSON.stringify(v));
      // Windows: rename can fail briefly while another handle (reader, indexer) is open.
      for (let i = 0; ; i++) {
        try { fs.renameSync(t, f); break; } catch (e) { if (!TRANSIENT.has(e.code) || i >= 50) throw e; sleep(5); }
      }
    } catch (e) { try { fs.unlinkSync(t); } catch {} throw e; }
  };
  // Inter-process lock: exclusive-create a lock file; a lock older than STALE_MS is
  // taken over (its holder crashed). Sync wait, so callers stay synchronous.
  const lockFile = path.join(dir, 'store.lock');
  const STALE_MS = 10000, WAIT_MS = 15000;
  const locked = fn => {
    fs.mkdirSync(dir, { recursive: true });
    const start = Date.now();
    for (;;) {
      try { fs.closeSync(fs.openSync(lockFile, 'wx')); break; } catch (e) {
        // Windows reports EPERM/EACCES/EBUSY while the old lock file is delete-pending.
        if (e.code !== 'EEXIST' && !TRANSIENT.has(e.code)) throw e;
        try { if (Date.now() - fs.statSync(lockFile).mtimeMs > STALE_MS) { fs.unlinkSync(lockFile); continue; } } catch {}
        if (Date.now() - start > WAIT_MS) throw new Error('notifications store busy');
        sleep(5);
      }
    }
    try { return fn(); } finally { try { fs.unlinkSync(lockFile); } catch {} }
  };
  const load = () => { const d = readJson(file, { seq: 0, items: [] }); if (!Array.isArray(d.items)) d.items = []; if (!Number.isInteger(d.seq)) d.seq = 0; return d; };

  return {
    add(kind, fields, cap) {
      if (!KINDS.includes(kind)) throw new Error('unknown kind');
      return locked(() => {
      const d = load();
      d.seq += 1;
      const item = { id: d.seq, kind, text: redact(fields && fields.text), ref: cleanId(fields && fields.ref), task_id: cleanId(fields && fields.task_id), ts: new Date(now()).toISOString(), read: false };
      d.items.push(item);
      while (d.items.length > cap) {
        const i = d.items.findIndex(x => x.read);
        d.items.splice(i === -1 ? 0 : i, 1);
      }
      writeJson(file, d);
      return item;
      });
    },
    list({ unread = false, offset = 0, limit = 50 } = {}) {
      const all = load().items.filter(x => !unread || !x.read).reverse(); // newest first
      return { total: all.length, offset, limit, items: all.slice(offset, offset + limit) };
    },
    unreadCount() { return load().items.filter(x => !x.read).length; },
    markRead(id) {
      return locked(() => {
        const d = load(); const it = d.items.find(x => x.id === id);
        if (!it) return null;
        if (!it.read) { it.read = true; writeJson(file, d); }
        return it;
      });
    },
    markAllRead() {
      return locked(() => {
        const d = load(); let n = 0;
        for (const it of d.items) if (!it.read) { it.read = true; n++; }
        if (n) writeJson(file, d);
        return n;
      });
    },
    prefs() { const p = readJson(prefsFile, {}); const out = {}; for (const k of KINDS) if (typeof p[k] === 'boolean') out[k] = p[k]; return out; },
    setPrefs(patch) { return locked(() => { const p = this.prefs(); for (const [k, v] of Object.entries(patch)) { if (v === null) delete p[k]; else p[k] = v; } writeJson(prefsFile, p); return p; }); },
  };
}

module.exports = { open, redact, KINDS, MAX_TEXT };
