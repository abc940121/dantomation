#!/usr/bin/env node
'use strict';
// The v1 base profile (presets/v1.json) with every module of it on at once:
//  - the config key "preset": "v1" turns the set on at load, user entries win, bad names are refused, the preset verb writes nothing
//  - dependsOn of each v1 module is satisfied by the set (chat-endpoint needs rooms, so rooms is in v1)
//  - all load without errors or warnings (main role; worker role for the worker module)
//  - no duplicate route, command, panel, provider, event prefix or settings section
//  - one fake-engine task end to end through bin/harness.js with the guard hooks, every module on
//  - every task.start / tool.done / task.end handler runs, each inside the hook timeout
//  - a beforeReply block yields "(reply withheld by <module>)"
// Runs in any mode: it writes its own temp config and state (HARNESS_CONFIG is ignored).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-combo-v1-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state'); // before the journal is required
process.env.HARNESS_LOG_DIR = path.join(tmp, 'logs');
process.env.HARNESS_CONFIG = path.join(tmp, 'inproc.json');
for (const k of ['HARNESS_OWNER', 'HARNESS_TASK_ID', 'HARNESS_TASK_DIR', 'HARNESS_VOICE', 'HARNESS_BOT']) delete process.env[k];

const M = require(path.join(ROOT, 'lib', 'modules'));
const P = require(path.join(ROOT, 'lib', 'preset'));
const C = require(path.join(ROOT, 'lib', 'config'));
const J = require(path.join(ROOT, 'lib', 'journal'));

const V1 = ['chat-ui', 'chat-endpoint', 'rooms', 'app-ui', 'voice', 'voice-chat', 'device-pairing', 'guard-base', 'guard-private-rules', 'tripwires',
  'approval-cards', 'question-cards', 'notifications', 'worker', 'checkpoint', 'task-watchdog', 'task-board', 'memory-tiers', 'trace'];
const preset = P.read('v1');
const ON = Object.keys(preset.modules).filter(m => preset.modules[m]);

let fails = 0;
const check = (label, ok, info) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const quiet = async fn => { const w = process.stderr.write; const out = []; process.stderr.write = s => { out.push(String(s)); return true; }; try { return [await fn(), out.join('')]; } finally { process.stderr.write = w; } };
const dups = list => list.filter((x, i) => list.indexOf(x) !== i);
const cfgOf = modules => ({ ...C.DEFAULTS, owner_name: 'Tester', modules });

