#!/usr/bin/env node
'use strict';
// The module loader and the guard dispatcher (core; needs no module on):
//  - every changeable module off: guard-base (locked on) still blocks; turning it off is refused
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
const OFF = { 'guard-base': true, checkpoint: false, 'guard-private-rules': false, 'spend-count': false, voice: false };
const RM = ['Bash', { command: 'rm -rf /data' }];

// every module off
const off = cfgFile('off', { modules: OFF });
res['every changeable module off: rm -rf is still blocked (kind delete)'] = guard(off, ...RM).kind === 'delete';
const lk = guard(cfgFile('base-off', { modules: { ...OFF, 'guard-base': false } }), 'Read', { file_path: 'README.md' });
res['guard-base off: the config is refused and the guard blocks a harmless Read'] = lk.code === 2 && /locked on/.test(lk.err);

// the lock cannot be edited away: the loaders and the guard-base folder are self_modify (a hard block)
for (const rel of ['lib/config.js', 'lib/modules.js', 'lib/preset.js', 'presets/v1.json', 'modules/guard-base/index.js', 'modules/guard-base/redline.js', 'guards/guard.js']) {
  const g = guard(off, 'Edit', { file_path: path.join(ROOT, rel), old_string: 'a', new_string: 'b' });
  res[`editing ${rel} is blocked (self_modify)`] = g.code === 2 && g.kind === 'self_modify';
}
// module verbs: trunk verbs win, a duplicate claim is an error, an off module names itself
{
  const fake = (name, verbs) => ({ name, commands: Object.fromEntries(verbs.map(v => [v, () => 0])) });
  const M = require('../lib/modules');
  const cl = M.verbClaimers([fake('a', ['x', 'y']), fake('b', ['x']), { name: 'c' }], 'x');
  res['verbClaimers lists every module that claims a verb, in load order'] = cl.join() === 'a,b';
  res['verbClaimers ignores inherited names (constructor)'] = M.verbClaimers([fake('a', ['x'])], 'constructor').length === 0;
  const tm = (cfg, ...a) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'taskmote.js'), ...a], { env: { ...process.env, HARNESS_CONFIG: cfg, HARNESS_NO_SERVER: '1' }, encoding: 'utf8' });
  const proto = tm(off, 'constructor');
  res['taskmote constructor: usage, exit 2 (no prototype lookup)'] = proto.status === 2 && /usage:/.test(proto.stderr);
  const sc = tm(cfgFile('hello-off', { modules: { ...OFF, 'hello-stub': false } }), 'hello');
  res['taskmote hello with hello-stub off names the module, exit 2'] = sc.status === 2 && /needs the hello-stub module/.test(sc.stderr);
  res['old top-level hello names the new spelling'] = /is now "taskmote dev hello"/.test(sc.stderr);
  const dsc = tm(cfgFile('hello-off-dev', { modules: { ...OFF, 'hello-stub': false } }), 'dev', 'hello');
  res['taskmote dev hello with hello-stub off names the module, no old-spelling note'] = dsc.status === 2 && /needs the hello-stub module/.test(dsc.stderr) && !/is now/.test(dsc.stderr);
  const dv = tm(off, 'dev', 'nope');
  res['taskmote dev <unknown>: dev usage, exit 2'] = dv.status === 2 && /usage: taskmote dev </.test(dv.stderr);
  const hon = cfgFile('hello-on', { modules: { ...OFF, 'hello-stub': true } });
  const dh = tm(hon, 'dev', 'hello', 'zz'), oh = tm(hon, 'hello', 'zz');
  res['taskmote dev hello runs the module verb'] = dh.status === 0 && !/is now/.test(dh.stderr);
  res['taskmote hello (old spelling) still runs and names the new one'] = oh.status === 0 && /is now "taskmote dev hello"/.test(oh.stderr);
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'taskmote.js'), 'utf8');
  res['taskmote looks up trunk verbs before module verbs'] = src.includes('Object.prototype.hasOwnProperty.call(TRUNK, verb) ? TRUNK[verb] : (verb && moduleVerb)');
}
// every production entry point gets its module map from config.load(), never from a raw map
for (const rel of ['bin/harness.js', 'bin/taskmote.js', 'bin/approve-mcp.js', 'bin/taskmote-mcp.js', 'guards/guard.js', 'lib/server.js']) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const calls = src.match(/\bM\.load\(([^)]*)\)/g) || [];
  res[`${rel}: module map comes from config.load()`] = /\bC\.load\(\)/.test(src) && calls.every(c => /M\.load\((CONFIG|cfg)\)/.test(c));
}

// a new entry point that loads modules must join the list above, or this fails
{
  const ENTRIES = new Set(['bin/harness.js', 'bin/taskmote.js', 'bin/approve-mcp.js', 'bin/taskmote-mcp.js', 'guards/guard.js', 'lib/server.js', 'lib/config.js']); // config.js asks the registry which folders exist
  const extra = [];
  for (const dir of ['bin', 'lib', 'guards']) for (const f of fs.readdirSync(path.join(ROOT, dir))) {
    if (!f.endsWith('.js')) continue;
    const rel = dir + '/' + f, src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (rel !== 'lib/modules.js' && /require\(['"](\.\.?\/)+(lib\/)?modules(\.js)?['"]\)|\bM\.load\(/.test(src) && !ENTRIES.has(rel)) extra.push(rel);
  }
  res['no unlisted file in bin/, lib/ or guards/ loads modules' + (extra.length ? ': ' + extra.join(', ') : '')] = extra.length === 0;
}

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
  const failing = [['throws on require', 'zz-test-throws', true], ['wrong exported name', 'zz-test-noname', true], ['beforeTool is not a function', 'zz-test-badhook', true], ['non-boolean flag', 'checkpoint', 'yes']];
  for (const [label, mod, val] of failing) {
    const c = cfgFile('fail-' + mod, { modules: { ...OFF, [mod]: val } });
    const g = guard(c, 'Read', { file_path: 'README.md' });
    const s = harness(c, 'start', 'x'), r = harness(c, 'resume');
    res[`load failure (${label}): guard blocks a harmless Read, naming ${mod}`] = g.code === 2 && g.kind === 'module' && g.err.includes(mod);
    res[`load failure (${label}): start and resume exit 2 naming ${mod}`] = s.status === 2 && r.status === 2 && s.stderr.includes(mod) && r.stderr.includes(mod);
  }
  // a name with no folder (a removed module) is ignored with a warning, never a failure
  res['unknown module name (no folder): ignored, guard allows a harmless Read'] = guard(cfgFile('fail-unknown', { modules: { ...OFF, 'no-such-module': true } }), 'Read', { file_path: 'README.md' }).code === 0;
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
  fs.readFileSync(path.join(ROOT, d, f), 'utf8').split('\n').forEach((l, i) => { if (/require\([^)]*modules[/\\'"]/.test(l.replace(/(lib\/|\.\/)modules/g, 'lib/loader'))) hits.push(`${d}/${f}:${i + 1}`); });
}
res[`no require of modules/ in bin, lib, guards (hits: ${hits.join(',') || 'none'})`] = hits.length === 0;

fs.rmSync(tmp, { recursive: true, force: true });
let ok = true;
for (const [k, v] of Object.entries(res)) { ok = ok && v; console.log(`${v ? 'PASS' : 'FAIL'} ${k}`); }
console.log(`result: ${Object.values(res).filter(Boolean).length}/${Object.keys(res).length}`);
process.exit(ok ? 0 : 1);
