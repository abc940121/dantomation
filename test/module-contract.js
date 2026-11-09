#!/usr/bin/env node
'use strict';
// Proof of the module contract (docs/MODULES.md), core only:
//  - a new folder under modules/ plus one config line adds a hook, a command, a
//    route, a panel, a job and settings, with zero edits to core files
//    (checked mechanically: a hash of every core file before and after)
//  - removing the folder removes all of it, cleanly
//  - bad manifests (wrong type, unknown field, missing name, duplicate route, ...)
//    give one clear error naming the module, other modules still load, nothing throws
// Hook and command also run as real processes (guard.js, harness.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-contract-'));
const tag = crypto.randomBytes(3).toString('hex');
const NAME = `zz-proof-${tag}`, SEC = M.sectionKey(NAME);
const DIRS = [];
const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };

// Core = every tracked file outside modules/, plus anything in bin/ lib/ guards/ config/.
function coreHash() {
  const g = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  const files = new Set(g.status === 0 ? g.stdout.split('\0').filter(f => f && !f.startsWith('modules/')) : []);
  const walk = d => {
    if (!fs.existsSync(path.join(ROOT, d))) return;
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) e.isDirectory() ? walk(`${d}/${e.name}`) : files.add(`${d}/${e.name}`);
  };
  ['bin', 'lib', 'guards', 'config'].forEach(walk);
  const h = crypto.createHash('sha256');
  for (const f of [...files].sort()) {
    const p = path.join(ROOT, f);
    h.update(f + '\0' + (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'gone') + '\n');
  }
  return { hash: h.digest('hex'), count: files.size };
}
const writeModule = (name, src, ui) => {
  const d = path.join(M.DIR, name);
  DIRS.push(d);
  fs.mkdirSync(path.join(d, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(d, 'index.js'), src);
  if (ui) fs.writeFileSync(path.join(d, 'ui', 'panel.js'), 'export function mount(el) { el.textContent = "proof"; }\n');
  return d;
};
const cfgFile = (n, obj) => { const f = path.join(tmp, n + '.json'); fs.writeFileSync(f, JSON.stringify({ owner_name: 'Tester', ...obj })); return f; };
const env = cfg => {
  const e = { ...process.env, HARNESS_CONFIG: cfg, HARNESS_STATE_DIR: path.join(tmp, 'state'), HARNESS_LOG_DIR: path.join(tmp, 'logs') };
  delete e.HARNESS_OWNER; delete e.HARNESS_TASK_ID; delete e.HARNESS_TASK_DIR; delete e.HARNESS_VOICE;
  return e;
};
const guard = (cfg, command) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'guards', 'guard.js')], { input: JSON.stringify({ session_id: 'c', tool_name: 'Bash', tool_input: { command }, cwd: tmp }), env: env(cfg), encoding: 'utf8' });
  return { code: r.status, kind: (r.stderr.match(/BLOCKED \(([^)]+)\)/) || [])[1] || null, err: r.stderr.trim() };
};
const harness = (cfg, ...a) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), ...a], { env: env(cfg), encoding: 'utf8', timeout: 60000 });

