'use strict';
// search: full-text search over the owner's own history (tasks, messages, room
// transcripts) with an incremental in-memory index. Off by default. See README.md.
const J = require('../../lib/journal');
const { createIndex, createTailer, KINDS } = require('./engine');

let cached = null; // { key, index, refresh }
function engine(settings) {
  const key = `${J.JOURNAL}|${settings.max_docs}|${settings.max_doc_chars}`;
  if (cached && cached.key === key) return cached;
  const index = createIndex({ maxDocs: settings.max_docs, maxDocChars: settings.max_doc_chars });
  cached = { key, index, refresh: createTailer(J.JOURNAL, index) };
  return cached;
}

const bad = error => ({ status: 400, json: { error } });
const ID = /^[A-Za-z0-9._:-]{1,80}$/;

function handler(ctx) {
  const s = ctx.settings, qy = ctx.query || {};
  const one = k => (Array.isArray(qy[k]) ? qy[k][0] : qy[k]);
  const q = one('q');
  if (typeof q !== 'string' || !q.trim()) return bad('q required');
  if (q.length > s.max_query_chars) return bad(`q too long (max ${s.max_query_chars})`);
  const kind = one('kind');
  if (kind !== undefined && kind !== '' && !KINDS.includes(kind)) return bad(`kind must be one of ${KINDS.join(', ')}`);
  const filt = {};
  for (const k of ['bot', 'room']) {
    const v = one(k);
    if (v === undefined || v === '') continue;
    if (typeof v !== 'string' || !ID.test(v)) return bad(`${k} is not a valid id`);
    filt[k] = v;
  }
  const num = (k, def, min, max) => {
    const v = one(k);
    if (v === undefined || v === '') return def;
    if (!/^\d{1,9}$/.test(String(v))) return NaN;
    const n = Number(v);
    return n < min || n > max ? NaN : n;
  };
  const limit = num('limit', Math.min(20, s.max_results), 1, s.max_results);
  if (Number.isNaN(limit)) return bad(`limit must be 1..${s.max_results}`);
  const offset = num('offset', 0, 0, 100000);
  if (Number.isNaN(offset)) return bad('offset must be 0..100000');
  const e = engine(s);
  e.refresh();
  const r = e.index.query({ q, kind: kind || undefined, bot: filt.bot, room: filt.room, limit, offset });
  const next = offset + r.hits.length;
  return { status: 200, json: { total: r.total, limit, offset, next_offset: next < r.total ? next : null, results: r.hits } };
}

module.exports = {
  contract: 1,
  name: 'search',
  description: 'Full-text search over tasks, messages and room transcripts (owner only).',
  runsOn: 'main',
  routes: [{
    method: 'GET', path: '/search', access: 'owner',
    description: 'search history: ?q=&kind=task|message|room&bot=&room=&limit=&offset=; snippets with ids, paged',
    handler,
  }],
  statusLines: (J2, ctx) => { try { const e = engine(ctx.settings); e.refresh(); return [`search: ${e.index.size()} entries indexed`]; } catch { return ['search: index unavailable']; } },
  settings: {
    max_query_chars: { type: 'integer', default: 200, min: 1, max: 1000, description: 'longest accepted q' },
    max_results: { type: 'integer', default: 50, min: 1, max: 200, description: 'largest accepted limit per page' },
    max_docs: { type: 'integer', default: 50000, min: 100, max: 1000000, description: 'entries kept in memory; the oldest are dropped past this' },
    max_doc_chars: { type: 'integer', default: 4000, min: 100, max: 100000, description: 'characters indexed per entry' },
  },
  api: { engine },
};
