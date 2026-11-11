#!/usr/bin/env node
'use strict';
// roles: engines/codex.js with a fake codex (ROLES_CODEX_BIN is a node script). No real model call.
// Runs the real script as a child process, as the core does: prompt on stdin, reply on stdout.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-codex-test-'));
const SCRIPT = path.resolve(__dirname, '..', 'engines', 'codex.js');
const codex = require(SCRIPT);

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info !== undefined ? ': ' + String(info).slice(0, 300) : ''}`); };

// The fake: records argv + stdin of each call in calls.jsonl, answers like codex exec --json -o.
//   FAKE_MODE=resumefail: any "resume" call exits 1;  FAKE_MODE=fail: always exits 3;  FAKE_MODE=empty: no message.
const fake = path.join(tmp, 'fake-codex.js');
fs.writeFileSync(fake, `
const fs = require('fs');
const argv = process.argv.slice(2);
let input = ''; process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, input, cwd: process.cwd() }) + '\\n');
  const mode = process.env.FAKE_MODE || '';
  const resume = argv[1] === 'resume';
  if (mode === 'fail' || (mode === 'resumefail' && resume)) { console.error('boom: something broke'); process.exit(mode === 'fail' ? 3 : 1); }
  const id = argv.find(a => /^[0-9a-f-]{36}$/.test(a));
  console.log(JSON.stringify({ type: 'thread.started', thread_id: resume ? id : '11111111-2222-3333-4444-555555555555' }));
  console.log('not json noise');
  if (mode === 'empty') return;
  const text = 'reply ' + (resume ? 'resumed' : 'fresh') + ' to: ' + input.trim();
  fs.writeFileSync(argv[argv.indexOf('-o') + 1], text + '\\n');
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'event ' + text } }));
});
`);

const state = path.join(tmp, 'state'), work = path.join(tmp, 'work', 'bot-r-0a1b2c3d'), log = path.join(tmp, 'calls.jsonl');
fs.mkdirSync(work, { recursive: true });
const env = mode => ({ ...process.env, ROLES_CODEX_BIN: fake, FAKE_LOG: log, FAKE_MODE: mode || '', HARNESS_STATE_DIR: state, HARNESS_TASK_ID: 't-42', HARNESS_CONFIG: path.join(tmp, 'cfg.json') });
const run = (input, mode) => spawnSync(process.execPath, [SCRIPT], { cwd: work, env: env(mode), input, encoding: 'utf8' });
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
const sessFile = path.join(state, 'm', 'roles', 'codex-session-r-0a1b2c3d.json');

try {
  // pure helpers
  check('bot id from the work folder name', codex.botId(work, {}) === 'r-0a1b2c3d' && codex.botId(tmp, { HARNESS_BOT: 'x y' }) === 'x_y' && codex.botId(tmp, {}) === 'main');
  const argsFresh = codex.buildArgs({ env: { HARNESS_STATE_DIR: 'C:\\s', HARNESS_TASK_ID: 't1' }, cwd: '/w', outFile: '/o.txt', resumeId: null });
  check('first turn: exec, cwd, json, skip git check, sandbox, never ask, prompt from stdin', argsFresh[0] === 'exec' && argsFresh.includes('--skip-git-repo-check') && argsFresh.includes('--json') && argsFresh.slice(1, 3).join() === '-C,/w' && argsFresh.includes('sandbox_mode="workspace-write"') && argsFresh.includes('approval_policy="never"') && argsFresh[argsFresh.length - 1] === '-' && !argsFresh.includes('resume'), argsFresh.join(' '));
  const argsRes = codex.buildArgs({ env: {}, cwd: '/w', outFile: '/o.txt', resumeId: 'abcd1234-aaaa' });
  check('resume turn: exec resume <id> - and no -C', argsRes.slice(0, 2).join() === 'exec,resume' && argsRes.slice(-2).join() === 'abcd1234-aaaa,-' && !argsRes.includes('-C'));
  const mcp = argsFresh.filter(a => a.startsWith('mcp_servers.'));
  const mcpBot = codex.buildArgs({ env: { HARNESS_STATE_DIR: 'C:\s', HARNESS_TASK_ID: 't1', HARNESS_BOT: 'r-test01' }, cwd: '/w', outFile: '/o.txt', resumeId: null }).filter(a => a.startsWith('mcp_servers.'))[2];
  check('HARNESS_BOT is forwarded to the tools server only when set', /HARNESS_BOT="r-test01"/.test(mcpBot) && !/HARNESS_BOT/.test(mcp[2]), mcpBot);
  check('tools server attached with backslash-free paths and the task env', mcp.length === 4 && mcp[3] === 'mcp_servers.taskmote-tools.default_tools_approval_mode="approve"' && mcp[0].startsWith('mcp_servers.taskmote-tools.command=') && /taskmote-mcp\.js/.test(mcp[1]) && /HARNESS_TASK_ID="t1"/.test(mcp[2]) && /HARNESS_STATE_DIR="C:\/s"/.test(mcp[2]) && !mcp.join('').includes('\\\\'), mcp.join(' | '));
  check('event parser takes thread id and last agent message', (() => { const p = codex.parseEvents('{"type":"thread.started","thread_id":"abc"}\nnoise\n{"type":"item.completed","item":{"type":"agent_message","text":"one"}}\n{"type":"item.completed","item":{"type":"agent_message","text":"two"}}\n'); return p.id === 'abc' && p.last === 'two'; })());
  check('ROLES_CODEX_BIN resolves to node + the script', (() => { const e = codex.resolveCodex({ ROLES_CODEX_BIN: fake }); return e.bin === process.execPath && e.pre[0] === fake; })());

  // turn 1: fresh
  const r1 = run('hello one');
  check('first turn: exit 0, stdout is only the reply', r1.status === 0 && r1.stdout === 'reply fresh to: hello one\n', JSON.stringify([r1.status, r1.stdout, r1.stderr]));
  check('first turn: stderr stays empty', r1.stderr === '', r1.stderr);
  const c1 = calls();
  check('fake got the prompt on stdin, in the work folder, as exec (not resume)', c1.length === 1 && c1[0].input === 'hello one' && fs.realpathSync(c1[0].cwd) === fs.realpathSync(work) && c1[0].argv[0] === 'exec' && c1[0].argv[1] !== 'resume');
  check('session id stored under state/m/roles, not in the work folder', fs.existsSync(sessFile) && JSON.parse(fs.readFileSync(sessFile, 'utf8')).id === '11111111-2222-3333-4444-555555555555' && fs.readdirSync(work).length === 0);

  // turn 2: resume
  const r2 = run('hello two');
  const c2 = calls();
  check('second turn resumes the stored id', r2.status === 0 && r2.stdout === 'reply resumed to: hello two\n' && c2.length === 2 && c2[1].argv.slice(0, 2).join() === 'exec,resume' && c2[1].argv.includes('11111111-2222-3333-4444-555555555555') && c2[1].argv[c2[1].argv.length - 1] === '-', JSON.stringify([r2.stdout, c2[1] && c2[1].argv]));

  // resume failure: one fresh start, session replaced
  fs.writeFileSync(sessFile, JSON.stringify({ id: '99999999-2222-3333-4444-555555555555' }));
  const before = calls().length;
  const r3 = run('hello three', 'resumefail');
  const c3 = calls().slice(before);
  check('failed resume falls back to one fresh start', r3.status === 0 && r3.stdout === 'reply fresh to: hello three\n' && c3.length === 2 && c3[0].argv[1] === 'resume' && c3[1].argv[1] !== 'resume', JSON.stringify([r3.status, r3.stdout, r3.stderr, c3.length]));
  check('the fresh start stored a new session id', JSON.parse(fs.readFileSync(sessFile, 'utf8')).id === '11111111-2222-3333-4444-555555555555');

  // failures
  fs.rmSync(sessFile);
  const r4 = run('x', 'fail');
  check('failure: non-zero exit, one short stderr line, empty stdout', r4.status === 1 && r4.stdout === '' && r4.stderr.trim().split('\n').length === 1 && /codex exit 3/.test(r4.stderr) && /boom/.test(r4.stderr), JSON.stringify([r4.status, r4.stderr]));
  check('failure stores no session', !fs.existsSync(sessFile));
  const r5 = run('x', 'empty');
  check('a turn with no message fails', r5.status === 1 && /no reply/.test(r5.stderr), r5.stderr);
  const r6 = run('   \n');
  check('empty prompt fails with exit 2', r6.status === 2 && /empty prompt/.test(r6.stderr));
  check('a damaged session file is ignored (fresh start)', (() => { fs.mkdirSync(path.dirname(sessFile), { recursive: true }); fs.writeFileSync(sessFile, '{ nope'); const n = calls().length; const r = run('again'); return r.status === 0 && calls()[n].argv[1] !== 'resume'; })());
} catch (e) { check('suite ran without an exception', false, e && e.stack); }
finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir */ } }
const fail = results.filter(x => !x).length;
console.log(`${results.length - fail}/${results.length} passed`);
process.exit(fail ? 1 : 0);
