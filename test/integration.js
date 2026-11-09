#!/usr/bin/env node
'use strict';
// Integration: the real server (fake engine) + the chat-ui panel, over HTTP only.
//   1. /m/chat-ui/ui/ serves index.html, app.js, state.js, style.css (200, right content type); no ".." escape; POST is 405
//   2. POST /api/chat to two bots, read SSE (Bearer) until both tasks end
//   3. state.js (the page's own reducer) folds the real SSE events into a finished task per bot
//   4. a card created in the journal reaches SSE as card_pending, and a yes answer yields card_resolved
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-'));
const state = path.join(base, 'state'), work = path.join(base, 'work');
fs.mkdirSync(work, { recursive: true });
process.env.HARNESS_STATE_DIR = state;
const cfg = path.join(base, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ owner_name: 'Tester', modules: { 'chat-ui': true, 'approval-cards': true, checkpoint: true, 'guard-base': true },
  bots: [{ id: 'alpha', name: 'alpha', engine: 'claude' }, { id: 'beta', name: 'beta', engine: 'claude' }], server: { port: 0, tick_ms: 50 } }));
const env = { ...process.env, HARNESS_CONFIG: cfg, HARNESS_STATE_DIR: state, HARNESS_LOG_DIR: path.join(base, 'logs'),
  HARNESS_ENGINE_SCRIPT: path.join(ROOT, 'test', 'fake-engine.js'), HARNESS_FAKE_DELAY_MS: '0', HARNESS_WORK_DIR: work };
delete env.HARNESS_OWNER; delete env.HARNESS_NO_SERVER; delete env.HARNESS_TASK_ID;

const tick = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 60000) => { const t0 = Date.now(); let v; while (!(v = await fn()) && Date.now() - t0 < ms) await tick(80); return v; };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function req(port, method, p, body, token) {
  const data = body === undefined ? null : JSON.stringify(body);
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) };
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
      let s = ''; res.on('data', c => { s += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* not json */ } resolve({ status: res.statusCode, type: res.headers['content-type'], body: j, raw: s }); });
    });
    r.on('error', reject); r.setTimeout(15000, () => r.destroy(new Error('timeout ' + p)));
    if (data) r.write(data); r.end();
  });
}

