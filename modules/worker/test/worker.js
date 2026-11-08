#!/usr/bin/env node
'use strict';
// Worker suite: runs worker.js as a child process against a mock server on 127.0.0.1
// (random port) with temp dirs for config, token, state and work folder. No network beyond loopback.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const WORKER = path.join(__dirname, '..', 'worker.js');
const TOKEN = 'test-token-0123456789abcdef';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, ok, info) { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && info !== undefined ? '  -> ' + (typeof info === 'string' ? info : JSON.stringify(info)).slice(0, 300) : ''}`); }

async function until(fn, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); } return false; }

// ---- mock server ------------------------------------------------------------
function mockServer() {
  const m = { queue: [], hellos: [], claims: 0, progress: [], results: {}, posts: {}, badAuth: 0, status500: 0, srv: null, port: 0 };
  m.push = j => m.queue.push(j);
  m.srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { m.badAuth++; res.writeHead(401); return res.end('{"error":"auth"}'); }
      let j = {}; try { j = body ? JSON.parse(body) : {}; } catch { /* */ }
      const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(o === undefined ? '' : JSON.stringify(o)); };
      if (req.url === '/api/bots') return send(200, []);
      if (req.url === '/api/worker/hello') { m.hellos.push(j); return send(200, { ok: true, pollMs: 100 }); }
      if (req.url === '/api/worker/claim') {
        m.claims++;
        if (m.status500 > 0) { m.status500--; return send(503, { error: 'busy' }); }
        const job = m.queue.shift();
        if (job) return send(200, { job });
        return setTimeout(() => send(204), 80);
      }
      let mt = req.url.match(/^\/api\/worker\/jobs\/([^/]+)\/progress$/);
      if (mt) { m.progress.push({ id: decodeURIComponent(mt[1]), ...j }); return send(200, { ok: true }); }
      mt = req.url.match(/^\/api\/worker\/jobs\/([^/]+)\/result$/);
      if (mt) { const id = decodeURIComponent(mt[1]); m.posts[id] = (m.posts[id] || 0) + 1; m.results[id] = j; return send(200, { ok: true }); }
      send(404, {});
    });
  });
  m.listen = port => new Promise(r => m.srv.listen(port || 0, '127.0.0.1', () => { m.port = m.srv.address().port; r(m); }));
  m.url = () => `http://127.0.0.1:${m.port}`;
  m.close = () => new Promise(r => { m.srv.closeAllConnections && m.srv.closeAllConnections(); m.srv.close(() => r()); });
  return m;
}

// ---- environment per scenario ----------------------------------------------
function freePort() { return new Promise(r => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }

function env(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-test-'));
  const work = path.join(dir, 'work');
  const e = { dir, work, state: path.join(dir, 'state'), logs: path.join(dir, 'logs'), tokenFile: path.join(dir, 'tok'), cfg: path.join(dir, 'config.json'), outside: path.join(dir, 'outside') };
  fs.mkdirSync(e.outside);
  fs.writeFileSync(path.join(e.outside, 'secret.txt'), 'top secret');
  fs.writeFileSync(path.join(e.outside, 'readonly.txt'), 'ro');
  fs.writeFileSync(path.join(dir, 'private.json'), JSON.stringify({ rules: [
    { kind: 'private_content', match: 'content', pattern: 'DO-NOT-PUBLISH', flags: '', reason: 'marked text stays out' },
    { kind: 'private_path', match: 'path', pattern: '/diary/', access: 'any', reason: 'diary is off limits' },
  ] }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    owner_name: 'Tester', private_rules: 'private.json',
    modules: { 'guard-base': true, checkpoint: true, 'guard-private-rules': true, worker: true },
    worker: { work_dir: work, deny: { any: [path.join(e.outside, 'secret.txt')], read_only: [path.join(e.outside, 'readonly.txt')] }, daily_cap: opts.cap === undefined ? 50 : opts.cap, backoff_ms: [100, 300], heartbeat_ms: 400, max_run_ms: 20000 },
  }));
  if (opts.token !== false) fs.writeFileSync(e.tokenFile, (opts.token || TOKEN) + '\n');
  return e;
}

