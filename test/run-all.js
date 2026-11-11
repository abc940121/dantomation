#!/usr/bin/env node
'use strict';
// Run every suite under one module configuration and print one line per suite.
//   node test/run-all.js core            all modules off (+ an end-to-end fake-engine task)
//   node test/run-all.js <module>        only that module on
//   node test/run-all.js module <name>   only that module's suites (the module, plus the modules its suites need, on)
//   node test/run-all.js all             all modules on
//   node test/run-all.js default         no HARNESS_CONFIG: the owner's real config, if any
//   node test/run-all.js every           core, each module alone, all
//   add --parallel [--jobs N] to run the suites of a mode at the same time (output stays in suite order)
//   a full run (all, every) takes a machine-wide lock in os.tmpdir() (test/gate-lock.js) and waits if another full run holds it
//   add --base <ref> to enable the trunk-diff suite against that base ref (else it SKIPs)
// Modules are discovered: every modules/<name>/ with an index.js. Its suites come from
// modules/<name>/tests.json {"suites": [{label, file, needs: [modules]}]} (file is relative
// to the module folder), so adding a module never edits this file (docs/module-contract.md).
// Core suites (test/*.js) are listed below. A temp config is written under os.tmpdir() and
// passed as HARNESS_CONFIG. A suite that needs a module which is off prints SKIP. Exit 0
// when no suite FAILs, except that public-boundary's "history of HEAD" check is expected to
// fail on master (see README, Tests): that one is reported as KNOWN, other failures as FAIL.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MODULES = require('../lib/modules').installed();
// [label, file, modules it needs on (empty: runs in any mode), exclusive?] -- core suites only.
// exclusive: creates temp module folders under modules/ or scans the whole tree, so with --parallel
// it runs alone after the parallel phase (the shared repo tree is the one shared resource).
const CORE_SUITES = [
  ['modules', 'test/modules.js', [], true],
  ['module-removal', 'test/module-removal.js', [], true],
  ['module-contract', 'test/module-contract.js', [], true],
  ['module-events', 'test/module-events.js', [], true],
  ['module-seams', 'test/module-seams.js', [], true],
  ['contract-v6', 'test/contract-v6.js', [], true],
  ['raw-route', 'test/raw-route.js', [], true],
  ['approve-mcp', 'test/approve-mcp.js', []],
  ['taskmote-mcp', 'test/taskmote-mcp.js', []],
  ['mcp-tiers', 'test/mcp-tiers.js', []],
  ['entry', 'test/entry.js', ['guard-base', 'checkpoint']],
  ['journal-prompt', 'test/journal-prompt.js', []],
  ['lock-race', 'test/lock-race.js', []],
  ['effect-verify', 'test/effect-verify.js', []],
  ['commit-crash', 'test/commit-crash.js', []],
  ['executor-race', 'test/executor-race.js', []],
  ['push-reconcile', 'test/push-reconcile.js', []],
  ['server', 'test/server.js', []],
  ['server-jobs', 'test/server-jobs.js', [], true], // scratch modules appear under modules/ while it runs: other suites must not see them
  ['integration', 'test/integration.js', ['chat-ui', 'approval-cards']],
  ['trunk-diff', 'test/trunk-diff.js', []],
  ['trunk-diff-test', 'test/trunk-diff.test.js', []],
  ['alias', 'test/alias.test.js', []],
  ['gate-lock', 'test/gate-lock.test.js', []],
  ['review-lane', 'test/review-lane.js', []],
  ['demo', 'test/demo.js', ['guard-base', 'checkpoint', 'approval-cards', 'chat-ui']],
  ['combo-v1', 'test/combo-v1.js', [], true],
];
const LAST_SUITES = [['public-boundary', 'test/public-boundary.js', ['guard-base'], true]];

// suites of a module, from modules/<name>/tests.json
function moduleSuites(name) {
  const f = path.join(ROOT, 'modules', name, 'tests.json');
  if (!fs.existsSync(f)) return [];
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  return (j.suites || []).map(s => [s.label, path.posix.join('modules', name, s.file), s.needs || [], !!s.exclusive]);
}
const SUITES = [...CORE_SUITES, ...MODULES.flatMap(moduleSuites), ...LAST_SUITES];
function tempConfig(on) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-runall-'));
  const modules = Object.fromEntries(MODULES.map(m => [m, on.includes(m)]));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ owner_name: 'Tester', modules }));
  return { dir, file, modules };
}

// A task runs end to end with the fake engine, in a scratch state dir.
function e2e(cfgFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-e2e-'));
  const env = { ...process.env, HARNESS_CONFIG: cfgFile, HARNESS_STATE_DIR: path.join(dir, 'state'), HARNESS_LOG_DIR: path.join(dir, 'logs'), HARNESS_ENGINE_SCRIPT: path.resolve(ROOT, 'test', 'fake-engine.js'), HARNESS_FAKE_DELAY_MS: '0' };
  delete env.HARNESS_OWNER;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'start', 'core only task', '--workdir', path.join(dir, 'w')], { env, encoding: 'utf8', timeout: 60000 , windowsHide: true });
  let types = [];
  try { types = fs.readFileSync(path.join(dir, 'state', 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).type); } catch { /* none */ }
  const out = fs.existsSync(path.join(dir, 'w', 'out.txt'));
  const ok = r.status === 0 && types.includes('task_done') && out;
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok, info: `exit ${r.status}, journal ${types.join('>')}, out.txt ${out}` };
}


const sleepless = (cmdArgs, opts) => new Promise(resolve => {
  const p = spawn(process.execPath, cmdArgs, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] , windowsHide: true });
  let out = '';
  const t = setTimeout(() => p.kill(), 300000);
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  p.on('close', code => { clearTimeout(t); resolve({ status: code, out }); });
});

