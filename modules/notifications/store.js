'use strict';
// notifications store: JSON files in the module's state dir, written atomically
// (tmp + rename). All access is synchronous, so in one process operations never
// interleave. Bounded: add() prunes to the cap, read entries first, oldest first.
const fs = require('fs');
const path = require('path');

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
  const writeJson = (f, v) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v)); fs.renameSync(f + '.tmp', f); };
  const load = () => { const d = readJson(file, { seq: 0, items: [] }); if (!Array.isArray(d.items)) d.items = []; if (!Number.isInteger(d.seq)) d.seq = 0; return d; };

  return {
    add(kind, fields, cap) {
      if (!KINDS.includes(kind)) throw new Error('unknown kind');
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
    },
    list({ unread = false, offset = 0, limit = 50 } = {}) {
      const all = load().items.filter(x => !unread || !x.read).reverse(); // newest first
      return { total: all.length, offset, limit, items: all.slice(offset, offset + limit) };
    },
    unreadCount() { return load().items.filter(x => !x.read).length; },
    markRead(id) {
      const d = load(); const it = d.items.find(x => x.id === id);
      if (!it) return null;
      if (!it.read) { it.read = true; writeJson(file, d); }
      return it;
    },
    markAllRead() {
      const d = load(); let n = 0;
      for (const it of d.items) if (!it.read) { it.read = true; n++; }
      if (n) writeJson(file, d);
      return n;
    },
    prefs() { const p = readJson(prefsFile, {}); const out = {}; for (const k of KINDS) if (typeof p[k] === 'boolean') out[k] = p[k]; return out; },
    setPrefs(patch) { const p = this.prefs(); for (const [k, v] of Object.entries(patch)) { if (v === null) delete p[k]; else p[k] = v; } writeJson(prefsFile, p); return p; },
  };
}

module.exports = { open, redact, KINDS, MAX_TEXT };
