#!/usr/bin/env node
'use strict';
// Run every suite under one module configuration and print one line per suite.
//   node test/run-all.js core            all modules off (+ an end-to-end fake-engine task)
//   node test/run-all.js <module>        only that module on (guard-base, guard-private-rules,
//                                        checkpoint, voice, spend-count, approval-cards, claim-audit)
//   node test/run-all.js all             all modules on
//   node test/run-all.js default         no HARNESS_CONFIG: the owner's real config, if any
//   node test/run-all.js every           core, each module alone, all
// A temp config is written under os.tmpdir() and passed as HARNESS_CONFIG. A suite
// that needs a module which is off prints SKIP. Exit 0 when no suite FAILs, except
// that public-boundary's "history of HEAD" check is expected to fail on master
// (see README, Tests): that one is reported as KNOWN, other failures there as FAIL.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MODULES = ['voice', 'spend-count', 'guard-base', 'guard-private-rules', 'checkpoint', 'approval-cards', 'claim-audit'];
// [label, file, modules it needs on (empty: runs in any mode)]
const SUITES = [
  ['modules', 'test/modules.js', []],
  ['entry', 'test/entry.js', ['guard-base', 'checkpoint']],
  ['journal-prompt', 'test/journal-prompt.js', []],
  ['lock-race', 'test/lock-race.js', []],
  ['effect-verify', 'test/effect-verify.js', []],
  ['commit-crash', 'test/commit-crash.js', []],
  ['executor-race', 'test/executor-race.js', []],
  ['push-reconcile', 'test/push-reconcile.js', []],
  ['guard-base', 'modules/guard-base/test/guard-base.js', ['guard-base']],
  ['private-rules', 'modules/guard-private-rules/test/private-rules.js', ['guard-private-rules']],
  ['checkpoint', 'modules/checkpoint/test/checkpoint.js', ['checkpoint']],
  ['voice-lock', 'modules/voice/test/voice-lock.js', ['voice']],
  ['spend', 'modules/spend-count/test/spend.js', ['spend-count']],
  ['approval-cards', 'modules/approval-cards/test/approval-cards.js', ['approval-cards']],
  ['claim-audit', 'modules/claim-audit/test/claim-audit.js', ['claim-audit']],
  ['public-boundary', 'test/public-boundary.js', ['guard-base']],
];

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
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'start', 'core only task', '--workdir', path.join(dir, 'w')], { env, encoding: 'utf8', timeout: 60000 });
  let types = [];
  try { types = fs.readFileSync(path.join(dir, 'state', 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).type); } catch { /* none */ }
  const out = fs.existsSync(path.join(dir, 'w', 'out.txt'));
  const ok = r.status === 0 && types.includes('task_done') && out;
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok, info: `exit ${r.status}, journal ${types.join('>')}, out.txt ${out}` };
}

function runMode(mode) {
  let cfg = null, enabled;
  if (mode === 'default') enabled = null;
  else {
    enabled = mode === 'all' ? MODULES : mode === 'core' ? [] : [mode];
    cfg = tempConfig(enabled);
  }
  console.log(`\n== mode ${mode}: ${cfg ? 'HARNESS_CONFIG=' + cfg.file + ' modules ' + JSON.stringify(cfg.modules) : 'no HARNESS_CONFIG (owner config if present)'}`);
  const env = { ...process.env };
  if (cfg) env.HARNESS_CONFIG = cfg.file; else delete env.HARNESS_CONFIG;
  delete env.HARNESS_OWNER;
  let fails = 0;
  if (mode === 'core') {
    const e = e2e(cfg.file);
    console.log(`${e.ok ? 'PASS' : 'FAIL'}  end-to-end fake-engine task: ${e.info}`);
    if (!e.ok) fails++;
  }
  for (const [label, file, needs] of SUITES) {
    if (enabled && needs.some(n => !enabled.includes(n))) { console.log(`SKIP  ${label} (needs ${needs.join(', ')})`); continue; }
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(ROOT, file)], { env: { ...env, HARNESS_FAKE_DELAY_MS: env.HARNESS_FAKE_DELAY_MS }, encoding: 'utf8', timeout: 300000, maxBuffer: 1 << 26 });
    const out = (r.stdout || '') + (r.stderr || '');
    const lines = out.trim().split('\n');
    let status = r.status === 0 ? 'PASS' : 'FAIL';
    if (r.status === 0 && /^SKIP:/m.test(out)) status = 'SKIP';
    let note = (lines.filter(l => /^(result|owner checks|PASS|FAIL)/.test(l)).pop() || lines[lines.length - 1] || '').slice(0, 110);
    if (label === 'public-boundary' && status === 'FAIL') {
      const bad = lines.filter(l => /^FAIL /.test(l));
      if (bad.length === 1 && /history of HEAD/.test(bad[0])) { status = 'KNOWN'; note = 'only the history-of-HEAD check fails (by design on master); tree check passes'; }
      else note = bad.join(' | ').slice(0, 150);
    }
    if (status === 'FAIL') fails++;
    console.log(`${status.padEnd(5)} ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s) ${note}`);
    if (status === 'FAIL' && process.env.RUNALL_VERBOSE) console.log(out);
  }
  if (cfg) fs.rmSync(cfg.dir, { recursive: true, force: true });
  return fails;
}

const arg = process.argv[2] || 'all';
const valid = ['core', 'all', 'default', 'every', ...MODULES];
if (!valid.includes(arg)) { console.error(`usage: node test/run-all.js ${valid.join('|')}`); process.exit(2); }
const modes = arg === 'every' ? ['core', ...MODULES, 'all'] : [arg];
let total = 0;
for (const m of modes) total += runMode(m);
console.log(`\n${total ? 'FAILED' : 'ok'}: ${total} failing suite(s)`);
process.exit(total ? 1 : 0);
