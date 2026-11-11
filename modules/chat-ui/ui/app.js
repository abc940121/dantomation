'use strict';
// Chat UI page: a messaging-app view on the vendored <vue-advanced-chat> web component.
// Server text goes into the DOM through textContent / text nodes (helper h below) or into the
// component as plain data; no HTML string is ever built. Pure logic: state.js, rooms.js, clean.js.
(function () {
  const D = window.DantoState;
  const C = window.DantoClean;
  // The vendored component probes a CDN for emoji data even with emojis off. This page makes no external
  // requests, so only same-origin (and data:) fetches go through.
  if (typeof window.fetch === 'function') {
    const realFetch = window.fetch.bind(window);
    window.fetch = (u, o) => {
      try { const x = new URL(typeof u === 'string' ? u : (u && u.url) || String(u), location.href); if (x.origin !== location.origin && x.protocol !== 'data:' && x.protocol !== 'blob:') return Promise.reject(Object.assign(new TypeError('external request blocked'), { blockedUrl: x.href })); } catch (e) { /* relative or odd input: let it through */ }
      return realFetch(u, o);
    };
  }
  // The component fires its emoji-data probe without a catch, so the blocked request above surfaced as an empty
  // "Uncaught (in promise)" (three of them). Say so once, in one line; any other unhandled rejection is logged with its message.
  let blockedSeen = false;
  window.addEventListener('unhandledrejection', ev => {
    const r = ev && ev.reason;
    if (r && r.blockedUrl) {
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      if (!blockedSeen) { blockedSeen = true; console.info('chat-ui: the chat component asked for an outside address (' + r.blockedUrl + '); it was blocked on purpose.'); }
      return;
    }
    console.error('chat-ui: unhandled error: ' + ((r && r.message) || String(r)));
  });
  const S = D.create();
  const RM = window.DantoRooms;
  const rooms = { list: [], msgs: [], busy: false }; // stays empty (and invisible) while the rooms module is off
  const TOKEN_KEY = 'taskmote.token';
  const ui = { cur: null, confirmUndo: null, cardMsg: {}, busyCards: new Set(), conn: 'connecting', needAuth: false, room: RM.roomFromSearch(location.search) };
  if (ui.room) ui.cur = 'room:' + ui.room;
  const $ = id => document.getElementById(id);

  // ---- language: en or zh-TW, chosen on first open and kept in localStorage (if storage fails, the picker shows again next time).
  const I = window.DantoI18n;
  let lang = null;
  try { const l = localStorage.getItem(I.KEY); if (I.isLang(l)) lang = l; } catch (e) { lang = null; }
  const tr = (k, v) => I.t(lang || 'en', k, v);
  const word = (prefix, v) => I.word(lang || 'en', prefix, v);
  // Static text lives in index.html as data-i18n / data-i18n-placeholder / data-i18n-aria-label attributes.
  function applyStatic() {
    try { document.documentElement.lang = lang || 'en'; document.title = tr('title'); } catch (e) { /* ignore */ }
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = tr(el.getAttribute('data-i18n'));
    for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = tr(el.getAttribute('data-i18n-placeholder'));
    for (const el of document.querySelectorAll('[data-i18n-aria-label]')) el.setAttribute('aria-label', tr(el.getAttribute('data-i18n-aria-label')));
  }
  let afterLang = null; // runs once after the first choice (the normal start-up flow)
  function chooseLang(l) {
    if (!I.isLang(l)) return;
    lang = l;
    try { localStorage.setItem(I.KEY, l); } catch (e) { /* storage blocked: the picker shows again next time */ }
    $('lang-gate').hidden = true; applyStatic(); render();
    const go = afterLang; afterLang = null; if (go) go();
  }
  function showLangGate() { $('lang-gate').hidden = false; }
  for (const b of document.querySelectorAll('#lang-gate [data-lang]')) b.addEventListener('click', () => chooseLang(b.getAttribute('data-lang')));
  // once a language is set the button flips en <-> zh-TW in place; the full-screen picker is for the first visit only
  $('lang-btn').addEventListener('click', () => (lang ? chooseLang(lang === 'en' ? 'zh-TW' : 'en') : showLangGate()));
  applyStatic();

  // ---- token: a #t= fragment is stripped from the URL and kept in localStorage.
  // Done at load and again on every hashchange (the page re-navigated with a new #t=).
  let token = null;
  function takeHash() {
    let t = null;
    try { t = D.tokenFromHash(location.hash); } catch (e) { t = null; }
    if (!t) return false;
    token = t;
    try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* storage blocked: the token only lasts for this page */ }
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    return true;
  }
  // ---- pairing: a #p=<code> fragment (or a typed code) is swapped for a per-device token.
  // The owner token never has to reach the phone. The code is single use and short lived.
  let pairCode = null;
  function takePair() {
    let c = null;
    try { c = D.pairFromHash(location.hash); } catch (e) { c = null; }
    if (!c) return false;
    pairCode = c;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    return true;
  }
  async function redeemCode(code) {
    try {
      const ua = String((typeof navigator !== 'undefined' && navigator.userAgent) || '');
      const r = await fetch('/m/device-pairing/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code, label: /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android phone' : 'browser' }) });
      const b = await r.json();
      if (!r.ok || !b || !b.token) return (b && b.error) || tr('auth.pairfail');
      token = b.token;
      try { localStorage.setItem(TOKEN_KEY, token); } catch (e) { /* storage blocked: the token only lasts for this page */ }
      return null;
    } catch (e) { return tr('auth.pairfail'); }
  }
  takeHash();
  takePair();
  if (!token) { try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { token = null; } }
  window.addEventListener('hashchange', () => {
    if (takePair()) { const c = pairCode; pairCode = null; redeemCode(c).then(err => { if (err) { showAuth(); $('pair-msg').textContent = err; } else { $('auth').hidden = true; ui.needAuth = false; boot(); } }); return; }
    if (takeHash()) { $('auth').hidden = true; ui.needAuth = false; if (typeof boot === 'function') boot(); } });

  const headers = extra => Object.assign({}, token ? { Authorization: 'Bearer ' + token } : {}, extra || {});
  async function api(path, opts) {
    const o = Object.assign({}, opts || {});
    o.headers = headers(o.body ? { 'Content-Type': 'application/json' } : {});
    const r = await fetch(path, o);
    if (r.status === 401) { showAuth(); throw new Error('unauthorized'); }
    let body = null;
    try { body = await r.json(); } catch (e) { /* no body */ }
    return { ok: r.ok, status: r.status, body };
  }
  // api() throws Error('unauthorized') after opening the pairing screen: callers show no network error for it.
  const isAuth = err => !!err && err.message === 'unauthorized';
  const post = (path, data) => api(path, { method: 'POST', body: JSON.stringify(data || {}) });

  function showAuth() { ui.needAuth = true; $('auth').hidden = false; }
  $('auth-form').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('token').value.trim();
    if (!v) return;
    if (D.looksLikeCode(v)) { // a pairing code, not the owner token
      redeemCode(v).then(err => { $('pair-msg').textContent = err || ''; if (!err) { $('token').value = ''; $('auth').hidden = true; ui.needAuth = false; boot(); } });
      return;
    }
    token = v;
    try { localStorage.setItem(TOKEN_KEY, v); } catch (err) { /* ignore */ }
    $('token').value = ''; $('auth').hidden = true; ui.needAuth = false;
    boot();
  });

  // ---- tiny DOM helper: strings become text nodes
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const k of Object.keys(props || {})) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      e.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return e;
  }

  const botName = id => (S.bots[id] && S.bots[id].name) || id || '?';

  // ---- the chat component
  const chat = $('chat');
  const VAC = window['vue-advanced-chat'];
  if (VAC && typeof VAC.register === 'function') { try { VAC.register(); } catch (e) { /* already registered */ } }
  const ME = 'me';
  const seen = {}; // first-seen time of an entry that carries no time of its own
  const stamp = (key, given) => {
    const g = given == null ? NaN : (typeof given === 'number' ? given : Date.parse(given));
    if (Number.isFinite(g)) return g;
    if (!seen[key]) seen[key] = Date.now();
    return seen[key];
  };
  const fmtTime = ms => { try { return new Date(ms).toLocaleTimeString(lang || 'en', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
  const fmtDate = ms => { try { return new Date(ms).toLocaleDateString(lang || 'en', { month: 'short', day: 'numeric' }); } catch (e) { return ''; } };
  const oneLine = (s, n) => { const x = String(s || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
  const setProp = (el, k, v) => { try { el[k] = v; } catch (e) { /* ignore */ } };

  // Conversation list: main bot first, then the other bots, then groups, then "All bots" (the broadcast).
  function convs() {
    const ids = S.order.slice();
    const main = S.bots.main ? 'main' : ids[0];
    const botIds = main ? [main].concat(ids.filter(i => i !== main)) : ['main'];
    const out = botIds.map(id => ({ id: 'bot:' + id, kind: 'bot', bot: id }));
    for (const r of rooms.list) out.push({ id: 'room:' + r.id, kind: 'room', room: r });
    out.push({ id: 'all', kind: 'all' });
    return out;
  }
  function curConv() {
    const list = convs();
    return list.find(c => c.id === ui.cur) || list[0];
  }

  // Messages of one conversation, already cleaned; internal-only text is dropped by cleanText and nothing else is hidden.
  function messagesOf(c) {
    const out = [];
    const push = (key, sender, name, text, ms, system) => {
      const content = C.cleanText(text);
      if (!content) return;
      const m = { _id: key, content, senderId: sender, username: name, avatar: C.avatarUri(sender, name), date: fmtDate(ms), timestamp: fmtTime(ms) };
      if (system) m.system = true;
      out.push(m);
    };
    if (c.kind === 'room') {
      // rooms.msgs is the transcript of the OPEN room only; another room must not borrow it for its list preview
      for (const m of (c.room.id === ui.room ? rooms.msgs : [])) {
        const human = m.kind === 'human';
        const name = human ? tr('conv.you') : RM.label(m);
        push('r' + (m.id == null ? out.length : m.id), human ? ME : 'sp:' + name, name, m.text == null ? '' : String(m.text), stamp('r' + m.id, m.ts || m.at || m.time));
      }
      return out;
    }
    const all = c.kind === 'all';
    let lastUser = null;
    for (const t of D.thread(S, all ? null : c.bot)) {
      const who = botName(t.bot);
      t.entries.forEach((e, i) => {
        const key = t.id + ':' + i;
        const ms = stamp(key, e.ts || e.at || (i === 0 ? t.startedAt || t.ts || t.createdAt : null));
        if (e.kind === 'user') {
          if (all && lastUser === e.text) return;
          lastUser = e.text;
          push(key, ME, tr('conv.you'), e.text, ms);
        } else if (e.kind === 'msg') push(key, t.bot, who, e.text, ms);
        else if (e.kind === 'note') push(key, t.bot, who, e.text, ms, true);
        else if (e.kind === 'tool') {
          const st = tr(e.status === 'running' ? 'chip.running' : e.status === 'ok' ? 'chip.ok' : 'chip.failed');
          push(key, t.bot, who, e.tool + ': ' + oneLine(e.summary, 140) + ' - ' + st, ms, true);
        } else if (e.kind === 'card') {
          const cd = S.cards[e.cardId];
          if (cd && cd.status !== 'pending') {
            const res = { yes: tr('card.approved'), no: tr('card.denied'), timeout: tr('card.timeout') }[cd.status] || cd.status;
            push(key, t.bot, who, (cd.tool || tr('card.approval')) + ': ' + oneLine(cd.summary, 140) + ' - ' + res, ms, true);
          }
        }
      });
    }
    return out;
  }

  function roomObjects() {
    return convs().map(c => {
      const users = [{ _id: ME, username: tr('conv.you'), avatar: C.avatarUri(ME, tr('conv.you')) }];
      let name, avId, typing = [], preview = '';
      if (c.kind === 'bot') {
        const b = S.bots[c.bot] || { id: c.bot, name: c.bot, status: 'idle' };
        name = b.name || c.bot; avId = c.bot;
        const online = b.status !== 'offline';
        users.push({ _id: c.bot, username: name, avatar: C.avatarUri(c.bot, name), status: { state: online ? 'online' : 'offline', lastChanged: online ? '' : word('status', 'offline') } });
        if (b.status === 'busy') typing = [c.bot];
      } else if (c.kind === 'room') {
        name = c.room.name + ' (' + c.room.members + ')'; avId = 'room:' + c.room.id;
        preview = tr(c.room.members === 1 ? 'conv.group.one' : 'conv.group.many', { n: c.room.members });
        users.push({ _id: avId, username: c.room.name, avatar: C.avatarUri(avId, c.room.name), status: { state: 'online', lastChanged: '' } });
        // the component shows sender names only when a room has more than two users, so list every speaker
        if (ui.room === c.room.id) for (const m of rooms.msgs) if (m.kind !== 'human') { const nm = RM.label(m), id = 'sp:' + nm; if (!users.some(u => u._id === id)) users.push({ _id: id, username: nm, avatar: C.avatarUri(id, nm), status: { state: 'online', lastChanged: '' } }); }
      } else {
        name = tr('conv.all'); avId = 'all';
        preview = tr('conv.broadcast');
        users.push({ _id: 'all', username: name, avatar: C.avatarUri('all', name), status: { state: 'online', lastChanged: '' } });
        if (S.order.some(i => S.bots[i].status === 'busy')) typing = ['all'];
        for (const i of S.order) users.push({ _id: i, username: botName(i), avatar: C.avatarUri(i, botName(i)), status: { state: 'online', lastChanged: '' } }); // names show on each bubble
      }
      const ms = messagesOf(c);
      const lastM = ms.length ? ms[ms.length - 1] : null;
      if (lastM) preview = (lastM.senderId === ME ? tr('conv.you') + ': ' : (c.kind === 'bot' ? '' : lastM.username + ': ')) + oneLine(lastM.content, 60);
      return { roomId: c.id, roomName: name, avatar: C.avatarUri(avId, name), unreadCount: 0, index: 0,
        lastMessage: { content: preview || tr('conv.noreply'), timestamp: lastM ? lastM.timestamp : '', saved: true, distributed: true, seen: true, new: false }, users, typingUsers: typing };
    });
  }

  // ---- push state into the component only when it changed (a rewritten array would reset the scroll position)
  let pendingOpen = ui.cur; // a ?room= conversation opens once the group list has loaded
  const last = { rooms: '', msgs: '', tm: '', styles: '', theme: '', cur: '' };
  const dark = () => { try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (e) { return false; } };
  function chatStyles(isDark) {
    const accent = isDark ? '#6ea8fe' : '#2563eb';
    return { general: { color: isDark ? '#e6e8eb' : '#1a1d21', colorSpinner: accent, borderStyle: '1px solid ' + (isDark ? '#2b3036' : '#dfe3e8') },
      container: { border: 'none', borderRadius: '0', boxShadow: 'none' },
      message: { backgroundMe: isDark ? '#1f3a66' : '#dbe8ff', background: isDark ? '#23282e' : '#f0f2f5', colorUsername: accent } };
  }
  function drawChat() {
    if (!chat) return;
    const th = dark() ? 'dark' : 'light';
    if (last.theme !== th) { last.theme = th; chat.setAttribute('theme', th); setProp(chat, 'styles', JSON.stringify(chatStyles(th === 'dark'))); }
    const tm = JSON.stringify({ ROOMS_EMPTY: tr('vac.ROOMS_EMPTY'), ROOM_EMPTY: tr('vac.ROOM_EMPTY'), NEW_MESSAGES: tr('vac.NEW_MESSAGES'), MESSAGE_DELETED: tr('vac.MESSAGE_DELETED'),
      MESSAGES_EMPTY: tr('vac.MESSAGES_EMPTY'), CONVERSATION_STARTED: tr('vac.CONVERSATION_STARTED'), TYPE_MESSAGE: tr('vac.TYPE_MESSAGE'), SEARCH: tr('vac.SEARCH'),
      IS_ONLINE: tr('vac.IS_ONLINE'), LAST_SEEN: tr('vac.LAST_SEEN'), IS_TYPING: tr('vac.IS_TYPING'), CANCEL_SELECT_MESSAGE: tr('vac.CANCEL_SELECT_MESSAGE') });
    if (last.tm !== tm) { last.tm = tm; setProp(chat, 'textMessages', tm); }
    const c = curConv();
    const ro = JSON.stringify(roomObjects());
    if (last.rooms !== ro) { last.rooms = ro; setProp(chat, 'rooms', ro); chat.setAttribute('rooms-loaded', 'true'); }
    const ms = JSON.stringify(messagesOf(c));
    const sig = c.id + '\n' + ms;
    if (last.msgs !== sig) { last.msgs = sig; setProp(chat, 'messages', ms); chat.setAttribute('messages-loaded', 'true'); }
    if (pendingOpen && c.id === pendingOpen) { pendingOpen = null; last.cur = c.id; chat.setAttribute('room-id', c.id); }
    else if (!last.cur) { last.cur = c.id; if (window.innerWidth > 600) chat.setAttribute('room-id', c.id); }
  }
  // Open a conversation from code (the "waiting" button); on a phone this also leaves the list pane.
  function openConv(id) { setCurrent(id); last.cur = id; chat.setAttribute('room-id', id); render(); }
  function setCurrent(id) {
    ui.cur = id; last.msgs = '';
    if (id.indexOf('room:') === 0) selectRoom(id.slice(5)); else { ui.room = null; roomGen++; rooms.msgs = []; urlRoom(); }
  }
  function urlRoom() {
    try { const q = RM.withRoom(location.search, ui.room); if (q !== location.search) history.replaceState(null, '', location.pathname + q + location.hash); } catch (e) { /* ignore */ }
  }
  if (chat) {
    chat.addEventListener('fetch-messages', e => {
      const d = e.detail && e.detail[0], id = d && d.room && d.room.roomId;
      if (id && id !== ui.cur) { setCurrent(id); render(); } else if (id) { last.msgs = ''; render(); }
    });
    chat.addEventListener('send-message', e => { const d = e.detail && e.detail[0]; if (d) sendFrom(d.roomId || ui.cur, d.content); });
  }
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (mq && mq.addEventListener) mq.addEventListener('change', () => render());

  // ---- header and the strip above the chat (approvals, questions, undo, send errors)
  let queued = false;
  function render() { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; draw(); }); } }
  function draw() {
    drawTop(); drawQuestions(); drawCards(); drawUndo();
    $('strip').hidden = !($('questions').childNodes.length || $('cards').childNodes.length || $('undo').childNodes.length);
    $('send-msg').hidden = !$('send-msg').textContent;
    drawChat();
    tick();
  }
  function drawTop() {
    const un = D.unverifiedTotal(S);
    const cb = $('claims-badge');
    cb.hidden = !un; cb.className = 'badge bad';
    cb.textContent = un ? tr(un === 1 ? 'claims.one' : 'claims.many', { n: un }) : '';
    const n = D.pendingCards(S).length, w = $('waiting');
    w.hidden = !n; w.textContent = tr('waiting', { n });
    const c = $('conn'); c.dataset.state = ui.conn; c.textContent = word('conn', ui.conn);
  }
  $('waiting').addEventListener('click', () => { const p = D.pendingCards(S)[0]; if (p && S.bots[p.bot]) openConv('bot:' + p.bot); });

  let roomGen = 0; // bumped on every room pick and on leaving room mode; stale poll responses are dropped
  function selectRoom(id) {
    roomGen++;
    ui.room = id; rooms.msgs = []; urlRoom(); render();
    if (id) pollRoom();
  }
  async function pollRoom() {
    const id = ui.room, gen = roomGen;
    if (!id || rooms.busy || ui.needAuth) return;
    rooms.busy = true;
    try {
      const r = await api(RM.messagesPath(id, RM.lastId(rooms.msgs)));
      if (r.ok && r.body && ui.room === id && gen === roomGen) { const n = RM.merge(rooms.msgs, r.body.messages); if (n.length !== rooms.msgs.length) { rooms.msgs = n; render(); } }
    } catch (err) { /* retry on the next poll */ }
    rooms.busy = false;
  }
  setInterval(pollRoom, 3000);
  async function loadRooms(keepOnError) {
    let ok = false;
    const prev = rooms.list;
    try { const r = await api(RM.listPath()); rooms.list = RM.parseRooms(r); ok = RM.listOk(r); } catch (err) { rooms.list = []; }
    if (!ok && keepOnError) rooms.list = prev; // a failed refresh keeps the list as it was
    // Only a successful list can say the requested room is gone; a 401 or network error keeps ?room= until the next try.
    if (ok && ui.room && !rooms.list.some(r => r.id === ui.room)) { ui.room = null; ui.cur = null; roomGen++; urlRoom(); }
  }

  // Approval cards (every pending one, with the bot's name), question cards and the undo row sit above the chat.
  function drawCards() {
    $('cards').replaceChildren(...D.pendingCards(S).map(c => cardView(c)));
  }
  function cardView(c) {
    const busy = ui.busyCards.has(c.id);
    const answer = a => async () => {
      ui.busyCards.add(c.id); ui.cardMsg[c.id] = ''; render();
      try {
        const r = await post('/api/cards/' + encodeURIComponent(c.id), { answer: a });
        if (r.status === 409) ui.cardMsg[c.id] = tr('card.err.understood');
        else if (!r.ok) ui.cardMsg[c.id] = tr('card.err.send', { status: r.status });
        else if (c.status === 'pending') { S.cards[c.id].status = a; }
      } catch (err) { ui.cardMsg[c.id] = isAuth(err) ? '' : tr('card.err.net'); }
      ui.busyCards.delete(c.id); render();
    };
    return h('div', { class: 'card' },
      h('h3', null, (c.bot && S.bots[c.bot] ? botName(c.bot) + ': ' : '') + tr('card.approve', { tool: c.tool || tr('card.action') })),
      h('p', { class: 'sum' }, c.summary),
      h('span', null, tr('card.timeleft')), h('span', { class: 'cd', 'data-exp': c.expiresAt == null ? '' : String(c.expiresAt) }, ''),
      h('div', { class: 'btns' },
        h('button', { type: 'button', class: 'btn-yes', disabled: busy, onclick: answer('yes') }, tr('card.yes')),
        h('button', { type: 'button', class: 'btn-no', disabled: busy, onclick: answer('no') }, tr('card.no'))),
      ui.cardMsg[c.id] ? h('p', { class: 'hint', role: 'alert' }, ui.cardMsg[c.id]) : null);
  }

  // Undo applies to the newest task of the open conversation that can still be undone.
  function drawUndo() {
    const c = curConv();
    const tasks = D.thread(S, c.kind === 'bot' ? c.bot : null).filter(t => D.canUndo(t, S));
    const t = tasks[tasks.length - 1];
    $('undo').replaceChildren(...(t ? [undoRow(t)] : []));
  }
  function undoRow(t) {
    if (ui.confirmUndo !== t.id) return h('div', { class: 'undo-row' }, h('button', { type: 'button', onclick: () => { ui.confirmUndo = t.id; render(); } }, tr('undo')));
    const lastU = t.undo[t.undo.length - 1];
    return h('div', { class: 'undo-row' },
      h('span', { class: 'ask' }, tr('undo.ask', { label: lastU && lastU.label ? ' (' + lastU.label + ')' : '' })),
      h('button', { type: 'button', class: 'go', onclick: () => doUndo(t) }, tr('undo.yes')),
      h('button', { type: 'button', onclick: () => { ui.confirmUndo = null; render(); } }, tr('undo.cancel')));
  }
  async function doUndo(t) {
    ui.confirmUndo = null;
    let text;
    try {
      const r = await post('/api/tasks/' + encodeURIComponent(t.id) + '/undo');
      if (r.ok && r.body && r.body.nothingLeft) {
        t.undo = [];
        text = tr('undo.none');
      } else if (r.ok && r.body) {
        t.undo.pop();
        text = tr('undo.done', { to: r.body.restoredTo == null ? tr('undo.prev') : String(r.body.restoredTo) }) + (r.body.redoHint ? tr('undo.redo', { hint: r.body.redoHint }) : '');
      } else text = tr('undo.fail') + (r.body && r.body.error ? ': ' + r.body.error : ' (' + r.status + ')');
    } catch (err) { text = isAuth(err) ? '' : tr('undo.fail.net'); }
    if (text) t.entries.push({ kind: 'note', text });
    render();
  }

  // ---- countdown: one timer updates the text of every pending card
  function tick() {
    const now = Date.now();
    for (const el of document.querySelectorAll('.cd')) {
      const v = el.dataset.exp, sec = v === '' ? null : D.remainingSec(/^\d+$/.test(v) ? Number(v) : v, now);
      el.textContent = sec == null ? '' : sec <= 0 ? tr('card.expired') : D.fmtCountdown(sec);
    }
  }
  setInterval(tick, 1000);

  // ---- sending: a bot conversation talks to that bot only, a group says it in that room, "All bots" broadcasts.
  async function sendFrom(convId, text) {
    const msg = $('send-msg');
    const c = convs().find(x => x.id === convId);
    if (!c) return;
    msg.textContent = ''; msg.hidden = true;
    // a failed send puts the text back in the box (unless the owner already typed something new)
    const restore = () => { try { const ta = $('chat').shadowRoot.querySelector('textarea'); if (ta && !ta.value) { ta.value = text; ta.dispatchEvent(new Event('input', { bubbles: true })); } } catch (e) { /* no box yet */ } };
    const fail = (r, err) => { restore(); if (err && err.auth) return; msg.textContent = err ? tr('send.fail.net') : tr('send.fail') + (r.body && r.body.error ? ': ' + r.body.error : ' (' + r.status + ')'); msg.hidden = false; };
    try {
      if (c.kind === 'room') {
        const rb = RM.sayBody(text);
        if (!rb) return;
        const r = await post(RM.sayPath(c.room.id), rb);
        if (r.ok) pollRoom(); else fail(r);
        return;
      }
      const body = c.kind === 'all' ? D.chatBody(true, new Set(), text) : D.chatBody(false, new Set([c.bot]), text);
      if (!body) return;
      const r = await post('/api/chat', body);
      if (!r.ok) fail(r);
    } catch (err) { fail(null, isAuth(err) ? { auth: true } : true); }
  }

  // ---- SSE over fetch (EventSource cannot send the Authorization header)
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let streaming = false;
  async function stream() {
    if (streaming) return;
    streaming = true;
    let backoff = 1000;
    while (!ui.needAuth) {
      const ctrl = new AbortController();
      let last = Date.now();
      const dog = setInterval(() => { if (Date.now() - last > 45000) ctrl.abort(); }, 5000);
      try {
        ui.conn = 'connecting'; render();
        const r = await fetch('/api/events?since=' + S.lastSeq, { headers: headers({ Accept: 'text/event-stream' }), signal: ctrl.signal });
        if (r.status === 401) { showAuth(); break; }
        if (!r.ok || !r.body) throw new Error('status ' + r.status);
        ui.conn = 'live'; backoff = 1000; render();
        const rd = r.body.getReader(), dec = new TextDecoder();
        const p = D.createSSEParser((type, data) => { D.reduce(S, type, data); render(); if (type === 'task_end') refreshBots(); });
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          last = Date.now();
          p.push(dec.decode(value, { stream: true }));
        }
      } catch (err) { /* fall through to reconnect */ }
      clearInterval(dog);
      ui.conn = 'reconnecting'; render();
      await sleep(backoff); backoff = Math.min(backoff * 2, 15000);
    }
    streaming = false;
  }

  // ---- question cards (question-cards module, e.g. "Undo task X?"): polled, shown above the thread.
  // A 403/404 means the module is off or not allowed here, so the box stays empty.
  const qs = { list: [], busy: new Set(), msg: {} };
  async function loadQuestions() {
    if (ui.needAuth) return;
    try { const r = await api('/m/question-cards/questions'); qs.list = r.ok && r.body && Array.isArray(r.body.questions) ? r.body.questions : []; } catch (e) { qs.list = []; }
    render();
  }
  function drawQuestions() {
    const box = $('questions');
    box.replaceChildren(...qs.list.map(q => {
      const id = q.question_id, busy = qs.busy.has(id);
      const pick = i => async () => {
        qs.busy.add(id); qs.msg[id] = ''; render();
        try {
          const r = await post('/m/question-cards/questions/' + encodeURIComponent(id) + '/answer', { choice: i + 1 });
          if (!r.ok) qs.msg[id] = tr('card.err.send', { status: r.status });
          else qs.list = qs.list.filter(x => x.question_id !== id);
        } catch (e) { qs.msg[id] = isAuth(e) ? '' : tr('card.err.net'); }
        qs.busy.delete(id); render(); loadQuestions();
      };
      const ct = I.cardText(q, lang || 'en'); // the chosen language when the question carries it, else the default text
      return h('div', { class: 'card' }, h('h3', null, tr('q.heading')), h('p', { class: 'sum' }, ct.text),
        h('div', { class: 'btns' }, ...ct.options.map((o, i) => h('button', { type: 'button', disabled: busy, onclick: pick(i) }, o))),
        qs.msg[id] ? h('p', { class: 'hint', role: 'alert' }, qs.msg[id]) : null);
    }));
  }
  setInterval(loadQuestions, 5000);

  // ---- "New group": a real button, not a model request. Roles come from /api/bots, the group is made by POST /m/roles/groups,
  // then the room list is re-read and the new room is opened. A failure stays inside the dialog and keeps what was typed.
  const ROLE_ID = /^r-[0-9a-f]{8}$/;
  const grp = { busy: false };
  function groupErr(msg) { const e = $('group-err'); e.textContent = msg || ''; e.hidden = !msg; }
  function openGroupDlg() {
    $('group-name').value = ''; groupErr('');
    const roles = S.order.filter(id => ROLE_ID.test(id));
    const list = $('group-list');
    if (!roles.length) list.replaceChildren(h('p', { class: 'hint' }, tr('group.none')));
    else list.replaceChildren(...roles.map(id => h('label', { class: 'pick' }, h('input', { type: 'checkbox', value: id }), h('span', null, S.bots[id].name))));
    $('group-dlg').hidden = false; $('group-name').focus();
  }
  function closeGroupDlg() { if (grp.busy) return; $('group-dlg').hidden = true; $('new-group').focus(); }
  async function submitGroup(e) {
    if (e) e.preventDefault();
    if (grp.busy) return;
    const name = $('group-name').value.trim();
    const members = [...document.querySelectorAll('#group-list input:checked')].map(x => x.value);
    if (!name || [...name].length > 40) return groupErr(tr('group.err.name'));
    if (!members.length || members.length > 16) return groupErr(tr('group.err.members'));
    grp.busy = true; groupErr(''); $('group-create').disabled = true; $('group-create').textContent = tr('group.creating');
    let msg = '', made = null;
    try {
      const r = await post('/m/roles/groups', { name, members });
      if (r.ok && r.body && typeof r.body.id === 'string') made = r.body;
      else if (r.status === 403) msg = tr('group.err.forbidden');
      else msg = (r.body && typeof r.body.error === 'string' && r.body.error) || tr('group.err.fail');
    } catch (err) { msg = isAuth(err) ? '' : tr('group.err.fail'); }
    grp.busy = false; $('group-create').disabled = false; $('group-create').textContent = tr('group.create');
    if (!made) return groupErr(msg); // an empty msg (pairing screen open) shows nothing and keeps the input
    $('group-dlg').hidden = true;
    await loadRooms(true);
    ui.cur = 'room:' + made.id; selectRoom(made.id);
  }
  $('new-group').addEventListener('click', openGroupDlg);
  $('group-cancel').addEventListener('click', closeGroupDlg);
  $('group-form').addEventListener('submit', submitGroup);
  $('group-dlg').addEventListener('keydown', e => { if (e.key === 'Escape') closeGroupDlg(); });

  async function boot() {
    try {
      const [b, t, c] = await Promise.all([api('/api/bots'), api('/api/tasks?limit=50'), api('/api/cards?state=pending')]);
      if (b.ok) D.applyBots(S, b.body);
      if (t.ok) D.applyTasks(S, t.body);
      if (c.ok) D.applyCards(S, c.body);
    } catch (err) { /* unauthorized shows the token form; others retry via the stream */ }
    await loadRooms(); await loadQuestions();
    render();
    stream().catch(err => console.error('chat-ui: the live stream stopped: ' + ((err && err.message) || err)));
  }
  // Refresh the roster: after each finished task, and every 15 s while the page is visible, so offline/busy
  // changes and bots that were added while the server runs (roles) show up.
  // Many task_end events can arrive at once (the replay after a reload): they share one pending refresh.
  let botsTimer = null;
  function refreshBots() {
    if (ui.needAuth || botsTimer) return;
    botsTimer = setTimeout(() => { botsTimer = null; loadBots(); }, 250);
  }
  async function loadBots() {
    if (ui.needAuth) return;
    try { const b = await api('/api/bots'); if (b.ok) { D.applyBots(S, b.body); render(); } } catch (err) { if (!isAuth(err)) console.warn('chat-ui: roster refresh failed: ' + ((err && err.message) || err)); }
  }
  setInterval(() => { if (document.visibilityState !== 'hidden') refreshBots(); }, 15000);
  // Re-read the room list every 5 s while visible, so a group made by asking in chat appears without a reload.
  setInterval(async () => { if (document.visibilityState !== 'hidden' && !ui.needAuth) { await loadRooms(true); render(); } }, 5000);

  // Redeem a #p= code right away: the fragment is already gone from the URL, so waiting for the language choice would lose it on a reload.
  const paired = pairCode ? redeemCode(pairCode) : Promise.resolve(null);
  pairCode = null;
  function start() {
    paired.then(err => { if (err) { showAuth(); $('pair-msg').textContent = err; } boot(); });
  }
  if (lang) start(); else { afterLang = start; showLangGate(); }
})();