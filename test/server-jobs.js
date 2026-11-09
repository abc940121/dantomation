#!/usr/bin/env node
'use strict';
// Core starts module jobs when the server is up and stops them in close() (lib/server.js).
//   1. a scratch module with a service job and an interval job: start runs, the interval ticks, close() stops both
//   2. a job that throws on start does not stop the server from coming up
//   3. rooms + chat-endpoint: a member with engine "chat-endpoint" (shadow mode) reaches a local HTTP
//      server and no longer gets the "is unavailable" line
// All on 127.0.0.1 with a scratch state dir. Needs nothing else on.
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'srvjobs-'));
process.env.HARNESS_STATE_DIR = path.join(base, 'state');
process.env.HARNESS_LOG_DIR = path.join(base, 'logs');
process.env.HARNESS_CONFIG = path.join(base, 'config.json');
const MARK = path.join(base, 'marks.log');
process.env.ZZJOBS_MARK = MARK;

let ok = true;
const check = (name, c, info) => { if (!c) ok = false; console.log(`${c ? 'PASS' : 'FAIL'} ${name}${!c && info !== undefined ? '  -> ' + JSON.stringify(info).slice(0, 300) : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); let v; while (!(v = await fn()) && Date.now() - t0 < ms) await sleep(20); return v; };
const marks = () => { try { return fs.readFileSync(MARK, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const writeCfg = c => fs.writeFileSync(process.env.HARNESS_CONFIG, JSON.stringify({ owner_name: 'Tester', server: { port: 0, tick_ms: 50 }, ...c }));

const M = require('../lib/modules');
// unique per run, so parallel runs never share (or delete) each other's scratch modules
const ID = `${process.pid}x${Math.random().toString(16).slice(2, 8)}`;
const N = { ok: `zzjobs${ID}`, bad: `zzbad${ID}`, slow: `zzslow${ID}` };
const dirs = [N.ok, N.bad, N.slow].map(n => path.join(M.DIR, n));
const cleanup = () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(base, { recursive: true, force: true }); };
process.on('exit', cleanup);

function scratchModules() {
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(dirs[0], 'index.js'), [
    "'use strict';",
    "const fs = require('fs');",
    "const mark = s => fs.appendFileSync(process.env.ZZJOBS_MARK, s + '\\n');",
    "module.exports = { contract: 1, name: '" + N.ok + "', description: 'scratch module for test/server-jobs.js', runsOn: 'main',",
    "  jobs: [",
    "    { id: 'svc', start() { mark('svc-start'); return () => mark('svc-stop'); } },",
    "    { id: 'tick', every: 1, run() { mark('tick'); } },",
    "  ] };",
    ''].join('\n'));
  fs.writeFileSync(path.join(dirs[1], 'index.js'), [
    "'use strict';",
    "module.exports = { contract: 1, name: '" + N.bad + "', description: 'scratch module whose job throws', runsOn: 'main',",
    "  jobs: [{ id: 'boom', start() { throw new Error('boom on start'); } }] };",
    ''].join('\n'));
  fs.writeFileSync(path.join(dirs[2], 'index.js'), [
    "'use strict';",
    "const fs = require('fs');",
    "const mark = s => fs.appendFileSync(process.env.ZZJOBS_MARK, s + '\\n');",
    "module.exports = { contract: 1, name: '" + N.slow + "', description: 'scratch module with a slow start', runsOn: 'main',",
    "  jobs: [{ id: 'slow', async start() { mark('slow-begin'); await new Promise(r => setTimeout(r, 500)); mark('slow-start'); return () => mark('slow-stop'); } }] };",
    ''].join('\n'));
}

const TOKEN = () => require('../lib/server').readToken(); // the owner token the first server start wrote
const post = (port, p, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: { authorization: 'Bearer ' + TOKEN(), 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => { let s = ''; res.on('data', c => { s += c; }); res.on('end', () => resolve({ status: res.statusCode, body: s })); });
  r.on('error', reject); r.end(data);
});
const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: { authorization: 'Bearer ' + TOKEN() } }, res => { let s = ''; res.on('data', c => { s += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* none */ } resolve({ status: res.statusCode, body: j }); }); }).on('error', reject);
});

async function main() {
  const S = require('../lib/server');
  let stderr = '';
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (c) => { stderr += c; return true; };

  // ---- 1 and 2: scratch modules
  scratchModules();
  const seen = [];
  const ep = http.createServer((req, res) => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { seen.push({ auth: req.headers.authorization, body: b }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ reply_text: 'hi from the endpoint' })); }); });
  await new Promise(r => ep.listen(0, '127.0.0.1', r));
  M.setSecret('chat-endpoint', 'tokens', JSON.stringify({ 'ex-token': 'tok-for-test-only' }));
  writeCfg({
    modules: { [N.ok]: true, [N.bad]: true, [N.slow]: true, rooms: true, 'chat-endpoint': true },
    rooms: { rooms: { dev: { lead: 'ann', window: 30, members: [
      { id: 'ann', name: 'Ann', voice: 'v-ann', bot: 'main' },
      { id: 'ex', name: 'Example', voice: 'v-ex', engine: 'chat-endpoint', endpoint: { url: `http://127.0.0.1:${ep.address().port}`, token_secret: 'ex-token', mode: 'shadow' } },
    ] } } },
  });
  const s1 = S.create();
  await s1.listen();
  check('start: the service job ran once before listen resolved', marks().filter(x => x === 'svc-start').length === 1, marks());
  check('start: a job that throws was reported, the server is up anyway', stderr.includes(`module job ${N.bad}/boom: boom on start`) && s1.server.listening, stderr);
  await waitFor(() => marks().includes('tick'), 4000);
  check('interval job ticks', marks().includes('tick'), marks());
  check('service job not stopped while running', !marks().includes('svc-stop'));
  await s1.close();
  check('close: the service job was stopped', marks().filter(x => x === 'svc-stop').length === 1, marks());
  const n = marks().length; await sleep(1200);
  check('close: no ticks after stop', marks().length === n, marks());
  fs.rmSync(MARK, { force: true });

  const s2 = S.create();
  await s2.listen(); await s2.close();
  check('start/stop pair balanced on an immediate close', marks().filter(x => x === 'svc-start').length === marks().filter(x => x === 'svc-stop').length && marks().includes('svc-start'), marks());

  // ---- 3: rooms + chat-endpoint end to end (shadow)
  const s3 = S.create();
  const a = await s3.listen();
  const say = await post(a.port, '/m/rooms/rooms/dev/say', { text: '@Example are you there?' });
  check('rooms: say accepted', say.status === 202, say);
  const hit = await waitFor(() => seen.length > 0, 8000);
  check('endpoint: the local HTTP server was called with the bearer token', hit && seen[0].auth === 'Bearer tok-for-test-only', seen);
  await sleep(300);
  const msgs = await get(a.port, '/m/rooms/rooms/dev/messages');
  const text = JSON.stringify(msgs.body);
  check('rooms: no "is unavailable" line for the member', msgs.status === 200 && !/unavailable/i.test(text), text);
  check('shadow: the reply was not posted', !/hi from the endpoint/.test(text), text);
  await s3.close(); ep.closeAllConnections(); ep.close();

  // ---- 4: close() while a start is still pending: one memoised promise, resolves only after start finished and stop ran
  fs.rmSync(MARK, { force: true });
  const s4 = S.create();
  const up = s4.listen();
  await waitFor(() => marks().includes('slow-begin'));
  check('slow start is pending', marks().includes('slow-begin') && !marks().includes('slow-start'), marks());
  let done = false;
  const c1 = s4.close(), c2 = s4.close();
  c1.then(() => { done = true; });
  check('close is memoised: repeated calls return the same promise', c1 === c2);
  await sleep(100);
  check('close has not resolved while the start is pending', !done && !marks().includes('slow-stop'), marks());
  await c1;
  const m4 = marks();
  check('close resolved only after the slow start finished and its stop ran, once', m4.indexOf('slow-start') > -1 && m4.indexOf('slow-stop') > m4.indexOf('slow-start') && m4.filter(x => x === 'slow-stop').length === 1, m4);
  await up.catch(() => {});
  await s4.close();
  check('a later close() does not stop twice', marks().filter(x => x === 'slow-stop').length === 1, marks());

  process.stderr.write = realWrite;
  console.log(ok ? 'server-jobs: ALL PASS' : 'server-jobs: FAILURES');
  process.exit(ok ? 0 : 1);
}
main().catch(e => { process.stderr.write = process.stderr.constructor.prototype.write; console.error(e); process.exit(1); });