async function runSuite([label, file, needs], enabled, env) {
  if (enabled && needs.some(n => !enabled.includes(n))) return { line: `SKIP  ${label} (needs ${needs.join(', ')})`, fail: false };
  const t0 = Date.now();
  const r = await sleepless([path.join(ROOT, file)], { env: { ...env, HARNESS_FAKE_DELAY_MS: env.HARNESS_FAKE_DELAY_MS } });
  const out = r.out;
  const lines = out.trim().split('\n');
  let status = r.status === 0 ? 'PASS' : 'FAIL';
  if (r.status === 0 && /^SKIP:/m.test(out)) status = 'SKIP';
  let note = (lines.filter(l => /^(result|owner checks|PASS|FAIL)/.test(l)).pop() || lines[lines.length - 1] || '').slice(0, status === 'FAIL' ? 400 : 110);
  if (status === 'FAIL' && !note.trim()) note = `(no output; exit ${r.status === null ? 'killed by runner timeout' : r.status})`;
  if (label === 'public-boundary' && status === 'FAIL') {
    const bad = lines.filter(l => /^FAIL /.test(l));
    if (bad.length === 1 && /history of HEAD/.test(bad[0])) { status = 'KNOWN'; note = 'only the history-of-HEAD check fails (by design on master); tree check passes'; }
    else note = bad.join(' | ').slice(0, 150);
  }
  let line = `${status.padEnd(5)} ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s) ${note}`;
  if (status === 'FAIL' && process.env.RUNALL_VERBOSE) line += '\n' + out;
  return { line, fail: status === 'FAIL', out };
}

async function runMode(mode, opts) {
  let cfg = null, enabled, suites = SUITES;
  // locked modules (guard-base) cannot be off, so every mode with a temp config keeps them on
  const LOCKED = Object.keys(require('../lib/config').LOCKED);
  if (mode === 'default') enabled = null;
  else if (mode.startsWith('module:')) {
    const name = mode.slice(7);
    suites = moduleSuites(name);
    enabled = [...new Set([...LOCKED, name, ...suites.flatMap(s => s[2])])];
    cfg = tempConfig(enabled);
  } else {
    enabled = mode === 'all' ? MODULES : [...new Set([...LOCKED, ...(mode === 'core' ? [] : [mode])])];
    cfg = tempConfig(enabled);
  }
  console.log(`\n== mode ${mode}${opts.parallel ? ' (parallel)' : ''}: ${cfg ? 'HARNESS_CONFIG=' + cfg.file + ' modules ' + JSON.stringify(cfg.modules) : 'no HARNESS_CONFIG (owner config if present)'}`);
  const env = { ...process.env };
  if (cfg) env.HARNESS_CONFIG = cfg.file; else delete env.HARNESS_CONFIG;
  delete env.HARNESS_OWNER;
  if (opts.base) env.TRUNK_BASE = opts.base; else delete env.TRUNK_BASE;
  let fails = 0;
  if (mode === 'core') {
    const e = e2e(cfg.file);
    console.log(`${e.ok ? 'PASS' : 'FAIL'}  end-to-end fake-engine task: ${e.info}`);
    if (!e.ok) fails++;
  }
  const results = [];
  if (opts.parallel) {
    // a pool of `jobs` workers over the non-exclusive suites, then the exclusive ones one by one
    const todo = suites.map((s, i) => i).filter(i => !suites[i][3]);
    await Promise.all(Array.from({ length: opts.jobs }, async () => { while (todo.length) { const i = todo.shift(); results[i] = await runSuite(suites[i], enabled, env); } }));
    for (let i = 0; i < suites.length; i++) if (suites[i][3]) results[i] = await runSuite(suites[i], enabled, env);
  }
  for (let i = 0; i < suites.length; i++) {
    const r = opts.parallel ? results[i] : await runSuite(suites[i], enabled, env);
    console.log(r.line);
    if (r.fail) fails++;
  }
  if (cfg) fs.rmSync(cfg.dir, { recursive: true, force: true });
  return fails;
}

(async () => {
  let args = process.argv.slice(2);
  const opts = { parallel: false, base: null, jobs: Math.max(2, Math.min(4, os.cpus().length >> 1)) };
  const ji = args.indexOf('--jobs');
  if (ji >= 0) { opts.jobs = Math.max(1, parseInt(args[ji + 1], 10) || 1); args.splice(ji, 2); }
  const bi = args.indexOf('--base');
  if (bi >= 0) { opts.base = args[bi + 1]; args.splice(bi, 2); }
  if (args.includes('--parallel')) { opts.parallel = true; args = args.filter(a => a !== '--parallel'); }
  if (args[0] === 'module' && args[1]) args = ['module:' + args[1]];
  const arg = args[0] || 'all';
  const valid = ['core', 'all', 'default', 'every', ...MODULES, ...MODULES.map(m => 'module:' + m)];
  if (!valid.includes(arg)) { console.error(`usage: node test/run-all.js [--parallel] [--base <ref>] core|all|default|every|<module>|module <name>  (modules: ${MODULES.join(', ')})`); process.exit(2); }
  const modes = arg === 'every' ? ['core', ...MODULES, 'all'] : [arg];
  // a full run takes a machine-wide lock (test/gate-lock.js): two full gates at once load the machine and fail timing suites
  let release = null;
  if (arg === 'all' || arg === 'every') release = await require('./gate-lock').acquire();
  let total = 0;
  try { for (const m of modes) total += await runMode(m, opts); } finally { if (release) release(); }
  console.log(`\n${total ? 'FAILED' : 'ok'}: ${total} failing suite(s)`);
  process.exit(total ? 1 : 0);
})();