async function main() {
  const res = {}, note = (k, v, extra) => { res[k] = !!v; if (!v) console.log(`  FAIL ${k}${extra ? ': ' + extra : ''}`); };
  const srv = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskmote.js'), 'serve'], { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = ''; srv.stdout.on('data', d => { out += d; }); srv.stderr.on('data', d => { out += d; });
  try {
    const info = await waitFor(() => { const i = readJson(path.join(state, 'server.json')); return i && i.pid === srv.pid && i.port ? i : null; }, 20000);
    if (!info) throw new Error('server did not start: ' + out);
    const port = info.port, token = fs.readFileSync(path.join(state, 'server.token'), 'utf8').trim();
    const ui = p => req(port, 'GET', '/m/chat-ui/ui/' + p, undefined, token);

    // 1. the panel over HTTP
    const want = { '': 'text/html', 'index.html': 'text/html', 'app.js': 'javascript', 'state.js': 'javascript', 'style.css': 'text/css' };
    for (const [f, t] of Object.entries(want)) { const r = await ui(f); note(`ui ${f || '/'} 200 ${t}`, r.status === 200 && (r.type || '').includes(t) && r.raw.length > 100, r.status + ' ' + r.type); }
    const html = (await ui('')).raw;
    note('ui page uses relative asset paths', /src="state\.js"/.test(html) && /href="style\.css"/.test(html));
    for (const p of ['../index.js', '%2e%2e/index.js', '..%5cindex.js', 'sub/..%2f..%2findex.js']) { const r = await ui(p); note('ui: no escape via ' + p, r.status === 404 && !/chat-ui: web/.test(r.raw), r.status + ' ' + r.raw.slice(0, 80)); }
    note('ui: POST -> 405', (await req(port, 'POST', '/m/chat-ui/ui/', {}, token)).status === 405);
    note('ui: unknown module -> 404', (await req(port, 'GET', '/m/nope/ui/', undefined, token)).status === 404);

    // 2. chat to two bots; one SSE stream with Bearer auth, as the page does it
    const events = []; let buf = '';
    const sreq = http.get({ host: '127.0.0.1', port, path: '/api/events?since=0', headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } }, r => {
      r.setEncoding('utf8');
      r.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const t = (/^event: (.*)$/m.exec(b) || [])[1], d = (/^data: (.*)$/m.exec(b) || [])[1]; if (t && d) events.push({ type: t, ...JSON.parse(d) }); } });
    });
    const chat = await req(port, 'POST', '/api/chat', { bots: ['alpha', 'beta'], text: 'hello both' }, token);
    note('chat: two task ids', chat.status === 200 && Array.isArray(chat.body) && chat.body.length === 2 && chat.body.every(x => x.taskId), chat.raw);
    const ids = (chat.body || []).map(x => x.taskId);
    const ended = await waitFor(() => ids.length === 2 && ids.every(id => events.some(e => e.type === 'task_end' && e.task === id)), 90000);
    note('sse: task_end for both bots', ended, JSON.stringify(events.map(e => e.type)));
    note('sse: events carry increasing seq', events.length > 2 && events.every((e, i) => i === 0 || e.seq > events[i - 1].seq));

    // 3. fold the real events with the page's own reducer
    const D = require('../modules/chat-ui/ui/state.js'), S = D.create();
    D.applyBots(S, (await req(port, 'GET', '/api/bots', undefined, token)).body);
    D.applyTasks(S, (await req(port, 'GET', '/api/tasks?limit=50', undefined, token)).body);
    for (const e of events) D.reduce(S, e.type, e);
    note('state: both bots listed', D.thread(S, 'alpha').length === 1 && D.thread(S, 'beta').length === 1);
    note('state: each task ended with the prompt and entries', ids.every(id => S.tasks[id] && S.tasks[id].state === 'done' && S.tasks[id].prompt === 'hello both' && S.tasks[id].entries.length > 1), JSON.stringify(S.tasks));

    // 4. card round-trip
    const card = (() => { const cm = require('../modules/approval-cards/cards'), id = 'card-' + require('crypto').randomBytes(3).toString('hex'), t = Date.now(); return require('../lib/journal').append({ type: 'card', card_id: id, task_id: ids[0], tool: 'Bash', input: { command: 'echo hi' }, sha256: cm.hashOf('Bash', { command: 'echo hi' }), summary: 'echo hi', rule: 'test', created_at: new Date(t).toISOString(), expires_at: new Date(t + 600000).toISOString() }); })();
    const pend = await waitFor(() => events.find(e => e.type === 'card_pending' && e.card && e.card.id === card.card_id), 10000);
    note('card: card_pending event has the fields the page reads', pend && ['id', 'task', 'bot', 'tool', 'summary', 'expiresAt'].every(k => pend.card[k]), JSON.stringify(pend));
    note('card: GET /api/cards?state=pending lists it as {id,...}', (await req(port, 'GET', '/api/cards?state=pending', undefined, token)).body.some(c => c.id === card.card_id));
    const yes = await req(port, 'POST', '/api/cards/' + card.card_id, { answer: 'yes' }, token);
    note('card: yes -> 200', yes.status === 200, yes.raw);
    note('card: card_resolved event', await waitFor(() => events.find(e => e.type === 'card_resolved' && e.cardId === card.card_id && e.answer === 'yes'), 10000));
    sreq.destroy();
  } catch (e) { console.log('  error: ' + (e.stack || e)); res.exception = false; }
  finally { if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(srv.pid)], { stdio: 'ignore' }); else srv.kill('SIGKILL'); }
  const failed = Object.entries(res).filter(([, v]) => !v).map(([k]) => k);
  console.log(`integration: ${Object.keys(res).length - failed.length}/${Object.keys(res).length} ${failed.length ? 'FAIL ' + failed.join('; ') : 'PASS'}`);
  process.exit(failed.length ? 1 : 0);
}
main();
