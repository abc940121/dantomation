#!/usr/bin/env node
'use strict';
// Optional modules are removable: deleting any one modules/<name>/ folder needs no edit in bin/ or lib/.
// One temp copy of the repo; each optional module folder is deleted in turn (the locked one is skipped) and the CLI,
// the config load (with the v1 preset) and the server module must still work, with no stack trace.
// A static check also keeps module names out of bin/ and lib/ except for the TRUNK_NAMES below.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const M = require('../lib/modules');
const LOCKED = Object.keys(require('../lib/config').LOCKED);
const NAMES = M.installed();

// Modules the trunk may name, each with the reason it counts as trunk. Anything else naming a module is a bug in the trunk.
const TRUNK_NAMES = {
  'guard-base': 'the locked safety floor: config refuses to run without it and the guard hook blocks every call',
  'guard-private-rules': 'config: an old config that only names private_rules must keep enforcing them, never silently drop them',
  'checkpoint': 'backs taskmote undo (server undo route, harness, taskmote-mcp undo_task); the trunk answers "off" without it',
  'approval-cards': 'decides red-line steps (server, approve-mcp, harness); config warns when it is turned off',
  'question-cards': 'the phone card behind ask_owner and undo_task in taskmote-mcp; nothing is undone without a card',
  'device-pairing': 'per-device token auth in the server request path, which must run before any module route',
  'digest': 'taskmote-mcp digest tool: a thin front for the module route, "off" when absent (tools are not module-declared yet)',
  'search': 'taskmote-mcp search_journal tool: same as digest',
  'demo': 'taskmote demo builds its throwaway sandbox before any config is read, so it cannot ask the config who is installed',
};

const res = {};

