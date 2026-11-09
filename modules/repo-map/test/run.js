#!/usr/bin/env node
'use strict';
// repo-map: symbol extraction, ranking, budget, caps, cache, symlink and gitignore rules, hooks,
// route and command. Temp fixture repos and a temp state dir only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repomap-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state');
for (const k of ['HARNESS_TASK_ID', 'HARNESS_TASK_DIR']) delete process.env[k];
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const E = require('../engine');

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info ? ': ' + info : ''}`); };
const OWNER = { kind: 'owner', id: '' };
const put = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const hasGit = spawnSync('git', ['--version']).status === 0;

function fixture(name, git) {
  const r = path.join(tmp, name);
  fs.mkdirSync(r, { recursive: true });
  put(r, 'src/core.js', 'function coreEngine() {}\nclass CoreBox {}\nconst helper = (a) => a;\nmodule.exports = { coreEngine };\n');
  put(r, 'src/a.js', 'const { coreEngine } = require("./core");\nexport function useA() { return coreEngine(); }\n');
  put(r, 'src/b.ts', 'import { coreEngine } from "./core";\nexport interface Shape {}\nexport type Id = string;\nexport const useB = async (x: number) => coreEngine();\n');
  put(r, 'lib/tool.py', 'def run_tool():\n    pass\n\nclass Runner:\n    def inner(self): pass\n');
  put(r, 'cmd/main.go', 'package main\nfunc main() {}\nfunc (s *Srv) Handle() {}\ntype Srv struct{}\n');
  put(r, 'src/lib.rs', 'pub fn rusty() {}\npub struct Thing;\nenum Mode { A }\n');
  put(r, 'src/App.java', 'public class App {\n  void m() {}\n}\ninterface Svc {}\n');
  put(r, 'src/Prog.cs', 'namespace Demo.App\n{\n}\npublic sealed class Prog {}\n');
  put(r, 'README.md', '# Title\n\n```\n# not a heading\n```\n\n## Usage\n#### too deep\n');
  put(r, 'node_modules/dep/index.js', 'function hiddenDep() {}\n');
  put(r, 'dist/out.js', 'function builtOut() {}\n');
  put(r, 'ignored.js', 'function ignoredFn() {}\n');
  put(r, 'data.bin.js', 'function a(){}\u0000\u0000binary');
  if (git) {
    put(r, '.gitignore', 'ignored.js\n');
    spawnSync('git', ['init', '-q'], { cwd: r });
  }
  return r;
}
const names = res => res.files.map(f => f.rel);

