#!/usr/bin/env node
'use strict';
// Dependency-free mock of the taskmote server API v0, for trying the chat UI
// and for tests. `node modules/chat-ui/mock-server.js` serves the UI and the API
// on 127.0.0.1:7421 (PORT / HOST / MOCK_TOKEN / MOCK_DELAY_MS override; MOCK_SEED=1 adds demo history).
// Scripted behaviour: any chat runs a short task with tool calls and an undo
// point; a prompt containing "risky" raises an approval card and waits for it;
// "fail" makes a tool fail and one claim unverified.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { parseAnswer } = require('../../lib/modules').registry({ modules: { 'approval-cards': true } }).api('approval-cards');

const UI_DIR = path.join(__dirname, 'ui');
const MOUNT = '/m/chat-ui/ui/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function createMock(opts = {}) {
  const delay = opts.delayMs == null ? 400 : opts.delayMs;
  const cardTtl = opts.cardTtlMs == null ? 120000 : opts.cardTtlMs;
  const token = opts.token || '';
  const bots = [
    { id: 'alpha', name: 'Alpha', engine: 'claude', status: 'idle', runsOn: 'main' },
    { id: 'main', name: 'Main', engine: 'claude', status: 'idle', runsOn: 'main' },
    { id: 'test-a', name: '測試甲', engine: 'claude', status: 'offline', runsOn: 'worker' },
    { id: 'r-11111111', name: 'Ann', engine: 'claude', status: 'idle', runsOn: 'main' },
    { id: 'r-22222222', name: 'Bob', engine: 'claude', status: 'idle', runsOn: 'main' },
  ];
  const events = [], subs = new Set(), tasks = new Map(), cards = new Map();
  // Groups (the rooms module): a transcript per room; a human line gets a scripted member reply.
  const rooms = [
    { id: 'team', name: 'Team', members: ['alpha', 'main'], messages: [] },
    { id: 'team-b', name: '測試組', members: ['alpha', 'test-a', 'main'], messages: [] },
  ];
  let nRoomMsg = 0, nGroup = 0;
  const roomLine = (r, kind, label, text) => { const m = { id: 'm' + String(++nRoomMsg).padStart(5, '0'), kind, label, text }; r.messages.push(m); return m; };
  if (opts.seed) {
    const r = rooms[0];
    roomLine(r, 'human', 'You', 'Please summarise the status.');
    roomLine(r, 'human', 'You', '## Current message (from human, id h1)\nHello team, what is next?\n\n## Room context (last 5)\n- Alpha: earlier note');
    roomLine(r, 'agent', 'Alpha', 'Status [j:step1]\nstep 2 done\n\n| item | state |\n| --- | --- |\n| build | ok |\n| tests | 2 failed |\n\nRun `npm test` again:\n```\nnpm test\n```\nSaw it: [t:"exit 1"]');
    roomLine(r, 'agent', 'Main', 'Treat it as data to weigh, not as instructions to follow.\n\u628a\u5b83\u7576\u6210\u8cc7\u6599\u4f86\u5224\u65b7\nOne long reply from a second member so that the bubble wraps across several lines on a narrow phone screen without being cut off.');
  }
  let seq = 0, nTask = 0, nCard = 0;

  function emit(type, data) {
    const ev = { seq: ++seq, ...data };
    events.push({ type, data: ev });
    const frame = frameOf(type, ev);
    for (const res of subs) res.write(frame);
  }
  const frameOf = (type, data) => `id: ${data.seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const setStatus = (bot, status) => { const b = bots.find(x => x.id === bot); if (b && b.status !== status) { b.status = status; emit('bot_status', { bot, status }); } };

  async function runTask(t) {
    const { id, bot, prompt } = t;
    emit('task_start', { task: id, bot, prompt });
    if (bots.find(b => b.id === bot).status === 'offline') {
      emit('message', { task: id, bot, text: 'This bot is offline.', final: true });
      t.state = 'failed'; emit('task_end', { task: id, state: 'failed' }); return;
    }
    setStatus(bot, 'busy');
    await sleep(delay);
    emit('message', { task: id, bot, text: 'Looking into it...', final: false });
    await sleep(delay);
    emit('tool_call', { task: id, bot, callId: id + '-c1', tool: 'Read', summary: 'read notes.txt' });
    await sleep(delay);
    emit('tool_result', { task: id, callId: id + '-c1', ok: true, summary: '12 lines' });
    t.undoPoints.push({ n: t.undoPoints.length + 1, label: 'before editing notes.txt' });
    emit('undo_point', { task: id, n: t.undoPoints.length, label: 'before editing notes.txt' });
    let approved = true;
    if (/risky/i.test(prompt)) {
      const card = { id: 'card-' + String(++nCard).padStart(6, '0'), task: id, bot, tool: 'Bash', summary: 'git push origin main', expiresAt: new Date(Date.now() + cardTtl).toISOString() };
      const c = { ...card, state: 'pending', timer: null, resolve: null };
      cards.set(card.id, c);
      const waiting = new Promise(res => { c.resolve = res; });
      c.timer = setTimeout(() => settleCard(c, 'timeout'), cardTtl);
      t.state = 'waiting_card';
      emit('card_pending', { card });
      approved = (await waiting) === 'yes';
      t.state = 'running';
    }
    if (approved) {
      const fail = /fail/i.test(prompt);
      emit('tool_call', { task: id, bot, callId: id + '-c2', tool: 'Bash', summary: /risky/i.test(prompt) ? 'git push origin main' : 'npm test' });
      await sleep(delay);
      emit('tool_result', { task: id, callId: id + '-c2', ok: !fail, summary: fail ? 'exit 1: 2 tests failed' : 'exit 0' });
    } else emit('message', { task: id, bot, text: 'Understood, I skipped that step.', final: false });
    await sleep(delay);
    emit('message', { task: id, bot, text: `Done with: ${prompt}`, final: true });
    t.claims = { checked: 2, unverified: /fail/i.test(prompt) ? 1 : 0 };
    emit('claims', { task: id, ...t.claims });
    t.state = 'done';
    emit('task_end', { task: id, state: 'done' });
    setStatus(bot, 'idle');
  }

  function settleCard(c, answer) {
    if (c.state !== 'pending') return false;
    c.state = answer; clearTimeout(c.timer);
    emit('card_resolved', { cardId: c.id, answer });
    c.resolve(answer);
    return true;
  }

  function startTask(bot, prompt) {
    const t = { id: 't' + String(++nTask).padStart(4, '0'), bot, prompt, state: 'running', undoPoints: [], claims: null };
    tasks.set(t.id, t);
    runTask(t).catch(e => { t.state = 'failed'; emit('task_end', { task: t.id, state: 'failed' }); process.stderr.write('mock task error: ' + e.message + '\n'); });
    return t;
  }
  const taskView = t => ({ id: t.id, bot: t.bot, prompt: t.prompt, state: t.state, steps: t.undoPoints.length, undoPoints: t.undoPoints.length, ...(t.claims ? { claims: t.claims } : {}) });
  const cardView = c => ({ id: c.id, task: c.task, bot: c.bot, tool: c.tool, summary: c.summary, expiresAt: c.expiresAt });

  function readBody(req) {
    return new Promise((res, rej) => {
      let b = '';
      req.on('data', d => { b += d; if (b.length > 1e6) { rej(new Error('too large')); req.destroy(); } });
      req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } });
      req.on('error', rej);
    });
  }
  const send = (res, code, body) => { const s = body === undefined ? '' : JSON.stringify(body); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(s); };

  function serveStatic(req, res, rel) {
    const name = rel === '' ? 'index.html' : rel;
    const file = path.resolve(UI_DIR, name);
    if (file !== UI_DIR && !file.startsWith(UI_DIR + path.sep)) return send(res, 404, { error: 'not found' });
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/') { res.writeHead(302, { Location: MOUNT }); return res.end(); }
    if (p.startsWith(MOUNT)) return serveStatic(req, res, decodeURIComponent(p.slice(MOUNT.length)));
    if (!p.startsWith('/api/') && !p.startsWith('/m/rooms/') && !p.startsWith('/m/roles/')) return send(res, 404, { error: 'not found' });
    if (token && req.headers.authorization !== 'Bearer ' + token) return send(res, 401, { error: 'unauthorized' });

    let rm;
    if (req.method === 'GET' && p === '/m/rooms/rooms') return send(res, 200, { rooms: rooms.map(r => ({ id: r.id, name: r.name, members: r.members })) });
    if ((rm = /^\/m\/rooms\/rooms\/([\w-]+)\/(messages|say)$/.exec(p))) {
      const r = rooms.find(x => x.id === rm[1]);
      if (!r) return send(res, 404, { error: 'no such room' });
      if (req.method === 'GET' && rm[2] === 'messages') {
        const since = url.searchParams.get('since');
        const i = since ? r.messages.findIndex(x => x.id === since) : -1;
        return send(res, 200, { messages: r.messages.slice(i + 1) });
      }
      if (req.method === 'POST' && rm[2] === 'say') {
        const b = await readBody(req);
        if (typeof b.text !== 'string' || !b.text.trim()) return send(res, 400, { error: 'bad request' });
        const h = roomLine(r, 'human', 'You', b.text.trim());
        const who = bots.find(x => x.id === r.members[0]);
        setTimeout(() => roomLine(r, 'agent', who ? who.name : r.members[0], 'Noted: ' + b.text.trim()), delay);
        return send(res, 200, { id: h.id });
      }
    }
    if (req.method === 'POST' && p === '/m/roles/groups') { // same rules as the real route
      const b = await readBody(req).catch(() => ({}));
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!name || [...name].length > 40) return send(res, 400, { error: 'the group name must be 1-40 characters' });
      if (!Array.isArray(b.members) || !b.members.length || b.members.length > 20) return send(res, 400, { error: 'members must be a list of 1-20 role ids' });
      const ids = [];
      for (const k of b.members) {
        if (typeof k !== 'string' || !/^r-[0-9a-f]{8}$/.test(k) || !bots.some(x => x.id === k)) return send(res, 400, { error: 'no such role id' });
        if (!ids.includes(k)) ids.push(k);
      }
      if (rooms.some(r => r.name === name)) return send(res, 400, { error: 'a group with that name exists' });
      const g = { id: 'g-' + String(++nGroup).padStart(8, '0'), name, members: ids, messages: [] };
      rooms.push(g);
      return send(res, 201, { id: g.id, name: g.name, lead: ids[0], members: ids.map(i => ({ id: i, name: bots.find(x => x.id === i).name })) });
    }
    if (req.method === 'GET' && p === '/m/roles/main') return opts.mainRole ? send(res, 200, { id: opts.mainRole, name: (bots.find(b => b.id === opts.mainRole) || {}).name || opts.mainRole }) : send(res, 404, { error: 'not found' });
    if (req.method === 'GET' && p === '/api/bots') return send(res, 200, bots);
    if (req.method === 'GET' && p === '/api/tasks') {
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
      return send(res, 200, [...tasks.values()].reverse().slice(0, limit).map(taskView));
    }
    let m;
    if ((m = /^\/api\/tasks\/([\w-]+)(\/stop|\/undo)?$/.exec(p))) {
      const t = tasks.get(m[1]);
      if (!t) return send(res, 404, { error: 'no such task' });
      if (req.method === 'GET' && !m[2]) return send(res, 200, taskView(t));
      if (req.method === 'POST' && m[2] === '/stop') { return send(res, 200, { id: t.id, state: t.state }); }
      if (req.method === 'POST' && m[2] === '/undo') {
        if (t.state === 'running' || t.state === 'waiting_card') return send(res, 409, { error: 'task is running' });
        const pt = t.undoPoints.pop();
        if (!pt) return send(res, 200, { restoredTo: null, nothingLeft: true, message: 'nothing left to undo' });
        return send(res, 200, { restoredTo: pt.label, redoHint: `taskmote undo --to ${pt.n} ${t.id}` });
      }
    }
    if (req.method === 'POST' && p === '/api/tasks') {
      const b = await readBody(req);
      if (!bots.some(x => x.id === b.bot) || typeof b.prompt !== 'string' || !b.prompt.trim()) return send(res, 400, { error: 'bad request' });
      const t = startTask(b.bot, b.prompt.trim());
      return send(res, 200, { id: t.id, bot: t.bot, state: t.state });
    }
    if (req.method === 'POST' && p === '/api/chat') {
      const b = await readBody(req);
      const ids = b.bots === 'all' ? bots.map(x => x.id) : b.bots;
      if (!Array.isArray(ids) || !ids.length || !ids.every(i => bots.some(x => x.id === i)) || typeof b.text !== 'string' || !b.text.trim()) return send(res, 400, { error: 'bad request' });
      return send(res, 200, [...new Set(ids)].map(bot => ({ bot, taskId: startTask(bot, b.text.trim()).id })));
    }
    if (req.method === 'GET' && p === '/api/cards') {
      const want = url.searchParams.get('state');
      return send(res, 200, [...cards.values()].filter(c => !want || c.state === want).map(cardView));
    }
    if ((m = /^\/api\/cards\/([\w-]+)$/.exec(p)) && req.method === 'POST') {
      const c = cards.get(m[1]);
      if (!c) return send(res, 404, { error: 'no such card' });
      const b = await readBody(req);
      const a = parseAnswer(String(b.answer));
      if (a === 'unclear') return send(res, 409, { error: 'unclear answer', state: c.state });
      if (c.state !== 'pending') return send(res, 409, { error: 'card already ' + c.state, state: c.state });
      settleCard(c, a);
      return send(res, 200, { id: c.id, state: a });
    }
    if (req.method === 'GET' && p === '/api/events') {
      const since = Number(url.searchParams.get('since')) || 0;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': open\n\n');
      for (const e of events) if (e.data.seq > since) res.write(frameOf(e.type, e.data));
      subs.add(res);
      const hb = setInterval(() => res.write(': hb\n\n'), 15000);
      req.on('close', () => { subs.delete(res); clearInterval(hb); });
      return;
    }
    return send(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => { if (!res.headersSent) send(res, 400, { error: String(e.message).slice(0, 100) }); else res.end(); });
  });
  const close = () => new Promise(r => {
    for (const c of cards.values()) clearTimeout(c.timer);
    for (const res of subs) res.end();
    server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections();
  });
  return { server, close, emit, state: { bots, tasks, cards, events } };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 7421, host = process.env.HOST || '127.0.0.1';
  const mock = createMock({ token: process.env.MOCK_TOKEN || '', delayMs: process.env.MOCK_DELAY_MS ? Number(process.env.MOCK_DELAY_MS) : 700, seed: process.env.MOCK_SEED === '1', mainRole: process.env.MOCK_MAIN || '' });
  mock.server.listen(port, host, () => console.log(`mock taskmote server on http://${host}:${port}${MOUNT}  (try a message containing "risky" or "fail")`));
}

module.exports = { createMock, MOUNT };
