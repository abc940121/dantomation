#!/usr/bin/env node
'use strict';
// chat-ui: (1) pure client logic in ui/state.js, (2) the mock server over HTTP,
// (3) the mock stream folded through the real reducer, (4) static asset checks.
// No browser. Needs the chat-ui module enabled (SKIP otherwise). Loopback only.
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UI = path.join(__dirname, '..', 'ui');
const cur = require(path.join(ROOT, 'lib', 'config')).load();
if (!cur.modules['chat-ui']) { console.log('SKIP: chat-ui is not enabled in this config'); process.exit(0); }

const D = require(path.join(UI, 'state.js'));
const { createMock, MOUNT } = require('../mock-server.js');
const vm = require('vm');
const mod = require('..');
const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !info ? '' : ': ' + info}`); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- 1. state.js
{
  const s = D.create();
  D.applyBots(s, [{ id: 'a', name: 'A', status: 'idle' }, { id: 'b', name: 'B', status: 'busy', runsOn: 'worker' }]);
  check('bots roster loaded in order', eq(s.order, ['a', 'b']) && s.bots.b.runsOn === 'worker');
  const ev = (type, d) => D.reduce(s, type, d);
  ev('task_start', { seq: 1, task: 't1', bot: 'a', prompt: 'hi' });
  ev('message', { seq: 2, task: 't1', bot: 'a', text: 'part', final: false });
  ev('message', { seq: 3, task: 't1', bot: 'a', text: 'whole', final: true });
  const t = s.tasks.t1;
  check('prompt is the first entry', t.entries[0].kind === 'user' && t.entries[0].text === 'hi');
  check('non-final message is replaced by the final one', t.entries.filter(e => e.kind === 'msg').length === 1 && t.entries[1].text === 'whole' && !t.entries[1].live);
  ev('tool_call', { seq: 4, task: 't1', bot: 'a', callId: 'c1', tool: 'Bash', summary: 'ls' });
  check('tool chip starts running', t.entries[2].status === 'running');
  ev('tool_result', { seq: 5, task: 't1', callId: 'c1', ok: true, summary: 'ok' });
  check('tool_result -> ok with summary', t.entries[2].status === 'ok' && t.entries[2].result === 'ok');
  ev('tool_call', { seq: 6, task: 't1', bot: 'a', callId: 'c2', tool: 'Bash', summary: 'x' });
  ev('tool_result', { seq: 7, task: 't1', callId: 'c2', ok: false, summary: 'boom' });
  check('tool_result -> failed', t.entries[3].status === 'failed');
  ev('tool_result', { seq: 8, task: 't1', callId: 'zz', ok: true, summary: 'late' });
  check('result without call makes a stub chip', t.entries.some(e => e.callId === 'zz' && e.status === 'ok'));
  // dedupe on replay
  const n = t.entries.length;
  ev('tool_call', { seq: 6, task: 't1', bot: 'a', callId: 'c9', tool: 'X', summary: '' });
  check('seq at or below lastSeq is ignored', t.entries.length === n && s.lastSeq === 8);
  ev('tool_call', { seq: 9, task: 't1', bot: 'a', callId: 'c1', tool: 'Bash', summary: 'ls' });
  check('duplicate callId is not added twice', t.entries.filter(e => e.callId === 'c1').length === 1);

  // cards
  ev('card_pending', { seq: 10, card: { id: 'card-1', task: 't1', bot: 'a', tool: 'Bash', summary: 'git push', expiresAt: '2030-01-01T00:00:10Z' } });
  check('card_pending adds an inline card and waits', t.entries.some(e => e.kind === 'card') && s.cards['card-1'].status === 'pending' && t.state === 'waiting_card' && D.pendingCards(s).length === 1);
  ev('card_resolved', { seq: 11, cardId: 'card-1', answer: 'yes' });
  check('card_resolved shows the answer and resumes', s.cards['card-1'].status === 'yes' && t.state === 'running' && D.pendingCards(s).length === 0);
  ev('card_pending', { seq: 12, card: { id: 'card-2', task: 't1', bot: 'a', tool: 'Bash', summary: 's', expiresAt: 1 } });
  ev('card_resolved', { seq: 13, cardId: 'card-2', answer: 'timeout' });
  check('timeout answer is kept', s.cards['card-2'].status === 'timeout');
  ev('card_resolved', { seq: 14, cardId: 'never-seen', answer: 'no' });
  check('resolved unknown card is harmless', s.cards['never-seen'].status === 'no');

  // undo / claims / end / bot status
  check('no undo while running', !D.canUndo(t));
  ev('undo_point', { seq: 15, task: 't1', n: 1, label: 'before' });
  ev('claims', { seq: 16, task: 't1', checked: 3, unverified: 1 });
  ev('task_end', { seq: 17, task: 't1', state: 'done' });
  ev('bot_status', { seq: 18, bot: 'a', status: 'busy' });
  check('undo available after the task ends', D.canUndo(t, s) && t.undo[0].n === 1);
  check('undo hidden on an older task once a newer one exists', (() => { const s2 = D.create(); D.reduce(s2, 'task_start', { seq: 1, task: 'o1', bot: 'a' }); D.reduce(s2, 'undo_point', { seq: 2, task: 'o1', n: 1, label: 'x' }); D.reduce(s2, 'task_end', { seq: 3, task: 'o1', state: 'done' }); const ok1 = D.canUndo(s2.tasks.o1, s2); D.reduce(s2, 'task_start', { seq: 4, task: 'o2', bot: 'a' }); return ok1 && !D.canUndo(s2.tasks.o1, s2); })());
  check('claims stored and totalled', eq(t.claims, { checked: 3, unverified: 1 }) && D.unverifiedTotal(s) === 1);
  check('bot_status updates the dot', s.bots.a.status === 'busy');
  ev('task_start', { seq: 19, task: 't2', bot: 'b', prompt: 'yo' });
  check('thread filter per bot and combined', D.thread(s, 'a').length === 1 && D.thread(s, 'b').length === 1 && D.thread(s, null).length === 2 && D.thread(s, null)[0].id === 't1');
  ev('nonsense', { seq: 20 }); D.reduce(s, 'message', null);
  check('unknown event and null data are ignored', s.lastSeq === 20);

  // API seeding
  const s2 = D.create();
  D.applyTasks(s2, [{ id: 'n2', bot: 'a', prompt: 'second', state: 'done', claims: { checked: 1, unverified: 0 } }, { id: 'n1', bot: 'a', prompt: 'first', state: 'done' }]);
  check('tasks seeded oldest first with prompt', eq(D.thread(s2, null).map(x => x.id), ['n1', 'n2']) && s2.tasks.n1.entries[0].text === 'first');
  D.reduce(s2, 'task_start', { seq: 1, task: 'n1', bot: 'a', prompt: 'first' });
  check('task_start after seeding keeps one prompt entry', s2.tasks.n1.entries.filter(e => e.kind === 'user').length === 1);

  // helpers
  check('chatBody all / list / empty', eq(D.chatBody(true, new Set(), ' hi '), { bots: 'all', text: 'hi' }) && eq(D.chatBody(false, new Set(['a', 'b']), 'x'), { bots: ['a', 'b'], text: 'x' }) && D.chatBody(false, new Set(), 'x') === null && D.chatBody(true, new Set(), '  ') === null);
  check('remainingSec / fmtCountdown', D.remainingSec('2030-01-01T00:00:10Z', Date.parse('2030-01-01T00:00:00Z')) === 10 && D.remainingSec(1000, 5000) === 0 && D.remainingSec('junk', 0) === null && D.fmtCountdown(125) === '2:05' && D.fmtCountdown(0) === 'expired' && D.fmtCountdown(null) === '');
  check('tokenFromHash', D.tokenFromHash('#t=abc%2B1') === 'abc+1' && D.tokenFromHash('#x=1&t=zz') === 'zz' && D.tokenFromHash('') === null && D.tokenFromHash('#t=') === null);
  check('pairFromHash / looksLikeCode', D.pairFromHash('#p=pc_abcDEF-123_xyz') === 'pc_abcDEF-123_xyz' && D.pairFromHash('#t=x') === null && D.pairFromHash('#p=12') === null && D.looksLikeCode('123456') && D.looksLikeCode('123 456') && D.looksLikeCode('pc_abcdefghijklmnop') && !D.looksLikeCode('some-owner-token-value'));

  // SSE parser: split across chunks, CRLF, comments, bad JSON
  const got = [];
  const p = D.createSSEParser((t, d) => got.push([t, d]));
  const wire = ': hi\r\n\r\nid: 1\r\nevent: message\r\ndata: {"seq":1,\r\ndata: "a":2}\r\n\r\nevent: x\ndata: not json\n\nevent: y\ndata: {"seq":2}\n\n';
  for (const c of wire.match(/[^]{1,5}/g)) p.push(c);
  check('SSE parser handles chunks, CRLF, multi-line data and bad JSON', eq(got, [['message', { seq: 1, a: 2 }], ['y', { seq: 2 }]]), JSON.stringify(got));
}

// ---------------------------------------------------------------- 2/3. mock over HTTP
const call = (port, method, p, body, token) => new Promise((res, rej) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: Object.assign({}, data ? { 'Content-Type': 'application/json' } : {}, token ? { Authorization: 'Bearer ' + token } : {}) }, r => {
    let b = ''; r.on('data', d => { b += d; }); r.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* not json */ } res({ status: r.statusCode, body: j, text: b, headers: r.headers }); });
  });
  req.on('error', rej); if (data) req.write(data); req.end();
});
// Open an SSE stream, fold events through the real parser; wait(pred) resolves when pred(events) holds.
function sse(port, since, token) {
  const events = [], waiters = [];
  let req;
  const parser = D.createSSEParser((type, data) => { events.push({ type, data }); for (const w of waiters.slice()) if (w.pred(events)) { waiters.splice(waiters.indexOf(w), 1); w.res(events); } });
  const open = new Promise(res => { req = http.get({ host: '127.0.0.1', port, path: '/api/events?since=' + since, headers: token ? { Authorization: 'Bearer ' + token } : {} }, r => { r.setEncoding('utf8'); r.on('data', c => parser.push(c)); res(r.statusCode); }); });
  const wait = (pred, ms = 8000) => new Promise((res, rej) => {
    if (pred(events)) return res(events);
    const w = { pred, res }; waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error('timeout waiting; saw ' + events.map(e => e.type).join(','))); } }, ms);
  });
  return { events, wait, open, close: () => req.destroy() };
}

async function mockTests() {
  const mock = createMock({ delayMs: 5, cardTtlMs: 60000 });
  await new Promise(r => mock.server.listen(0, '127.0.0.1', r));
  const port = mock.server.address().port;
  try {
    let r = await call(port, 'GET', '/api/bots');
    check('mock GET /api/bots has id, name, engine, status, runsOn', r.status === 200 && r.body.length >= 3 && r.body.every(b => b.id && b.name && b.engine && ['idle', 'busy', 'offline'].includes(b.status) && ['main', 'worker'].includes(b.runsOn)));
    r = await call(port, 'POST', '/api/chat', { bots: [], text: 'x' });
    check('mock chat rejects empty targets', r.status === 400);
    r = await call(port, 'POST', '/api/chat', { bots: ['nobody'], text: 'x' });
    check('mock chat rejects unknown bot', r.status === 400);

    // plain task through the reducer
    const live = sse(port, 0); await live.open;
    r = await call(port, 'POST', '/api/chat', { bots: ['scout'], text: 'hello there' });
    check('mock chat returns [{bot, taskId}]', r.status === 200 && r.body.length === 1 && r.body[0].bot === 'scout' && /^t\d+$/.test(r.body[0].taskId));
    const id = r.body[0].taskId;
    await live.wait(es => es.some(e => e.type === 'task_end' && e.data.task === id));
    const types = live.events.map(e => e.type);
    check('SSE script order', ['task_start', 'bot_status', 'message', 'tool_call', 'tool_result', 'undo_point', 'tool_call', 'tool_result', 'message', 'claims', 'task_end'].every((t, i, a) => types.indexOf(t, i ? types.indexOf(a[i - 1]) : 0) >= 0), types.join(','));
    const seqs = live.events.map(e => e.data.seq);
    check('events carry increasing seq', seqs.every((q, i) => i === 0 || q > seqs[i - 1]));
    const s = D.create(); D.applyBots(s, mock.state.bots.map(b => ({ ...b, status: 'idle' }))); for (const e of live.events) D.reduce(s, e.type, e.data);
    const t = s.tasks[id];
    check('mock stream folds to a finished task with chips, undo and claims', t.state === 'done' && t.entries.filter(e => e.kind === 'tool' && e.status === 'ok').length === 2 && D.canUndo(t) && t.claims.checked === 2 && s.bots.scout.status === 'idle', JSON.stringify(t));
    check('final message replaced the live one', t.entries.filter(e => e.kind === 'msg').length === 1 && t.entries.find(e => e.kind === 'msg').text.startsWith('Done'));

    // since replay
    const mid = live.events[3].data.seq;
    const re = sse(port, mid); await re.open;
    await re.wait(es => es.some(e => e.type === 'task_end'));
    check('events?since replays only later events', re.events[0].data.seq === mid + 1 && re.events.length === live.events.length - 4);
    re.close();

    // tasks and undo
    r = await call(port, 'GET', '/api/tasks?limit=5');
    check('GET /api/tasks lists the task', r.status === 200 && r.body[0].id === id && r.body[0].state === 'done');
    r = await call(port, 'GET', '/api/tasks/' + id);
    check('GET /api/tasks/:id', r.status === 200 && r.body.prompt === 'hello there' && r.body.claims.checked === 2);
    r = await call(port, 'POST', `/api/tasks/${id}/undo`);
    check('undo returns restoredTo and redoHint', r.status === 200 && r.body.restoredTo && r.body.redoHint);
    r = await call(port, 'POST', `/api/tasks/${id}/undo`);
    check('undo with nothing left is a plain answer, not an error', r.status === 200 && r.body.nothingLeft === true && r.body.restoredTo === null);
    r = await call(port, 'GET', '/api/tasks/nope');
    check('unknown task is 404', r.status === 404);

    // card flow: unclear -> 409, yes -> resolved
    const n0 = live.events.length;
    r = await call(port, 'POST', '/api/chat', { bots: ['builder'], text: 'do something risky' });
    const id2 = r.body[0].taskId;
    await live.wait(es => es.some(e => e.type === 'card_pending' && e.data.card.task === id2));
    const card = live.events.find(e => e.type === 'card_pending' && e.data.card.task === id2).data.card;
    check('card_pending has id, task, bot, tool, summary, expiresAt', card.id && card.bot === 'builder' && card.tool && card.summary && Date.parse(card.expiresAt) > Date.now());
    r = await call(port, 'GET', '/api/cards?state=pending');
    check('GET /api/cards?state=pending lists it', r.body.some(c => c.id === card.id));
    r = await call(port, 'POST', '/api/tasks/' + id2 + '/undo');
    check('undo while waiting for a card is refused', r.status === 409);
    r = await call(port, 'POST', '/api/cards/' + card.id, { answer: 'maybe later' });
    check('unclear free text answer is 409 and card stays pending', r.status === 409 && (await call(port, 'GET', '/api/cards?state=pending')).body.some(c => c.id === card.id));
    r = await call(port, 'POST', '/api/cards/' + card.id, { answer: 'yes' });
    check('answer yes accepted', r.status === 200);
    await live.wait(es => es.some(e => e.type === 'task_end' && e.data.task === id2));
    const res = live.events.slice(n0).find(e => e.type === 'card_resolved');
    check('card_resolved carries cardId and answer', res && res.data.cardId === card.id && res.data.answer === 'yes');
    r = await call(port, 'POST', '/api/cards/' + card.id, { answer: 'no' });
    check('answering a resolved card is 409', r.status === 409);

    // denial, failure, all, offline
    r = await call(port, 'POST', '/api/chat', { bots: ['scout'], text: 'risky and fail' });
    const id3 = r.body[0].taskId;
    await live.wait(es => es.some(e => e.type === 'card_pending' && e.data.card.task === id3));
    const c3 = live.events.filter(e => e.type === 'card_pending').pop().data.card;
    await call(port, 'POST', '/api/cards/' + c3.id, { answer: 'no' });
    await live.wait(es => es.some(e => e.type === 'task_end' && e.data.task === id3));
    check('denied card skips the tool', !live.events.some(e => e.type === 'tool_call' && e.data.task === id3 && e.data.tool === 'Bash') && live.events.some(e => e.type === 'card_resolved' && e.data.answer === 'no'));
    r = await call(port, 'POST', '/api/chat', { bots: 'all', text: 'fail please' });
    check('chat "all" fans out one task per bot', r.status === 200 && r.body.length === mock.state.bots.length);
    await live.wait(es => es.filter(e => e.type === 'task_end').length >= 6);
    const failed = live.events.find(e => e.type === 'tool_result' && e.data.ok === false);
    const off = live.events.find(e => e.type === 'task_end' && e.data.state === 'failed');
    check('failing tool and offline bot are reported', failed && off && live.events.some(e => e.type === 'claims' && e.data.unverified === 1));
    live.close();

    // static serving + auth
    r = await call(port, 'GET', MOUNT);
    check('mock serves index.html at the mount path', r.status === 200 && /<title>/.test(r.text) && /text\/html/.test(r.headers['content-type']));
    r = await call(port, 'GET', MOUNT + 'state.js');
    check('mock serves state.js as javascript', r.status === 200 && /javascript/.test(r.headers['content-type']));
    r = await call(port, 'GET', MOUNT + '..%2f..%2findex.js');
    check('static path traversal is refused', r.status === 404);
  } finally { await mock.close(); }

  const m2 = createMock({ delayMs: 1, token: 'secret-token' });
  await new Promise(r => m2.server.listen(0, '127.0.0.1', r));
  const p2 = m2.server.address().port;
  try {
    check('token mock: no token is 401', (await call(p2, 'GET', '/api/bots')).status === 401);
    check('token mock: wrong token is 401', (await call(p2, 'GET', '/api/bots', undefined, 'nope')).status === 401);
    check('token mock: right token is 200', (await call(p2, 'GET', '/api/bots', undefined, 'secret-token')).status === 200);
    const e = sse(p2, 0); const code = await e.open; e.close();
    check('token mock: events need the token', code === 401);
  } finally { await m2.close(); }
}

// ---------------------------------------------------------------- 4. static assets
function assetTests() {
  const files = fs.readdirSync(UI);
  check('ui has index.html, app.js, style.css, state.js', ['index.html', 'app.js', 'style.css', 'state.js'].every(f => files.includes(f)));
  const read = f => fs.readFileSync(path.join(UI, f), 'utf8');
  const html = read('index.html');
  check('viewport meta with viewport-fit=cover', /<meta\s+name="viewport"[^>]*width=device-width[^>]*viewport-fit=cover/.test(html));
  const all = files.map(f => [f, read(f)]);
  const ext = all.filter(([, c]) => /(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}|\bsrc="\/\/|@import|url\(\s*["']?https?:/i.test(c.replace(/\/\/ .*$/gm, '').replace(/\/\*[^]*?\*\//g, '')));
  check('no external URLs in ui files', ext.length === 0, ext.map(x => x[0]).join(','));
  const scripts = [...html.matchAll(/<(?:script|link|img)[^>]+(?:src|href)="([^"]+)"/g)].map(m => m[1]);
  check('html references only relative local files', scripts.length >= 3 && scripts.every(u => !/^([a-z]+:)?\/\//i.test(u) && files.includes(u)), scripts.join(','));
  const bad = all.filter(([f, c]) => f.endsWith('.js') && /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new Function)\b/.test(c.replace(/\/\/.*$/gm, '')));
  check('no innerHTML / outerHTML / insertAdjacentHTML / document.write / eval in js', bad.length === 0, bad.map(x => x[0]).join(','));
  check('no alert/confirm/prompt dialogs', !all.some(([f, c]) => f.endsWith('.js') && /(^|[^.\w])(alert|confirm|prompt)\s*\(/.test(c)));
  const css = read('style.css');
  check('css: dark mode, safe-area insets, tablet+ columns', /prefers-color-scheme:\s*dark/.test(css) && /env\(safe-area-inset-bottom\)/.test(css) && /env\(safe-area-inset-top\)/.test(css) && /min-width:\s*820px/.test(css));
  check('css: tap targets at least 44px', /button[^}]*min-height:\s*44px/.test(css));
  check('no names or user paths in module files', !fs.readdirSync(path.join(__dirname, '..'), { recursive: true }).filter(f => /\.(js|html|css|md)$/.test(f)).some(f => /\bDan\b|C:\\Users|\/Users\//.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'))));
  check('manifest: contract 2, one panel, entry exists under ui/, served at /m/chat-ui/ui/', mod.name === 'chat-ui' && mod.contract === 2 && mod.panels.length === 1 && /^ui\//.test(mod.panels[0].entry) && fs.existsSync(path.join(__dirname, '..', mod.panels[0].entry)) && MOUNT === '/m/chat-ui/ui/');
  hashTests();
  roomTests();
}

// rooms.js: pure helpers for the room picker, and the app wiring is static-checked.
function roomTests() {
  const RM = require(path.join(UI, 'rooms.js'));
  const list = RM.parseRooms({ ok: true, body: { rooms: [{ id: 'dev', name: 'Dev', members: [{}, {}] }, { id: 'x' }, { nope: 1 }] } });
  check('rooms: list parsed, bad rows dropped, name falls back to id', list.length === 2 && list[0].members === 2 && list[1].name === 'x');
  check('rooms: module off (404 / no body / bad shape) gives no rooms', RM.parseRooms({ ok: false, status: 404, body: null }).length === 0 && RM.parseRooms({ ok: true, body: {} }).length === 0 && RM.parseRooms(null).length === 0);
  const a = RM.merge([], [{ id: 'm1', text: 'a' }, { id: 'm2', text: 'b' }]);
  const b = RM.merge(a, [{ id: 'm2', text: 'b' }, { id: 'm3', text: 'c' }, null]);
  check('rooms: merge by id, no duplicates, order kept; lastId is the newest', b.length === 3 && RM.lastId(b) === 'm3' && RM.lastId([]) === null);
  check('rooms: paths are encoded and match the module routes', RM.messagesPath('a/b', 'm 1') === '/m/rooms/rooms/a%2Fb/messages?since=m%201' && RM.sayPath('dev') === '/m/rooms/rooms/dev/say' && RM.messagesPath('dev') === '/m/rooms/rooms/dev/messages');
  check('rooms: say body trims and refuses empty', eq(RM.sayBody('  hi '), { text: 'hi' }) && RM.sayBody('   ') === null && RM.sayBody(undefined) === null);
  check('rooms: label prefers the speaker label', RM.label({ label: 'Ann', speaker: 'ann' }) === 'Ann' && RM.label({ speaker: 'ann' }) === 'ann' && RM.label(null) === '?');
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  check('rooms: app never summarises and only calls say/messages/list', !/\/summary/.test(app + fs.readFileSync(path.join(UI, 'rooms.js'), 'utf8')) && /RM\.sayPath/.test(app));
  check('rooms: stale poll responses are dropped by a selection generation', /roomGen\+\+/.test(app) && /gen === roomGen/.test(app) && (app.match(/roomGen\+\+/g) || []).length >= 3);
  check('rooms: a finished send clears the composer only if room and text are unchanged', /\$\('text'\)\.value === sentText/.test(app) && /ui\.room === sentRoom && roomGen === sentGen/.test(app));
  check('rooms: ?room= read from the query and written back, other params kept', RM.roomFromSearch('?room=dev') === 'dev' && RM.roomFromSearch('?a=1') === null && RM.roomFromSearch('') === null && RM.withRoom('?a=1', 'x y') === '?a=1&room=x+y' && RM.withRoom('?room=dev', null) === '' && RM.withRoom('?a=1&room=dev', null) === '?a=1' && RM.roomFromSearch(RM.withRoom('', 'a&b=c')) === 'a&b=c');
  check('rooms: picker is a select filled from the room list and kept in sync with the URL', /id="room-pick"/.test(fs.readFileSync(path.join(UI, 'index.html'), 'utf8')) && /drawRoomPick/.test(app) && app.includes('RM.withRoom(location.search, ui.room)') && app.includes('RM.roomFromSearch(location.search)') && app.includes('selectRoom(e.target.value || null)'));
  check('rooms: a failed list (401, offline) is not a successful one, so it cannot drop ?room=', RM.listOk({ ok: true, body: { rooms: [] } }) === true && RM.listOk({ ok: false, status: 401, body: null }) === false && RM.listOk(null) === false && RM.listOk({ ok: true, body: {} }) === false && /ok && ui.room && !rooms.list.some/.test(app));
  check('rooms: index.html loads rooms.js before app.js', /rooms\.js[^]*app\.js/.test(fs.readFileSync(path.join(UI, 'index.html'), 'utf8')));
}

// app.js run in a vm with a stub DOM: the #t= token is taken at load and again on hashchange.
function hashTests() {
  const stub = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : stub()), apply: () => stub(), set: () => true });
  const run = hash => {
    const store = new Map(), handlers = {};
    const location = { hash, pathname: '/m/chat-ui/ui/index.html', search: '' };
    const win = { DantoState: D, DantoRooms: require(path.join(UI, 'rooms.js')), addEventListener: (ev, f) => { handlers[ev] = f; } };
    const ctx = { window: win, DantoState: D, location, history: { replaceState: (a, b, url) => { location.hash = ''; ctx.replaced = url; } },
      localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
      document: { getElementById: stub, createElement: stub, addEventListener: () => {}, body: stub(), hidden: false },
      fetch: () => Promise.reject(new Error('offline')), requestAnimationFrame: () => 0, setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
      console: { log() {}, error() {} }, AbortController, TextDecoder, URL, navigator: {} };
    ctx.self = ctx.globalThis = ctx;
    vm.runInNewContext(fs.readFileSync(path.join(UI, 'app.js'), 'utf8'), ctx);
    return { store, handlers, location, ctx };
  };
  const a = run('#t=first-token');
  check('token in the hash at load: stored and stripped', a.store.get('taskmote.token') === 'first-token' && a.location.hash === '' && a.ctx.replaced === '/m/chat-ui/ui/index.html');
  check('hashchange handler is registered', typeof a.handlers.hashchange === 'function');
  a.location.hash = '#t=second%2Btoken';
  a.handlers.hashchange();
  check('hashchange with #t=: new token stored and stripped', a.store.get('taskmote.token') === 'second+token' && a.location.hash === '');
  a.location.hash = '#other';
  a.handlers.hashchange();
  check('hashchange without a token changes nothing', a.store.get('taskmote.token') === 'second+token' && a.location.hash === '#other');
}

(async () => {
  assetTests();
  await mockTests();
  const fails = results.filter(x => !x).length;
  console.log(`result: ${results.length - fails}/${results.length} checks passed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL harness error: ' + e.stack); process.exit(1); });