// ---- static check: no module name in bin/ or lib/ outside TRUNK_NAMES ----
const files = d => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(d, e.name)) : /\.js$/.test(e.name) ? [path.join(d, e.name)] : []);
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;,{(])\/\/.*$/gm, '$1');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shapes = n => [
  new RegExp(n.includes('-') ? `['"\`]${esc(n)}['"\`]` : `(?:api|apiOf|need|viaRoute|has|get)\\([^)]*['"]${esc(n)}['"]`),
  new RegExp(`/m/${esc(n)}(?![\\w-])`),
  new RegExp(`modules/${esc(n)}(?![\\w-])`),
  new RegExp(`(?:^|[{,\\s])${esc(n)}\\s*:\\s*(?:true|false)\\b`),
];
const hits = [];
for (const f of [...files('bin'), ...files('lib')]) {
  const src = strip(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  for (const n of NAMES) if (!(n in TRUNK_NAMES) && shapes(n).some(r => r.test(src))) hits.push(`${f.replace(/\\/g, '/')}: ${n}`);
}
res['no module name in bin/ or lib/ outside TRUNK_NAMES' + (hits.length ? ` (${hits.join('; ')})` : '')] = hits.length === 0;
res['TRUNK_NAMES lists only installed modules'] = Object.keys(TRUNK_NAMES).every(n => NAMES.includes(n));

// ---- removal run ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modrm-'));
const repo = path.join(tmp, 'repo');
fs.cpSync(ROOT, repo, { recursive: true, filter: s => !/[\\/](\.git|node_modules|state)$/.test(s) });
const cfgFile = path.join(tmp, 'config.json');
const env = { ...process.env, HARNESS_CONFIG: cfgFile, HARNESS_NO_SERVER: '1', HARNESS_STATE_DIR: path.join(tmp, 'state'), HOME: tmp, USERPROFILE: tmp };
const run = (args, opts) => spawnSync(process.execPath, args, { env, encoding: 'utf8', cwd: repo, timeout: 30000, ...opts });
const cli = args => run([path.join(repo, 'bin', 'taskmote.js'), ...args]);
const TRACE = /\n\s+at .*[(:]\d+(:\d+)?\)?|(?:TypeError|ReferenceError|SyntaxError|Cannot find module)/;
const clean = r => r.status !== null && !TRACE.test(r.stdout + r.stderr);

// What each module offers, read before anything is deleted.
const cat = Object.fromEntries(M.catalog({ modules: {} }).map(c => [c.name, c]));
const tryNode = code => run(['-e', code]);
const LOAD = `const C=require('./lib/config');const c=C.load();require('./lib/modules').load(c);require('./lib/server');console.log('ok');`;

// A guard that is on but whose folder is gone (half-synced or bad checkout) is refused, never dropped: config load,
// the CLI and the task runner all stop with the fail-closed message and no stack trace.
const GUARD = n => LOCKED.includes(n) || n.startsWith('guard-');
for (const name of NAMES.filter(GUARD)) {
  fs.writeFileSync(cfgFile, JSON.stringify({ preset: 'v1', modules: { [name]: true } }));
  fs.rmSync(path.join(repo, 'modules', name), { recursive: true, force: true });
  const bad = [];
  const l = tryNode(`try{${LOAD}}catch(e){console.log('refused: '+e.message);process.exit(3)}`);
  if (l.status !== 3 || !/fail closed/.test(l.stdout)) bad.push('config load not refused: ' + (l.stdout + l.stderr).split('\n')[0].slice(0, 120));
  for (const [what, r] of [['CLI', cli([])], ['task runner', run([path.join(repo, 'bin', 'harness.js')])]]) {
    if (!(r.status === 2 && clean(r) && /fail closed/.test(r.stderr))) bad.push(`${what} not refused`);
  }
  if (!LOCKED.includes(name)) { // an explicit false is how a changeable guard is removed: then it loads
    fs.writeFileSync(cfgFile, JSON.stringify({ preset: 'v1', modules: { [name]: false } }));
    const off = tryNode(LOAD);
    if (off.status !== 0 || !/ok/.test(off.stdout)) bad.push('set to false, still refused');
  }
  res[`guard ${name} on with its folder deleted: refused (fail closed)` + (bad.length ? ` (${bad.join('; ')})` : '')] = bad.length === 0;
  fs.cpSync(path.join(ROOT, 'modules', name), path.join(repo, 'modules', name), { recursive: true });
}

for (const name of NAMES) {
  if (GUARD(name)) continue;
  fs.writeFileSync(cfgFile, JSON.stringify({ preset: 'v1', modules: { [name]: true } }));
  fs.rmSync(path.join(repo, 'modules', name), { recursive: true, force: true });
  const bad = [];
  const top = cli([]);
  if (!(top.status === 2 && clean(top))) bad.push('usage');
  for (const args of [['dev'], ['dev', 'x'], ['check'], ['ask'], ['preset', 'persona'], ['preset'], ...Object.keys(cat[name].commands.length ? Object.fromEntries(cat[name].commands.map(c => [c, 1])) : {}).map(c => [c])]) {
    const r = cli(args);
    if (!clean(r)) bad.push(args.join(' ') + (r.status === null ? ' (timeout)' : ' (stack trace)'));
  }
  const l = tryNode(LOAD);
  if (l.status !== 0 || !/ok/.test(l.stdout) || TRACE.test(l.stderr)) bad.push('config load / server require: ' + (l.stderr || l.stdout).split('\n')[0].slice(0, 120));
  res[`remove ${name}: CLI, config and server still work` + (bad.length ? ` (${bad.join('; ')})` : '')] = bad.length === 0;
  fs.cpSync(path.join(ROOT, 'modules', name), path.join(repo, 'modules', name), { recursive: true }); // back for the next round
}
fs.rmSync(tmp, { recursive: true, force: true });

let ok = true;
for (const [k, v] of Object.entries(res)) { console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`); if (!v) ok = false; }
console.log(ok ? `module-removal: all ${Object.keys(res).length} checks passed` : 'module-removal: FAILED');
process.exit(ok ? 0 : 1);
