#!/usr/bin/env node
'use strict';
// Server tests (lib/server.js), all on 127.0.0.1 with a scratch state dir and the fake engine.
//   1. kill the server (and its engine) after an effect's act but before its done line, restart,
//      resume: the effect is reconciled, not repeated (0 duplicate effects)
//   2. SSE: seq numbers are stable across the restart; reconnect with ?since= replays the rest
//   3. card answer over HTTP: unclear -> 409 (still pending), yes -> 200, again -> 409
//   4. auth: no token on a non-local bind refuses to start; token required when local_no_auth is off
//   5. worker: result posted twice applies once; a claim past its deadline becomes UNCERTAIN
//   6. the CLI (do / status) talks to the running server
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DANT = path.join(ROOT, 'bin', 'taskmote.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-'));
const state = path.join(base, 'state'), work = path.join(base, 'work');
fs.mkdirSync(work, { recursive: true });
process.env.HARNESS_STATE_DIR = state; // for the in-process journal use (card creation) below
const cfgFile = path.join(base, 'config.json');
const writeCfg = server => fs.writeFileSync(cfgFile, JSON.stringify({
  owner_name: 'Tester',
  modules: { 'approval-cards': true, checkpoint: true, 'guard-base': true },
  bots: [{ id: 'main', name: 'main', engine: 'claude' }, { id: 'remote', name: 'remote', engine: 'claude', runsOn: 'worker' }],
  server: { port: 0, tick_ms: 50, job_timeout_ms: 700, claim_wait_ms: 300, ...server },
}));
const env = { ...process.env, HARNESS_CONFIG: cfgFile, HARNESS_STATE_DIR: state, HARNESS_LOG_DIR: path.join(base, 'logs'),
  HARNESS_ENGINE_SCRIPT: path.join(ROOT, 'test', 'fake-engine.js'), HARNESS_FAKE_DELAY_MS: '0', HARNESS_FAKE_GUARD: '1', HARNESS_WORK_DIR: work };
delete env.HARNESS_OWNER; delete env.HARNESS_NO_SERVER; delete env.HARNESS_TASK_ID;

const tick = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 60000) => { const t0 = Date.now(); let v; while (!(v = await fn()) && Date.now() - t0 < ms) await tick(80); return v; };
const journal = () => { try { return fs.readFileSync(path.join(state, 'journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const killTree = pid => { if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' }); else try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
const info = () => { try { return JSON.parse(fs.readFileSync(path.join(state, 'server.json'), 'utf8')); } catch { return null; } };

let srv = null;
async function startServer(extraEnv = {}, cfg = {}) {
  writeCfg(cfg);
  const prev = info();
  srv = spawn(process.execPath, [DANT, 'serve'], { env: { ...env, ...extraEnv }, cwd: work, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  srv.out = ''; srv.stdout.on('data', d => { srv.out += d; }); srv.stderr.on('data', d => { srv.out += d; });
  const i = await waitFor(() => { const x = info(); return x && x.pid === srv.pid && x.port && (!prev || x.pid !== prev.pid) ? x : null; }, 20000);
  if (!i) throw new Error('server did not start: ' + srv.out);
  return i;
}

const ownerToken = () => { try { return fs.readFileSync(path.join(state, 'server.token'), 'utf8').trim(); } catch { return null; } };
// Sends the owner token by default (as the CLI does); pass { authorization: null } to send none.
function req(port, method, p, body, headers = {}) {
  headers = { ...headers };
  if (headers.authorization === null) delete headers.authorization;
  else if (!headers.authorization && ownerToken()) headers.authorization = `Bearer ${ownerToken()}`;
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let s = ''; res.on('data', c => { s += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* none */ } resolve({ status: res.statusCode, body: j, raw: s }); });
    });
    r.on('error', reject); r.setTimeout(15000, () => r.destroy(new Error('timeout ' + method + ' ' + p)));
    if (data) r.write(data); r.end();
  });
}

// Collect SSE events until done(events) or ms elapses.
function sse(port, since, done, ms = 15000, headers = {}) {
  return new Promise(resolve => {
    const events = []; let buf = '';
    const r = http.get({ host: '127.0.0.1', port, path: `/api/events?since=${since}`, headers }, res => {
      res.setEncoding('utf8');
      res.on('data', c => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const type = (/^event: (.*)$/m.exec(block) || [])[1], data = (/^data: (.*)$/m.exec(block) || [])[1];
          if (type && data) events.push({ type, ...JSON.parse(data) });
        }
        if (done(events)) { r.destroy(); resolve(events); }
      });
    });
    r.on('error', () => resolve(events));
    setTimeout(() => { r.destroy(); resolve(events); }, ms);
  });
}

