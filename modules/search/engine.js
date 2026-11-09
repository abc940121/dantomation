'use strict';
// search engine: an incremental in-memory inverted index over journal records.
// Pure logic plus a journal tailer; no network. See README.md.
const fs = require('fs');
const { redactFull } = require('../../lib/redact');

const CJK = /[⺀-鿿぀-ヿ가-힯豈-﫿]/;
const WORD = /[\p{L}\p{N}_]/u;
const KINDS = ['task', 'message', 'room'];

// Shared scanner. Calls onWord(word) for latin/digit words and onRun(run) for
// each maximal run of CJK characters.
function scan(text, onWord, onRun) {
  const s = String(text).toLowerCase().normalize('NFKC');
  let word = '', run = '';
  const fw = () => { if (word) onWord(word.slice(0, 40)); word = ''; };
  const fr = () => { if (run) onRun(run); run = ''; };
  for (const ch of s) {
    if (CJK.test(ch)) { fw(); run += ch; continue; }
    fr();
    if (WORD.test(ch)) word += ch; else fw();
  }
  fw(); fr();
}

// Index terms of a text: words, plus every CJK character and character bigram.
function terms(text) {
  const out = new Set();
  scan(text, w => out.add(w), run => {
    for (let i = 0; i < run.length; i++) { out.add(run[i]); if (i + 1 < run.length) out.add(run[i] + run[i + 1]); }
  });
  return out;
}

// Terms a query must all match (AND). A CJK run needs its bigrams only (a lone char is itself).
function queryTerms(q) {
  const out = new Set();
  scan(q, w => out.add(w), run => {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run[i] + run[i + 1]);
  });
  return [...out];
}

// Whole words and CJK runs of the query, used to confirm a hit and to place the snippet.
function queryChunks(q) {
  const out = [];
  scan(q, w => out.push(w), r => out.push(r));
  return out;
}

function createIndex({ maxDocs = 50000, maxDocChars = 4000 } = {}) {
  let docs = [];                 // {seq, kind, bot, room, task_id, rec_id, ts, text, low}
  let post = new Map();          // term -> ascending array of seq
  let seq = 0;
  const taskBot = new Map();     // task_id -> bot

  function put(d) {
    docs.push(d);
    for (const t of terms(d.text)) { let a = post.get(t); if (!a) post.set(t, a = []); a.push(d.seq); }
  }
  function add(doc) {
    const text = redactFull(String(doc.text)).slice(0, maxDocChars);
    if (!text.trim()) return;
    put({ ...doc, seq: ++seq, text, low: text.toLowerCase().normalize('NFKC') });
    if (docs.length > maxDocs) {
      const keep = docs.slice(Math.ceil(maxDocs * 0.1));
      docs = []; post = new Map();
      for (const d of keep) put(d);
    }
  }

  function ingest(r) {
    if (!r || typeof r !== 'object' || typeof r.type !== 'string') return;
    const base = { rec_id: r.id, ts: r.ts, task_id: r.task_id || null };
    const bot = r.bot ? String(r.bot).slice(0, 80) : null;
    if (r.type === 'task_start' && typeof r.request === 'string') {
      if (r.task_id && bot) taskBot.set(r.task_id, bot);
      add({ ...base, kind: 'task', bot, room: null, text: r.request });
    } else if (r.type === 'queue_add' && typeof r.prompt === 'string') {
      if (r.task_id && bot) taskBot.set(r.task_id, bot);
      add({ ...base, kind: 'message', bot, room: null, text: r.prompt });
    } else if (r.type === 'reply' && typeof r.text === 'string') {
      add({ ...base, kind: 'message', bot: taskBot.get(r.task_id) || null, room: null, text: r.text });
    } else if (r.type === 'room_msg' && typeof r.text === 'string' && r.room) {
      add({ ...base, kind: 'room', bot: r.kind === 'bot' ? String(r.speaker).slice(0, 80) : null, room: String(r.room), text: r.text });
    }
  }

  function snippet(d, chunks, width = 120) {
    let at = -1;
    for (const w of chunks) { const i = d.low.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
    const start = Math.max(0, Math.max(at, 0) - Math.floor(width / 3));
    const end = Math.min(d.text.length, start + width);
    return (start > 0 ? '...' : '') + d.text.slice(start, end).replace(/\s+/g, ' ') + (end < d.text.length ? '...' : '');
  }

  function query({ q, kind, bot, room, limit, offset }) {
    const qt = queryTerms(q);
    const none = { total: 0, hits: [] };
    if (!qt.length) return none;
    const lists = qt.map(t => post.get(t));
    if (lists.some(l => !l)) return none;
    lists.sort((a, b) => a.length - b.length);
    let cand = lists[0];
    for (let i = 1; i < lists.length && cand.length; i++) { const s = new Set(lists[i]); cand = cand.filter(x => s.has(x)); }
    const chunks = queryChunks(q);
    const bySeq = new Map(); for (const d of docs) bySeq.set(d.seq, d);
    const matched = [];
    for (let i = cand.length - 1; i >= 0; i--) { // newest first
      const d = bySeq.get(cand[i]);
      if (!d) continue;
      if (kind && d.kind !== kind) continue;
      if (bot && d.bot !== bot) continue;
      if (room && d.room !== room) continue;
      if (!chunks.every(w => d.low.includes(w))) continue; // bigrams alone can match non-adjacent text
      matched.push(d);
    }
    const hits = matched.slice(offset, offset + limit).map(d => ({
      kind: d.kind, id: d.rec_id, task_id: d.task_id, bot: d.bot, room: d.room, ts: d.ts, snippet: snippet(d, chunks),
    }));
    return { total: matched.length, hits };
  }

  return { ingest, query, size: () => docs.length, reset() { docs = []; post = new Map(); taskBot.clear(); } };
}

// Reads only bytes appended since the last call. A shrunk file restarts from
// zero. A partial last line waits for its newline.
function createTailer(file, index, { chunk = 1 << 20, maxPerRefresh = 64 << 20 } = {}) {
  let off = 0, pending = Buffer.alloc(0);
  return function refresh() {
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size < off) { off = 0; pending = Buffer.alloc(0); index.reset(); }
      let budget = maxPerRefresh;
      while (off < size && budget > 0) {
        const buf = Buffer.alloc(Math.min(chunk, size - off));
        const n = fs.readSync(fd, buf, 0, buf.length, off);
        if (n <= 0) break;
        off += n; budget -= n;
        let data = Buffer.concat([pending, buf.subarray(0, n)]);
        let nl;
        while ((nl = data.indexOf(0x0a)) >= 0) {
          const line = data.subarray(0, nl).toString('utf8'); data = data.subarray(nl + 1);
          if (!line.trim()) continue;
          try { index.ingest(JSON.parse(line)); } catch { /* torn line */ }
        }
        pending = Buffer.from(data);
        if (pending.length > (4 << 20)) pending = Buffer.alloc(0); // runaway line: drop
      }
    } finally { fs.closeSync(fd); }
  };
}

module.exports = { createIndex, createTailer, terms, queryTerms, KINDS };
