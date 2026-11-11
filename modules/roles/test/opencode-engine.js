#!/usr/bin/env node
'use strict';
// roles: engines/opencode.js (and the daily turn cap shared with codex.js) with fakes. No real model call.
// Runs the real scripts as child processes, as the core does: prompt on stdin, reply on stdout.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-opencode-test-'));
const SCRIPT = path.resolve(__dirname, '..', 'engines', 'opencode.js');
const CODEX = path.resolve(__dirname, '..', 'engines', 'codex.js');
const oc = require(SCRIPT);
const limits = require(path.resolve(__dirname, '..', 'engines', 'limits.js'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info !== undefined ? ': ' + String(info).slice(0, 300) : ''}`); };

// The fake opencode: records argv, the attached prompt file, stdin and the opencode.json of the work folder in calls.jsonl,
// answers like `opencode run --format json`. FAKE_MODE: resumefail | fail | empty | freelimit (free id: "Free usage limit reached") |
// golimit (Go id: rate limit) | keyexp | slow | statuswords (exit 1 with a reply that says success).
const fake = path.join(tmp, 'fake-opencode.js');
fs.writeFileSync(fake, `
const fs = require('fs');
const argv = process.argv.slice(2);
let stdin = ''; process.stdin.on('data', c => stdin += c);
process.stdin.on('end', () => {
  const fi = argv.indexOf('-f'), input = fi >= 0 ? fs.readFileSync(argv[fi + 1], 'utf8') : '';
  let cfg = null; try { cfg = JSON.parse(fs.readFileSync('opencode.json', 'utf8')); } catch (e) {}
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, input, stdin, cwd: process.cwd(), cfg, env: process.env.OPENCODE_CONFIG_CONTENT }) + '\\n');
  const mode = process.env.FAKE_MODE || '';
  const model = argv[argv.indexOf('-m') + 1];
  if (mode === 'freelimit' && model.startsWith('opencode/')) { console.error('Error: Free usage limit reached. Try again later.'); process.exit(1); }
  if (mode === 'golimit' && model.startsWith('opencode-go/')) { console.error('Error: rate limit exceeded'); process.exit(1); }
  if (mode === 'keyexp') { console.error('Error: API key has expired'); process.exit(1); }
  if (mode === 'slow') { setTimeout(() => {}, 60000); return; }
  const si = argv.indexOf('-s'), resume = si >= 0;
  if (mode === 'fail' || (mode === 'resumefail' && resume)) { console.error('boom: something broke'); process.exit(mode === 'fail' ? 3 : 1); }
  const sid = resume ? argv[si + 1] : 'ses_fake0123456789ABCDEF';
  console.log(JSON.stringify({ type: 'step_start', sessionID: sid, part: { messageID: 'm1', type: 'step-start' } }));
  console.log('not json noise');
  if (mode === 'empty') return;
  if (mode === 'statuswords') { console.log(JSON.stringify({ type: 'text', sessionID: sid, part: { messageID: 'm2', type: 'text', text: 'status: success, all done' } })); process.exit(1); }
  console.log(JSON.stringify({ type: 'text', sessionID: sid, part: { messageID: 'm1', type: 'text', text: 'early thought' } }));
  console.log(JSON.stringify({ type: 'tool_use', sessionID: sid, part: { messageID: 'm1', type: 'tool' } }));
  const text = 'reply ' + (resume ? 'resumed' : 'fresh') + ' to: ' + input.trim();
  console.log(JSON.stringify({ type: 'text', sessionID: sid, part: { messageID: 'm2', type: 'text', text } }));
});
`);

const state = path.join(tmp, 'state'), work = path.join(tmp, 'work', 'bot-r-0a1b2c3d'), log = path.join(tmp, 'calls.jsonl'), cfgFile = path.join(tmp, 'cfg.json');
fs.mkdirSync(work, { recursive: true });
const FREE = oc.FREE, GO = oc.GO;
const env = (mode, extra) => ({ ...process.env, ROLES_OPENCODE_BIN: fake, ROLES_OPENCODE_MODEL: '', FAKE_LOG: log, FAKE_MODE: mode || '', HARNESS_STATE_DIR: state, HARNESS_TASK_ID: 't-42', HARNESS_CONFIG: cfgFile, ...extra });
const run = (input, mode, extra) => spawnSync(process.execPath, [SCRIPT], { cwd: work, env: env(mode, extra), input, encoding: 'utf8' });
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
const modelOfCall = c => c.argv[c.argv.indexOf('-m') + 1];
const promptFileOf = c => c.argv[c.argv.indexOf('-f') + 1];
const rolesDir = path.join(state, 'm', 'roles');
const sessFile = path.join(rolesDir, 'opencode-session-r-0a1b2c3d.json');
const turnsFile = path.join(rolesDir, 'turns-r-0a1b2c3d.json');
const exhFile = path.join(rolesDir, 'opencode-free-exhausted.json');
const goFile = path.join(rolesDir, 'opencode-go-turns.json');
const setCfg = roles => fs.writeFileSync(cfgFile, JSON.stringify({ roles }));
const cleanState = () => { for (const f of [sessFile, turnsFile, exhFile, goFile]) fs.rmSync(f, { force: true }); };

try {
  // pure helpers
  check('bot id from the work folder name', oc.botId(work, {}) === 'r-0a1b2c3d' && oc.botId(tmp, { HARNESS_BOT: 'x y' }) === 'x_y' && oc.botId(tmp, {}) === 'main');
  check('args: run, short message, standalone, auto, json, -m, -f prompt file; no -s on the first turn', oc.buildArgs({ model: FREE, resumeId: null, promptFile: 'P' }).join(' ') === `run Answer the request in the attached file. --standalone --auto --format json -m ${FREE} -f P`);
  check('resume args add -s <id>', oc.buildArgs({ model: GO, resumeId: 'ses_abc', promptFile: 'P' }).join(' ').includes('-m ' + GO + ' -s ses_abc -f P'));
  check('the allowed ids are the two hard-coded ones', FREE === 'opencode/deepseek-v4.1-flash-free' && GO === 'opencode-go/deepseek-v4.1-flash');
  check('event parser takes the session id and the text of the last message with text', (() => { const p = oc.parseEvents('{"type":"text","sessionID":"ses_a","part":{"messageID":"1","text":"one"}}\nnoise\n{"type":"text","sessionID":"ses_a","part":{"messageID":"2","text":"two "}}\n{"type":"text","sessionID":"ses_a","part":{"messageID":"2","text":"parts"}}\n'); return p.id === 'ses_a' && p.last === 'two parts'; })());
  check('ROLES_OPENCODE_BIN resolves to node + the script', (() => { const e = oc.resolveOpencode({ ROLES_OPENCODE_BIN: fake }); return e.bin === process.execPath && e.pre[0] === fake; })());
  check('only the two ids pass the money gate (variant suffix ok)', oc.modelProblem(FREE, []) === null && oc.modelProblem(GO, []) === null && oc.modelProblem(GO + '#high', []) === null);
  check('everything else is refused, bilingual, even other free-looking or plan ids', ['openai/gpt-5', 'opencode/big-pickle', 'opencode/glm-5.3-flash-free', 'opencode-go/kimi-k2', 'evil/opencode-go/deepseek-v4.1-flash'].every(m => oc.modelProblem(m, []) !== null) && /could cost money/.test(oc.modelProblem('openai/gpt-5', [])) && /可能產生費用/.test(oc.modelProblem('openai/gpt-5', [])), oc.modelProblem('openai/gpt-5', []));
  check('the owner extra list lets a listed model through, only that one', oc.modelProblem('openai/gpt-5', ['openai/gpt-5']) === null && oc.modelProblem('openai/gpt-5', ['openai/gpt-4']) !== null);
  check('classify: free limit, quota, key, nothing', oc.classify('Free usage limit reached') === 'free' && oc.classify('x rate limit y') === 'quota' && oc.classify('usage limit reached') === 'quota' && oc.classify('API key has expired') === 'key' && oc.classify('Unauthorized') === 'key' && oc.classify('boom') === null);
  check('model read from the role record when no override', (() => { fs.mkdirSync(rolesDir, { recursive: true }); fs.writeFileSync(path.join(rolesDir, 'roles.json'), JSON.stringify({ roles: [{ id: 'r-0a1b2c3d', name: 'n', model: GO }] })); return oc.modelOf({ HARNESS_STATE_DIR: state }, 'r-0a1b2c3d') === GO && oc.modelOf({ HARNESS_STATE_DIR: state }, 'r-ffffffff') === ''; })());
  fs.rmSync(path.join(rolesDir, 'roles.json'));

  // turn 1: fresh, no model = free first
  const r1 = run('hello one');
  check('first turn: exit 0, stdout is only the last message text', r1.status === 0 && r1.stdout === 'reply fresh to: hello one\n', JSON.stringify([r1.status, r1.stdout, r1.stderr]));
  check('first turn: stderr stays empty', r1.stderr === '', r1.stderr);
  const c1 = calls();
  check('the prompt went in the attached file (stdin closed), in the work folder, on the free id, no -s', c1.length === 1 && c1[0].input === 'hello one' && c1[0].stdin === '' && fs.realpathSync(c1[0].cwd) === fs.realpathSync(work) && modelOfCall(c1[0]) === FREE && !c1[0].argv.includes('-s') && c1[0].argv[0] === 'run', JSON.stringify(c1[0]));
  check('the prompt file is under state/m/roles (not the work folder) and is deleted after the turn', path.dirname(promptFileOf(c1[0])) === rolesDir && !fs.existsSync(promptFileOf(c1[0])));
  const oj = c1[0].cfg;
  check('HARNESS_BOT is forwarded to the opencode tools env only when set', oc.configFor({ HARNESS_BOT: 'r-test01' }, '/w', 'node', false, false).mcp['taskmote-tools'].environment.HARNESS_BOT === 'r-test01' && !('HARNESS_BOT' in oc.configFor({}, '/w', 'node', false, false).mcp['taskmote-tools'].environment));
  check('opencode.json in the work folder: tools server with the task env, no backslashes, no env-var config', oj && oj.mcp['taskmote-tools'].type === 'local' && /taskmote-mcp\.js$/.test(oj.mcp['taskmote-tools'].command[1]) && oj.mcp['taskmote-tools'].environment.HARNESS_TASK_ID === 't-42' && !JSON.stringify(oj.mcp).includes('\\\\') && c1[0].env === undefined, JSON.stringify(oj && oj.mcp));
  const pm = oj && oj.permission;
  check('opencode.json permissions: external dirs denied except the work folder, secret-file reads, config edits, webfetch, bash denied', pm && pm.external_directory['*'] === 'deny' && Object.entries(pm.external_directory).some(([k, v]) => v === 'allow' && k.replace(/\/\*\*$/, '') === work.replace(/\\/g, '/')) && pm.read['**/*.env'] === 'deny' && ['opencode.json', 'AGENTS.md', 'CLAUDE.md'].every(x => pm.edit[x] === 'deny' && pm.edit['**/' + x] === 'deny') && ['.opencode/**', '.claude/**', '.codex/**'].every(x => pm.edit[x] === 'deny') && pm.bash === 'deny' && pm.shell === 'deny', JSON.stringify(pm));
  check('web is on by default: no network tool is denied', ['webfetch', 'websearch', 'execute', 'fetch'].every(k => pm[k] === 'allow' || pm[k] === undefined) && pm.webfetch === 'allow', JSON.stringify(pm));
  check('session id stored under state/m/roles', fs.existsSync(sessFile) && JSON.parse(fs.readFileSync(sessFile, 'utf8')).id === 'ses_fake0123456789ABCDEF');

  // turn 2: resume
  const r2 = run('hello two');
  const c2 = calls();
  check('second turn passes -s with the stored id', r2.status === 0 && r2.stdout === 'reply resumed to: hello two\n' && c2.length === 2 && c2[1].argv.join(' ').includes('-s ses_fake0123456789ABCDEF -f '), JSON.stringify([r2.stdout, c2[1] && c2[1].argv]));
  setCfg({ opencode_allow_bash: true });
  run('bash on');
  check('the config switch opencode_allow_bash allows bash', calls().pop().cfg.permission.bash === 'allow');
  setCfg({ opencode_allow_web: false });
  run('web off');
  const pw = calls().pop().cfg.permission;
  check('opencode_allow_web=false denies every network tool, incl. Code Mode execute', ['execute', 'webfetch', 'websearch', 'codesearch', 'fetch', 'browser', 'web*', 'http*', 'context7_*'].every(k => pw[k] === 'deny'), JSON.stringify(pw));
  check('opencode_allow_web=false leaves the file rules alone', pw.external_directory['*'] === 'deny' && pw.read['**/*.env'] === 'deny' && pw.edit['opencode.json'] === 'deny');
  setCfg({});

  // resume failure: one fresh start
  const before = calls().length;
  const r3 = run('hello three', 'resumefail');
  const c3 = calls().slice(before);
  check('failed resume falls back to one fresh start', r3.status === 0 && r3.stdout === 'reply fresh to: hello three\n' && c3.length === 2 && c3[0].argv.includes('-s') && !c3[1].argv.includes('-s'), JSON.stringify([r3.status, r3.stdout, r3.stderr, c3.length]));

  // failures and the success rule
  cleanState();
  let n = calls().length;
  const r4 = run('x', 'fail');
  check('a failing run: exit 1, one stderr line with the error, empty stdout, no retry loop', r4.status === 1 && r4.stdout === '' && /opencode exit 3.*boom/.test(r4.stderr.trim()) && r4.stderr.trim().split('\n').length === 1 && calls().length === n + 1, JSON.stringify([r4.status, r4.stderr, calls().length - n]));
  check('failure stores no session', !fs.existsSync(sessFile));
  const r5 = run('x', 'empty');
  check('exit 0 with no reply text is a failure', r5.status === 1 && /no reply/.test(r5.stderr), r5.stderr);
  const r6 = run('x', 'statuswords');
  check('a reply that says "success" but exits 1 is a failure (only exit 0 + text counts)', r6.status === 1 && r6.stdout === '', JSON.stringify([r6.status, r6.stdout]));
  check('empty prompt fails with exit 2', run('   \n').status === 2);

  // money gate end to end
  cleanState();
  n = calls().length;
  const g1 = run('x', '', { ROLES_OPENCODE_MODEL: 'openai/gpt-5' });
  check('a per-token model is refused before opencode runs, with a bilingual message', g1.status === 1 && g1.stdout === '' && /could cost money/.test(g1.stderr) && /可能產生費用/.test(g1.stderr) && calls().length === n, g1.stderr);
  const g1b = run('x', '', { ROLES_OPENCODE_MODEL: 'opencode/big-pickle' });
  check('an id outside the two (even a free one) is refused', g1b.status === 1 && calls().length === n, g1b.stderr);
  const g4 = run('x', '', { ROLES_OPENCODE_MODEL: GO });
  check('the Go plan id runs without config', g4.status === 0 && modelOfCall(calls()[n]) === GO, g4.stderr);
  setCfg({ opencode_extra_paid_models: ['openai/gpt-5'] });
  const g3 = run('x', '', { ROLES_OPENCODE_MODEL: 'openai/gpt-5' });
  check('a model listed in opencode_extra_paid_models is used', g3.status === 0 && modelOfCall(calls()[n + 1]) === 'openai/gpt-5', g3.stderr);
  setCfg({});

  // free exhausted -> Go, remembered 120 minutes
  cleanState();
  n = calls().length;
  const f1 = run('fb', 'freelimit');
  const fc = calls().slice(n).map(modelOfCall);
  check('"Free usage limit reached": one retry on the Go id, reply returned', f1.status === 0 && /^reply /.test(f1.stdout) && fc.join() === FREE + ',' + GO, JSON.stringify([f1.status, f1.stdout, fc, f1.stderr]));
  check('free exhausted is remembered for about 120 minutes', (() => { const j = JSON.parse(fs.readFileSync(exhFile, 'utf8')); const left = j.until - Date.now(); return left > 119 * 60000 && left <= 120 * 60000; })());
  n = calls().length;
  const f2 = run('next', 'freelimit');
  check('while remembered, later turns go straight to the Go id (no free attempt)', f2.status === 0 && calls().slice(n).map(modelOfCall).join() === GO, JSON.stringify(calls().slice(n).map(modelOfCall)));
  fs.writeFileSync(exhFile, JSON.stringify({ until: Date.now() - 1000 }));
  n = calls().length;
  run('later');
  check('after the 120 minutes the free id is tried first again', modelOfCall(calls()[n]) === FREE);

  // quota used up / key expired
  cleanState(); n = calls().length;
  fs.writeFileSync(exhFile, JSON.stringify({ until: Date.now() + 60000 }));
  const q = run('q', 'golimit');
  check('rate limit on the Go id: no retry, bilingual quota reply, exit 0', q.status === 0 && /quota is used up/.test(q.stdout) && /額度/.test(q.stdout) && calls().length === n + 1, JSON.stringify([q.status, q.stdout, calls().length - n]));
  cleanState();
  const k = run('k', 'keyexp');
  check('expired key: bilingual renewal reply, exit 0, no retry', k.status === 0 && /API key has expired/.test(k.stdout) && /金鑰/.test(k.stdout), k.stdout);

  // timeout
  cleanState();
  setCfg({ opencode_timeout_s: 1 });
  const t0 = Date.now(), tm = run('slow', 'slow');
  check('timeout (config opencode_timeout_s): process killed, bilingual reply, exit 0, quickly', tm.status === 0 && /too long/.test(tm.stdout) && /花太久/.test(tm.stdout) && Date.now() - t0 < 20000, JSON.stringify([tm.status, tm.stdout, Date.now() - t0]));
  setCfg({});
  check('default timeout is 900 seconds, configurable', limits.settings({ HARNESS_CONFIG: cfgFile }).timeoutS === 900 && (setCfg({ opencode_timeout_s: 30 }), limits.settings({ HARNESS_CONFIG: cfgFile }).timeoutS === 30));
  setCfg({});

  // Go plan counter (all roles) and goDailyCap
  cleanState();
  run('a', '', { ROLES_OPENCODE_MODEL: GO }); run('b', '', { ROLES_OPENCODE_MODEL: GO }); run('free one');
  check('Go turns are counted per day in module state, free turns are not', JSON.parse(fs.readFileSync(goFile, 'utf8')).n === 2 && limits.goCount(rolesDir) === 2);
  check('role_list shows the count (opencode_go_turns_today)', (() => { const mod = require('../index.js'); const t = mod.api.mcpTools.find(x => x.name === 'role_list'); return t.run({}, { state: { dir: rolesDir } }).opencode_go_turns_today === 2; })());
  check('goDailyCap default is 0 (off)', limits.settings({ HARNESS_CONFIG: cfgFile }).goCap === 0);
  setCfg({ go_daily_cap: 2 }); n = calls().length;
  const gc = run('c', '', { ROLES_OPENCODE_MODEL: GO });
  check('goDailyCap reached: bilingual refusal, exit 0, opencode not run, not counted', gc.status === 0 && /Go plan daily limit of 2/.test(gc.stdout) && /今日/.test(gc.stdout) && calls().length === n && limits.goCount(rolesDir) === 2, gc.stdout);
  const gd = run('d');
  check('the cap does not block the free id', gd.status === 0 && /^reply /.test(gd.stdout));
  fs.writeFileSync(goFile, JSON.stringify({ day: '2000-01-01', n: 99 }));
  check('a count from an earlier day is 0', limits.goCount(rolesDir) === 0);
  fs.writeFileSync(cfgFile, '{ nope');
  check('a damaged config file gives the defaults, not a crash', limits.settings({ HARNESS_CONFIG: cfgFile }).cap === 200 && limits.settings({ HARNESS_CONFIG: cfgFile }).paid.length === 0);

  // daily turn cap (opencode)
  cleanState();
  setCfg({ daily_turn_cap: 2 });
  const a = run('one'), b = run('two'), n1 = calls().length, c = run('three');
  check('cap 2: two turns pass, the third is refused with exit 0', a.status === 0 && b.status === 0 && c.status === 0 && n1 === calls().length, JSON.stringify([a.status, b.status, c.status]));
  check('the refusal names the cap, the reset, in English and Traditional Chinese', /daily limit of 2 turns/.test(c.stdout) && /resets tomorrow/.test(c.stdout) && /每日 2 次/.test(c.stdout) && /明天/.test(c.stdout), c.stdout);
  check('a refused turn is not counted', JSON.parse(fs.readFileSync(turnsFile, 'utf8')).n === 2);
  fs.writeFileSync(turnsFile, JSON.stringify({ day: '2000-01-01', n: 99 }));
  const d = run('new day');
  check('a counter from an earlier day does not count (resets next day)', d.status === 0 && /^reply /.test(d.stdout) && JSON.parse(fs.readFileSync(turnsFile, 'utf8')).n === 1, d.stdout);
  setCfg({ daily_turn_cap: 0 });
  fs.writeFileSync(turnsFile, JSON.stringify({ day: limits.localDay(new Date()), n: 5000 }));
  check('cap 0 = off', run('free').stdout.startsWith('reply '));
  setCfg({});
  check('default cap is 200', limits.settings({ HARNESS_CONFIG: cfgFile }).cap === 200 && limits.DEFAULT_CAP === 200);
  fs.writeFileSync(turnsFile, JSON.stringify({ day: limits.localDay(new Date()), n: 200 }));
  check('default cap refuses at 200', /daily limit of 200 turns/.test(run('x').stdout));

  // the same cap in the codex engine (fake codex: any call answers)
  const fakeCodex = path.join(tmp, 'fake-codex.js');
  fs.writeFileSync(fakeCodex, `let i='';process.stdin.on('data',c=>i+=c);process.stdin.on('end',()=>{const a=process.argv.slice(2);require('fs').writeFileSync(a[a.indexOf('-o')+1],'codex ok\\n');console.log('{"type":"thread.started","thread_id":"11111111-2222-3333-4444-555555555555"}');});`);
  const runCodex = () => spawnSync(process.execPath, [CODEX], { cwd: work, env: { ...env(''), ROLES_CODEX_BIN: fakeCodex }, input: 'hi', encoding: 'utf8' });
  setCfg({ daily_turn_cap: 1 }); fs.rmSync(turnsFile, { force: true });
  const k1 = runCodex(), k2 = runCodex();
  check('codex engine: cap 1 lets one turn through, refuses the next with the notice', k1.stdout === 'codex ok\n' && k2.status === 0 && /daily limit of 1 turns/.test(k2.stdout) && /每日 1 次/.test(k2.stdout), JSON.stringify([k1.stdout, k2.stdout, k2.stderr]));
} catch (e) { check('suite ran without an exception', false, e && e.stack); }
finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir */ } }
const fail = results.filter(x => !x).length;
console.log(`${results.length - fail}/${results.length} passed`);
process.exit(fail ? 1 : 0);