async function main() {
  const res = {};
  const note = (k, v, extra) => { res[k] = !!v; if (!v && extra) console.log('  detail:', extra); };

  // ---- 1 + 2 + 6: task through the CLI, killed mid-task, resumed
  let i = await startServer({ HARNESS_PAUSE_EFFECT: 's2-write', HARNESS_PAUSE_AFTER_ACT_MS: '120000' });
  const port1 = i.port, token = null;
  note('bots: config bots listed', (await req(port1, 'GET', '/api/bots')).body.map(b => b.id).join() === 'main,remote');
  const doOut = spawnSync(process.execPath, [DANT, 'do', 'server kill test'], { env, cwd: work, encoding: 'utf8', timeout: 30000 });
  const taskId = (/task (t\S+) sent to the server/.exec(doOut.stdout) || [])[1];
  note('cli: do goes to the running server', doOut.status === 0 && taskId, doOut.stdout + doOut.stderr);
  const paused = await waitFor(() => fs.existsSync(path.join(state, 'paused.flag')), 60000);
  note('server ran the engine up to the pause', paused);
  const before = await req(port1, 'GET', `/api/tasks/${taskId}`);
  note('task is running before the kill', before.body && before.body.state === 'running', JSON.stringify(before.body));
  const evBefore = await sse(port1, 0, e => e.some(x => x.type === 'tool_result' && x.callId === 's1-message'), 10000);
  const stat = spawnSync(process.execPath, [DANT, 'status'], { env, cwd: work, encoding: 'utf8' });
  note('cli: status via server', /open task: /.test(stat.stdout), stat.stdout + stat.stderr);

  const lock = (() => { try { return JSON.parse(fs.readFileSync(path.join(state, 'executor.lock'), 'utf8')); } catch { return null; } })();
  killTree(srv.pid);
  for (const p of (lock && lock.pids) || []) killTree(p);
  await waitFor(() => !alive(srv.pid), 15000);
  await waitFor(() => !(lock && (lock.pids || []).some(alive)), 15000);
  fs.rmSync(path.join(state, 'paused.flag'), { force: true });
  const beforeKillDone = journal().filter(r => r.type === 'effect_done').map(r => r.effect_id);
  note('killed with s2-write not yet done', !beforeKillDone.includes('s2-write'), beforeKillDone.join());

  // the resumed engine prints a stream-json result line: its answer must reach the journal and the chat
  const streamFile = path.join(base, 'stream.jsonl');
  fs.writeFileSync(streamFile, JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\n' + JSON.stringify({ type: 'result', result: '  hello from the engine  ' }) + '\n');
  i = await startServer({ HARNESS_FAKE_STREAM: streamFile });
  const port2 = i.port;
  const restate = await req(port2, 'GET', `/api/tasks/${taskId}`);
  note('after restart the task is still known and not running', restate.body && restate.body.state === 'stopped', JSON.stringify(restate.body));
  const resumed = await req(port2, 'POST', `/api/tasks/${taskId}/resume`, {});
  note('resume accepted', resumed.status === 200, resumed.raw);
  const finished = await waitFor(async () => { const t = (await req(port2, 'GET', `/api/tasks/${taskId}`)).body; return t && t.state === 'done' ? t : null; }, 60000);
  note('resumed task reaches done', finished);

  const j = journal();
  const done = j.filter(r => r.task_id === taskId && r.type === 'effect_done');
  const ids = done.map(d => d.effect_id).sort();
  const dups = ids.length - new Set(ids).size;
  const wd = (j.find(r => r.type === 'task_start' && r.task_id === taskId) || {}).workdir || path.join(work, taskId);
  const outF = path.join(path.isAbsolute(wd) ? wd : path.join(work, '..', wd), 'out.txt');
  const outTxt = fs.existsSync(outF) ? fs.readFileSync(outF, 'utf8') : '';
  const writes = outTxt.split('\n').filter(l => l === 'second change').length;
  note('0 duplicate effects (effect_done)', dups === 0 && ids.join() === 's1-message,s1-write,s2-write', ids.join());
  note('0 duplicate effects (file writes)', outTxt === 'server kill test\nsecond change\n' && writes === 1, JSON.stringify(outTxt));
  console.log('  effect records: ' + JSON.stringify(j.filter(r => r.task_id === taskId && /^effect/.test(r.type)).map(r => r.type + ':' + r.effect_id + (r.mode ? ':' + r.mode : ''))));
  console.log(`kill/resume: effect_done ${JSON.stringify(ids)}, duplicates ${dups}, out.txt ${JSON.stringify(outTxt)}, task ${finished ? finished.state : 'unfinished'}`);

  // the reply is journaled after the engine exits, which can be after task_end: wait for both
  const all = await sse(port2, 0, e => e.some(x => x.type === 'task_end' && x.task === taskId) && e.some(x => x.type === 'message' && x.task === taskId && x.final === true), 10000);
  const seqs = all.map(e => e.seq);
  note('sse: seq strictly increasing', seqs.every((s, k) => k === 0 || s > seqs[k - 1]));
  note('sse: events before the kill keep their seq after restart', evBefore.length > 0 && evBefore.every(e => all.some(a => a.seq === e.seq && a.type === e.type)), `${evBefore.length} before`);
  const mid = all[Math.floor(all.length / 2)].seq;
  const tail = await sse(port2, mid, e => e.length >= all.filter(a => a.seq > mid).length, 10000);
  note('sse: reconnect with since replays exactly the missed events', JSON.stringify(tail.map(e => e.seq)) === JSON.stringify(all.filter(a => a.seq > mid).map(e => e.seq)), `${tail.length} vs ${all.filter(a => a.seq > mid).length}`);
  note('reply: the engine answer is journaled', journal().some(r => r.type === 'reply' && r.task_id === taskId && r.text === 'hello from the engine'), JSON.stringify(j.filter(r => r.type === 'reply')));
  note('reply: the chat gets it as a final message', all.some(e => e.type === 'message' && e.task === taskId && e.final === true && e.text === 'hello from the engine'), JSON.stringify(all.filter(e => e.type === 'message')));
  note('sse: tool_call/tool_result/task_end present', ['tool_call', 'tool_result', 'task_end', 'undo_point'].every(t => all.some(e => e.type === t)));

  // undo (checkpoint on): latest task only
  const upBefore = (await req(port2, 'GET', `/api/tasks/${taskId}`)).body.undoPoints;
  const und = await req(port2, 'POST', `/api/tasks/${taskId}/undo`, {});
  const upAfter = (await req(port2, 'GET', `/api/tasks/${taskId}`)).body.undoPoints;
  note('undoPoints counts what undo will do, and drops after an undo', Number.isInteger(upBefore) && upBefore >= 1 && upAfter < upBefore, `${upBefore} -> ${upAfter}`);
  note('undo via server restores one change', und.status === 200 && Number.isInteger(und.body.restoredTo), und.raw);
  let last = null; for (let i = 0; i < 6 && !(last && last.body && last.body.nothingLeft); i++) last = await req(port2, 'POST', `/api/tasks/${taskId}/undo`, {});
  note('undo past the last point is a plain "nothing left" answer, not an error', last && last.status === 200 && last.body.nothingLeft === true && last.body.restoredTo === null, last && last.raw);

  // ---- 3: cards over HTTP
  const J = require('../lib/journal'); // STATE comes from HARNESS_STATE_DIR below
  const cardsMod = require('../modules/approval-cards/cards');
  // security round 5: a reply holding the owner token is scrubbed; a reply record with a non-string text must not wedge the view
  const tokNow = ownerToken();
  J.append({ type: 'reply', task_id: 'trep1', text: 'the token is ' + tokNow + ' ok' });
  fs.appendFileSync(path.join(state, 'journal.jsonl'), JSON.stringify({ type: 'reply', task_id: 'trep2', text: { toString: 1 } }) + String.fromCharCode(10));
  J.append({ type: 'reply', task_id: 'trep3', text: 'after the bad one' });
  const rep = await sse(port2, 0, e => e.some(x => x.type === 'message' && x.task === 'trep3'), 10000);
  const rep1 = rep.find(x => x.type === 'message' && x.task === 'trep1');
  note('reply: the owner token inside reply text never reaches the chat', rep1 && rep1.text.includes('[REDACTED]') && !JSON.stringify(rep).includes(tokNow), JSON.stringify(rep1));
  note('reply: a record with a non-string text is skipped, later records still flow, the server is alive', rep.some(x => x.type === 'message' && x.task === 'trep3') && (await req(port2, 'GET', '/api/bots')).status === 200, JSON.stringify(rep.filter(x => /^trep/.test(x.task || '')).map(x => x.task)));
  const cardId = 'card-' + require('crypto').randomBytes(3).toString('hex'), t0 = Date.now(); // the card record, as the approval-cards module writes it
  const card = J.append({ type: 'card', card_id: cardId, task_id: 'tcardtest', tool: 'Bash', input: { command: 'echo hi' }, sha256: cardsMod.hashOf('Bash', { command: 'echo hi' }), summary: 'echo hi', rule: 'test', created_at: new Date(t0).toISOString(), expires_at: new Date(t0 + 600000).toISOString() });
  await tick(300);
  const listed = (await req(port2, 'GET', '/api/cards')).body;
  note('cards: pending listed', Array.isArray(listed) && listed.some(c => c.id === card.card_id && c.state === 'pending'), JSON.stringify(listed));
  const noTokCard = await req(port2, 'POST', `/api/cards/${card.card_id}`, { answer: 'yes' }, { authorization: null });
  const afterNoTok = (await req(port2, 'GET', '/api/cards', undefined, { authorization: null })).body;
  note('auth: tokenless loopback POST /api/cards/:id -> 401, card stays pending', noTokCard.status === 401 && afterNoTok.some(c => c.id === card.card_id && c.state === 'pending'), noTokCard.raw);
  const wrongTokCard = await req(port2, 'POST', `/api/cards/${card.card_id}`, { answer: 'yes' }, { authorization: 'Bearer nope' });
  note('auth: wrong token on a card answer -> 401', wrongTokCard.status === 401);
  const badUtf8 = await req(port2, 'POST', '/api/chat', Buffer.from([0x7b, 0x22, 0x74, 0x22, 0x3a, 0x22, 0xa7, 0x22, 0x7d]));
  note('body: invalid UTF-8 bytes -> 400 "not valid UTF-8 JSON", not stored as U+FFFD', badUtf8.status === 400 && /valid UTF-8 JSON/.test(badUtf8.raw), badUtf8.raw);
  const zhBody = await req(port2, 'POST', '/api/cards/no-such-card', { answer: 'yes', note: '你好世界' });
  note('body: valid Chinese UTF-8 still passes the body reader', zhBody.status !== 400, zhBody.raw);
  const noTokOthers = await Promise.all([['POST', '/api/tasks', { prompt: 'x' }], ['POST', `/api/tasks/${taskId}/stop`, {}], ['POST', `/api/tasks/${taskId}/undo`, {}], ['POST', `/api/tasks/${taskId}/resume`, {}], ['POST', '/api/chat', { bots: 'all', text: 'x' }], ['POST', '/api/worker/hello', { workerId: 'w' }], ['POST', '/api/worker/claim', { workerId: 'w' }]].map(([m, p, b]) => req(port2, m, p, b, { authorization: null })));
  note('auth: every other state-changing route and worker route -> 401 without a token', noTokOthers.every(r => r.status === 401), noTokOthers.map(r => r.status).join());
  note('auth: tokenless loopback GET (read-only) still works', (await req(port2, 'GET', '/api/bots', undefined, { authorization: null })).status === 200);
  // actors: owner token, optional worker token (state/worker.token), anonymous
  fs.writeFileSync(path.join(state, 'worker.token'), 'wtok-' + require('crypto').randomBytes(8).toString('hex') + '\n');
  const wauth = { authorization: 'Bearer ' + fs.readFileSync(path.join(state, 'worker.token'), 'utf8').trim() };
  const wk = await Promise.all([['POST', '/api/worker/hello', { workerId: 'w' }], ['POST', '/api/tasks', { prompt: 'x' }], ['POST', '/api/chat', { bots: 'all', text: 'x' }], ['POST', `/api/cards/${card.card_id}`, { answer: 'yes' }], ['GET', '/api/settings/approval-cards'], ['PATCH', '/api/settings/approval-cards', { timeout_minutes: 9 }]].map(([m, p, b]) => req(port2, m, p, b, wauth)));
  note('actor: the worker token may call /api/worker/ (not 401/403)', wk[0].status !== 401 && wk[0].status !== 403, String(wk[0].status));
  note('actor: the worker token is refused (403) on tasks, chat, cards and settings', wk.slice(1).every(r => r.status === 403), wk.map(r => r.status).join());
  const set0 = await req(port2, 'GET', '/api/settings/approval-cards');
  note('settings: owner GET /api/settings/<module> -> schema + values', set0.status === 200 && set0.body.values && set0.body.settings === undefined ? true : set0.status === 200 && !!set0.body.values, set0.raw);
  const set1 = await req(port2, 'PATCH', '/api/settings/approval-cards', { timeout_minutes: 9 });
  const cfgOn = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  note('settings: owner PATCH saves to the config file atomically', set1.status === 200 && cfgOn.approval_cards && cfgOn.approval_cards.timeout_minutes === 9, set1.raw);
  note('settings: an invalid value -> 400, config unchanged', (await req(port2, 'PATCH', '/api/settings/approval-cards', { timeout_minutes: -5 })).status === 400 && JSON.parse(fs.readFileSync(cfgFile, 'utf8')).approval_cards.timeout_minutes === 9);
  note('settings: no token -> 401; unknown module -> 404', (await req(port2, 'PATCH', '/api/settings/approval-cards', { timeout_minutes: 3 }, { authorization: null })).status === 401 && (await req(port2, 'GET', '/api/settings/nope')).status === 404);
  // an agent (HARNESS_TASK_ID set) tries to answer its OWN pending card over HTTP
  const agentEnv = { ...env, HARNESS_TASK_ID: 'tagent', HARNESS_TASK_DIR: work };
  const agentHook = (tool, ti) => spawnSync(process.execPath, [path.join(ROOT, 'guards', 'guard.js')], { input: JSON.stringify({ session_id: 'fake', tool_name: tool, tool_input: ti, cwd: work }), env: agentEnv, encoding: 'utf8' });
  const tokFile = path.join(state, 'server.token').split(path.sep).join('/');
  const apiUrl = `http://127.0.0.1:${port2}/api/cards/${card.card_id}`;
  const stillPending = async () => (await req(port2, 'GET', '/api/cards', undefined, { authorization: null })).body.some(c => c.id === card.card_id && c.state === 'pending');
  // (a) the token file is readable on disk: the guards must stop the read and the use
  const a1 = agentHook('Read', { file_path: tokFile });
  const a2 = agentHook('Bash', { command: `cat ${tokFile}` });
  const a3 = agentHook('Bash', { command: `curl -s -X POST ${apiUrl} -H "Authorization: Bearer $(cat ${tokFile})" -d '{"answer":"yes"}'` });
  const a4 = agentHook('Bash', { command: `node -e "fetch('${apiUrl}',{method:'POST',body:'{}'})"` });
  note('agent (token readable): Read of the token file blocked', a1.status === 2, a1.stdout + a1.stderr);
  note('agent (token readable): cat of the token file blocked', a2.status === 2, a2.stdout + a2.stderr);
  note('agent (token readable): shell-to-API call with the token blocked', a3.status === 2, a3.stdout + a3.stderr);
  note('agent (token readable): shell-to-API call from node blocked', a4.status === 2, a4.stdout + a4.stderr);
  // (b) the token is not available to it: the server itself refuses, from a process that carries the agent env
  const agentPost = spawnSync(process.execPath, ['-e', `fetch(${JSON.stringify(apiUrl)},{method:'POST',headers:{'content-type':'application/json'},body:'{"answer":"yes"}'}).then(r=>{console.log(r.status)})`], { env: agentEnv, encoding: 'utf8', timeout: 20000 });
  note('agent (no token): tokenless HTTP answer -> 401', agentPost.stdout.trim() === '401', agentPost.stdout + agentPost.stderr);
  const agentCli = spawnSync(process.execPath, [DANT, 'do', 'agent starts a task'], { env: agentEnv, cwd: work, encoding: 'utf8', timeout: 30000 });
  note('agent: the CLI under HARNESS_TASK_ID does not send the owner token (server refuses)', agentCli.status !== 0 && /refused/.test(agentCli.stderr + agentCli.stdout), agentCli.stdout + agentCli.stderr);
  note('agent: its card is still pending after all attempts', await stillPending());
  const unclear = await req(port2, 'POST', `/api/cards/${card.card_id}`, { answer: 'hmm maybe' });
  note('cards: unclear answer -> 409', unclear.status === 409 && unclear.body.answer === 'unclear', unclear.raw);
  const still = (await req(port2, 'GET', '/api/cards')).body;
  note('cards: card still pending after unclear', still.some(c => c.id === card.card_id));
  const yes = await req(port2, 'POST', `/api/cards/${card.card_id}`, { answer: 'yes' });
  note('cards: yes -> 200', yes.status === 200 && yes.body.answer === 'yes', yes.raw);
  const again = await req(port2, 'POST', `/api/cards/${card.card_id}`, { answer: 'yes' });
  note('cards: second answer -> 409', again.status === 409, again.raw);
  note('cards: unknown id -> 404', (await req(port2, 'POST', '/api/cards/card-ffffff', { answer: 'yes' })).status === 404);

  // ---- 5: worker
  const cl0 = await req(port2, 'POST', '/api/worker/claim', { workerId: 'w1' });
  note('worker: main-bot work is never queued for workers (claim -> 204)', cl0.status === 204, cl0.raw);
  note('worker: hello', (await req(port2, 'POST', '/api/worker/hello', { workerId: 'w1' })).status === 200);
  const t1 = await req(port2, 'POST', '/api/tasks', { bot: 'remote', prompt: 'on the worker' });
  note('worker: task for a worker bot is queued', t1.status === 201 && t1.body.state === 'queued', t1.raw);
  const c1 = await req(port2, 'POST', '/api/worker/claim', { workerId: 'w1' });
  const job = c1.body && c1.body.job;
  note('worker: claim returns the job', c1.status === 200 && job && job.task === t1.body.id, c1.raw);
  const c1b = await req(port2, 'POST', '/api/worker/claim', { workerId: 'w1' });
  note('worker: retried claim returns the same job', c1b.body && c1b.body.job && c1b.body.job.id === job.id);
  const pr = await req(port2, 'POST', `/api/worker/jobs/${job.id}/progress`, { workerId: 'w1', events: [{ type: 'message', data: { text: 'working', final: false } }] });
  note('worker: progress accepted', pr.status === 200 && pr.body.applied, pr.raw);
  const r1 = await req(port2, 'POST', `/api/worker/jobs/${job.id}/result`, { workerId: 'w1', ok: true, result: { text: 'all done' } });
  const r2 = await req(port2, 'POST', `/api/worker/jobs/${job.id}/result`, { workerId: 'w1', ok: true, result: { text: 'all done' } });
  const jr = journal().filter(r => r.type === 'job_result' && r.job_id === job.id);
  note('worker: result posted twice applied once', r1.body.applied === true && r2.body.applied === false && jr.length === 1, `${r1.raw} ${r2.raw} ${jr.length}`);
  note('worker: task done after result', (await req(port2, 'GET', `/api/tasks/${t1.body.id}`)).body.state === 'done');

  const wAll = await sse(port2, 0, e => e.some(x => x.type === 'task_end' && x.task === t1.body.id), 10000);
  note('worker: result without reply keeps the old final message', wAll.some(e => e.type === 'message' && e.task === t1.body.id && e.final === true && e.text === 'all done'), JSON.stringify(wAll.filter(e => e.type === 'message' && e.task === t1.body.id)));
  const tr = await req(port2, 'POST', '/api/tasks', { bot: 'remote', prompt: 'with a reply' });
  const cr = await req(port2, 'POST', '/api/worker/claim', { workerId: 'w1' });
  const tokR = ownerToken();
  await req(port2, 'POST', `/api/worker/jobs/${cr.body.job.id}/result`, { workerId: 'w1', ok: true, result: { exit: 0, stdout: 'task x done', finished: true, reply: 'worker says hi ' + tokR } });
  const rAll = await sse(port2, 0, e => e.some(x => x.type === 'task_end' && x.task === tr.body.id), 10000);
  const rMsg = rAll.filter(e => e.type === 'message' && e.task === tr.body.id && e.final === true);
  note('worker: result.reply reaches the chat as one final message, scrubbed', rMsg.length === 1 && rMsg[0].text.startsWith('worker says hi') && !JSON.stringify(rAll).includes(tokR), JSON.stringify(rMsg));
  const tn = await req(port2, 'POST', '/api/tasks', { bot: 'remote', prompt: 'bad reply' });
  const cn = await req(port2, 'POST', '/api/worker/claim', { workerId: 'w1' });
  await req(port2, 'POST', `/api/worker/jobs/${cn.body.job.id}/result`, { workerId: 'w1', ok: true, result: { text: 'plain', reply: { x: 1 } } });
  const nAll = await sse(port2, 0, e => e.some(x => x.type === 'task_end' && x.task === tn.body.id), 10000);
  note('worker: a non-string reply is ignored', nAll.some(e => e.type === 'message' && e.task === tn.body.id && e.final === true && e.text === 'plain'), JSON.stringify(nAll.filter(e => e.task === tn.body.id)));

  const t2 = await req(port2, 'POST', '/api/tasks', { bot: 'remote', prompt: 'will time out' });
  const c2 = await req(port2, 'POST', '/api/worker/claim', { workerId: 'w1' });
  const job2 = c2.body.job;
  const uncertain = await waitFor(() => journal().some(r => r.type === 'job_uncertain' && r.job_id === job2.id), 10000);
  note('worker: claim deadline expiry -> UNCERTAIN', uncertain);
  const t2s = (await req(port2, 'GET', `/api/tasks/${t2.body.id}`)).body;
  note('worker: uncertain task is not reported done', t2s.uncertain === true && t2s.state === 'failed', JSON.stringify(t2s));
  const late = await req(port2, 'POST', `/api/worker/jobs/${job2.id}/result`, { workerId: 'w1', ok: true, result: 'late' });
  note('worker: late result after UNCERTAIN is not applied', late.body.applied === false && !journal().some(r => r.type === 'job_result' && r.job_id === job2.id), late.raw);

  const t3 = await req(port2, 'POST', '/api/tasks', { bot: 'remote', prompt: 'stop me' });
  const stp = await req(port2, 'POST', `/api/tasks/${t3.body.id}/stop`, {});
  note('stop: queued worker task -> stopped', stp.status === 200 && stp.body.state === 'stopped', stp.raw);
  note('chat: fan-out to all bots', (await req(port2, 'POST', '/api/chat', { bots: 'all', text: 'hello all' })).body.length === 2);

  // ---- workdir: `taskmote do --workdir <dir>` with a live server runs the task in that folder (it used to be dropped)
  const wdDir = path.join(base, 'chosen-folder'); fs.mkdirSync(wdDir, { recursive: true });
  const wdRel = await req(port2, 'POST', '/api/tasks', { prompt: 'x', workdir: 'relative/dir' });
  const wdMissing = await req(port2, 'POST', '/api/tasks', { prompt: 'x', workdir: path.join(base, 'no-such-folder') });
  const wdWorker = await req(port2, 'POST', '/api/tasks', { prompt: 'x', workdir: wdDir }, wauth);
  note('workdir: relative path -> 400, missing folder -> 400, worker token -> 403', wdRel.status === 400 && wdMissing.status === 400 && wdWorker.status === 403, [wdRel.status, wdMissing.status, wdWorker.status].join());
  const wdDo = spawnSync(process.execPath, [DANT, 'do', 'workdir test', '--workdir', wdDir], { env, cwd: work, encoding: 'utf8', timeout: 30000 });
  const wdTask = (/task (t\S+) sent to the server/.exec(wdDo.stdout) || [])[1];
  const wdStart = wdTask && await waitFor(() => journal().find(r => r.type === 'task_start' && r.task_id === wdTask), 60000);
  note('workdir: do --workdir through the server starts the task in that folder', !!wdStart && path.resolve(wdStart.workdir) === path.resolve(wdDir), wdDo.stdout + wdDo.stderr + JSON.stringify(wdStart || null));
  await waitFor(() => journal().some(r => r.type === 'task_done' && r.task_id === wdTask), 60000);
  // ---- 4: auth
  killTree(srv.pid); await waitFor(() => !alive(srv.pid), 15000);
  fs.rmSync(path.join(state, 'server.json'), { force: true });
  fs.rmSync(path.join(state, 'server.token'), { force: true });
  writeCfg({ host: '0.0.0.0' });
  const refuse = spawnSync(process.execPath, [DANT, 'serve'], { env, cwd: work, encoding: 'utf8', timeout: 20000 });
  note('auth: non-local bind without a token refuses to start', refuse.status === 2 && /token/.test(refuse.stderr) && !info(), refuse.stdout + refuse.stderr);
  const tk = spawnSync(process.execPath, [DANT, 'token', 'new'], { env, encoding: 'utf8' });
  const tokenText = fs.readFileSync(path.join(state, 'server.token'), 'utf8').trim();
  note('auth: token new writes a token file', tk.status === 0 && tokenText.length >= 32);
  i = await startServer({}, { local_no_auth: false });
  const noTok = await req(i.port, 'GET', '/api/bots', undefined, { authorization: null });
  const badTok = await req(i.port, 'GET', '/api/bots', undefined, { authorization: 'Bearer nope' });
  const goodTok = await req(i.port, 'GET', '/api/bots', undefined, { authorization: `Bearer ${tokenText}` });
  const evNo = await req(i.port, 'GET', '/api/events?since=0', undefined, { authorization: null });
  note('auth: no token -> 401', noTok.status === 401 && evNo.status === 401);
  note('auth: wrong token -> 401', badTok.status === 401);
  note('auth: right token -> 200', goodTok.status === 200);
  note('auth: foreign Host header refused without token', (await req(i.port, 'GET', '/api/bots', undefined, { host: 'evil.example', authorization: null })).status === 401);
  const evTok = await sse(i.port, 0, e => e.length > 0, 5000, { authorization: `Bearer ${tokenText}` });
  note('sse: /api/events accepts Authorization: Bearer (fetch streaming)', evTok.length > 0);
  note('ui: /ui/m/<module> is gone (404); an unknown module panel is 404', (await req(i.port, 'GET', '/ui/m/demo/', undefined, { authorization: `Bearer ${tokenText}` })).status === 404 && (await req(i.port, 'GET', '/m/demo/ui/', undefined, { authorization: `Bearer ${tokenText}` })).status === 404);
  killTree(srv.pid); await waitFor(() => !alive(srv.pid), 15000);

  // ---- 7: safety net: a turn that ends without task-done does not keep the bot busy or block the queue
  i = await startServer();
  const post = p => req(i.port, 'POST', '/api/tasks', { prompt: p });
  const stateOf = async id => ((await req(i.port, 'GET', `/api/tasks/${id}`)).body || {}).state;
  const ended = id => waitFor(async () => { const s = await stateOf(id); return ['done', 'failed', 'stopped'].includes(s) && !procsBusy(id) ? s : null; }, 60000);
  const procsBusy = id => !journal().some(r => r.type === 'task_done' && r.task_id === id);
  const greet = (await post('greeting [no-done]')).body.id, after = (await post('next message')).body.id;
  note('net: no task-done + exit 0 closes the turn as done', await ended(greet) === 'done' && journal().some(r => r.type === 'task_done' && r.task_id === greet && r.auto === true && !r.failed));
  note('net: the next queued message still runs', await ended(after) === 'done');
  const boom = (await post('boom [exit 3]')).body.id;
  note('net: no task-done + exit 3 closes the turn as failed', await ended(boom) === 'failed' && journal().some(r => r.type === 'task_done' && r.task_id === boom && r.failed === true && r.code === 3));
  const evNet = await sse(i.port, 0, e => e.some(x => x.type === 'task_end' && x.task === boom), 10000);
  note('net: the chat gets task_end failed and the bot goes idle', evNet.some(e => e.type === 'task_end' && e.task === boom && e.state === 'failed') && evNet.some(e => e.type === 'bot_status' && e.status === 'idle'));
  killTree(srv.pid); await waitFor(() => !alive(srv.pid), 15000);
  // a crash in the middle of an effect stays open for resume (the journal has an intent with no done)
  i = await startServer({ HARNESS_PAUSE_EFFECT: 's2-write', HARNESS_PAUSE_AFTER_ACT_MS: '120000' });
  const midT = (await post('crash mid effect')).body.id;
  await waitFor(() => fs.existsSync(path.join(state, 'paused.flag')), 60000);
  const lk = (() => { try { return JSON.parse(fs.readFileSync(path.join(state, 'executor.lock'), 'utf8')); } catch { return null; } })();
  for (const p of (lk && lk.pids) || []) killTree(p);
  await waitFor(async () => (await stateOf(midT)) !== 'running', 15000);
  await tick(500);
  fs.rmSync(path.join(state, 'paused.flag'), { force: true });
  note('net: a crash mid-effect leaves the task open for resume', !journal().some(r => r.type === 'task_done' && r.task_id === midT) && ((await req(i.port, 'GET', `/api/tasks/${midT}`)).body || {}).open === true);
  await req(i.port, 'POST', `/api/tasks/${midT}/stop`, {});
  killTree(srv.pid); await waitFor(() => !alive(srv.pid), 15000);

  // a turn run by the CLI (not the server) that ended without task-done: closed by the sweep, never while the executor lock is held
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'start', 'cli turn [no-done]'], { env: { ...env, HARNESS_NO_SERVER: '1' }, encoding: 'utf8', timeout: 60000 });
  const cliT = (journal().filter(r => r.type === 'engine_exit').pop() || {}).task_id;
  const lockFile = path.join(state, 'executor.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pids: [process.pid], task_id: cliT, nonce: 'test-holder' }));
  i = await startServer();
  await tick(2500);
  note('net: no close while another process holds the executor lock', !!cliT && !journal().some(r => r.type === 'task_done' && r.task_id === cliT), cli.stdout + cli.stderr);
  fs.rmSync(lockFile, { force: true });
  note('net: a CLI-run turn left open is closed by the sweep', !!(await waitFor(() => journal().some(r => r.type === 'task_done' && r.task_id === cliT && r.auto === true && !r.failed), 15000)));
  killTree(srv.pid); await waitFor(() => !alive(srv.pid), 15000);

  // a restart during a live card's wait: the engine that polled it is gone, so the startup sweep closes the card (no allow ever), and the task is not left open
  const cli2 = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'start', 'orphan turn [no-done]'], { env: { ...env, HARNESS_NO_SERVER: '1' }, encoding: 'utf8', timeout: 60000 });
  const orT = (journal().filter(r => r.type === 'engine_exit').pop() || {}).task_id;
  const orId = 'card-0badc0';
  J.append({ type: 'card', card_id: orId, task_id: orT, tool: 'Bash', input: { command: 'winget install x' }, sha256: cardsMod.hashOf('Bash', { command: 'winget install x' }), summary: 'install x', rule: 'redline:install', created_at: new Date().toISOString(), expires_at: null, live: true });
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  J.append({ type: 'card', card_id: 'card-0dead01', task_id: null, tool: 'Bash', input: { command: 'winget install y' }, sha256: cardsMod.hashOf('Bash', { command: 'winget install y' }), summary: 'install y', rule: 'redline:install', created_at: new Date().toISOString(), expires_at: null, live: true, waiter_pid: deadPid });
  J.append({ type: 'card', card_id: 'card-0a11e0', task_id: null, tool: 'Bash', input: { command: 'winget install y' }, sha256: cardsMod.hashOf('Bash', { command: 'winget install y' }), summary: 'install y', rule: 'redline:install', created_at: new Date().toISOString(), expires_at: null, live: true, waiter_pid: process.pid });
  // pid reuse: the recorded waiter pid is alive (another process now has it) but no heartbeat; an old card is closed.
  // The same with a fresh heartbeat stays pending.
  const reused = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  const oldAt = new Date(Date.now() - 10 * 60000).toISOString();
  J.append({ type: 'card', card_id: 'card-0e05ed', task_id: null, tool: 'Bash', input: { command: 'winget install r' }, sha256: cardsMod.hashOf('Bash', { command: 'winget install r' }), summary: 'install r', rule: 'redline:install', created_at: oldAt, expires_at: null, live: true, waiter_pid: reused.pid });
  J.waiterBeat(process.pid);
  const beating = setInterval(() => J.waiterBeat(process.pid), 2000);
  J.append({ type: 'card', card_id: 'card-0bea70', task_id: null, tool: 'Bash', input: { command: 'winget install b' }, sha256: cardsMod.hashOf('Bash', { command: 'winget install b' }), summary: 'install b', rule: 'redline:install', created_at: oldAt, expires_at: null, live: true, waiter_pid: process.pid });
  // legacy: a live card with neither a waiter pid nor a task (raised before pids were recorded): closed once old,
  // left alone while it is younger than a day.
  const dayAgo = ms => new Date(Date.now() - 24 * 3600 * 1000 - ms).toISOString();
  J.append({ type: 'card', card_id: 'card-01e9ac', task_id: null, tool: 'Bash', input: { command: 'winget install l' }, sha256: cardsMod.hashOf('Bash', { command: 'winget install l' }), summary: 'install l', rule: 'redline:install', created_at: dayAgo(60000), expires_at: null, live: true });
  J.append({ type: 'card', card_id: 'card-01e9ad', task_id: null, tool: 'Bash', input: { command: 'winget install l' }, sha256: cardsMod.hashOf('Bash', { command: 'winget install l' }), summary: 'install l', rule: 'redline:install', created_at: dayAgo(-15000), expires_at: null, live: true });
  i = await startServer();
  const orClosed = await waitFor(() => journal().find(r => r.type === 'card_answer' && r.card_id === orId), 15000);
  note('restart sweep: an orphaned live card is closed as a system no, reason "closed: server restarted, not used"', !!orClosed && orClosed.answer === 'no' && orClosed.who === 'system' && orClosed.reason === 'closed: server restarted, not used', cli2.stdout + cli2.stderr);
  note('restart sweep: a needs_you line is written for the card', !!(await waitFor(() => journal().find(r => r.type === 'needs_you' && r.card_id === orId && r.task_id === orT), 5000)));
  note('restart sweep: the card is closed before the task is closed (sweep runs before pump)', (() => { const j = journal(); const a = j.findIndex(r => r.type === 'card_answer' && r.card_id === orId), d = j.findIndex(r => r.type === 'task_done' && r.task_id === orT); return a >= 0 && (d < 0 || a < d); })());
  const lateYes = await req(i.port, 'POST', `/api/cards/${orId}`, { answer: 'yes' });
  note('restart sweep: a late yes finds no pending card and is never used', lateYes.status === 409 && !journal().some(r => r.type === 'card_used' && r.card_id === orId) && !journal().some(r => r.type === 'card_answer' && r.card_id === orId && r.answer === 'yes'), lateYes.raw);
  note('restart sweep: the task is not stuck open (pump closed it)', !!(await waitFor(() => journal().some(r => r.type === 'task_done' && r.task_id === orT), 15000)));
  note('restart sweep: a card with no task whose waiter process is gone is closed as a system no', !!(await waitFor(() => journal().find(r => r.type === 'card_answer' && r.card_id === 'card-0dead01' && r.answer === 'no' && r.who === 'system'), 15000)));
  note('restart sweep: a card whose waiter process is alive is left pending', !journal().some(r => r.type === 'card_answer' && r.card_id === 'card-0a11e0'));
  note('pid reuse: an old card whose pid is alive but has no heartbeat is closed as a system no', !!(await waitFor(() => journal().find(r => r.type === 'card_answer' && r.card_id === 'card-0e05ed' && r.answer === 'no' && r.who === 'system'), 15000)));
  note('pid reuse: an old card whose waiter heartbeat is fresh stays pending', !journal().some(r => r.type === 'card_answer' && r.card_id === 'card-0bea70'));
  note('legacy: an old live card with no pid and no task is closed as a system no with a needs_you line', !!(await waitFor(() => journal().find(r => r.type === 'card_answer' && r.card_id === 'card-01e9ac' && r.answer === 'no' && r.who === 'system'), 15000)) && journal().some(r => r.type === 'needs_you' && r.card_id === 'card-01e9ac' && r.kind === 'server_restart'));
  note('legacy: a young live card with no pid and no task is left pending', !journal().some(r => r.type === 'card_answer' && r.card_id === 'card-01e9ad'));
  reused.kill();
  // a waiter alive at startup that exits while the server runs: the running sweep closes its card
  const lateWaiter = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  J.append({ type: 'card', card_id: 'card-0de1a7', task_id: null, tool: 'Bash', input: { command: 'winget install z' }, sha256: cardsMod.hashOf('Bash', { command: 'winget install z' }), summary: 'install z', rule: 'redline:install', created_at: new Date().toISOString(), expires_at: null, live: true, waiter_pid: lateWaiter.pid });
  await new Promise(r => setTimeout(r, 6000));
  note('running sweep: a card whose waiter is still alive stays pending', !journal().some(r => r.type === 'card_answer' && r.card_id === 'card-0de1a7'));
  lateWaiter.kill(); await waitFor(() => !alive(lateWaiter.pid), 15000);
  const lwClosed = await waitFor(() => journal().find(r => r.type === 'card_answer' && r.card_id === 'card-0de1a7'), 20000);
  note('running sweep: a card whose waiter exits after startup is closed as a system no and a needs_you line is written', !!lwClosed && lwClosed.answer === 'no' && lwClosed.who === 'system' && lwClosed.reason === 'closed: its waiting process exited, not used' && journal().some(r => r.type === 'needs_you' && r.card_id === 'card-0de1a7' && r.kind === 'waiter_gone'));
  note('pid reuse: the fresh-heartbeat card is still pending after the running sweeps', !journal().some(r => r.type === 'card_answer' && r.card_id === 'card-0bea70'));
  clearInterval(beating); J.waiterDone(process.pid);
  J.append({ type: 'card_answer', module: 'approval-cards', card_id: 'card-0bea70', task_id: null, answer: 'no', who: 'system', where: null, reason: 'test cleanup' });
  note('legacy: the young no-pid card is closed by the running sweep once it ages past a day', !!(await waitFor(() => journal().find(r => r.type === 'card_answer' && r.card_id === 'card-01e9ad' && r.answer === 'no' && r.who === 'system'), 40000)) && journal().some(r => r.type === 'needs_you' && r.card_id === 'card-01e9ad'));
  J.append({ type: 'card_answer', module: 'approval-cards', card_id: 'card-0a11e0', task_id: null, answer: 'no', who: 'system', where: null, reason: 'test cleanup' });
  killTree(srv.pid); await waitFor(() => !alive(srv.pid), 15000);

  // ---- 2b: a bot must not read the token (guard-base is on in this config)
  const tokenPath = path.join(state, 'server.token');
  const hook = (tool, ti) => spawnSync(process.execPath, [path.join(ROOT, 'guards', 'guard.js')], { input: JSON.stringify({ session_id: 'fake', tool_name: tool, tool_input: ti, cwd: work }), env, encoding: 'utf8' });
  const rd = hook('Read', { file_path: tokenPath });
  const cat = hook("Bash", { command: "cat " + JSON.stringify(tokenPath.split(path.sep).join("/")) });
  const gl = hook('Glob', { pattern: '**/server.token', path: base });
  const okRead = hook('Read', { file_path: path.join(work, 'notes.txt') });
  note('guard: fake agent Read of the token file is blocked', rd.status === 2, rd.stdout + rd.stderr);
  note('guard: fake agent cat of the token file is blocked', cat.status === 2, cat.stdout + cat.stderr);
  note('guard: fake agent Glob for the token file is blocked', gl.status === 2, gl.stdout + gl.stderr);
  note('guard: an ordinary Read is still allowed', okRead.status === 0, okRead.stdout + okRead.stderr);
  note('token lives in the state dir, not a task work dir', path.dirname(tokenPath) === state && !tokenPath.startsWith(work));

  let ok = true;
  for (const [k, v] of Object.entries(res)) { ok = ok && v; console.log(`${v ? 'PASS' : 'FAIL'} ${k}`); }
  const n = Object.values(res).filter(Boolean).length;
  console.log(`result: ${n}/${Object.keys(res).length} server checks`);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* leave it */ }
  process.exit(ok ? 0 : 1);
}
process.on('exit', () => { if (srv && alive(srv.pid)) killTree(srv.pid); });
main().catch(e => { console.error(e); if (srv) killTree(srv.pid); process.exit(1); });
