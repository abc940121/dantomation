#!/usr/bin/env node
'use strict';
// The module loader and the guard dispatcher (core; needs no module on):
//  - every module off: the guard allows a call guard-base would block
//  - private_rules without a "modules" key turns guard-private-rules on; with a
//    "modules" key only that key counts
//  - an enabled module that cannot load (unknown, throws on require, bad exports,
//    non-boolean flag): harness start/resume exit 2 naming it, the guard blocks every call
//  - a subcommand no module adds is a usage error (exit 2)
//  - no file in bin/, lib/ or guards/ requires anything under modules/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-modules-'));
const res = {};
const cfgFile = (name, obj) => { const f = path.join(tmp, name + '.json'); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
const env = cfg => { const e = { ...process.env, HARNESS_CONFIG: cfg, HARNESS_STATE_DIR: path.join(tmp, 'state'), HARNESS_LOG_DIR: path.join(tmp, 'logs') }; delete e.HARNESS_OWNER; delete e.HARNESS_TASK_ID; delete e.HARNESS_TASK_DIR; delete e.HARNESS_VOICE; return e; };
const guard = (cfg, tool, ti) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'guards', 'guard.js')], { input: JSON.stringify({ session_id: 'm', tool_name: tool, tool_input: ti, cwd: tmp }), env: env(cfg), encoding: 'utf8' });
  return { code: r.status, kind: (r.stderr.match(/BLOCKED \(([^)]+)\)/) || [])[1] || null, err: r.stderr.trim() };
};
const harness = (cfg, ...a) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), ...a], { env: { ...env(cfg), HARNESS_ENGINE_SCRIPT: path.resolve(ROOT, 'test', 'fake-engine.js'), HARNESS_FAKE_DELAY_MS: '0' }, encoding: 'utf8', timeout: 60000 });
const OFF = { 'guard-base': false, checkpoint: false, 'guard-private-rules': false, 'spend-count': false, voice: false };
const RM = ['Bash', { command: 'rm -rf /data' }];

// every module off
const off = cfgFile('off', { modules: OFF });
res['all modules off: rm -rf is allowed (core has no rules)'] = guard(off, ...RM).code === 0;
res['guard-base on: the same call is blocked (kind delete)'] = guard(cfgFile('base', { modules: { ...OFF, 'guard-base': true } }), ...RM).kind === 'delete';

// private_rules auto-enable
fs.writeFileSync(path.join(tmp, 'pr.json'), JSON.stringify({ rules: [{ kind: 'private_shell', match: 'shell', pattern: 'shutdown', reason: 'no' }] }));
const SD = ['Bash', { command: 'shutdown now' }];
res['private_rules without a modules key: guard-private-rules turns on'] = guard(cfgFile('auto', { private_rules: 'pr.json' }), ...SD).kind === 'private_shell';
res['private_rules with a modules key that lacks it: stays off'] = guard(cfgFile('auto-off', { private_rules: 'pr.json', modules: { 'guard-base': true } }), ...SD).code === 0;
res['private_rules with the module set false: off'] = guard(cfgFile('auto-false', { private_rules: 'pr.json', modules: { 'guard-private-rules': false } }), ...SD).code === 0;
res['private_rules with the module set true: on'] = guard(cfgFile('auto-true', { private_rules: 'pr.json', modules: { 'guard-private-rules': true } }), ...SD).kind === 'private_shell';
res['a broken rules file (module enabled) blocks every call'] = (() => { fs.writeFileSync(path.join(tmp, 'bad.json'), '{ nope'); const c = cfgFile('badrules', { private_rules: 'bad.json' }); const g = guard(c, 'Read', { file_path: 'x' }), h = harness(c, 'start', 'x'); return g.kind === 'module' && /guard-private-rules/.test(g.err) && h.status === 2 && /guard-private-rules/.test(h.stderr); })();

// load failures
const brokenDir = path.join(ROOT, 'modules', 'zz-test-throws');
const noName = path.join(ROOT, 'modules', 'zz-test-noname');
const badHook = path.join(ROOT, 'modules', 'zz-test-badhook');
try {
  fs.mkdirSync(brokenDir, { recursive: true }); fs.writeFileSync(path.join(brokenDir, 'index.js'), "throw new Error('boom');\n");
  fs.mkdirSync(noName, { recursive: true }); fs.writeFileSync(path.join(noName, 'index.js'), "module.exports = { name: 'something-else', beforeTool() { return null; } };\n");
  fs.mkdirSync(badHook, { recursive: true }); fs.writeFileSync(path.join(badHook, 'index.js'), "module.exports = { name: 'zz-test-badhook', beforeTool: 'yes' };\n");
  const failing = [['unknown name', 'no-such-module', true], ['throws on require', 'zz-test-throws', true], ['wrong exported name', 'zz-test-noname', true], ['beforeTool is not a function', 'zz-test-badhook', true], ['non-boolean flag', 'guard-base', 'yes']];
  for (const [label, mod, val] of failing) {
    const c = cfgFile('fail-' + mod, { modules: { ...OFF, [mod]: val } });
    const g = guard(c, 'Read', { file_path: 'README.md' });
    const s = harness(c, 'start', 'x'), r = harness(c, 'resume');
    res[`load failure (${label}): guard blocks a harmless Read, naming ${mod}`] = g.code === 2 && g.kind === 'module' && g.err.includes(mod);
    res[`load failure (${label}): start and resume exit 2 naming ${mod}`] = s.status === 2 && r.status === 2 && s.stderr.includes(mod) && r.stderr.includes(mod);
  }
  res['a failing module that is switched off does not matter'] = guard(cfgFile('fail-off', { modules: { ...OFF, 'zz-test-throws': false } }), 'Read', { file_path: 'README.md' }).code === 0;
} finally {
  for (const d of [brokenDir, noName, badHook]) fs.rmSync(d, { recursive: true, force: true });
}

// subcommands come from modules only
const rs = harness(off, 'restore', 't1', '1');
res['restore with checkpoint off: usage error, exit 2'] = rs.status === 2 && /usage: harness/.test(rs.stderr);
const rs2 = harness(cfgFile('ck', { modules: { ...OFF, checkpoint: true } }), 'restore', 't1', '1');
res['restore with checkpoint on but not the owner: exit 6'] = rs2.status === 6;

// the hard rule: no static require of modules/ in bin, lib, guards
const hits = [];
for (const d of ['bin', 'lib', 'guards']) for (const f of fs.readdirSync(path.join(ROOT, d))) {
  if (!f.endsWith('.js')) continue;
  fs.readFileSync(path.join(ROOT, d, f), 'utf8').split('\n').forEach((l, i) => { if (/require\([^)]*modules[/\\'"]/.test(l.replace(/lib\/modules/g, 'lib/loader'))) hits.push(`${d}/${f}:${i + 1}`); });
}
res[`no require of modules/ in bin, lib, guards (hits: ${hits.join(',') || 'none'})`] = hits.length === 0;

fs.rmSync(tmp, { recursive: true, force: true });
let ok = true;
for (const [k, v] of Object.entries(res)) { ok = ok && v; console.log(`${v ? 'PASS' : 'FAIL'} ${k}`); }
console.log(`result: ${Object.values(res).filter(Boolean).length}/${Object.keys(res).length}`);
process.exit(ok ? 0 : 1);
