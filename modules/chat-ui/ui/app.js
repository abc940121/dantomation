'use strict';
// Chat UI page. All server text goes into the DOM through textContent / text
// nodes (helper h below); no HTML string is ever built. Pure logic is in state.js.
(function () {
  const D = window.DantoState;
  const S = D.create();
  const RM = window.DantoRooms;
  const rooms = { list: [], msgs: [], busy: false }; // stays empty (and invisible) while the rooms module is off
  const TOKEN_KEY = 'taskmote.token';
  const ui = { view: null, all: false, targets: new Set(), openChips: new Set(), confirmUndo: null, cardMsg: {}, busyCards: new Set(), conn: 'connecting', needAuth: false, room: RM.roomFromSearch(location.search) };
  const $ = id => document.getElementById(id);

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
      if (!r.ok || !b || !b.token) return (b && b.error) || 'pairing failed';
      token = b.token;
      try { localStorage.setItem(TOKEN_KEY, token); } catch (e) { /* storage blocked: the token only lasts for this page */ }
      return null;
    } catch (e) { return 'pairing failed'; }
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

  // ---- rendering (whole view rebuilt; UI-only state lives in `ui`)
  let queued = false;
  function render() { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; draw(); }); } }

  function draw() {
    drawTop(); drawRoster(); if (ui.room) drawRoom(); else drawThread(); drawTargets();
    $('targets').hidden = !!ui.room;
    $('text').placeholder = ui.room ? 'Say something to the room' : 'Message';
  }

  function drawTop() {
    const un = D.unverifiedTotal(S);
    const cb = $('claims-badge');
    cb.hidden = !un; cb.className = 'badge bad';
    cb.textContent = un ? un + ' unverified claim' + (un === 1 ? '' : 's') : '';
    const n = D.pendingCards(S).length, w = $('waiting');
    w.hidden = !n; w.textContent = n + ' waiting for you';
    const c = $('conn'); c.dataset.state = ui.conn; c.textContent = ui.conn;
    drawRoomPick();
  }

  // Room picker: a select shown only while the rooms module answers. Options are rebuilt only when the list
  // changes, so an open dropdown is not closed by a re-render. The ?room= query follows the selection.
  function drawRoomPick() {
    const sel = $('room-pick');
    sel.hidden = !rooms.list.length;
    const sig = rooms.list.map(r => r.id + '\n' + r.name).join('\n');
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.replaceChildren(h('option', { value: '' }, 'No room'), ...rooms.list.map(r => h('option', { value: r.id }, r.name)));
    }
    sel.value = ui.room || '';
    try {
      const q = RM.withRoom(location.search, ui.room);
      if (q !== location.search) history.replaceState(null, '', location.pathname + q + location.hash);
    } catch (e) { /* ignore */ }
  }
  $('room-pick').addEventListener('change', e => selectRoom(e.target.value || null));

  function drawRoster() {
    const pend = {};
    for (const c of D.pendingCards(S)) pend[c.bot] = (pend[c.bot] || 0) + 1;
    const items = [h('button', { type: 'button', 'aria-current': String(ui.view === null), onclick: () => selectView(null) }, h('span', null, 'All activity'))];
    for (const id of S.order) {
      const b = S.bots[id];
      items.push(h('button', { type: 'button', 'aria-current': String(ui.view === id), onclick: () => selectView(id) },
        h('span', { class: 'dot ' + b.status, title: b.status }),
        h('span', null, b.name),
        h('span', { class: 'meta' }, b.status + (b.runsOn === 'worker' ? ' / worker' : '') + (pend[id] ? ' / ' + pend[id] + ' waiting' : ''))));
    }
    for (const r of rooms.list) {
      items.push(h('button', { type: 'button', class: 'room-btn', 'aria-current': String(ui.room === r.id), onclick: () => selectRoom(r.id) },
        h('span', null, r.name), h('span', { class: 'meta' }, 'room / ' + r.members + (r.members === 1 ? ' member' : ' members'))));
    }
    $('roster').replaceChildren(...items);
  }

  let roomGen = 0; // bumped on every room pick and on leaving room mode; stale poll responses are dropped
  function selectRoom(id) {
    roomGen++;
    ui.room = id; rooms.msgs = []; stickBottom = true; render();
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
  async function loadRooms() {
    let ok = false;
    try { const r = await api(RM.listPath()); rooms.list = RM.parseRooms(r); ok = RM.listOk(r); } catch (err) { rooms.list = []; }
    // Only a successful list can say the requested room is gone; a 401 or network error keeps ?room= until the next try.
    if (ok && ui.room && !rooms.list.some(r => r.id === ui.room)) { ui.room = null; roomGen++; }
  }

  function selectView(id) {
    ui.view = id; ui.room = null; roomGen++;
    if (id) { ui.all = false; ui.targets = new Set([id]); }
    render(); stickBottom = true;
  }

  function drawTargets() {
    const items = [h('button', { type: 'button', 'aria-pressed': String(ui.all), onclick: () => { ui.all = !ui.all; if (ui.all) ui.targets.clear(); render(); } }, 'All bots')];
    for (const id of S.order) {
      items.push(h('button', { type: 'button', 'aria-pressed': String(!ui.all && ui.targets.has(id)),
        onclick: () => { ui.all = false; if (ui.targets.has(id)) ui.targets.delete(id); else ui.targets.add(id); render(); } }, botName(id)));
    }
    $('targets').replaceChildren(...items);
  }

  let stickBottom = true;
  function drawRoom() {
    const box = $('thread');
    stickBottom = stickBottom || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (!rooms.msgs.length) { box.replaceChildren(h('p', { class: 'empty' }, 'No lines in this room yet. Say something below.')); return; }
    box.replaceChildren(...rooms.msgs.map(m => h('div', { class: 'room-line' + (m.kind === 'human' ? ' mine' : '') },
      h('span', { class: 'who' }, RM.label(m)), h('div', { class: 'bubble' + (m.kind === 'human' ? ' user' : '') }, String(m.text == null ? '' : m.text)))));
    if (stickBottom) box.scrollTop = box.scrollHeight;
    stickBottom = false;
  }

  function drawThread() {
    const box = $('thread');
    stickBottom = stickBottom || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const tasks = D.thread(S, ui.view);
    if (!tasks.length) { box.replaceChildren(h('p', { class: 'empty' }, 'No messages yet. Pick a bot below and say something.')); return; }
    box.replaceChildren(...tasks.map(taskBlock));
    if (stickBottom) box.scrollTop = box.scrollHeight;
    stickBottom = false;
    tick();
  }

  function taskBlock(t) {
    const head = h('div', { class: 'task-head' },
      ui.view ? null : h('span', { class: 'who' }, botName(t.bot)),
      h('span', null, t.state.replace('_', ' ')),
      t.claims ? h('span', { class: 'badge' + (t.claims.unverified ? ' bad' : '') }, 'claims ' + (t.claims.checked - t.claims.unverified) + '/' + t.claims.checked + ' verified') : null);
    return h('section', { class: 'task' }, head, t.entries.map(e => entry(t, e)), undoRow(t));
  }

  function entry(t, e) {
    if (e.kind === 'user') return h('div', { class: 'bubble user' }, e.text);
    if (e.kind === 'msg') return h('div', { class: 'bubble' + (e.live ? ' live' : '') }, e.text);
    if (e.kind === 'note') return h('p', { class: 'note' }, e.text);
    if (e.kind === 'tool') return toolChip(e);
    if (e.kind === 'card') return cardView(S.cards[e.cardId]);
    return null;
  }

  function toolChip(e) {
    const open = ui.openChips.has(e.callId);
    const label = e.status === 'running' ? 'running' : e.status === 'ok' ? 'ok' : 'failed';
    const btn = h('button', { type: 'button', class: 'chip', 'data-status': e.status, 'aria-expanded': String(open),
      onclick: () => { if (open) ui.openChips.delete(e.callId); else ui.openChips.add(e.callId); render(); } },
      h('strong', null, e.tool), h('span', { class: 'sum' }, e.summary), h('span', { class: 'state' }, label));
    if (!open) return btn;
    return h('div', null, btn, h('div', { class: 'chip-detail' }, e.summary + (e.result ? '\n' + e.result : '')));
  }

  function cardView(c) {
    if (!c) return null;
    if (c.status !== 'pending') {
      const word = { yes: 'Approved', no: 'Denied', timeout: 'Timed out (counts as no)' }[c.status] || c.status;
      return h('div', { class: 'card done' }, h('h3', null, c.tool || 'Approval'), c.summary ? h('p', { class: 'sum' }, c.summary) : null,
        h('span', { class: 'result ' + c.status }, word));
    }
    const busy = ui.busyCards.has(c.id);
    const answer = a => async () => {
      ui.busyCards.add(c.id); ui.cardMsg[c.id] = ''; render();
      try {
        const r = await post('/api/cards/' + encodeURIComponent(c.id), { answer: a });
        if (r.status === 409) ui.cardMsg[c.id] = 'That answer was not understood. Tap Yes or No.';
        else if (!r.ok) ui.cardMsg[c.id] = 'Could not send the answer (' + r.status + ').';
        else if (c.status === 'pending') { S.cards[c.id].status = a; }
      } catch (err) { ui.cardMsg[c.id] = 'Could not reach the server.'; }
      ui.busyCards.delete(c.id); render();
    };
    return h('div', { class: 'card' },
      h('h3', null, 'Approve ' + (c.tool || 'action') + '?'),
      h('p', { class: 'sum' }, c.summary),
      h('span', null, 'Time left: '), h('span', { class: 'cd', 'data-exp': c.expiresAt == null ? '' : String(c.expiresAt) }, ''),
      h('div', { class: 'btns' },
        h('button', { type: 'button', class: 'btn-yes', disabled: busy, onclick: answer('yes') }, 'Yes'),
        h('button', { type: 'button', class: 'btn-no', disabled: busy, onclick: answer('no') }, 'No')),
      ui.cardMsg[c.id] ? h('p', { class: 'hint', role: 'alert' }, ui.cardMsg[c.id]) : null);
  }

  function undoRow(t) {
    if (!D.canUndo(t, S)) return null;
    if (ui.confirmUndo !== t.id) return h('div', { class: 'undo-row' }, h('button', { type: 'button', onclick: () => { ui.confirmUndo = t.id; render(); } }, 'Undo'));
    const last = t.undo[t.undo.length - 1];
    return h('div', { class: 'undo-row' },
      h('span', { class: 'ask' }, 'Roll back this task' + (last && last.label ? ' (' + last.label + ')' : '') + '?'),
      h('button', { type: 'button', class: 'go', onclick: () => doUndo(t) }, 'Yes, undo'),
      h('button', { type: 'button', onclick: () => { ui.confirmUndo = null; render(); } }, 'Cancel'));
  }

  async function doUndo(t) {
    ui.confirmUndo = null;
    let text;
    try {
      const r = await post('/api/tasks/' + encodeURIComponent(t.id) + '/undo');
      if (r.ok && r.body && r.body.nothingLeft) {
        t.undo = [];
        text = 'Nothing left to undo: the folder already matches every undo point.';
      } else if (r.ok && r.body) {
        t.undo.pop();
        text = 'Undone. Restored to ' + (r.body.restoredTo == null ? 'the previous point' : String(r.body.restoredTo)) + '.' + (r.body.redoHint ? '\nTo redo: ' + r.body.redoHint : '');
      } else text = 'Undo failed' + (r.body && r.body.error ? ': ' + r.body.error : ' (' + r.status + ')');
    } catch (err) { text = 'Undo failed: could not reach the server.'; }
    t.entries.push({ kind: 'note', text });
    stickBottom = true; render();
  }

  // ---- countdown: one timer updates the text of every pending card
  function tick() {
    const now = Date.now();
    for (const el of document.querySelectorAll('.cd')) {
      const v = el.dataset.exp, sec = v === '' ? null : D.remainingSec(/^\d+$/.test(v) ? Number(v) : v, now);
      el.textContent = sec == null ? '' : D.fmtCountdown(sec);
    }
  }
  setInterval(tick, 1000);

  // ---- composer
  $('composer').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('send-msg');
    if (ui.room) {
      const rb = RM.sayBody($('text').value);
      if (!rb) { msg.textContent = 'Type a message first.'; return; }
      $('send').disabled = true; msg.textContent = '';
      const sentRoom = ui.room, sentGen = roomGen, sentText = $('text').value;
      try {
        const r = await post(RM.sayPath(ui.room), rb);
        if (r.ok) { if (ui.room === sentRoom && roomGen === sentGen && $('text').value === sentText) $('text').value = ''; stickBottom = true; pollRoom(); } else msg.textContent = 'Send failed' + (r.body && r.body.error ? ': ' + r.body.error : ' (' + r.status + ')');
      } catch (err) { msg.textContent = 'Send failed: could not reach the server.'; }
      $('send').disabled = false;
      return;
    }
    const body = D.chatBody(ui.all, ui.targets, $('text').value);
    if (!body) { msg.textContent = $('text').value.trim() ? 'Pick at least one bot to send to.' : 'Type a message first.'; return; }
    $('send').disabled = true; msg.textContent = '';
    try {
      const r = await post('/api/chat', body);
      if (r.ok) { $('text').value = ''; stickBottom = true; } else msg.textContent = 'Send failed' + (r.body && r.body.error ? ': ' + r.body.error : ' (' + r.status + ')');
    } catch (err) { msg.textContent = 'Send failed: could not reach the server.'; }
    $('send').disabled = false;
  });
  $('text').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('composer').requestSubmit(); }
  });
  $('waiting').addEventListener('click', () => selectView(null));

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
        const p = D.createSSEParser((type, data) => { D.reduce(S, type, data); render(); });
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

  async function boot() {
    try {
      const [b, t, c] = await Promise.all([api('/api/bots'), api('/api/tasks?limit=50'), api('/api/cards?state=pending')]);
      if (b.ok) D.applyBots(S, b.body);
      if (t.ok) D.applyTasks(S, t.body);
      if (c.ok) D.applyCards(S, c.body);
    } catch (err) { /* unauthorized shows the token form; others retry via the stream */ }
    await loadRooms();
    render(); stream();
  }
  // Refresh the roster now and then so offline/busy changes without events show up.
  setInterval(async () => {
    if (ui.needAuth) return;
    try { const b = await api('/api/bots'); if (b.ok) { D.applyBots(S, b.body); render(); } } catch (err) { /* ignore */ }
  }, 30000);

  if (pairCode) { const c = pairCode; pairCode = null; redeemCode(c).then(err => { if (err) { showAuth(); $('pair-msg').textContent = err; } boot(); }); } else boot();
})();