(async () => {
  try {
    // ---- off by default
    const off = M.registry({ modules: { 'repo-map': false } });
    check('off: nothing registered', off.errors.length === 0 && !off.listRoutes().some(r => r.module === 'repo-map') && !off.listCommands().includes('repo-map'));

    const repo = fixture('repo', hasGit);
    const reg = M.registry({ modules: { 'repo-map': true } });
    check('on: loads, contract 2, defaults', reg.errors.length === 0 && reg.modules().find(m => m.name === 'repo-map').contract === 2 && reg.settingsFor('repo-map').inject === false, reg.errors.join('|'));
    check('bad setting type is a load error', M.registry({ modules: { 'repo-map': true }, repo_map: { inject: 'yes' } }).errors.length === 1);
    check('unknown setting is a load error', M.registry({ modules: { 'repo-map': true }, repo_map: { nope: 1 } }).errors.length === 1);
    const routes = reg.listRoutes().filter(r => r.module === 'repo-map');
    check('one owner GET route and the command', routes.length === 1 && routes[0].method === 'GET' && routes[0].path === '/m/repo-map/map' && (routes[0].access || 'owner') === 'owner' && reg.listCommands().includes('repo-map'));

    // ---- prepareTurn: only with inject
    let t = await M.prepareTurn(reg.mods, { task_id: 't1', workdir: repo });
    check('inject false (default): nothing added', t.context.length === 0 && t.errors.length === 0);
    const regOn = M.registry({ modules: { 'repo-map': true }, repo_map: { inject: true } });
    t = await M.prepareTurn(regOn.mods, { task_id: 't1', workdir: repo });
    const txt = (t.context[0] || {}).text || '';
    check('inject true: map added under the module', t.context.length === 1 && t.context[0].module === 'repo-map' && /src\/core\.js/.test(txt), txt.slice(0, 200));
    const lineOf = p => txt.split('\n').findIndex(l => l.startsWith(p + ':') || l === p);
    check('most referenced file ranks first', lineOf('src/core.js') === 1, txt);
    check('top-level symbols listed, nested ones not', /src\/core\.js: coreEngine, CoreBox, helper/.test(txt) && /lib\/tool\.py: run_tool, Runner/.test(txt) && !/inner/.test(txt));
    check('go, rust, java, c# symbols', /cmd\/main\.go: main, Handle, Srv/.test(txt) && /src\/lib\.rs: rusty, Thing, Mode/.test(txt) && /src\/App\.java: App, Svc/.test(txt) && /src\/Prog\.cs: Demo\.App, Prog/.test(txt));
    check('ts symbols', /src\/b\.ts: Shape, Id, useB/.test(txt) && /src\/a\.js: useA/.test(txt));
    check('markdown headings (fenced and level 4 ignored)', /README\.md: # Title, ## Usage\b/.test(txt) && !/not a heading|too deep/.test(txt));
    check('node_modules, dist and binary skipped', !/hiddenDep|node_modules|dist\/|builtOut|data\.bin/.test(txt));
    if (hasGit) check('gitignore respected when git is available', !/ignored\.js/.test(txt));
    else console.log('SKIP gitignore: git not installed');

    // ---- non-git fallback
    const plain = fixture('plain', false);
    const rp = E.build(plain, { use_git: true, cache: null });
    check('no git repo: falls back to the walk and still skips node_modules/dist', rp.stats.git === false && names(rp).includes('src/core.js') && !names(rp).some(n => /node_modules|dist/.test(n)));
    check('no git repo: .gitignore not applied (no git)', names(rp).includes('ignored.js'));

    // ---- budget
    const small = E.render(E.build(repo, {}), { max_chars: 300 });
    check('output fits the char budget', small.text.length <= 300 && small.shown < small.total && /more files not shown/.test(small.text), String(small.text.length));
    const tiny = E.render(E.build(repo, {}), { max_chars: 200 });
    check('tiny budget still within limit', tiny.text.length <= 200);
    const few = E.render(E.build(repo, {}), { max_chars: 4000, max_symbols_per_file: 1 });
    check('max_symbols_per_file caps the list', /src\/core\.js: coreEngine\n/.test(few.text + '\n'), few.text);

    // ---- caps
    const capF = E.build(repo, { max_files: 3 });
    check('max_files cap', capF.files.length <= 3 && capF.stats.scanned + capF.stats.skipped === 3 && capF.stats.truncated === true);
    const capB = E.build(repo, { max_bytes_total: 1024, max_file_bytes: 1024 });
    check('max_bytes_total cap stops reading', capB.stats.truncated === true || capB.files.length <= 9);
    const big = fixture('big', false);
    put(big, 'huge.js', 'function early() {}\n' + '// x\n'.repeat(5000) + 'function late() {}\n');
    const hb = E.build(big, { max_file_bytes: 1024 });
    const huge = hb.files.find(f => f.rel === 'huge.js');
    check('max_file_bytes reads only the head of a file', huge && huge.syms.some(s => s.n === 'early') && !huge.syms.some(s => s.n === 'late'));

    // ---- cache by mtime, retention cap
    const cache = { version: 1, files: {} };
    const c1 = E.build(plain, { cache });
    const c2 = E.build(plain, { cache });
    check('second build hits the cache for every file', c1.stats.cache_hits === 0 && c2.stats.cache_hits === c2.stats.scanned && c2.stats.scanned > 0);
    const edited = path.join(plain, 'src', 'core.js');
    const future = new Date(Date.now() + 5000);
    fs.writeFileSync(edited, 'function renamedEngine() {}\n');
    fs.utimesSync(edited, future, future);
    const c3 = E.build(plain, { cache });
    check('changed mtime re-reads only that file', c3.stats.cache_hits === c3.stats.scanned - 1 && c3.files.find(f => f.rel === 'src/core.js').syms[0].n === 'renamedEngine');
    const capCache = { version: 1, files: {} };
    E.build(plain, { cache: capCache, cache_entries: 4 });
    check('retention cap bounds the cache', Object.keys(capCache.files).length === 4);

    // ---- symlinks: never outside the root
    const outside = path.join(tmp, 'outside');
    put(outside, 'secret.js', 'function outsideSecret() {}\n');
    const sl = fixture('sl', false);
    let linked = false;
    try {
      fs.symlinkSync(path.join(outside, 'secret.js'), path.join(sl, 'link-out.js'));
      fs.symlinkSync(path.join(sl, 'src', 'core.js'), path.join(sl, 'link-in.js'));
      linked = true;
    } catch { /* no symlink right on this machine */ }
    if (linked) {
      const rs = E.build(sl, {});
      check('symlink outside the root is skipped, inside one is read', !names(rs).includes('link-out.js') && names(rs).includes('link-in.js') && !JSON.stringify(rs.files).includes('outsideSecret'));
    } else console.log('SKIP symlink check: cannot create symlinks here');

    // ---- extraction unit checks
    check('extractSymbols: indented and unknown language give nothing', E.extractSymbols('js', '  function nested() {}\n').length === 0 && E.extractSymbols('zz', 'function f(){}').length === 0);

    // ---- hooks never throw into the turn
    const bogus = M.registry({ modules: { 'repo-map': true }, repo_map: { inject: true, root: path.join(tmp, 'does-not-exist') } });
    t = await M.prepareTurn(bogus.mods, { task_id: 't2', workdir: repo });
    check('missing root: prepareTurn yields nothing and no error', t.context.length === 0 && t.errors.length === 0);
    const emptyDir = path.join(tmp, 'empty'); fs.mkdirSync(emptyDir);
    t = await M.prepareTurn(regOn.mods, { task_id: 't3', workdir: emptyDir });
    check('empty repo: nothing injected', t.context.length === 0 && t.errors.length === 0);

    // ---- route
    const rootReg = M.registry({ modules: { 'repo-map': true }, repo_map: { root: repo } });
    const call = (q) => { const f = rootReg.findRoute('GET', '/m/repo-map/map'); return rootReg.callRoute(f, { actor: OWNER, query: q || {} }); };
    let r = await call();
    check('route: map for the configured root', r.status === 200 && /src\/core\.js/.test(r.json.map) && r.json.shown > 0 && r.json.stats && !('root' in r.json));
    r = await call({ path: 'cmd' });
    check('route: ?path limits to a subfolder', r.status === 200 && /cmd\/main\.go/.test(r.json.map) && !/src\/core\.js/.test(r.json.map));
    r = await call({ path: '..' });
    check('route: path outside the root is 400', r.status === 400);
    r = await call({ path: path.join(tmp, 'outside') });
    check('route: absolute path outside the root is 400', r.status === 400);
    r = await call({ path: 'nope' });
    check('route: missing path is 404', r.status === 404);
    const fr = rootReg.findRoute('GET', '/m/repo-map/map');
    check('route: anonymous is refused', (await rootReg.callRoute(fr, { actor: { kind: 'anonymous', id: '' }, query: {} })).status === 403);
    const badRoot = M.registry({ modules: { 'repo-map': true }, repo_map: { root: path.join(tmp, 'gone') } });
    r = await badRoot.callRoute(badRoot.findRoute('GET', '/m/repo-map/map'), { actor: OWNER, query: {} });
    check('route: unreadable root is a generic 500', r.status === 500 && r.json.error === 'could not build the map');

    // ---- cache file written under module state, bounded
    const stateDir = path.join(process.env.HARNESS_STATE_DIR, 'm', 'repo-map');
    let cf = null;
    try { cf = JSON.parse(fs.readFileSync(path.join(stateDir, 'cache.json'), 'utf8')); } catch { /* checked below */ }
    check('cache persisted in module state', cf && cf.version === 1 && Object.keys(cf.files).length > 0);

    // ---- command
    const cfgFile = path.join(tmp, 'cfg.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ modules: { 'repo-map': true } }));
    const env = { ...process.env, HARNESS_CONFIG: cfgFile, HARNESS_STATE_DIR: path.join(tmp, 'state2'), HARNESS_LOG_DIR: path.join(tmp, 'logs'), HARNESS_WORK_DIR: tmp };
    const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), ...a], { env, encoding: 'utf8', cwd: tmp });
    const c = cli('repo-map', repo);
    check('command: prints the map', c.status === 0 && /src\/core\.js/.test(c.stdout), c.stderr + c.stdout.slice(0, 200));
    const cb = cli('repo-map', path.join(tmp, 'gone'));
    check('command: bad folder is a short error, exit 3', cb.status === 3 && /cannot map/.test(cb.stderr) && !/at .*\.js:\d+/.test(cb.stderr), cb.stderr);

    // ---- no private paths or names in the module sources
    const srcs = ['index.js', 'engine.js', 'README.md', 'DECISIONS.md', 'PROVENANCE.md'].map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
    check('sources hold no user paths', !/C:\\Users|\/Users\/|\/home\//i.test(srcs));
  } catch (e) {
    check('suite ran without an unexpected error', false, e && e.stack);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  const bad = results.filter(x => !x).length;
  console.log(`\nrepo-map: ${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})();