const PROOF = `'use strict';
let ticks = 0;
module.exports = {
  contract: 1, name: '${NAME}', runsOn: ['main'],
  beforeTool({ ti, settings }) { return String(ti.command || '').includes('frobnicate') ? ['zz_proof', 'proof hook (limit ' + settings.limit + ')'] : null; },
  commands: { zzproof(args, core) { console.log('proof says ' + core.settings.greeting); } },
  routes: [{ method: 'GET', path: '/ping/:n', handler: ({ params, settings }) => ({ status: 200, json: { pong: params.n, greeting: settings.greeting } }) }],
  panels: [{ id: 'proof', title: 'Proof', mount: 'page', entry: 'ui/panel.js' }],
  jobs: [{ id: 'tick', every: 0.02, run() { ticks++; } }, { id: 'svc', start() { ticks += 1000; return () => { ticks += 1000000; }; } }],
  settings: { greeting: { type: 'string', default: 'hi', description: 'greeting' }, limit: { type: 'integer', default: 3, min: 1, description: 'a number' } },
  api: { ticks: () => ticks },
};
`;
// Bad manifests: [label, source(folder name), config section or undefined, expected error]
const BAD = [
  ['wrong type', n => `module.exports = { contract: 1, name: '${n}', routes: 'nope', priority: 'high' };`, undefined, /priority must be a number, got string.*routes must be an array, got string/],
  ['unknown field', n => `module.exports = { contract: 1, name: '${n}', colour: 'red' };`, undefined, /unknown field "colour"/],
  ['missing name', () => 'module.exports = { contract: 1, beforeTool() { return null; } };', undefined, /missing "name"/],
  ['duplicate route', n => `const h = () => ({ status: 200, json: {} }); module.exports = { contract: 1, name: '${n}', routes: [{ method: 'GET', path: '/a/:x', handler: h }, { method: 'GET', path: '/a/:y', handler: h }] };`, undefined, /duplicate route GET \/a\/:y/],
  ['contract above what the trunk supports', n => `module.exports = { contract: ${M.CONTRACT + 1}, name: '${n}' };`, undefined, new RegExp(`needs module contract ${M.CONTRACT + 1}; this core supports up to ${M.CONTRACT}`)],
  ['contract not an integer', n => `module.exports = { contract: '2', name: '${n}' };`, undefined, /contract must be an integer, got/],
  ['newer contract', n => `module.exports = { contract: 99, name: '${n}' };`, undefined, /needs module contract 99/],
  ['default does not match its type', n => `module.exports = { contract: 1, name: '${n}', settings: { x: { type: 'number', default: 'ten', description: 'x' } } };`, undefined, /settings\.x\.default must be a number, got string/],
  ['panel entry missing', n => `module.exports = { contract: 1, name: '${n}', panels: [{ id: 'p', title: 'P', mount: 'chat', entry: 'ui/none.js' }] };`, undefined, /panels\[0\]\.entry ui\/none\.js does not exist/],
  ['job with neither run nor start', n => `module.exports = { contract: 1, name: '${n}', jobs: [{ id: 'j' }] };`, undefined, /jobs\[0\] needs either every \+ run/],
  ['config: bad type and unknown key', n => `module.exports = { contract: 1, name: '${n}', settings: { limit: { type: 'integer', default: 1, description: 'l' } } };`, { limit: 'many', lmit: 2 }, /\.limit" must be an integer, got string "many".*unknown key "lmit"/],
];

(async () => {
  const before = coreHash();
  let jobsHandle = null;
  try {
    check(`core files hashed (${before.count} files)`, before.count > 20);
    // ---- add: one folder + one config line
    const dir = writeModule(NAME, PROOF, true);
    const cfgObj = { modules: { 'hello-stub': false, [NAME]: true }, [SEC]: { greeting: 'howdy' } };
    const cfg = cfgFile('on', cfgObj);
    const reg = M.registry(cfgObj);
    check('added: loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    check('added: route listed under /m/<name>/', reg.listRoutes().some(r => r.method === 'GET' && r.path === `/m/${NAME}/ping/:n`));
    const found = reg.findRoute('GET', `/m/${NAME}/ping/7`);
    const res = found && await reg.callRoute(found, { actor: { kind: 'owner', id: 'test' } });
    check('added: route found and answers with params + settings', res && res.status === 200 && res.json.pong === '7' && res.json.greeting === 'howdy', JSON.stringify(res));
    check('added: panel listed', reg.listPanels().some(p => p.module === NAME && p.mount === 'page' && p.url === `/m/${NAME}/ui/panel.js`));
    check('added: jobs listed', reg.listJobs().filter(j => j.module === NAME).map(j => `${j.id}:${j.kind}`).join() === 'tick:interval,svc:service');
    check('added: settings = config over defaults', JSON.stringify(reg.settingsFor(NAME)) === '{"greeting":"howdy","limit":3}');
    check('added: command listed', reg.listCommands().includes('zzproof'));
    const api = require(path.join(dir, 'index.js')).api;
    const errs = [];
    jobsHandle = await reg.startJobs({}, (j, e) => errs.push(e.message));
    await new Promise(r => setTimeout(r, 150));
    await jobsHandle.stop(); jobsHandle = null;
    const t = api.ticks();
    await new Promise(r => setTimeout(r, 80));
    check('added: jobs start, tick, stop (no ticks after stop)', t > 1001000 && t % 1000 > 0 && api.ticks() === t && !errs.length, `ticks ${t}`);
    const g = guard(cfg, 'echo frobnicate');
    check('added: hook runs in the real guard with its setting', g.code === 2 && g.kind === 'zz_proof' && /limit 3/.test(g.err), g.err);
    check('added: other calls still pass the guard', guard(cfg, 'echo fine').code === 0);
    const h = harness(cfg, 'zzproof');
    check('added: command runs in the real harness with its setting', h.status === 0 && /proof says howdy/.test(h.stdout), (h.stdout + h.stderr).trim());

    // ---- remove the folder
    fs.rmSync(dir, { recursive: true, force: true });
    const offObj = { modules: { 'hello-stub': true } };
    const gone = M.registry(offObj);
    check('removed: no route, panel, job, command or settings left', gone.errors.length === 0 && !gone.listRoutes().some(r => r.module === NAME) && !gone.listPanels().some(p => p.module === NAME)
      && !gone.listJobs().some(j => j.module === NAME) && !gone.listCommands().includes('zzproof') && gone.settingsFor(NAME) === null && !gone.findRoute('GET', `/m/${NAME}/ping/7`));
    check('removed: the guard allows the word again', guard(cfgFile('off', offObj), 'echo frobnicate').code === 0);
    const h2 = harness(cfgFile('off2', offObj), 'zzproof');
    check('removed: the command is a usage error (exit 2)', h2.status === 2 && /usage/.test(h2.stderr), h2.stderr.trim());
    const stale = M.registry(cfgObj);
    check('removed but still enabled: clear "unknown module" error', stale.errors.length === 1 && stale.errors[0] === `${NAME}: unknown module (no folder modules/${NAME})`, stale.errors.join(' | '));

    // ---- bad manifests
    for (const [i, [label, src, sec, re]] of BAD.entries()) {
      const n = `zz-bad-${i}-${tag}`;
      writeModule(n, src(n), false);
      const c = { modules: { 'hello-stub': true, [n]: true }, ...(sec ? { [M.sectionKey(n)]: sec } : {}) };
      let r = null, threw = null;
      try { r = M.registry(c); } catch (e) { threw = e; }
      const ok = !threw && r.errors.length === 1 && r.errors[0].startsWith(`${n}: `) && re.test(r.errors[0])
        && r.mods.map(m => m.name).join() === 'hello-stub' && r.listRoutes().length === 1 && r.listRoutes()[0].module === 'hello-stub';
      check(`bad manifest (${label}): one clear error, hello-stub still loads`, ok, threw ? threw.stack : r.errors.join(' | '));
    }
    // contract field: 1 and 2 and the trunk's own number load; every in-repo manifest sets it explicitly
    const okc = [1, 2, M.CONTRACT].map((v, i) => { const n = `zz-ok-${i}-${tag}`; writeModule(n, `module.exports = { contract: ${v}, name: '${n}' };`, false); return n; });
    const rc = M.registry({ modules: Object.fromEntries(okc.map(n => [n, true])) });
    check('contract field: 1, 2 and the trunk number all load', rc.errors.length === 0 && rc.modules().map(m => m.contract).join() === `1,2,${M.CONTRACT}`, rc.errors.join(' | '));
    check('contract field: every in-repo manifest sets contract explicitly, within the trunk number', fs.readdirSync(M.DIR).filter(d => fs.existsSync(path.join(M.DIR, d, 'index.js')) && !d.startsWith('zz-')).every(d => { const m = require(path.join(M.DIR, d, 'index.js')); return Number.isInteger(m.contract) && m.contract >= 1 && m.contract <= M.CONTRACT; }));
    const gb = guard(cfgFile('bad', { modules: { 'hello-stub': true, [`zz-bad-0-${tag}`]: true } }), 'echo fine');
    check('bad manifest: the real guard fails closed with the message, no stack trace', gb.code === 2 && gb.kind === 'module' && gb.err.includes(`zz-bad-0-${tag}`) && !/\n\s+at /.test(gb.err), gb.err);
  } catch (e) { check('no exception', false, e.stack); }
  finally {
    if (jobsHandle) await jobsHandle.stop();
    for (const d of DIRS) fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const after = coreHash();
  check('zero core edits: core files hash the same before and after', after.hash === before.hash && after.count === before.count, `${before.hash.slice(0, 12)} -> ${after.hash.slice(0, 12)}`);
  check('nothing left under modules/', !DIRS.some(d => fs.existsSync(d)));
  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  process.exit(n === results.length ? 0 : 1);
})();