(async () => {
  // ---- the preset covers the v1 set (every dependsOn is inside it)
  check('every v1 module is exactly true in the preset', V1.every(m => preset.modules[m] === true), V1.filter(m => preset.modules[m] !== true).join(','));
  check('preset has nothing outside v1', Object.keys(preset.modules).every(m => V1.includes(m)));
  check('preset carries no settings or secrets', Object.keys(preset).every(k => k === 'modules' || k.startsWith('_')));
  const needs = [];
  for (const m of V1) for (const d of require(path.join(ROOT, 'modules', m, 'index.js')).dependsOn || []) if (!V1.includes(d)) needs.push(`${m} -> ${d}`);
  check('every dependsOn of a v1 module is inside the v1 set', needs.length === 0, needs.join(', '));
  check('chat-endpoint and rooms are both on in the preset', preset.modules['chat-endpoint'] === true && preset.modules.rooms === true);

  // ---- the preset key: read at load, user entries win, bad names refused, the verb writes nothing
  const sd = path.join(tmp, 'cfg'); fs.mkdirSync(sd);
  const loadIn = (name, obj) => { // a fresh process, because the config is cached per process
    const f = path.join(sd, name + '.json');
    if (obj !== undefined) fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
    const env = { ...process.env, HARNESS_CONFIG: f };
    const r = spawnSync(process.execPath, ['-e', "const C=require(process.argv[1]);const c=C.load();console.log(JSON.stringify({modules:c.modules,warn:C.warn()}))", path.join(ROOT, 'lib', 'config.js')], { env, encoding: 'utf8' });
    try { return JSON.parse(r.stdout); } catch { return { error: (r.stderr || '').slice(0, 300) }; }
  };
  const a1 = loadIn('on', { preset: 'v1' });
  check('"preset": "v1" turns every v1 module on at load', !a1.error && V1.every(m => a1.modules[m] === true) && a1.warn === null, a1.error || JSON.stringify(a1.warn));
  const a2 = loadIn('over', { preset: 'v1', modules: { tripwires: false, 'guard-base': false } });
  check('a user false overrides the preset', a2.modules.tripwires === false && a2.modules['guard-base'] === false && a2.modules.trace === true);
  const a3 = loadIn('none', {});
  check('without the key no v1-only module is on', a3.modules.tripwires !== true && a3.modules.rooms !== true);
  for (const bad of ['nope', '../v1', 'V1', 'v1/../v1', '', 7]) {
    const b = loadIn('bad', { preset: bad, modules: { trace: true } });
    check(`preset ${JSON.stringify(bad)} is refused: nothing applied, warning shown`, !b.error && b.warn && /no preset applied/.test(b.warn) && b.modules.tripwires !== true && b.modules.rooms !== true && b.modules.trace === true, b.error || JSON.stringify(b.warn));
  }
  // the verb writes nothing: bytes, mtime and the directory listing stay as they were
  const vf = path.join(sd, 'verb.json'); fs.writeFileSync(vf, '{"modules":{"tripwires":false},"keep": 1}');
  const before = { b: fs.readFileSync(vf), m: fs.statSync(vf).mtimeMs, ls: fs.readdirSync(sd).join() };
  process.env.HARNESS_CONFIG = vf;
  delete require.cache[require.resolve(path.join(ROOT, 'lib', 'config'))]; // the config is cached per process
  const out = [], log0 = console.log;
  console.log = (...x) => out.push(x.join(' '));
  let vrc; try { vrc = P.cli(['v1']); P.cli(['v1', '--dry-run']); } finally { console.log = log0; }
  check('the preset verb writes nothing (bytes, mtime, directory)', fs.readFileSync(vf).equals(before.b) && fs.statSync(vf).mtimeMs === before.m && fs.readdirSync(sd).join() === before.ls);
  check('the verb names the modules, the user override and the line to add', vrc === 0 && out.some(l => /on: trace/.test(l)) && out.some(l => /kept as you set it: tripwires = false/.test(l)) && out.some(l => /^ +"preset": "v1"$/m.test(l)), out.join(' | ').slice(0, 200));
  const cli1 = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'taskmote.js'), 'preset', 'v1'], { env: { ...process.env, HARNESS_CONFIG: path.join(sd, 'absent.json') }, encoding: 'utf8' });
  check('the CLI verb works with no config and creates none', cli1.status === 0 && !fs.existsSync(path.join(sd, 'absent.json')) && /"preset": "v1"/.test(cli1.stdout), (cli1.stderr || '').slice(0, 200));
  const cli2 = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'taskmote.js'), 'preset', '../v1'], { env: { ...process.env, HARNESS_CONFIG: path.join(sd, 'absent.json') }, encoding: 'utf8' });
  check('the CLI verb refuses an invalid name', cli2.status !== 0 && /not valid/.test(cli2.stderr));
  process.env.HARNESS_CONFIG = path.join(tmp, 'inproc.json');

  // ---- load: no errors, no warnings
  const cfg = cfgOf({ ...preset.modules });
  const [loaded, warns] = await quiet(async () => M.registry(cfg));
  check('main role loads with no errors', loaded.errors.length === 0, loaded.errors.join('; '));
  check('main role prints no warnings', warns.trim() === '', warns.trim().slice(0, 200));
  const names = loaded.mods.map(m => m.name);
  const notMain = ON.filter(m => !names.includes(m));
  check('every enabled module loads on main except the worker-only worker', notMain.join(',') === 'worker', 'not loaded: ' + notMain.join(','));
  const [wl, wwarn] = await quiet(async () => M.registry(cfg, { role: 'worker' }));
  check('worker role loads with no errors or warnings', wl.errors.length === 0 && wwarn.trim() === '', wl.errors.join('; ') + wwarn.trim().slice(0, 100));
  check('the worker module loads on the worker role', wl.mods.some(m => m.name === 'worker'));
  const [gap] = await quiet(async () => M.registry(cfgOf({ ...preset.modules, rooms: false })));
  check('chat-endpoint without rooms is one named load error (its dependency left out)', gap.errors.length === 1 && /chat-endpoint: depends on "rooms"/.test(gap.errors[0]), gap.errors.join('; '));

  // ---- no duplicates
  const served = loaded.listRoutes().map(r => `${r.method} /m/${r.module}/${String(r.path).replace(/^\//, '')}`);
  check('no duplicate route (method + served path)', dups(served).length === 0, dups(served).join(', '));
  const owners = {};
  for (const m of loaded.mods) for (const k of Object.keys(m.commands || {})) (owners[k] = owners[k] || []).push(m.name);
  const clash = Object.entries(owners).filter(([, v]) => v.length > 1);
  check('no command name claimed by two modules', clash.length === 0, clash.map(([k, v]) => `${k}: ${v.join('+')}`).join('; '));
  const panels = loaded.listPanels().map(p => `${p.module}/${p.id}`);
  check('no duplicate panel id', dups(panels).length === 0, dups(panels).join(', '));
  const sections = loaded.modules().map(m => M.sectionKey(m.name));
  check('no duplicate settings section', dups(sections).length === 0, dups(sections).join(', '));
  const coreKeys = Object.keys(C.DEFAULTS).concat(['server', 'private_rules', 'owner_name', 'engine', 'engines', 'modules']);
  check('no settings section shadows a core config key', !sections.some(s => coreKeys.includes(s)), sections.filter(s => coreKeys.includes(s)).join(', '));
  const provs = M.PROVIDER_KINDS.flatMap(k => loaded.providers(k).map(p => `${k}:${p.id}`));
  check('no duplicate provided tool, bot or engine', dups(provs).length === 0, dups(provs).join(', '));
  const prefixes = loaded.mods.flatMap(m => [m.name, ...(m.emits || [])]);
  check('no duplicate event prefix', dups(prefixes).length === 0, dups(prefixes).join(', '));

  // ---- events: every handler runs, each inside the hook timeout
  const budget = cfg.modules_hook_timeout_ms || M.HOOK_TIMEOUT_MS;
  const work = path.join(tmp, 'inproc-work');
  fs.mkdirSync(work, { recursive: true });
  J.append({ type: 'task_start', task_id: 'combo-1', request: 'combo task', workdir: work });
  const legacy = { task: { task_id: 'combo-1', request: 'combo task', workdir: work }, code: 0, config: cfg };
  const events = {
    'task.start': { task_id: 'combo-1', request: 'combo task', workdir: work, resumed: false },
    'tool.done': { task_id: 'combo-1', tool: 'Bash', tool_name: 'Bash', tool_use_id: 'toolu_1', workdir: work, input: { command: 'echo hi' }, ok: true },
    'task.end': { task_id: 'combo-1', code: 0, workdir: work },
  };
  let endTotal = 0;
  for (const [event, payload] of Object.entries(events)) {
    const [res, err] = await quiet(async () => {
      const slow = [], errs = [];
      for (const m of loaded.mods) { // one module at a time so each handler is timed alone
        const t0 = Date.now();
        const r = await M.emit([m], event, payload, legacy);
        const ms = Date.now() - t0;
        if (event === 'task.end') endTotal += ms;
        if (ms >= budget) slow.push(`${m.name} ${ms}ms`);
        errs.push(...r.errors);
      }
      return { slow, errs };
    });
    check(`${event}: no handler failed`, res.errs.length === 0 && err.trim() === '', res.errs.concat(err.trim()).join('; ').slice(0, 300));
    check(`${event}: every handler finished under the ${budget} ms hook timeout`, res.slow.length === 0, res.slow.join(', '));
  }
  check('task.end handlers together fit the engine hook limit', endTotal < M.ENGINE_HOOK_LIMIT_MS, endTotal + ' ms');
  const [stat] = await quiet(async () => M.statusLines(loaded.mods, J));
  check('statusLines of all modules answer, none failed', stat.length > 0 && !stat.some(l => /status failed/.test(l)), stat.filter(l => /failed/.test(l)).join('; '));
  const [bt] = await quiet(async () => M.beforeTool(loaded.mods, { tool: 'Bash', ti: { command: 'echo hi' }, cwd: work, task_id: 'combo-1' }));
  check('beforeTool of all modules allows a harmless call', bt === null, JSON.stringify(bt));

  // ---- end to end: bin/harness.js, fake engine, guard hooks, every v1 module on
  const runTask = (label, extraCfg, streamText, request) => {
    const dir = path.join(tmp, label);
    fs.mkdirSync(dir, { recursive: true });
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ owner_name: 'Tester', preset: 'v1', ...extraCfg }));
    const env = { ...process.env, HARNESS_CONFIG: cfgPath, HARNESS_STATE_DIR: path.join(dir, 'state'), HARNESS_LOG_DIR: path.join(dir, 'logs'),
      HARNESS_ENGINE_SCRIPT: path.resolve(ROOT, 'test', 'fake-engine.js'), HARNESS_FAKE_DELAY_MS: '0', HARNESS_FAKE_HOOKS: '1' };
    if (streamText) { const sf = path.join(dir, 'stream.jsonl'); fs.writeFileSync(sf, JSON.stringify({ type: 'result', result: streamText }) + '\n'); env.HARNESS_FAKE_STREAM = sf; }
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'start', request, '--workdir', path.join(dir, 'w')], { env, encoding: 'utf8', timeout: 120000 });
    let recs = [];
    try { recs = fs.readFileSync(path.join(dir, 'state', 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { /* none */ }
    return { r, recs, dir };
  };
  const a = runTask('e2e', {}, 'all good', 'combo v1 task');
  const types = a.recs.map(x => x.type);
  check('e2e: the task finishes (exit 0, task_done)', a.r.status === 0 && types.includes('task_done'), `exit ${a.r.status} ${(a.r.stderr || '').slice(0, 300)}`);
  check('e2e: stderr has no module error or warning', !/module \S+ .*(failed|error|hook_)|legacy contract|warning/i.test(a.r.stderr || ''), (a.r.stderr || '').slice(0, 300));
  check('e2e: the effect wrote out.txt', fs.existsSync(path.join(a.dir, 'w', 'out.txt')));
  check('e2e: the reply was journaled', a.recs.some(x => x.type === 'reply' && x.text === 'all good'));
  const stateM = path.join(a.dir, 'state', 'm');
  console.log('INFO modules with state after the e2e task: ' + ((fs.existsSync(stateM) ? fs.readdirSync(stateM) : []).join(', ') || 'none'));
  const guardLog = path.join(a.dir, 'logs', 'guard.jsonl');
  check('e2e: the guard blocked nothing', !fs.existsSync(guardLog) || fs.readFileSync(guardLog, 'utf8').trim() === '', fs.existsSync(guardLog) ? fs.readFileSync(guardLog, 'utf8').slice(0, 300) : '');

  // ---- a beforeReply block from one module
  const b = runTask('block', { tripwires: { mode: 'block', banned_phrases: ['combo-banned-phrase'] } }, 'the reply has combo-banned-phrase in it', 'combo v1 block task');
  const reply = b.recs.find(x => x.type === 'reply');
  check('beforeReply block: the reply is "(reply withheld by tripwires)"', !!reply && reply.text === '(reply withheld by tripwires)', reply ? reply.text : 'no reply; ' + (b.r.stderr || '').slice(0, 200));
  check('beforeReply block: the journal names the module and never the reply', b.recs.some(x => x.type === 'reply_blocked' && x.module === 'tripwires') && !JSON.stringify(b.recs).includes('combo-banned-phrase'));
  check('beforeReply block: the task still finishes', b.r.status === 0 && b.recs.some(x => x.type === 'task_done'));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nresult: ${fails ? 'FAIL' : 'ok'} (${fails} failing check(s))`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