function startWorker(e, server, extra = [], extraEnv = {}) {
  const child = spawn(process.execPath, [WORKER, '--server', server, ...extra], {
    env: { ...process.env, HARNESS_CONFIG: e.cfg, HARNESS_STATE_DIR: e.state, HARNESS_LOG_DIR: e.logs, HARNESS_WORKER_TOKEN_FILE: e.tokenFile, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const w = { child, out: '', exit: null };
  child.stdout.on('data', d => w.out += d);
  child.stderr.on('data', d => w.out += d);
  w.done = new Promise(r => child.on('exit', code => { w.exit = code; r(code); }));
  w.stop = async () => { if (w.exit === null) child.kill(); await w.done; };
  return w;
}

const tool = (id, tl, input, extra = {}) => ({ id, task: 't-' + id, kind: 'tool', payload: { tool: tl, input, ...extra.payload }, deadline: extra.deadline });
const clean = e => { try { fs.rmSync(e.dir, { recursive: true, force: true }); } catch { /* windows may hold a handle briefly */ } };
const journalOf = e => { try { return fs.readFileSync(path.join(e.state, 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };

(async () => {
  // 1. claim, run, result (+ hello, progress, checkpoint before a write, a shell tool)
  {
    const e = env(), m = await mockServer().listen();
    const target = path.join(e.work, 'a.txt');
    m.push(tool('j1', 'Write', { file_path: target, content: 'hello' }));
    m.push(tool('j2', 'Bash', { command: 'echo shelltest' }));
    const w = startWorker(e, m.url(), ['--max-jobs', '2']);
    const code = await Promise.race([w.done, sleep(30000).then(() => 'timeout')]);
    check('claim/run/result: worker exits 0 after 2 jobs', code === 0, { code, out: w.out });
    check('claim/run/result: Write job ran and result ok', fs.existsSync(target) && fs.readFileSync(target, 'utf8') === 'hello' && m.results.j1 && m.results.j1.ok === true, m.results.j1);
    check('claim/run/result: Bash job output returned', m.results.j2 && m.results.j2.ok && /shelltest/.test(JSON.stringify(m.results.j2.result)), m.results.j2);
    check('claim/run/result: hello sent with workerId and capabilities', m.hellos.length >= 1 && m.hellos[0].workerId && m.hellos[0].capabilities.includes('tool'), m.hellos);
    check('claim/run/result: progress events (tool_call and tool_result) reported', m.progress.some(p => p.id === 'j1' && p.events.some(x => x.type === 'tool_call')) && m.progress.some(p => p.id === 'j1' && p.events.some(x => x.type === 'tool_result')), m.progress);
    check('claim/run/result: each result posted exactly once', m.posts.j1 === 1 && m.posts.j2 === 1, m.posts);
    check('checkpoint taken before the write job', typeof (m.results.j1.result || {}).checkpoint === 'number' && !(m.results.j2.result || {}).checkpoint, m.results.j1);
    check('worker made no listening socket (outbound only)', !/listening/i.test(w.out), w.out);
    await m.close(); clean(e);
  }

  // 2. 204 idle, then a late job
  {
    const e = env(), m = await mockServer().listen();
    const w = startWorker(e, m.url(), ['--max-jobs', '1']);
    await until(() => m.claims >= 4);
    check('204 idle: worker keeps polling, stays alive, posts nothing', m.claims >= 4 && w.exit === null && Object.keys(m.posts).length === 0, { claims: m.claims, exit: w.exit });
    m.push(tool('late', 'Bash', { command: 'echo late' }));
    const code = await Promise.race([w.done, sleep(20000).then(() => 'timeout')]);
    check('204 idle: a job that arrives later is run', code === 0 && m.results.late && m.results.late.ok, { code, out: w.out });
    await m.close(); clean(e);
  }

  // 3. server down, retry with backoff, recover
  {
    const e = env(), port = await freePort();
    const w = startWorker(e, `http://127.0.0.1:${port}`, ['--max-jobs', '1']);
    await sleep(1500);
    check('server down: worker is still alive and says it is retrying', w.exit === null && /unreachable/.test(w.out), { exit: w.exit, out: w.out });
    const m = mockServer(); m.push(tool('after', 'Bash', { command: 'echo back' }));
    await m.listen(port);
    const code = await Promise.race([w.done, sleep(25000).then(() => 'timeout')]);
    check('server down: after the server comes up the job is claimed and reported', code === 0 && m.results.after && m.results.after.ok, { code, out: w.out });
    // server dies mid-session, then returns
    await m.close(); clean(e);
  }
  {
    const e = env(), m = await mockServer().listen();
    m.status500 = 2; m.push(tool('five', 'Bash', { command: 'echo five' }));
    const w = startWorker(e, m.url(), ['--max-jobs', '1']);
    const code = await Promise.race([w.done, sleep(20000).then(() => 'timeout')]);
    check('server 503 on claim: worker retries and recovers', code === 0 && m.results.five && m.results.five.ok, { code, out: w.out });
    await m.close(); clean(e);
  }

  // 4-6. refusals: jail, deny list read, private rules (and guard-base)
  {
    const e = env(), m = await mockServer().listen();
    const out = path.join(e.outside, 'escape.txt');
    m.push(tool('jail', 'Write', { file_path: out, content: 'x' }));
    m.push(tool('jail2', 'Write', { file_path: path.join(e.work, '..', 'outside', 'dotdot.txt'), content: 'x' }));
    m.push(tool('jail3', 'Bash', { command: `echo hi > "${path.join(e.outside, 'sh.txt')}"`.replace(/\\/g, '/') }));
    m.push(tool('denyread', 'Read', { file_path: path.join(e.outside, 'secret.txt') }));
    m.push(tool('rowrite', 'Write', { file_path: path.join(e.outside, 'readonly.txt'), content: 'x' }));
    m.push(tool('roread', 'Read', { file_path: path.join(e.outside, 'readonly.txt') }));
    m.push(tool('priv', 'Write', { file_path: path.join(e.work, 'p.txt'), content: 'this is DO-NOT-PUBLISH text' }));
    m.push(tool('privpath', 'Read', { file_path: path.join(e.work, 'diary', 'd.txt') }));
    m.push(tool('guard', 'Bash', { command: 'git push --no-verify' }));
    m.push(tool('badtool', 'WebFetch', { url: 'http://x' }));
    const w = startWorker(e, m.url(), ['--max-jobs', '10']);
    const code = await Promise.race([w.done, sleep(40000).then(() => 'timeout')]);
    check('refusals: worker finished all jobs', code === 0, { code, out: w.out });
    const R = id => m.results[id] || {};
    check('jail violation refused (absolute path outside), file not created', R('jail').ok === false && /jail|outside/i.test(R('jail').error || '') && !fs.existsSync(out), R('jail'));
    check('jail violation refused (.. escape)', R('jail2').ok === false && !fs.existsSync(path.join(e.outside, 'dotdot.txt')), R('jail2'));
    check('jail violation refused (shell redirect outside)', R('jail3').ok === false && !fs.existsSync(path.join(e.outside, 'sh.txt')), R('jail3'));
    check('deny-list read refused with a reason', R('denyread').ok === false && /deny list/.test(R('denyread').error || ''), R('denyread'));
    check('deny-list read-only: write refused, read allowed', R('rowrite').ok === false && /read-only/.test(R('rowrite').error || '') && R('roread').ok === true, [R('rowrite'), R('roread')]);
    check('private rule (content) refused; file not written', R('priv').ok === false && /private rule/.test(R('priv').error || '') && !fs.existsSync(path.join(e.work, 'p.txt')), R('priv'));
    check('private rule (path, access any) refuses a read', R('privpath').ok === false && /private rule/.test(R('privpath').error || ''), R('privpath'));
    check('guard-base applies locally', R('guard').ok === false && /guard-base/.test(R('guard').error || ''), R('guard'));
    check('unsupported tool refused', R('badtool').ok === false && /unsupported/.test(R('badtool').error || ''), R('badtool'));
    check('refusal is logged', /REFUSED/.test(w.out) && fs.existsSync(path.join(e.logs, 'worker.jsonl')) && /refused/.test(fs.readFileSync(path.join(e.logs, 'worker.jsonl'), 'utf8')), w.out);
    check('refused jobs never reached "start" (no run, no checkpoint)', !journalOf(e).some(r => r.phase === 'start' && ['jail', 'jail2', 'denyread', 'priv', 'guard'].includes(r.job_id)), journalOf(e).filter(r => r.phase === 'start'));
    await m.close(); clean(e);
  }

  // 7. crash between run and post: no rerun, re-post once
  {
    const e = env(), m = await mockServer().listen();
    const counter = path.join(e.work, 'count.txt').replace(/\\/g, '/');
    m.push(tool('crash', 'Bash', { command: `echo run >> "${counter}"`, }));
    const w1 = startWorker(e, m.url(), ['--max-jobs', '1'], { HARNESS_WORKER_CRASH_AFTER_RUN: '1' });
    const c1 = await Promise.race([w1.done, sleep(30000).then(() => 'timeout')]);
    check('crash seam: first worker died after running, before posting', c1 === 9 && !m.posts.crash && fs.existsSync(counter), { c1, posts: m.posts, out: w1.out });
    m.push(tool('crash', 'Bash', { command: `echo run >> "${counter}"` })); // server hands the same job out again
    const w2 = startWorker(e, m.url(), ['--max-jobs', '1']);
    const c2 = await Promise.race([w2.done, sleep(30000).then(() => 'timeout')]);
    const runs = fs.readFileSync(counter, 'utf8').trim().split('\n').length;
    check('crash recovery: job was NOT rerun', runs === 1, { runs });
    check('crash recovery: stored result re-posted exactly once, ok', c2 === 0 && m.posts.crash === 1 && m.results.crash.ok === true, { c2, posts: m.posts, out: w2.out });
    // a third start must not post again
    m.queue.length = 0;
    const w3 = startWorker(e, m.url(), ['--max-jobs', '1']);
    await sleep(1200); await w3.stop();
    check('crash recovery: later restarts do not re-post', m.posts.crash === 1, m.posts);
    await m.close(); clean(e);
  }
  {
    // crash while the job itself was running (start recorded, no done): outcome unknown, not rerun
    const e = env(), m = await mockServer().listen();
    const counter = path.join(e.work, 'c2.txt').replace(/\\/g, '/');
    fs.mkdirSync(e.state, { recursive: true });
    fs.writeFileSync(path.join(e.state, 'journal.jsonl'), JSON.stringify({ type: 'worker_job', phase: 'start', job_id: 'mid', kind: 'tool', day: '2000-01-01', ts: 1 }) + '\n');
    m.push(tool('mid', 'Bash', { command: `echo run >> "${counter}"` }));
    const w = startWorker(e, m.url(), ['--max-jobs', '1']);
    const c = await Promise.race([w.done, sleep(30000).then(() => 'timeout')]);
    check('crash mid-run: reported as unknown, never rerun', c === 0 && m.results.mid && m.results.mid.ok === false && /NOT rerun/.test(m.results.mid.error) && !fs.existsSync(counter), { c, r: m.results.mid, out: w.out });
    await m.close(); clean(e);
  }

  // 8. daily cap
  {
    const e = env({ cap: 2 }), m = await mockServer().listen();
    for (const n of ['c1', 'c2', 'c3']) m.push(tool(n, 'Bash', { command: 'echo cap' }));
    const w = startWorker(e, m.url(), ['--max-jobs', '3']);
    await Promise.race([w.done, sleep(30000)]);
    check('daily cap: first two run, third refused with a clear reason', m.results.c1 && m.results.c1.ok && m.results.c2 && m.results.c2.ok && m.results.c3 && m.results.c3.ok === false && /daily cap reached \(2 of 2/.test(m.results.c3.error), m.results.c3);
    // survives a restart: counted from the journal
    m.push(tool('c4', 'Bash', { command: 'echo cap' }));
    const w2 = startWorker(e, m.url(), ['--max-jobs', '1']);
    await Promise.race([w2.done, sleep(20000)]);
    check('daily cap: still enforced after a restart', m.results.c4 && m.results.c4.ok === false && /daily cap/.test(m.results.c4.error), m.results.c4);
    await m.close(); clean(e);
  }

  // 8b. task job through the existing launch, with the fake engine
  {
    const e = env(), m = await mockServer().listen();
    m.push({ id: 'tk1', task: 't-tk1', kind: 'task', payload: { prompt: 'make the file' } });
    const w = startWorker(e, m.url(), ['--max-jobs', '1'], { HARNESS_ENGINE_SCRIPT: path.resolve(__dirname, '..', '..', '..', 'test', 'fake-engine.js'), HARNESS_FAKE_DELAY_MS: '0' });
    const c = await Promise.race([w.done, sleep(60000).then(() => 'timeout')]);
    const r = m.results.tk1 || {};
    check('task job: engine started through the existing launch and finished', c === 0 && r.ok === true && r.result && r.result.finished === true && journalOf(e).some(x => x.type === 'task_done'), { c, r, out: w.out });
    await m.close(); clean(e);
  }

  // 8c. the engine's final answer rides in result.reply
  {
    const e = env(), m = await mockServer().listen();
    const sf = path.join(os.tmpdir(), 'stream-' + process.pid + '.jsonl');
    fs.writeFileSync(sf, JSON.stringify({ type: 'result', result: '  the answer is 42  ' }) + '\n');
    m.push({ id: 'tk2', task: 't-tk2', kind: 'task', payload: { prompt: 'answer me' } });
    const w = startWorker(e, m.url(), ['--max-jobs', '1'], { HARNESS_ENGINE_SCRIPT: path.resolve(__dirname, '..', '..', '..', 'test', 'fake-engine.js'), HARNESS_FAKE_DELAY_MS: '0', HARNESS_FAKE_STREAM: sf });
    const c = await Promise.race([w.done, sleep(60000).then(() => 'timeout')]);
    const r = m.results.tk2 || {};
    check('task job: the engine answer is in result.reply (scrubbed, trimmed)', c === 0 && r.result && r.result.reply === 'the answer is 42', { c, r, out: w.out });
    fs.rmSync(sf, { force: true });
    await m.close(); clean(e);
  }

  // 9. deadline
  {
    const e = env(), m = await mockServer().listen();
    m.push(tool('late', 'Bash', { command: 'echo x' }, { deadline: new Date(Date.now() - 5000).toISOString() }));
    m.push(tool('slow', 'Bash', { command: 'sleep 20' }, { deadline: new Date(Date.now() + 2500).toISOString() }));
    const w = startWorker(e, m.url(), ['--max-jobs', '2']);
    const t0 = Date.now();
    await Promise.race([w.done, sleep(30000)]);
    check('deadline: a job already past its deadline is refused unrun', m.results.late && m.results.late.ok === false && /deadline/.test(m.results.late.error) && !journalOf(e).some(r => r.job_id === 'late' && r.phase === 'start'), m.results.late);
    check('deadline: a running job is stopped at its deadline', m.results.slow && m.results.slow.ok === false && Date.now() - t0 < 15000, { r: m.results.slow, ms: Date.now() - t0 });
    await m.close(); clean(e);
  }

  // 10. token missing / wrong
  {
    const e = env({ token: false });
    const w = startWorker(e, 'http://127.0.0.1:9', ['--max-jobs', '1']);
    const c = await Promise.race([w.done, sleep(15000).then(() => 'timeout')]);
    check('token missing: clear error, exit 2, no connection attempt', c === 2 && /no worker token/.test(w.out) && /setup\.js token/.test(w.out) && !/unreachable/.test(w.out), { c, out: w.out });
    clean(e);
  }
  {
    const e = env({ token: 'wrong-token-0123456789abcdef' }), m = await mockServer().listen();
    const w = startWorker(e, m.url(), ['--max-jobs', '1']);
    const c = await Promise.race([w.done, sleep(15000).then(() => 'timeout')]);
    check('token rejected by server: clear error, exit 2 (no retry loop)', c === 2 && /refused the token/.test(w.out) && m.badAuth <= 2, { c, bad: m.badAuth, out: w.out });
    await m.close(); clean(e);
  }
  {
    const e = env();
    const w = startWorker(e, 'ftp://x');
    const c = await w.done;
    check('bad server URL: clear error', c === 2 && /http/.test(w.out), w.out);
    clean(e);
  }

  // 11. setup.js
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-setup-'));
    const tf = path.join(dir, 'sub', 'tok');
    const run = args => spawnSync(process.execPath, [path.join(__dirname, '..', 'setup.js'), ...args], { env: { ...process.env, HARNESS_WORKER_TOKEN_FILE: tf }, encoding: 'utf8', timeout: 30000 });
    const r1 = run(['token']);
    const tok = fs.existsSync(tf) ? fs.readFileSync(tf, 'utf8').trim() : '';
    check('setup token: file written, token printed once, next steps shown', r1.status === 0 && tok.length >= 32 && r1.stdout.split(tok).length === 2 && /Next steps/.test(r1.stdout), r1);
    const r2 = run(['token']);
    check('setup token: refuses to overwrite without --force', r2.status === 1 && fs.readFileSync(tf, 'utf8').trim() === tok, r2);
    if (process.platform === 'win32') {
      const acl = spawnSync('icacls', [tf], { encoding: 'utf8' });
      const who = os.userInfo().username.toLowerCase();
      const lines = acl.stdout.split('\n').filter(l => /:\(/.test(l));
      check('setup token: only the current user has access (icacls)', lines.length === 1 && lines[0].toLowerCase().includes(who), acl.stdout);
    } else check('setup token: mode 600', (fs.statSync(tf).mode & 0o777) === 0o600);
    const m = await mockServer().listen();
    fs.writeFileSync(tf, TOKEN + '\n');
    const ok = await new Promise(r => { const c = spawn(process.execPath, [path.join(__dirname, '..', 'setup.js'), 'check', '--server', m.url()], { env: { ...process.env, HARNESS_WORKER_TOKEN_FILE: tf } }); let o = ''; c.stdout.on('data', d => o += d); c.on('exit', code => r({ code, o })); });
    check('setup check: reachable and token accepted', ok.code === 0 && /^OK/.test(ok.o), ok);
    fs.writeFileSync(tf, 'wrong-token-0123456789abcdef\n');
    const bad = await new Promise(r => { const c = spawn(process.execPath, [path.join(__dirname, '..', 'setup.js'), 'check', '--server', m.url()], { env: { ...process.env, HARNESS_WORKER_TOKEN_FILE: tf } }); let o = ''; c.stderr.on('data', d => o += d); c.on('exit', code => r({ code, o })); });
    check('setup check: wrong token says so', bad.code === 1 && /REFUSED the token/.test(bad.o), bad);
    await m.close();
    const down = await new Promise(r => { const c = spawn(process.execPath, [path.join(__dirname, '..', 'setup.js'), 'check', '--server', `http://127.0.0.1:${m.port}`], { env: { ...process.env, HARNESS_WORKER_TOKEN_FILE: tf } }); let o = ''; c.stderr.on('data', d => o += d); c.on('exit', code => r({ code, o })); });
    check('setup check: unreachable server explained', down.code === 1 && /CANNOT REACH/.test(down.o), down);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }

  console.log(`result: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('FAIL suite crashed: ' + (e.stack || e)); process.exit(1); });
