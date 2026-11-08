#!/usr/bin/env node
'use strict';
// guard-private-rules: run-time config and private rules. Each case runs the real guard as a hook
// (child process, JSON on stdin) under a temp HARNESS_CONFIG:
//   example: modules/guard-private-rules/example-private.json loaded through a temp config
//   self-protection: agents cannot write the config or the rules file
//   broken: a config that exists but is not JSON -> guard blocks everything
//           (kind config) and harness.js exits 2
//   none: HARNESS_CONFIG names a missing file -> default modules, warning line
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GUARD = path.join(ROOT, 'guards', 'guard.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-private-'));
const LOGS = path.join(tmp, 'logs');
const cfgDir = path.join(tmp, 'cfg');
fs.mkdirSync(cfgDir);
fs.copyFileSync(path.join(ROOT, 'modules', 'guard-private-rules', 'example-private.json'), path.join(cfgDir, 'private-rules.json'));
const CFG = path.join(cfgDir, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ owner_name: 'Tester', private_rules: 'private-rules.json', modules: { 'guard-base': true, 'guard-private-rules': true } }));
const RULES = path.join(cfgDir, 'private-rules.json');
const BROKEN = path.join(tmp, 'broken.json');
fs.writeFileSync(BROKEN, '{ not json');
const MISSING = path.join(tmp, 'nope', 'config.json');

function guard(cfg, tool, ti) {
  const env = { ...process.env, HARNESS_CONFIG: cfg, HARNESS_LOG_DIR: LOGS };
  delete env.HARNESS_TASK_ID; delete env.HARNESS_TASK_DIR; delete env.HARNESS_VOICE;
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ session_id: 'pr', tool_name: tool, tool_input: ti, cwd: tmp }), env, encoding: 'utf8' });
  const kind = (r.stderr.match(/BLOCKED \(([^)]+)\)/) || [])[1] || null;
  return { code: r.status, kind, err: r.stderr.trim() };
}
const B = c => ['Bash', { command: c }];
const cases = [
  // [label, config, [tool, input], expect blocked kind or null]
  ['example: Write into example-archive', CFG, ['Write', { file_path: '/data/example-archive/a.txt', content: 'x' }], 'private_path'],
  ['example: Read in example-archive is allowed (access write)', CFG, ['Read', { file_path: '/data/example-archive/a.txt' }], null],
  ['example: Read in example-diary is blocked (access any)', CFG, ['Read', { file_path: '/data/example-diary/day1.md' }], 'private_path'],
  ['example: shell cat of example-diary is blocked', CFG, B('cat /data/example-diary/day1.md'), 'private_path'],
  ['example: shell shutdown', CFG, B('shutdown /s /t 0'), 'private_shell'],
  ['example: content marker in a Write', CFG, ['Write', { file_path: '/tmp/x.md', content: 'notes DO-NOT-PUBLISH' }], 'private_content'],
  ['example: lower-case marker is fine (flags "")', CFG, ['Write', { file_path: '/tmp/x.md', content: 'do-not-publish' }], null],
  ['example: ordinary Write passes', CFG, ['Write', { file_path: '/tmp/x.md', content: 'hello' }], null],
  ['example: base rules still apply', CFG, B('rm -rf /data'), 'delete'],
  ['self: Write the config file', CFG, ['Write', { file_path: CFG, content: '{}' }], 'config'],
  ['self: Edit the rules file', CFG, ['Edit', { file_path: RULES, old_string: 'a', new_string: 'b' }], 'config'],
  ['self: shell redirect into the rules file', CFG, B(`echo {} > "${RULES}"`), 'config'],
  ['self: Read the rules file is allowed', CFG, ['Read', { file_path: RULES }], null],
  ['broken: harmless ls is blocked (fail closed)', BROKEN, B('ls'), 'config'],
  ['broken: Read is blocked', BROKEN, ['Read', { file_path: '/tmp/x.md' }], 'config'],
  ['none: ordinary Write passes', MISSING, ['Write', { file_path: '/tmp/x.md', content: 'hello' }], null],
  ['none: example paths are not special', MISSING, ['Write', { file_path: '/data/example-archive/a.txt', content: 'x' }], null],
  ['none: base rules still apply', MISSING, B('git push --force origin main'), 'delete'],
];
let pass = 0;
for (const [label, cfg, [tool, ti], want] of cases) {
  const r = guard(cfg, tool, ti);
  const ok = want ? r.code === 2 && r.kind === want : r.code === 0;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: exit ${r.code}${r.kind ? ` kind ${r.kind}` : ''}`);
  if (!ok) console.log(`   stderr: ${r.err.slice(0, 200)}`);
}
// the block message names the configured owner
const msg = guard(CFG, 'Bash', { command: 'shutdown now' }).err;
const named = /ask Tester\./.test(msg);
console.log(`${named ? 'PASS' : 'FAIL'} block message names the configured owner: ${JSON.stringify(msg.slice(0, 160))}`);

// harness.js: broken config -> exit 2; missing config -> warning line, still runs
const H = (cfg, ...a) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), ...a], { env: { ...process.env, HARNESS_CONFIG: cfg, HARNESS_STATE_DIR: path.join(tmp, 'state'), HARNESS_LOG_DIR: LOGS }, encoding: 'utf8' });
const hb = H(BROKEN, 'status');
const hbOk = hb.status === 2 && /unreadable/.test(hb.stderr);
console.log(`${hbOk ? 'PASS' : 'FAIL'} harness.js with broken config exits 2: exit ${hb.status} ${JSON.stringify(hb.stderr.trim().slice(0, 140))}`);
const hn = H(MISSING, 'status');
const hnOk = hn.status === 0 && /no config at .*default modules/.test(hn.stderr);
console.log(`${hnOk ? 'PASS' : 'FAIL'} harness.js with no config warns and runs: exit ${hn.status} ${JSON.stringify(hn.stderr.trim().slice(0, 140))}`);

// Owner checks: if the owner's own config (HARNESS_CONFIG or ~/.harness) has a
// rules file with a "checks" array [{tool, path, blocked}], run each against it.
// Keeps the owner's private paths out of this public file.
let ownTotal = 0, ownPass = 0;
try {
  const ownCfg = process.env.HARNESS_CONFIG || path.join(os.homedir(), '.harness', 'config.json');
  const oc = JSON.parse(fs.readFileSync(ownCfg, 'utf8'));
  const checks = oc.private_rules ? (JSON.parse(fs.readFileSync(path.resolve(path.dirname(ownCfg), oc.private_rules), 'utf8')).checks || []) : [];
  for (const c of checks) {
    ownTotal++;
    const ti = c.tool === 'Bash' ? { command: c.command } : { file_path: c.path, ...(c.tool === 'Write' ? { content: 'x' } : {}) };
    const r = guard(ownCfg, c.tool, ti);
    const ok = c.blocked ? r.code === 2 : r.code === 0;
    if (ok) ownPass++;
    console.log(`${ok ? 'PASS' : 'FAIL'} owner check ${ownTotal}: ${c.tool} ${c.blocked ? 'blocked' : 'allowed'} -> exit ${r.code}${r.kind ? ` kind ${r.kind}` : ''}`);
  }
} catch { /* no owner config: nothing to check */ }
if (ownTotal) console.log(`owner checks: ${ownPass}/${ownTotal}`);

fs.rmSync(tmp, { recursive: true, force: true });
const total = cases.length + 3 + ownTotal; const got = pass + named + hbOk + hnOk + ownPass;
console.log(`result: ${got}/${total}`);
process.exit(got === total ? 0 : 1);
