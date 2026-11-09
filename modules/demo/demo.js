'use strict';
// `taskmote demo`: a 60-second tour of what Taskmote adds on top of Claude Code, run in the
// throwaway sandbox bin/taskmote.js made (TASKMOTE_DEMO_SANDBOX). Everything here is the real
// thing except the agent: the real server, the real harness run, the real guard hook and module
// chain, the real approval card and permission-prompt tool, the real checkpoint undo. The agent
// is agent.js, a script (no LLM) that sends four tool calls through that path.
// TASKMOTE_DEMO_AUTO=yes|no answers the card itself (tests, CI); otherwise the owner taps it.
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const TASKMOTE = path.join(ROOT, 'bin', 'taskmote.js');
const tty = !!process.stdout.isTTY;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const say = (tag, code, text) => console.log(`${paint(code, tag.padEnd(9))} ${text}`);
const dim = s => paint('2', s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function request(port, token, method, p, body) {
  return new Promise(resolve => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, timeout: 5000, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, res => {
      let s = '';
      res.on('data', d => { s += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* not json */ } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}

const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });

// Kill a process and its children, hard (no cleanup runs: a crash).
function kill(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

async function demo(args, ctx) {
  const sb = process.env.TASKMOTE_DEMO_SANDBOX;
  if (!sb || process.env.HARNESS_TASK_ID) {
    console.error('the demo runs only through `taskmote demo`, which makes its own throwaway sandbox; agents never run it.');
    process.exitCode = 6; return;
  }
  const J = ctx.J;
  const t0 = Date.now();
  const auto = /^(yes|no)$/i.test(process.env.TASKMOTE_DEMO_AUTO || '') ? process.env.TASKMOTE_DEMO_AUTO.toLowerCase() : null;
  const events = path.join(sb, 'events.jsonl');
  const work = path.join(process.env.HARNESS_WORK_DIR, 'bot-main');
  let server = null, finished = false;

  // Stop everything this demo started: the server and any task process still holding the executor lock.
  const stopAll = () => {
    if (server) kill(server.pid);
    try { for (const pid of [].concat(JSON.parse(fs.readFileSync(path.join(J.STATE, 'executor.lock'), 'utf8')).pids || [])) kill(pid); } catch { /* no lock */ }
  };
  process.on('SIGINT', () => { if (finished) return; stopAll(); console.log(`\n${dim('stopped; the sandbox is removed.')}`); process.exit(0); });
  try {
    // The sandbox config: the modules this tour shows; the server on a free loopback port.
    const port = await freePort();
    fs.writeFileSync(process.env.HARNESS_CONFIG, JSON.stringify({ owner_name: 'you',
      modules: { 'guard-base': true, checkpoint: true, 'approval-cards': true, 'chat-ui': true, demo: true },
      server: { host: '127.0.0.1', port } }, null, 2));

    // A tiny project for the agent to work in.
    fs.mkdirSync(work, { recursive: true });
    git(work, 'init', '-q');
    fs.writeFileSync(path.join(work, 'notes.md'), '# Notes\n\nTeh launch\n');
    fs.writeFileSync(path.join(work, 'app.js'), "console.log('hello');\n");
    git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'start');
    fs.writeFileSync(events, '');

    const startServer = () => {
      const log = fs.openSync(path.join(sb, 'server.log'), 'a');
      // HARNESS_PAUSE_*: bin/effect.js's crash-window seam, so the crash step lands at a known point.
      const env = { ...process.env, HARNESS_ENGINE_SCRIPT: path.join(__dirname, 'agent.js'), TASKMOTE_DEMO_EVENTS: events, HARNESS_PAUSE_EFFECT: 'demo-summary', HARNESS_PAUSE_AFTER_ACT_MS: '120000' };
      delete env.TASKMOTE_DEMO_SANDBOX;
      server = spawn(process.execPath, [TASKMOTE, 'serve'], { env, stdio: ['ignore', log, log], windowsHide: true });
      fs.closeSync(log);
    };
    const waitUp = async () => {
      for (let i = 0; i < 200; i++) { const r = await request(port, null, 'GET', '/api/status'); if (r && r.status === 200) return true; await sleep(100); }
      return false;
    };

    console.log(paint('1', 'Taskmote demo') + dim(` (sandbox ${sb}; your own config and state are not touched)`));
    startServer();
    if (!await waitUp()) { stopAll(); console.error('the server did not start; see ' + path.join(sb, 'server.log')); process.exitCode = 1; return; }
    const token = fs.readFileSync(path.join(J.STATE, 'server.token'), 'utf8').trim();
    const url = `http://127.0.0.1:${port}/m/chat-ui/ui/index.html#t=${token}`;
    say('server', '36', `running. Open the approval page: ${paint('4', url)}`);
    say('', '0', dim('loopback only: phones need the device-pairing module and a private network, so this demo stays on this machine.'));

    const made = await request(port, token, 'POST', '/api/tasks', { bot: 'main', prompt: 'demo: tidy notes.md, publish, summarise' });
    if (!made || made.status !== 201) { stopAll(); console.error(`could not start the task: ${JSON.stringify(made && made.body)}`); process.exitCode = 1; return; }
    const taskId = made.body.id;
    say('task', '36', `started ${taskId} through the real harness; a scripted agent (no LLM) makes the tool calls.`);

    // Narrate the agent's events as they arrive.
    let seen = 0;
    const nextEvent = async (pred, ms = auto ? 60000 : 3600000) => {
      for (const end = Date.now() + ms; ;) {
        if (Date.now() > end) throw new Error('the scripted agent stopped answering; see ' + path.join(J.STATE));
        const lines = fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
        for (; seen < lines.length; seen++) if (pred(lines[seen])) return lines[seen++];
        await sleep(100);
      }
    };
    const result = { checkpoint: false, blocked: false, resumed: false, card: false, outcome: null, undone: false };

    const a = await nextEvent(e => e.step === 'a');
    const cks = J.readAll().records.filter(r => r.type === 'checkpoint' && r.task_id === taskId);
    result.checkpoint = a.ok && cks.length > 0;
    say('(a) edit', '32', a.ok ? `allowed: the agent fixed a typo in notes.md; checkpoint ${cks.length ? cks[cks.length - 1].n : '?'} taken first.` : `unexpected: the edit was stopped (${a.reason})`);

    const b = await nextEvent(e => e.step === 'b');
    result.blocked = b.blocked;
    say('(b) block', '31', b.blocked ? `"git push --force origin main" BLOCKED: ${b.reason.replace(/^\[guard\]\s*BLOCKED \(\w+\):\s*/, '').replace(/\.\s*Do not retry.*$/s, '')}` : 'unexpected: the force push was not blocked');
    say('', '0', dim('a locked red line: unlike a Claude Code permission prompt, no config, flag, bypass mode or click can switch it off.'));

    // Crash and resume: the agent is killed (kill -9) between a side effect's act and its done
    // line; the journal keeps the task open, and `resume` picks it up from the journal.
    for (let i = 0; i < 300 && !fs.existsSync(path.join(J.STATE, 'paused.flag')); i++) await sleep(100);
    const lock = J.readLock(path.join(J.STATE, 'executor.lock'));
    for (const pid of (lock && lock.pids) || []) kill(pid);
    say('crash', '35', 'the agent was killed mid-step (kill -9), after writing summary.md but before the journal saw it finish.');
    let resumed = null;
    for (let i = 0; i < 100 && !(resumed && resumed.status === 200); i++) { resumed = await request(port, token, 'POST', `/api/tasks/${taskId}/resume`); if (!resumed || resumed.status !== 200) await sleep(200); }
    const r = resumed && resumed.status === 200 && await nextEvent(e => e.step === 'resume');
    const eff = r && await nextEvent(e => e.step === 'effect');
    result.resumed = !!(r && r.skipped.includes(1) && r.skipped.includes(2) && /RECONCILED/.test(eff.out));
    say('resume', '35', result.resumed ? `the same task resumed from the journal: steps ${r.skipped.join(', ')} not redone, summary.md not written twice (${eff.out.split(':')[0].toLowerCase()}).` : `unexpected: resume did not pick the task up (${JSON.stringify(resumed && resumed.body)})`);

    say('', '0', dim('a crashed Claude Code session stays dead until you notice; here the journal knows which steps and side effects finished.'));

    const c = await nextEvent(e => e.step === 'c' && 'ask' in e);
    let card = null;
    for (let i = 0; i < 100 && !card; i++) { const q = await request(port, token, 'GET', '/api/cards?state=pending'); card = q && q.body && q.body.find(x => x.task === taskId); if (!card) await sleep(100); }
    result.card = c.ask && !!card;
    say('(c) card', '33', card ? `risky step held: ${card.summary.replace(/ \(in .*$/, '')}` : `unexpected: no approval card (${c.reason})`);
    say('', '0', dim('the agent waits on a real approval card; with device pairing the same card reaches your phone, so you can answer away from the desk.'));

    if (card) {
      if (auto) {
        say('', '0', dim(`TASKMOTE_DEMO_AUTO=${auto}: answering the card from here.`));
        await request(port, token, 'POST', `/api/cards/${card.id}`, { answer: auto });
      } else {
        say('waiting', '33', `tap Approve or Deny on the page: ${paint('4', url)}  ${dim('(Ctrl-C quits)')}`);
      }
      // A person answering the card gets no deadline: the page stays up until they tap or press Ctrl-C.
      const o = await nextEvent(e => e.step === 'c' && 'outcome' in e, auto ? undefined : Infinity);
      result.outcome = o.outcome;
      // Who decided: the server's trace line (route, caller, user agent). No line means the card was not answered over HTTP.
      let trace = '';
      for (let i = 0; i < 20 && !trace; i++) { // the line lands just after the outcome event
        try { trace = (fs.readFileSync(path.join(sb, 'server.log'), 'utf8').match(/^card \S+ decision via .*$/m) || [''])[0]; } catch {}
        if (!trace) await sleep(100);
      }
      say('', '0', dim(trace || 'no HTTP answer was logged for this card'));
      say('answer', o.outcome === 'allow' ? '32' : '31', o.outcome === 'allow' ? 'APPROVED: the agent may make the paid call now (the demo agent stops short of the network).' : `DENIED: ${o.message.replace(/^card \S+ DENIED \(\w+\):\s*/, '').replace(/ \(in .*$/, '').slice(0, 160)}; the agent was told no and moves on.`);
    }

    // Wait for the task to end (the executor lock is let go) before the owner's undo.
    for (let i = 0; i < 300; i++) {
      const r = await request(port, token, 'GET', `/api/tasks/${taskId}`);
      const st = r && r.body && (r.body.state || (r.body.task && r.body.task.state));
      if (st && !['running', 'queued', 'waiting_card'].includes(st)) break;
      await sleep(100);
    }
    const before = git(work, 'diff', '--', 'notes.md').stdout.split('\n').filter(l => /^[+-][^+-]/.test(l));
    const u = spawnSync(process.execPath, [TASKMOTE, 'undo'], { env: process.env, encoding: 'utf8' });
    result.undone = u.status === 0 && git(work, 'status', '--porcelain').stdout.trim() === '';
    say('(d) undo', '32', result.undone ? `taskmote undo put notes.md back (the agent's change: ${before.map(l => (l[0] === '+' ? paint('32', l) : paint('31', l))).join(' ')})` : `unexpected: ${(u.stdout + u.stderr).trim().split('\n')[0]}`);

    finished = true;
    stopAll();
    const ok = result.checkpoint && result.blocked && result.resumed && result.card && !!result.outcome && result.undone;
    console.log(`${paint(ok ? '1;32' : '1;31', ok ? 'done' : 'demo incomplete')} in ${((Date.now() - t0) / 1000).toFixed(0)} s. ${dim('Install for real: see README "Quickstart".')}`);
    console.log(`DEMO_RESULT ${JSON.stringify(result)}`);
    process.exitCode = ok ? 0 : 1;
  } catch (e) { finished = true; stopAll(); console.error(`demo stopped: ${e.message}`); process.exitCode = 1; }
}

module.exports = { demo };
