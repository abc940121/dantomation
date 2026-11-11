'use strict';
// Pure client logic for the chat UI: event -> state reduction, the SSE text
// parser and small selectors. No DOM, no network. Loaded by the page as a plain
// script (global DantoState) and by Node tests via require.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DantoState = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const create = () => ({ bots: {}, order: [], tasks: {}, cards: {}, lastSeq: 0, nextOrder: 1 });

  function ensureTask(s, id, bot) {
    let t = s.tasks[id];
    if (!t) t = s.tasks[id] = { id, bot: bot || null, prompt: '', state: 'running', entries: [], undo: [], claims: null, order: s.nextOrder++ };
    else if (bot && !t.bot) t.bot = bot;
    return t;
  }
  const addUser = t => { if (t.prompt && !t.entries.some(e => e.kind === 'user')) t.entries.unshift({ kind: 'user', text: t.prompt }); };
  const liveMsg = t => { for (let i = t.entries.length - 1; i >= 0; i--) if (t.entries[i].kind === 'msg') return t.entries[i].live ? t.entries[i] : null; return null; };

  function applyBots(s, list) {
    if (!Array.isArray(list)) return s;
    s.order = [];
    for (const b of list) {
      if (!b || typeof b.id !== 'string') continue;
      s.bots[b.id] = { id: b.id, name: b.name || b.id, engine: b.engine || '', status: b.status || 'offline', runsOn: b.runsOn || 'main', ...(typeof b.avatar === 'string' ? { avatar: b.avatar } : {}) };
      s.order.push(b.id);
    }
    return s;
  }

  // The main role (chief of staff) is the bot whose id the roles module reports; without one, the configured main bot.
  function mainBotId(s, roleId) {
    if (roleId && s.bots[roleId]) return roleId;
    return s.bots.main ? 'main' : s.order[0];
  }

  // The bot conversations in list order: the main role (else the config main bot) pinned first, then the rest; 'bot:main' when there are no bots.
  function botConvIds(s, roleId) {
    const main = mainBotId(s, roleId);
    return (main ? [main].concat(s.order.filter(i => i !== main)) : ['main']).map(id => 'bot:' + id);
  }

  // GET /api/tasks is assumed newest first; only tasks not yet known are added.
  function applyTasks(s, list) {
    if (!Array.isArray(list)) return s;
    for (const x of list.slice().reverse()) {
      if (!x || typeof x.id !== 'string' || s.tasks[x.id]) continue;
      const t = ensureTask(s, x.id, x.bot);
      t.prompt = String(x.prompt || ''); t.state = x.state || t.state;
      if (x.claims && typeof x.claims === 'object') t.claims = { checked: x.claims.checked | 0, unverified: x.claims.unverified | 0 };
      addUser(t);
    }
    return s;
  }

  function addCard(s, c) {
    if (!c || typeof c.id !== 'string') return;
    const prev = s.cards[c.id];
    s.cards[c.id] = { id: c.id, task: c.task, bot: c.bot, tool: c.tool || '', summary: c.summary || '', expiresAt: c.expiresAt, status: prev ? prev.status : 'pending' };
    if (c.task) {
      const t = ensureTask(s, c.task, c.bot);
      if (!t.entries.some(e => e.kind === 'card' && e.cardId === c.id)) t.entries.push({ kind: 'card', cardId: c.id });
      if (s.cards[c.id].status === 'pending') t.state = 'waiting_card';
    }
  }
  function applyCards(s, list) { if (Array.isArray(list)) for (const c of list) addCard(s, c); return s; }

  const pendingFor = (s, taskId) => Object.values(s.cards).some(c => c.task === taskId && c.status === 'pending');

  // Apply one SSE event. Events at or below lastSeq are ignored (replay overlap).
  function reduce(s, type, d) {
    if (!d || typeof d !== 'object') return s;
    if (typeof d.seq === 'number') { if (d.seq <= s.lastSeq) return s; s.lastSeq = d.seq; }
    switch (type) {
      case 'task_start': {
        const t = ensureTask(s, d.task, d.bot);
        t.prompt = String(d.prompt || t.prompt); t.state = 'running'; addUser(t); break;
      }
      case 'message': {
        const t = ensureTask(s, d.task, d.bot);
        const live = liveMsg(t), text = String(d.text == null ? '' : d.text);
        // A non-final message is a live bubble that the next message replaces.
        if (live) { live.text = text; live.live = !d.final; } else t.entries.push({ kind: 'msg', text, live: !d.final });
        break;
      }
      case 'tool_call': {
        const t = ensureTask(s, d.task, d.bot);
        if (!t.entries.some(e => e.kind === 'tool' && e.callId === d.callId))
          t.entries.push({ kind: 'tool', callId: d.callId, tool: String(d.tool || 'tool'), summary: String(d.summary || ''), status: 'running', result: '' });
        break;
      }
      case 'tool_result': {
        const t = ensureTask(s, d.task);
        let e = t.entries.find(x => x.kind === 'tool' && x.callId === d.callId);
        if (!e) { e = { kind: 'tool', callId: d.callId, tool: 'tool', summary: '', status: 'running', result: '' }; t.entries.push(e); }
        e.status = d.ok ? 'ok' : 'failed'; e.result = String(d.summary || '');
        break;
      }
      case 'card_pending': addCard(s, d.card); break;
      case 'card_resolved': {
        const c = s.cards[d.cardId];
        if (c) { c.status = d.answer; const t = s.tasks[c.task]; if (t && t.state === 'waiting_card' && !pendingFor(s, t.id)) t.state = 'running'; }
        else s.cards[d.cardId] = { id: d.cardId, task: null, bot: null, tool: '', summary: '', expiresAt: null, status: d.answer };
        break;
      }
      case 'undo_point': { const t = ensureTask(s, d.task); t.undo.push({ n: d.n, label: String(d.label || '') }); break; }
      case 'task_end': {
        const t = ensureTask(s, d.task); t.state = d.state || 'done';
        const live = liveMsg(t); if (live) live.live = false;
        break;
      }
      case 'bot_status': if (s.bots[d.bot]) s.bots[d.bot].status = d.status; break;
      case 'claims': { const t = ensureTask(s, d.task); t.claims = { checked: d.checked | 0, unverified: d.unverified | 0 }; break; }
      default: break;
    }
    return s;
  }

  const pendingCards = s => Object.values(s.cards).filter(c => c.status === 'pending');
  function thread(s, botId) {
    return Object.values(s.tasks).filter(t => !botId || t.bot === botId).sort((a, b) => a.order - b.order);
  }
  const unverifiedTotal = s => Object.values(s.tasks).reduce((n, t) => n + (t.claims ? t.claims.unverified : 0), 0);
  const newest = (s, t) => !Object.values(s.tasks).some(x => x.order > t.order);
  const canUndo = (t, s) => !!t && t.undo.length > 0 && t.state !== 'running' && t.state !== 'waiting_card' && (!s || newest(s, t));

  // Seconds left until expiresAt (ISO string or epoch ms); null when unknown.
  function remainingSec(expiresAt, nowMs) {
    const at = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
    return Number.isFinite(at) ? Math.max(0, Math.ceil((at - nowMs) / 1000)) : null;
  }
  function fmtCountdown(sec) {
    if (sec == null) return '';
    if (sec <= 0) return 'expired';
    const m = Math.floor(sec / 60), r = sec % 60;
    return m + ':' + String(r).padStart(2, '0');
  }

  // Body for POST /api/chat, or null when nothing can be sent.
  function chatBody(all, ids, text) {
    const t = String(text || '').trim();
    const list = [...ids];
    if (!t || (!all && !list.length)) return null;
    return { bots: all ? 'all' : list, text: t };
  }

  // Incremental text/event-stream parser: push(chunk) calls onEvent(type, data).
  function createSSEParser(onEvent) {
    let buf = '', hold = '';
    return {
      push(chunk) {
        let text = hold + String(chunk); hold = '';
        if (text.endsWith('\r')) { hold = '\r'; text = text.slice(0, -1); }
        buf += text.replace(/\r\n?/g, '\n');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          let type = 'message'; const data = [];
          for (const line of block.split('\n')) {
            if (!line || line[0] === ':') continue;
            const c = line.indexOf(':');
            const f = c < 0 ? line : line.slice(0, c);
            let v = c < 0 ? '' : line.slice(c + 1);
            if (v[0] === ' ') v = v.slice(1);
            if (f === 'event') type = v; else if (f === 'data') data.push(v);
          }
          if (!data.length) continue;
          let j; try { j = JSON.parse(data.join('\n')); } catch { continue; }
          onEvent(type, j);
        }
      },
    };
  }

  // Token handling: take "t=<token>" out of a location hash.
  function tokenFromHash(hash) {
    const m = /(?:^#|&)t=([^&]*)/.exec(String(hash || ''));
    if (!m) return null;
    try { return decodeURIComponent(m[1]) || null; } catch { return null; }
  }

  // First open of the chat pane: null = not decided yet, true = open the first (main) chat, false = stay on the list.
  // A wide screen always preselects it. A phone waits for the first boot, so the main role is known, and opens it only when there is one.
  const firstOpen = (wide, booted, mainRole) => (wide ? true : booted ? !!mainRole : null);

  // Pairing: take "p=<pairing code>" out of a location hash (the QR or link from device-pairing).
  function pairFromHash(hash) {
    const m = /(?:^#|&)p=([\w-]{6,80})(?:&|$)/.exec(String(hash || ''));
    return m ? m[1] : null;
  }
  // #h=<code>&lang=<lang>: the one-time handoff the home-screen icon is saved with. lang is optional and checked by the caller.
  function handoffFromHash(hash) {
    const s = String(hash || '');
    const m = /(?:^#|&)h=([\w-]{6,120})(?:&|$)/.exec(s);
    if (!m) return null;
    const l = /(?:^#|&)lang=([A-Za-z-]{2,10})(?:&|$)/.exec(s);
    return { code: m[1], lang: l ? l[1] : null };
  }
  // A typed or pasted value is a pairing code when it is six digits or starts with pc_.
  const looksLikeCode = v => /^\d{3}\s?-?\s?\d{3}$/.test(String(v).trim()) || /^pc_[\w-]{10,80}$/.test(String(v).trim());

  // Shrink a picked picture in the page before upload: decode (EXIF orientation applied), centre-crop to a square (the role avatar is
  // shown as a square/round picture, object-fit: cover), at most `side` px, WebP (JPEG when the browser cannot encode WebP), quality
  // lowered step by step until the ENCODED blob is at most maxBytes. Returns the blob, or null when the file cannot be read or nothing fits.
  // env = { createImageBitmap(file, opts), makeCanvas(w, h) } so the size logic runs outside a browser too.
  async function shrinkImage(file, env, maxBytes, side) {
    let bmp;
    try { bmp = await env.createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { return null; }
    if (!bmp || !(bmp.width > 0) || !(bmp.height > 0)) return null;
    const sq = Math.min(bmp.width, bmp.height), out = Math.max(1, Math.min(side || 512, sq));
    let cv;
    try { cv = env.makeCanvas(out, out); cv.getContext('2d').drawImage(bmp, (bmp.width - sq) / 2, (bmp.height - sq) / 2, sq, sq, 0, 0, out, out); } catch (e) { return null; }
    if (typeof bmp.close === 'function') { try { bmp.close(); } catch (e) { /* ignore */ } }
    const enc = (type, q) => new Promise(res => { try { cv.toBlob(b => res(b || null), type, q); } catch (e) { res(null); } });
    let type = 'image/webp';
    const first = await enc(type, 0.9);
    if (!first || first.type !== 'image/webp') type = 'image/jpeg'; // no WebP encoder: the browser answers with PNG or nothing
    for (const q of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]) {
      const b = type === 'image/webp' && q === 0.9 ? first : await enc(type, q);
      if (b && b.type === type && b.size > 0 && b.size <= maxBytes) return b;
    }
    return null;
  }

  return { shrinkImage, firstOpen, botConvIds, mainBotId, pairFromHash, handoffFromHash, looksLikeCode, create, reduce, applyBots, mainBotId, applyTasks, applyCards, thread, pendingCards, pendingFor, unverifiedTotal, canUndo, remainingSec, fmtCountdown, chatBody, createSSEParser, tokenFromHash };
});
