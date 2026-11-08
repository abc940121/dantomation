#!/usr/bin/env node
'use strict';
// Module contract v1.2 (docs/MODULES.md): the hardening and the additive seams.
//  - route access (owner / worker / public-get) against ctx.actor; generic 500 with
//    a journal ref and no secret; decoded params with "..", "/", "\" refused
//  - beforeTool: a result of the wrong shape is a module_bad_result block; ctx.signal
//    is aborted on timeout
//  - validation: every, min / max, panel entries that escape the folder
//  - jobs: stop() waits for an in-flight run, a slow service start times out
//  - provides / providers(kind), prepareTurn, ctx.tasks stub
//  - settingsSchema / updateSettings, stateVersion + migrate, uninstall
//  - Windows: an extra ACE on a secrets file is a warning, and restrict re-locks it
// Temp modules go under modules/zz-sm-*, removed at the end. Runs in any mode.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-seams-'));
const STATE = path.join(tmp, 'state');
process.env.HARNESS_STATE_DIR = STATE; // before the journal is required
delete process.env.HARNESS_TASK_ID;
const ROOT = path.resolve(__dirname, '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));
const tag = crypto.randomBytes(3).toString('hex');
const N = s => `zz-sm-${s}-${tag}`;
const DIRS = [];
const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const mod = (name, body, files = {}) => {
  const d = path.join(M.DIR, name);
  DIRS.push(d);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'index.js'), `'use strict';\nmodule.exports = ${body};\n`);
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); }
  return name;
};
const quiet = async fn => { const w = process.stderr.write; const out = []; process.stderr.write = s => { out.push(String(s)); return true; }; try { return [await fn(), out.join('')]; } finally { process.stderr.write = w; } };
const OWNER = { kind: 'owner', id: 'test' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  try {
    // ---- routes: access, actor, errors, params
    const SECRET = `zq-${tag}-very-secret`;
    const rt = mod(N('rt'), `{ contract: 1, name: '${N('rt')}',
      settings: { token: { type: 'secret', description: 'a token' } },
      routes: [
        { method: 'GET', path: '/who', description: 'who', handler: ({ actor }) => ({ status: 200, json: actor }) },
        { method: 'POST', path: '/w', description: 'worker', access: 'worker', handler: () => ({ status: 200, json: {} }) },
        { method: 'GET', path: '/pub', description: 'public', access: 'public-get', handler: () => ({ status: 200, json: {} }) },
        { method: 'GET', path: '/boom', description: 'throws', handler: ({ secret }) => { throw new Error('bad token ' + secret('token')); } },
        { method: 'GET', path: '/shape', description: 'bad shape', handler: () => 'nope' },
        { method: 'GET', path: '/f/:name', description: 'param', handler: ({ params }) => ({ status: 200, json: params }) },
      ] }`);
    M.setSecret(rt, 'token', SECRET);
    let reg = M.registry({ modules: { [rt]: true } });
    const call = (m, u, actor) => reg.callRoute(reg.findRoute(m, u), { actor });
    let r = await call('GET', `/m/${rt}/who`, OWNER);
    check('owner route: the handler gets ctx.actor', r.status === 200 && r.json.kind === 'owner' && r.json.id === 'test', JSON.stringify(r));
    check('owner route: no actor (anonymous) is 403', (await call('GET', `/m/${rt}/who`)).status === 403 && (await call('GET', `/m/${rt}/who`, { kind: 'worker', id: 'w' })).status === 403);
    check('worker route: worker and owner pass, anonymous 403', (await call('POST', `/m/${rt}/w`, { kind: 'worker', id: 'w' })).status === 200 && (await call('POST', `/m/${rt}/w`, OWNER)).status === 200 && (await call('POST', `/m/${rt}/w`, { kind: 'bogus' })).status === 403);
    check('public-get route: anonymous passes', (await call('GET', `/m/${rt}/pub`)).status === 200);
    check('listRoutes carries access', reg.listRoutes().filter(x => x.module === rt).map(x => x.access).join() === 'owner,worker,public-get,owner,owner,owner');
    r = await call('GET', `/m/${rt}/boom`, OWNER);
    const rec = J.readAll().records.find(x => x.id === r.json.ref);
    check('throwing route: generic 500 with a journal ref', r.status === 500 && r.json.error === 'internal error' && rec && rec.type === 'route_error' && rec.module === rt && /bad token/.test(rec.error), JSON.stringify(r));
    check('throwing route: the secret is in neither the response nor the journal', !JSON.stringify(r).includes(SECRET) && !fs.readFileSync(J.JOURNAL, 'utf8').includes(SECRET) && rec.error.includes('[secret]'), rec && rec.error);
    r = await call('GET', `/m/${rt}/shape`, OWNER);
    check('bad response shape: generic 500', r.status === 500 && r.json.error === 'internal error' && r.json.ref);
    check('decoded params work', (await call('GET', `/m/${rt}/f/a%20b`, OWNER)).json.name === 'a b');
    const bad = ['..', '%2e%2e', 'a%2Fb', 'a%5Cb', 'a%00', '%E0%A4%A'].filter(p => reg.findRoute('GET', `/m/${rt}/f/${p}`));
    check('params holding .., /, \\, NUL or bad escapes match no route', bad.length === 0, bad.join(' '));
    let e = M.load({ modules: { [mod(N('pa'), `{ contract: 1, name: '${N('pa')}', routes: [{ method: 'POST', path: '/x', access: 'public-get', handler() {} }, { method: 'GET', path: '/y', access: 'all', handler() {} }] }`)]: true } });
    check('access: public-get only for GET, unknown values refused', /public-get" is only for GET/.test(e.errors.join()) && /access must be one of/.test(e.errors.join()), e.errors.join(' | '));

    // ---- beforeTool results and ctx.signal
    let aborted = null;
    global.__smAbort = v => { aborted = v; };
    const bt = mod(N('bt'), `{ contract: 1, name: '${N('bt')}', beforeTool: ({ ti }) => ti.r === 'str' ? 'blocked?' : ti.r === 'obj' ? { kind: 'x' } : ti.r === 'false' ? false : ti.r === 'one' ? ['x'] : null }`);
    const slow = mod(N('slow'), `{ contract: 1, name: '${N('slow')}', beforeTool: ({ signal }) => new Promise(res => { signal.addEventListener('abort', () => global.__smAbort(signal.aborted)); setTimeout(res, 400); }) }`);
    const ld = M.load({ modules: { [bt]: true } });
    const res = {};
    for (const v of ['str', 'obj', 'false', 'one', 'none']) res[v] = await M.beforeTool(ld.mods, { tool: 'Bash', ti: { r: v } });
    check('beforeTool: a string, an object or a 1-tuple is a module_bad_result block', ['str', 'obj', 'one'].every(v => res[v] && res[v][0] === 'module_bad_result' && /must return null/.test(res[v][1])), JSON.stringify(res));
    check('beforeTool: false and null allow', res.false === null && res.none === null);
    const ls = M.load({ modules: { [slow]: true }, modules_hook_timeout_ms: 50 });
    const hit = await M.beforeTool(ls.mods, { tool: 'Bash', ti: {} });
    await sleep(20);
    check('timeout: module_timeout block and ctx.signal aborted', hit && hit[0] === 'module_timeout' && aborted === true, `${JSON.stringify(hit)} aborted=${aborted}`);

    // ---- validation
    const v = (k, body, files) => M.load({ modules: { [mod(N(k), `{ contract: 1, name: '${N(k)}', ${body} }`, files)]: true } }).errors.join(' | ');
    check('every: Infinity, NaN, 0 and huge are refused', ['Infinity', 'NaN', '0', '-1', '1e12'].every(x => /every must be a finite number/.test(v('ev' + x.replace(/\W/g, '').toLowerCase(), `jobs: [{ id: 'j', every: ${x}, run() {} }]`))));
    check('settings min/max: non-numbers and min > max refused', /must be finite numbers/.test(v('mn', `settings: { n: { type: 'number', default: 1, min: '0', description: 'n' } }`)) && /is above max/.test(v('mx', `settings: { n: { type: 'number', default: 1, min: 5, max: 2, description: 'n' } }`)));
    check('panel entry that is a folder is refused', /is not a regular file/.test(v('pd', `panels: [{ id: 'p', title: 'P', mount: 'chat', entry: 'ui/dir' }]`, { 'ui/dir/x.js': '' })));
    const esc = N('ps');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'x.js'), '//');
    mod(esc, `{ contract: 1, name: '${esc}', panels: [{ id: 'p', title: 'P', mount: 'chat', entry: 'ui/link/x.js' }] }`, { 'ui/keep.txt': '' });
    let linked = true; // a junction on Windows needs no extra rights
    try { fs.symlinkSync(outside, path.join(M.DIR, esc, 'ui', 'link'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { linked = false; }
    if (linked) {
      const er = M.load({ modules: { [esc]: true } }).errors.join();
      check('panel entry symlinked outside the module folder is refused', /resolves outside the module folder/.test(er), er);
    } else console.log('SKIP panel symlink escape (symlinks not permitted here)');
    const long = v('lg', `${Array.from({ length: 40 }, (_, i) => `x${i}: 1`).join(', ')}, settings: { zlast_key: { type: 'nope' } }`);
    check('load errors are not cut short (the last field is still named)', long.includes('settings.zlast_key'), long.length + ' chars');

    // ---- jobs: stop waits for the in-flight run; a slow service start times out
    global.__smJob = [];
    const jb = mod(N('jb'), `{ contract: 1, name: '${N('jb')}', jobs: [
      { id: 'run', every: 0.02, run: ({ signal }) => new Promise(res => { global.__smJob.push('start'); setTimeout(() => { global.__smJob.push(signal.aborted ? 'end-aborted' : 'end'); res(); }, 150); }) },
      { id: 'late', start: () => new Promise(res => setTimeout(() => res(() => global.__smJob.push('late-stopped')), 200)) }] }`);
    reg = M.registry({ modules: { [jb]: true }, modules_hook_timeout_ms: 80 });
    const jerr = [];
    const h = await reg.startJobs({}, (j, er) => jerr.push(`${j.id}: ${er.message}`));
    await sleep(60);
    await h.stop();
    const afterStop = global.__smJob.slice();
    check('a slow service start times out (reported, not thrown)', jerr.some(x => /late: .*start took longer/.test(x)), jerr.join(' | '));
    check('stop() waits for the in-flight run (signal aborted)', afterStop.filter(x => x === 'start').length === 1 && afterStop.includes('end-aborted'), afterStop.join());
    await sleep(250);
    check('a start that settles late is stopped at once', global.__smJob.includes('late-stopped'), global.__smJob.join());

    // ---- providers, prepareTurn, ctx.tasks
    const pv = mod(N('pv'), `{ contract: 1, name: '${N('pv')}',
      provides: { tools: [{ id: 'grep', description: 'search', schema: { q: 'string' } }], bots: [{ id: 'helper' }] },
      prepareTurn: ({ resumed }) => ({ context: ['line one', resumed ? 'resumed' : 'fresh'] }),
      commands: { zztasks: (a, { tasks }) => tasks.enqueue({}).then(() => 'resolved', e => e.message) } }`);
    const pbad = mod(N('pb'), `{ contract: 1, name: '${N('pb')}', prepareTurn: () => ({ context: 'not an array' }) }`);
    const pbig = mod(N('pg'), `{ contract: 1, name: '${N('pg')}', prepareTurn: () => ({ context: ['y'.repeat(9000)] }) }`);
    reg = M.registry({ modules: { [pv]: true, [pbad]: true, [pbig]: true } });
    check('providers(kind) lists contributions with their module', JSON.stringify(reg.providers('tools')) === JSON.stringify([{ id: 'grep', description: 'search', schema: { q: 'string' }, module: pv, kind: 'tools' }]) && reg.providers('bots').length === 1 && reg.providers('engines').length === 0, JSON.stringify(reg.providers('tools')));
    check('providers: unknown kind throws; bad entries are load errors', (() => { try { reg.providers('widgets'); return false; } catch { return true; } })()
      && /provides: unknown kind "x"/.test(v('pk', `provides: { x: [] }`)) && /duplicate provides.tools id "a"/.test(v('pdup', `provides: { tools: [{ id: 'a' }, { id: 'a' }] }`)));
    const [pt, perr] = await quiet(() => M.prepareTurn(reg.mods, { resumed: true }));
    check('prepareTurn: context lines per module, clipped, a bad shape reported not thrown', pt.context.length === 2 && pt.context[0].text === 'line one\nresumed' && pt.context[1].text.endsWith(' [clipped]') && pt.context[1].text.length < 8100
      && pt.errors.length === 1 && /prepareTurn failed/.test(perr), JSON.stringify(pt).slice(0, 200));
    check('ctx.tasks: rejects until S1', /not available until S1/.test(await M.commands(reg.mods).zztasks([])));

    // ---- settingsSchema / updateSettings
    const st = mod(N('st'), `{ contract: 1, name: '${N('st')}', settings: {
      n: { type: 'integer', default: 3, min: 1, max: 9, description: 'n' }, key: { type: 'secret', description: 'k' } },
      commands: { zzkey: (a, { secret, settings }) => [secret('key'), settings.key, settings.n] } }`);
    const cfg = { modules: { [st]: true } };
    reg = M.registry(cfg);
    const sch = reg.settingsSchema(st);
    check('settingsSchema: section key and specs', sch.section === M.sectionKey(st) && sch.settings.n.max === 9 && sch.settings.key.type === 'secret' && reg.settingsSchema('nope') === null);
    let refused = '';
    try { await reg.updateSettings(st, { n: 5, key: 'kkkk-value', bogus: 1 }); } catch (er) { refused = er.message; }
    check('updateSettings: a bad key refuses the whole patch', /unknown setting "bogus"/.test(refused) && reg.settingsFor(st).n === 3 && !fs.existsSync(M.secretsFile(st)), refused);
    const saved = [];
    const out = await reg.updateSettings(st, { n: 5, key: 'kkkk-value' }, { save: (k, sec) => saved.push([k, sec]) });
    const seen = await M.commands(reg.mods).zzkey([]);
    check('updateSettings: applies, secret to the secrets file, save() gets the section', out.n === 5 && out.key === 'configured' && JSON.stringify(seen) === '["kkkk-value","configured",5]'
      && JSON.parse(fs.readFileSync(M.secretsFile(st), 'utf8')).key === 'kkkk-value' && JSON.stringify(saved) === JSON.stringify([[M.sectionKey(st), { n: 5 }]]) && !JSON.stringify(saved).includes('kkkk'), JSON.stringify([out, seen, saved]));
    await reg.updateSettings(st, { n: null, key: '' });
    check('updateSettings: null resets, empty secret removes', reg.settingsFor(st).n === 3 && reg.settingsFor(st).key === 'missing' && !JSON.parse(fs.readFileSync(M.secretsFile(st), 'utf8')).key);
    try { await reg.updateSettings(st, { n: 99 }); refused = ''; } catch (er) { refused = er.message; }
    check('updateSettings: value checks apply (max)', /must be <= 9/.test(refused), refused);

    // ---- stateVersion, migrate, uninstall
    global.__smMig = [];
    const mg = N('mg');
    const mgBody = ver => `{ contract: 1, name: '${mg}', stateVersion: ${ver}, migrate(from, { state }) { global.__smMig.push(from + '>' + ${ver}); }, uninstall({ state }) { global.__smMig.push('uninstall:' + fs.existsSync(state.dir)); } }`;
    mod(mg, mgBody(1));
    fs.writeFileSync(path.join(M.DIR, mg, 'index.js'), `'use strict';\nconst fs = require('fs');\nmodule.exports = ${mgBody(1)};\n`);
    let lm = M.load({ modules: { [mg]: true } });
    let mr = await M.migrate(lm.mods);
    const vf = path.join(STATE, 'm', mg, 'state-version.json');
    check('migrate: a fresh install runs migrate(0) once and writes the version', mr.errors.length === 0 && global.__smMig.join() === '0>1' && JSON.parse(fs.readFileSync(vf, 'utf8')).version === 1);
    await M.migrate(lm.mods);
    check('migrate: nothing to do the second time', global.__smMig.join() === '0>1');
    delete require.cache[require.resolve(path.join(M.DIR, mg, 'index.js'))];
    fs.writeFileSync(path.join(M.DIR, mg, 'index.js'), `'use strict';\nconst fs = require('fs');\nmodule.exports = ${mgBody(2)};\n`);
    lm = M.load({ modules: { [mg]: true } });
    mr = await M.migrate(lm.mods);
    check('migrate: an older state runs migrate(1) to 2 and journals it', mr.errors.length === 0 && global.__smMig.join() === '0>1,1>2' && J.readAll().records.some(x => x.type === 'module_migrated' && x.module === mg && x.from === 1 && x.to === 2));
    fs.writeFileSync(vf, JSON.stringify({ version: 7 }));
    mr = await M.migrate(lm.mods);
    check('migrate: a state newer than the module is an error', mr.errors.length === 1 && /newer than this module's stateVersion 2/.test(mr.errors[0]), mr.errors.join());
    check('migrate without stateVersion is a load error', /migrate needs stateVersion/.test(v('ms', 'migrate() {}')));
    const un = await M.uninstall({ modules: { [mg]: true } }, mg);
    check('uninstall: hook runs, state/m/<name> removed, journaled', un.errors.length === 0 && global.__smMig.includes('uninstall:true') && !fs.existsSync(path.join(STATE, 'm', mg))
      && J.readAll().records.some(x => x.type === 'module_uninstalled' && x.module === mg), JSON.stringify(un));
    const cf = path.join(tmp, 'un.json');
    fs.writeFileSync(cf, JSON.stringify({ owner_name: 'Tester', modules: {} }));
    const agent = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'uninstall', mg], { env: { ...process.env, HARNESS_CONFIG: cf, HARNESS_STATE_DIR: STATE, HARNESS_TASK_ID: 'T1' }, encoding: 'utf8' });
    check('the uninstall verb refuses inside an agent task', agent.status === 2 && /not from inside a task/.test(agent.stderr), agent.stderr.trim());

    // ---- hook time budget: the hooks of one engine call must add up to less than the engine's 60 s
    const b1 = mod(N('b1'), `{ contract: 1, name: '${N('b1')}', beforeTool() { return null; } }`), b2 = mod(N('b2'), `{ contract: 1, name: '${N('b2')}', beforeTool() { return null; } }`);
    let bl = M.load({ modules: { [b1]: true, [b2]: true }, modules_hook_timeout_ms: 30000 });
    check('hook budget: timeouts adding up to the 60 s engine limit are a load error naming the modules and the total', bl.errors.length === 1 && bl.errors[0].includes(b1) && bl.errors[0].includes(b2) && /60000 ms/.test(bl.errors[0]) && /hook time budget/.test(bl.errors[0]), bl.errors.join(' | '));
    bl = M.load({ modules: { [b1]: true, [b2]: true }, modules_hook_timeout_ms: 29999 });
    check('hook budget: just under the limit loads', bl.errors.length === 0 && bl.mods.length === 2, bl.errors.join(' | '));
    bl = M.load({ modules: { [b1]: true, [b2]: true } });
    check('hook budget: the default 5 s per hook is fine', bl.errors.length === 0);

    // ---- Windows: a widened secrets file is a warning; restrict re-locks it
    if (process.platform === 'win32') {
      const sf = M.secretsFile(rt);
      spawnSync('icacls', [sf, '/grant', '*S-1-1-0:(R)'], { windowsHide: true });
      const widened = M.aclProblem(sf);
      const [lr, warn] = await quiet(() => M.load({ modules: { [rt]: true } }));
      check('a secrets file open to others: load warns and goes on', widened && lr.errors.length === 0 && /not owner-only/.test(warn), `${widened} | ${warn.trim()}`);
      check('the warning carries the exact icacls fix for that file, from the runtime path, and no secret value', warn.includes(M.icaclsFix(sf)) && /icacls ".*" [/]inheritance:r [/]grant:r ".+:F"/.test(warn) && !/s3cret/i.test(warn), warn.trim());
      M.restrict(sf, false);
      check('restrict re-locks it to the owner only', M.aclProblem(sf) === null, M.aclProblem(sf));
    } else console.log('SKIP Windows ACL warning (not Windows)');
    // ---- security round: fail-open crash, route params, precedence, secret scrubbing
    {
      const nul = mod(N('nul'), `{ contract: 1, name: '${N('nul')}', beforeTool() { throw Object.create(null); } }`);
      const ln = M.load({ modules: { [nul]: true } });
      const hit = await M.beforeTool(ln.mods, { tool: 'Bash', ti: {} });
      check('a module throwing a null-prototype object ends in a block, not a crash', hit && /unprintable|module/.test(hit[0] + hit[1]), JSON.stringify(hit));
      const gcfg = path.join(tmp, 'guard-cfg.json');
      fs.writeFileSync(gcfg, JSON.stringify({ modules: { [nul]: true } }));
      const gr = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'guards', 'guard.js')], { input: JSON.stringify({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'echo hi' }, cwd: tmp }), env: { ...process.env, HARNESS_CONFIG: gcfg, HARNESS_STATE_DIR: STATE, HARNESS_LOG_DIR: path.join(tmp, 'logs') }, encoding: 'utf8' });
      check('the real guard process exits 2 for it', gr.status === 2 && /BLOCKED/.test(gr.stderr), `${gr.status} ${gr.stderr}`);
      const rp = mod(N('rp'), `{ contract: 1, name: '${N('rp')}',
        settings: { tok: { type: 'secret', description: 'a token' } },
        routes: [
          { method: 'GET', path: '/:page', description: 'page', access: 'public-get', handler: () => ({ status: 200, json: { which: 'param' } }) },
          { method: 'GET', path: '/admin', description: 'admin', handler: () => ({ status: 200, json: { which: 'literal' } }) },
          { method: 'GET', path: '/f/:name', description: 'f', handler: ({ params }) => ({ status: 200, json: params }) },
          { method: 'GET', path: '/bad', description: 'bad', handler: ({ secret }) => secret('tok') },
          { method: 'POST', path: '/rec', description: 'rec', handler: ({ state, secret }) => { state.append({ type: 'zz_rec', text: 'x ' + secret('tok'), nested: { a: ['y ' + secret('tok')] } }); return { status: 200, json: {} }; } },
        ] }`);
      const NL = `line1-${tag}\nline2-${tag}`;
      M.setSecret(rp, 'tok', NL);
      const r2 = M.registry({ modules: { [rp]: true } });
      const base = `/m/${rp}`;
      check('a literal segment beats an earlier :param', r2.findRoute('GET', `${base}/admin`).route.path.endsWith('/admin'));
      check('other single segments still reach the :param route', r2.findRoute('GET', `${base}/other`).route.path.endsWith('/:page'));
      check('a double-encoded dot-dot-slash param matches nothing', r2.findRoute('GET', `${base}/f/%252e%252e%252f`) === null);
      check('a single-encoded value still decodes', r2.findRoute('GET', `${base}/f/a%20b`).params.name === 'a b');
      const bd = await r2.callRoute(r2.findRoute('GET', `${base}/bad`), { actor: OWNER });
      const re = J.readAll().records.find(x => x.type === 'route_error' && x.module === rp);
      check('a secret with a newline in a bad route result is scrubbed in its JSON-escaped form', bd.status === 500 && re && !re.error.includes('line1-') && re.error.includes('[secret]'), re && re.error);
      let rej = ''; try { M.setSecret(rp, 'tok', 'abc'); } catch (e) { rej = e.message; }
      check('a secret shorter than 4 characters is refused', /at least 4/.test(rej), rej);
      await r2.callRoute(r2.findRoute('POST', `${base}/rec`), { actor: OWNER });
      const rec = J.readAll().records.find(x => x.type === 'zz_rec');
      check('ctx.state.append scrubs the secret from string fields, nested too', rec && !JSON.stringify(rec).includes('line1-') && JSON.stringify(rec).includes('[secret]'), JSON.stringify(rec));
    }
    // ---- security round 2
    {
      const S20 = `Qz${tag}-0123456789abcdef`.slice(0, 20); // 20 chars, no JSON-special characters
      const rs = mod(N('r2'), `{ contract: 1, name: '${N('r2')}',
        settings: { tok: { type: 'secret', description: 'a token' } },
        beforeTool: ({ ti, secret }) => ti.r === 'blk' ? ['custom', 'denied ' + secret('tok')] : ti.r === 'bad' ? { pad: 'x'.repeat(15), leak: secret('tok') } : null,
        routes: [
          { method: 'GET', path: '/ok', description: 'ok', handler: ({ secret }) => ({ status: 'ok', note: secret('tok') }) },
          { method: 'POST', path: '/rec', description: 'rec', handler: ({ state, secret }) => {
            const s = secret('tok'); let deep = { leaf: 'deep ' + s }; for (let i = 0; i < 10; i++) deep = { d: deep };
            state.append({ type: 'zz_r2', deep, [s]: 1, when: new Date(0) }); return { status: 200, json: {} }; } },
          { method: 'POST', path: '/cyc', description: 'cyc', handler: ({ state }) => { const o = { type: 'zz_cyc' }; o.self = o; state.append(o); return { status: 200, json: {} }; } },
        ] }`);
      M.setSecret(rs, 'tok', S20);
      const reg2 = M.registry({ modules: { [rs]: true } });
      const P = S20.slice(0, 6);
      await reg2.callRoute(reg2.findRoute('POST', `/m/${rs}/rec`), { actor: OWNER });
      const rr = J.readAll().records.find(x => x.type === 'zz_r2');
      const rtxt = JSON.stringify(rr);
      check('state.append scrubs a secret 10 levels deep and as an object key', rr && !rtxt.includes(P) && rtxt.includes('[secret]'), rtxt);
      check('state.append keeps a Date as its ISO string', rr && rr.when === '1970-01-01T00:00:00.000Z', rr && String(rr.when));
      const cy = await reg2.callRoute(reg2.findRoute('POST', `/m/${rs}/cyc`), { actor: OWNER });
      check('state.append of an unserializable record fails closed and journals nothing', cy.status === 500 && !J.readAll().records.some(x => x.type === 'zz_cyc'), JSON.stringify(cy));
      await reg2.callRoute(reg2.findRoute('GET', `/m/${rs}/ok`), { actor: OWNER });
      const rj = J.readAll().records.filter(x => x.module === rs && x.type === 'route_error');
      check('route {status:"ok"} result: no prefix of the secret reaches the journal', rj.length > 0 && rj.every(x => !x.error.includes(P)), rj.map(x => x.error).join('|'));
      const ld2 = M.load({ modules: { [rs]: true } });
      const bad = await M.beforeTool(ld2.mods, { tool: 'Bash', ti: { r: 'bad' } });
      check('beforeTool bad result: no prefix of the secret in the block message', bad && bad[0] === 'module_bad_result' && !bad[1].includes(P), bad && bad[1]);
      const blk = await M.beforeTool(ld2.mods, { tool: 'Bash', ti: { r: 'blk' } });
      check('beforeTool block message is scrubbed of the module secret', blk && blk[0] === 'custom' && !blk[1].includes(P) && blk[1].includes('[secret]'), blk && blk[1]);
    }
    {
      // the guard as a real process, with a config load that throws a non-Error
      const pre = path.join(tmp, 'pre-throw.js');
      fs.writeFileSync(pre, `const C = require(${JSON.stringify(path.join(ROOT, 'lib', 'config'))}); C.load = () => { throw Object.create(null); };\n`);
      const pre2 = path.join(tmp, 'pre-require.js');
      fs.writeFileSync(pre2, `const Mod = require('module'); const L = Mod._load; Mod._load = function (r, ...a) { if (/lib[\\/]redact$/.test(r)) throw 'boom'; return L.call(this, r, ...a); };\n`);
      const g = pre => spawnSync(process.execPath, ['--require', pre, path.join(ROOT, 'guards', 'guard.js')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' } }), encoding: 'utf8', env: { ...process.env, HARNESS_STATE_DIR: STATE } });
      const g1 = g(pre), g2 = g(pre2);
      check('guard: a config load that throws a non-Error blocks with exit 2', g1.status === 2 && /BLOCKED \(config\)/.test(g1.stderr), `${g1.status} ${g1.stderr}`);
      check('guard: a throw while loading requires exits 2, not 1', g2.status === 2 && /BLOCKED/.test(g2.stderr), `${g2.status} ${g2.stderr}`);
      // ---- security round 3
      {
        const S3 = `r3-${tag}-` + 'k'.repeat(3) + 'Z9';
        const pre6 = S3.slice(0, 6);
        const NLS = `nl${tag}first\nsecond-${tag}`;
        const pre6nl = NLS.slice(0, 6);
        const seen = text => text.includes(pre6) || text.includes(pre6nl);
        const readLog = () => { try { return fs.readFileSync(path.join(tmp, 'logs3', 'guard.jsonl'), 'utf8'); } catch { return ''; } };
        // (a) a block whose kind is the secret
        const ka = mod(N('ka'), `{ contract: 1, name: '${N('ka')}', settings: { tok: { type: 'secret', description: 't' } },
          beforeTool: ({ secret }) => [secret('tok'), 'blocked ' + secret('tok')] }`);
        M.setSecret(ka, 'tok', S3);
        const kl = M.load({ modules: { [ka]: true } });
        const kh = await M.beforeTool(kl.mods, { tool: 'Bash', ti: {} });
        check('security 3 (a): a secret used as the block kind is scrubbed', kh && !JSON.stringify(kh).includes(pre6) && kh[0].includes('[secret]'), JSON.stringify(kh));
        // (b) the real guard, async throw with the secret
        const cfg3 = path.join(tmp, 'guard3-cfg.json');
        const runGuard = (modName, args = [], input = { session_id: 's', tool_name: 'Bash', tool_input: { command: 'echo hi' }, cwd: tmp }) => {
          fs.writeFileSync(cfg3, JSON.stringify({ modules: { [modName]: true } }));
          return spawnSync(process.execPath, [path.join(ROOT, 'guards', 'guard.js'), ...args], { input: typeof input === 'string' ? input : JSON.stringify(input), env: { ...process.env, HARNESS_CONFIG: cfg3, HARNESS_STATE_DIR: STATE, HARNESS_LOG_DIR: path.join(tmp, 'logs3') }, encoding: 'utf8' });
        };
        for (const [label, body] of [['an async throw', "new Promise(() => { setTimeout(() => { throw new Error('boom ' + secret('tok')); }, 5); })"], ['an unhandled rejection', "(Promise.reject(new Error('boom ' + secret('tok'))), new Promise(() => {}))"]]) {
          const am = mod(N('as' + label.length), `{ contract: 1, name: '${N('as' + label.length)}', settings: { tok: { type: 'secret', description: 't' } },
            beforeTool: ({ secret }) => ${body} }`);
          M.setSecret(am, 'tok', S3);
          const gr = runGuard(am);
          check(`security 3 (b): guard with ${label} exits 2 and leaks no secret prefix`, gr.status === 2 && !seen(gr.stderr) && !seen(readLog()), `${gr.status} ${gr.stderr}`);
        }
        // (c) route precedence
        const rm = mod(N('rc'), `{ contract: 1, name: '${N('rc')}', routes: [
          { method: 'GET', path: '/:a/b/c', description: 'param first', access: 'public-get', handler: () => ({ status: 200, json: { which: 'param' } }) },
          { method: 'GET', path: '/lit/:b/:c', description: 'literal first', handler: () => ({ status: 200, json: { which: 'literal' } }) },
        ] }`);
        const rreg = M.registry({ modules: { [rm]: true } });
        const rf = rreg.findRoute('GET', `/m/${rm}/lit/b/c`);
        check('security 3 (c): the literal-first route wins over a later-declared-first param route', rf && rf.route.path.endsWith('/lit/:b/:c'), rf && rf.route.path);
        const rf2 = rreg.findRoute('GET', `/m/${rm}/zzz/b/c`);
        check('security 3 (c): the param route still serves other paths', rf2 && rf2.route.path.endsWith('/:a/b/c'), rf2 && rf2.route.path);
        // (d) a secret holding a newline
        const nm = mod(N('nl'), `{ contract: 1, name: '${N('nl')}', settings: { tok: { type: 'secret', description: 't' } },
          beforeTool: ({ secret }) => { throw new Error(secret('tok') + ' tail'); },
          routes: [{ method: 'GET', path: '/x', description: 'x', handler: ({ secret }) => { throw new Error('bad ' + secret('tok')); } }] }`);
        M.setSecret(nm, 'tok', NLS);
        const nl = M.load({ modules: { [nm]: true } });
        const nh = await M.beforeTool(nl.mods, { tool: 'Bash', ti: {} });
        check('security 3 (d): newline secret thrown from beforeTool leaves no prefix', nh && !JSON.stringify(nh).includes(pre6nl), JSON.stringify(nh));
        const nreg = M.registry({ modules: { [nm]: true } });
        const nr = await nreg.callRoute(nreg.findRoute('GET', `/m/${nm}/x`), { actor: OWNER });
        const nrec = J.readAll().records.find(x => x.id === nr.json.ref);
        check('security 3 (d): newline secret thrown from a route leaves no prefix in result or journal', nr.status === 500 && nrec && !JSON.stringify(nr).includes(pre6nl) && !JSON.stringify(nrec).includes(pre6nl) && !fs.readFileSync(J.JOURNAL, 'utf8').includes(pre6nl), JSON.stringify(nrec));
        // (e) prepareTurn bad result
        const pm = mod(N('pt'), `{ contract: 1, name: '${N('pt')}', settings: { tok: { type: 'secret', description: 't' } },
          prepareTurn: ({ secret }) => ({ context: 'x'.repeat(20) + secret('tok') }) }`);
        M.setSecret(pm, 'tok', S3);
        const pl = M.load({ modules: { [pm]: true } });
        const [pres] = await quiet(() => M.prepareTurn(pl.mods, {}));
        check('security 3 (e): a bad prepareTurn result does not leak a secret prefix into the error', pres.errors.length === 1 && !pres.errors[0].includes(pre6), pres.errors.join('|'));
        // (f) --after never blocks
        const fm = mod(N('af'), `{ contract: 1, name: '${N('af')}' }`);
        const f1 = runGuard(fm, ['--after'], 'this is not json');
        check('security 3 (f): --after with non-JSON stdin exits 0', f1.status === 0, `${f1.status} ${f1.stderr}`);
        const f2 = runGuard(fm, ['--after'], '[1]'.replace('[1]', '5'));
        check('security 3 (f): --after with a non-object input exits 0', f2.status === 0, `${f2.status} ${f2.stderr}`);
        fs.writeFileSync(cfg3, '{ broken json');
        const f3 = spawnSync(process.execPath, [path.join(ROOT, 'guards', 'guard.js'), '--after'], { input: JSON.stringify({ tool_name: 'Bash', tool_input: {} }), env: { ...process.env, HARNESS_CONFIG: cfg3, HARNESS_STATE_DIR: STATE, HARNESS_LOG_DIR: path.join(tmp, 'logs3') }, encoding: 'utf8' });
        check('security 3 (f): --after with a broken config exits 0', f3.status === 0, `${f3.status} ${f3.stderr}`);
        // (g) review round: ctx cannot override sanitized params
        const pm1 = mod(N('pp'), `{ contract: 1, name: '${N('pp')}', routes: [{ method: 'GET', path: '/:a', description: 'p', handler: ({ params }) => ({ status: 200, json: { a: params.a } }) }] }`);
        const preg = M.registry({ modules: { [pm1]: true } });
        const pr = await preg.callRoute(preg.findRoute('GET', `/m/${pm1}/ok`), { actor: OWNER, params: { a: '../evil' } });
        check('review 1: ctx.params cannot replace the sanitized route params', pr.status === 200 && pr.json.a === 'ok', JSON.stringify(pr));
        // (h) a throw at require time carries a secret: load error, guard and uninstall
        const envk = 'ZZ_SM_FAIL_' + tag;
        const lm = mod(N('lf'), `(() => { if (process.env.${envk}) throw new Error('boom ' + ${JSON.stringify(S3)}); return { contract: 1, name: '${N('lf')}', settings: { tok: { type: 'secret', description: 't' } } }; })()`);
        M.setSecret(lm, 'tok', S3);
        process.env[envk] = '1';
        delete require.cache[require.resolve(path.join(M.DIR, lm, 'index.js'))];
        const ll = M.load({ modules: { [lm]: true } });
        check('review 2: a require-time throw with a secret leaves no secret prefix in the load error', ll.errors.length === 1 && !seen(ll.errors.join('|')) && ll.errors[0].startsWith(lm + ':'), ll.errors.join('|'));
        const lg = runGuard(lm);
        check('review 2: the guard blocks on it and leaks no secret prefix to stderr or the log', lg.status === 2 && !seen(lg.stderr) && !seen(readLog()), `${lg.status} ${lg.stderr}`);
        delete process.env[envk];
        // (i) the event name is module-visible text: a secret inside it is scrubbed
        const ES = 'evsecret' + tag + 'x';
        const em = mod(N('ev'), `{ contract: 1, name: '${N('ev')}', settings: { tok: { type: 'secret', description: 't' } }, emits: ['${N('ev')}'],
          on: { [${JSON.stringify(N('ev') + '.' + ES)}]: () => { throw new Error('nope'); } } }`);
        M.setSecret(em, 'tok', ES);
        const el = M.load({ modules: { [em]: true } });
        const [er, eerr] = await quiet(() => M.emit(el.mods, N('ev') + '.' + ES, {}));
        check('review 3: a secret inside an event name is scrubbed from the failure message and stderr', el.errors.length === 0 && er.errors.length === 1 && !(er.errors.join('|') + eerr).includes('evsecr'), el.errors.join('|') + ' ' + er.errors.join('|'));
        // (j) every form of every secret goes into one list, longest first
        const hb = 'wertyu', ha = 'q"wertyu';
        const hm = mod(N('hs'), `{ contract: 1, name: '${N('hs')}', settings: { b: { type: 'secret', description: 'b' }, a: { type: 'secret', description: 'a' } },
          beforeTool: ({ secret }) => { throw new Error(JSON.stringify({ v: secret('a') })); } }`);
        M.setSecret(hm, 'b', '\\"' + hb);
        M.setSecret(hm, 'a', ha);
        const hl = M.load({ modules: { [hm]: true } });
        const hh = await M.beforeTool(hl.mods, { tool: 'Bash', ti: {} });
        check('review 4: a secret whose escaped form contains another secret is hidden whole', hh && !JSON.stringify(hh).includes('wertyu') && !JSON.stringify(hh).includes('q\\'), JSON.stringify(hh));
      }
    }
    // ---- security round 5
    {
      const SA = `sa-${tag}-first-modules-secret-value-0123456789`, SB = `sb-${tag}-second-modules-secret`;
      const ma = mod(N('xa'), `{ contract: 1, name: '${N('xa')}', settings: { tok: { type: 'secret', description: 't' } } }`);
      const mb = mod(N('xb'), `{ contract: 1, name: '${N('xb')}', settings: { tok: { type: 'secret', description: 't' } },
        beforeTool: async ctx => { ctx.state.append({ type: 'r5_leak', v: '${SA}' }); throw new Error('leaked ${SA}'); } }`);
      M.setSecret(ma, 'tok', SA); M.setSecret(mb, 'tok', SB);
      const xl = M.load({ modules: { [ma]: true, [mb]: true } });
      const hit = await M.beforeTool(xl.mods, { tool: 'Bash', ti: {} });
      const rec = J.readAll().records.find(r => r.type === 'r5_leak');
      check('round 5: module A secret thrown / journaled by module B is hidden (error and state.append)', hit && !JSON.stringify(hit).includes(SA) && rec && !JSON.stringify(rec).includes(SA), JSON.stringify(hit) + JSON.stringify(rec));
      check('round 5: scrubAll hides every loaded module secret and secret patterns, unclipped', !M.scrubAll('x ' + SA + ' ' + SB).includes('first-modules') && !M.scrubAll('y'.repeat(900) + SB).includes(SB) && M.scrubAll('y'.repeat(900)).length === 900 && M.scrubAll('sk-ant-' + 'a'.repeat(30)) === '[REDACTED]');
      // settings validation quotes a bad value clipped; a secret prefix must not survive the clip
      const mc = mod(N('xc'), `{ contract: 1, name: '${N('xc')}', settings: { n: { type: 'number', description: 'n', default: 1 }, tok: { type: 'secret', description: 't' } } }`);
      const SC = `sc-${tag}-` + 'z'.repeat(50);
      M.setSecret(mc, 'tok', SC);
      const cl = M.load({ modules: { [mc]: true }, [mc.replace(/-/g, '_')]: { n: SC } });
      check('round 5: a bad setting value equal to a secret is scrubbed before it is clipped', cl.errors.length === 1 && !cl.errors.join().includes(SC.slice(0, 20)) && /\[secret\]/.test(cl.errors.join()), cl.errors.join());
      // load / setSecret / uninstall errors of a module that throws on require, carrying its own secret
      const marker = path.join(tmp, 'boom-marker');
      const md = mod(N('xd'), `{ contract: 1, name: '${N('xd')}', settings: { tok: { type: 'secret', description: 't' } } }`);
      const SD = `sd-${tag}-the-stored-secret`;
      M.setSecret(md, 'tok', SD);
      fs.writeFileSync(path.join(M.DIR, md, 'index.js'), `'use strict';\nif (require('fs').existsSync(${JSON.stringify(marker)})) throw new Error('boom ${SD}');\nmodule.exports = { contract: 1, name: '${md}', settings: { tok: { type: 'secret', description: 't' } } };\n`);
      fs.writeFileSync(marker, '');
      const dropCache = () => delete require.cache[require.resolve(path.join(M.DIR, md, 'index.js'))];
      dropCache();
      let e1 = ''; try { M.setSecret(md, 'tok', 'another-value'); } catch (e) { e1 = e.message; }
      dropCache();
      let e2 = ''; try { await M.uninstall({}, md); } catch (e) { e2 = e.message; }
      check('round 5: setSecret / uninstall errors from require are scrubbed of the module secret', /boom/.test(e1) && /boom/.test(e2) && !e1.includes(SD) && !e2.includes(SD), e1 + ' | ' + e2);
      dropCache();
      fs.writeFileSync(M.secretsFile(md), 'not json');
      const wl = M.load({ modules: { [md]: true } });
      check('round 5: unreadable secrets file -> fixed load message, no raw error text', wl.errors.length === 1 && /details withheld/.test(wl.errors[0]) && !/boom/.test(wl.errors[0]), wl.errors.join());
    }
    // ---- security round 5: the guard process
    {
      const gdir = path.join(tmp, 'guard'); fs.mkdirSync(gdir, { recursive: true });
      const GS = path.join(gdir, 'state'), GL = path.join(gdir, 'logs');
      const gm = mod(N('g'), `{ contract: 1, name: '${N('g')}', settings: { tok: { type: 'secret', description: 't' } },
        beforeTool: async ({ tool, ti, secret }) => { const how = String(ti.command || ''); const j = require(${JSON.stringify(path.join(ROOT, 'lib', 'journal'))});
          if (how === 'late-timer') { setTimeout(() => { throw new Error('late'); }, 0); return null; }
          if (how === 'late-reject') { setImmediate(() => Promise.reject(new Error('late'))); return null; }
          if (how === 'journal') { j.readAll(); return null; }
          return how.includes(secret('tok')) ? ['module', 'nope'] : null; } }`);
      const GSEC = `gsec-${tag}-guard-secret-value-abcdef`;
      const env0 = { ...process.env, HARNESS_STATE_DIR: GS, HARNESS_LOG_DIR: GL };
      delete env0.HARNESS_TASK_ID;
      const cfgOf = on => { const f = path.join(gdir, 'c' + on + '.json'); fs.writeFileSync(f, JSON.stringify({ owner_name: 'Tester', modules: on ? { [gm]: true } : {} })); return f; };
      spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'secret', gm, 'tok'], { env: { ...env0, HARNESS_CONFIG: cfgOf(1) }, input: GSEC, encoding: 'utf8' });
      const run = (input, on, args = [], more = {}) => spawnSync(process.execPath, [path.join(ROOT, 'guards', 'guard.js'), ...args], { env: { ...env0, HARNESS_CONFIG: cfgOf(on), ...more }, input, encoding: 'utf8', timeout: 30000 });
      const ok = c => JSON.stringify({ tool_name: 'Bash', tool_input: { command: c } });
      check('round 5 guard: [] / {} / missing tool_input / non-string tool_name block (exit 2)', ['[]', '{}', '{"tool_name":"Bash"}', '{"tool_name":5,"tool_input":{}}', '{"tool_name":"Bash","tool_input":[]}'].every(i => run(i, 0).status === 2));
      check('round 5 guard: a valid call is allowed, and --after still exits 0 on junk', run(ok('ls'), 0).status === 0 && run('[]', 0, ['--after']).status === 0);
      check('round 5 guard: a zero-delay async throw from a hook cannot be outrun by exit 0', run(ok('late-timer'), 1).status === 2 && run(ok('late-reject'), 1).status === 2);
      fs.mkdirSync(path.join(GS, 'journal.jsonl'), { recursive: true });
      const jr = run(ok('journal'), 1, [], { HARNESS_TASK_ID: 'T1' });
      check('round 5 guard: an unreadable journal inside the guard ends as exit 2, not 5', jr.status === 2, String(jr.status) + jr.stderr);
      fs.rmSync(path.join(GS, 'journal.jsonl'), { recursive: true, force: true });
      const sr = run(ok('echo ' + GSEC), 1);
      let glog = ''; try { glog = fs.readFileSync(path.join(GL, 'guard.jsonl'), 'utf8'); } catch { /* none */ }
      check('round 5 guard: a module secret in the blocked command is not logged or printed', sr.status === 2 && glog.includes('nope') && !glog.includes(GSEC) && !sr.stderr.includes(GSEC), glog);
    }
    // ---- security round 6
    {
      const SE = `se-${tag}-rotated-out-secret-value`, SF = `sf-${tag}-the-other-modules-secret`;
      const me = mod(N('ya'), `{ contract: 1, name: '${N('ya')}', settings: { tok: { type: 'secret', description: 't' } } }`);
      M.setSecret(me, 'tok', SE); M.setSecret(me, 'tok', 'rotated-to-' + tag + '-new-value');
      check('round 6: a rotated-out secret value is still hidden', !M.scrubAll('x ' + SE).includes('rotated-out') && !M.hideAll('x ' + SE).includes(SE));
      // another enabled module's secret inside this module's load error; and a manifest value clipped by show()
      const mf = mod(N('yb'), `{ contract: 1, name: '${N('yb')}', settings: { tok: { type: 'secret', description: 't' } } }`);
      M.setSecret(mf, 'tok', SF);
      const mg = mod(N('yc'), `{ contract: 1, name: '${N('yc')}' }`);
      fs.writeFileSync(path.join(M.DIR, mg, 'index.js'), `'use strict';\nthrow new Error('boom ${SF}');\n`);
      const mh = mod(N('yd'), `{ contract: 1, name: '${N('yd')}', settings: { tok: { type: 'secret', description: 't' } } }`);
      const SH = `sh-${tag}-` + 'q'.repeat(50);
      M.setSecret(mh, 'tok', SH);
      fs.writeFileSync(path.join(M.DIR, mh, 'index.js'), `'use strict';\nmodule.exports = { contract: 1, name: '${mh}', priority: '${SH}', settings: { tok: { type: 'secret', description: 't' } } };\n`);
      delete require.cache[require.resolve(path.join(M.DIR, mh, 'index.js'))];
      const l6 = M.load({ modules: { [mg]: true, [mf]: true, [mh]: true } });
      const e6 = l6.errors.join(' | ');
      check('round 6: a load error carrying another enabled module\'s secret is scrubbed', /boom/.test(e6) && !e6.includes(SF.slice(0, 12)), e6);
      check('round 6: a manifest value equal to the module secret is scrubbed before show() clips it', /priority/.test(e6) && !e6.includes(SH.slice(0, 12)), e6);
      // the token values: a clip at the boundary cannot leave a prefix
      const TK = 'tk-' + tag + '-' + 'w'.repeat(40);
      fs.writeFileSync(path.join(J.STATE, 'server.token'), TK + '\n');
      const sc = M.scrubAll('a'.repeat(3990) + TK).slice(0, 4000);
      fs.rmSync(path.join(J.STATE, 'server.token'), { force: true });
      check('round 6: scrubAll hides the owner token before the caller clips', !sc.includes(TK.slice(0, 10)) && sc.endsWith('[secret]'), sc.slice(-30));
      check('round 6: a secret with trailing whitespace is hidden whole', !M.scrubAll('r ' + SE + '\n').includes('rotated-out'));
    }
    // ---- security round 6: the guard process
    {
      const gdir = path.join(tmp, 'guard6'); fs.mkdirSync(gdir, { recursive: true });
      const GS = path.join(gdir, 'state'), GL = path.join(gdir, 'logs');
      const G6 = `g6-${tag}-guard6-secret-value-abcdef`;
      const gm = mod(N('z'), `{ contract: 1, name: '${N('z')}', settings: { tok: { type: 'secret', description: 't' } },
        beforeTool: async ({ ti }) => { if (ti.command === 'late-50') setTimeout(() => { throw new Error('x'); }, 50); return null; },
        on: { 'tool.done': async ({ secret }) => { setTimeout(() => { throw new Error('boom ' + secret('tok')); }, 0); await new Promise(r => setTimeout(r, 40)); } } }`);
      const env0 = { ...process.env, HARNESS_STATE_DIR: GS, HARNESS_LOG_DIR: GL };
      delete env0.HARNESS_TASK_ID;
      const cfg = path.join(gdir, 'c.json'); fs.writeFileSync(cfg, JSON.stringify({ owner_name: 'Tester', modules: { [gm]: true } }));
      spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'secret', gm, 'tok'], { env: { ...env0, HARNESS_CONFIG: cfg }, input: G6, encoding: 'utf8' });
      const run = (input, args = []) => spawnSync(process.execPath, [path.join(ROOT, 'guards', 'guard.js'), ...args], { env: { ...env0, HARNESS_CONFIG: cfg }, input, encoding: 'utf8', timeout: 30000 });
      const call = c => JSON.stringify({ tool_name: 'Bash', tool_input: { command: c }, tool_response: {} });
      check('round 6 guard: a hook throw 50 ms after it returned null still blocks (exit 2)', run(call('late-50')).status === 2);
      check('round 6 guard: a plain allow still exits 0', run(call('ls')).status === 0);
      const ar = run(call('ls'), ['--after']);
      check('round 6 guard: --after with an async throw exits 0 and prints no secret', ar.status === 0 && !ar.stderr.includes(G6) && !/boom/.test(ar.stderr), String(ar.status) + ar.stderr);
    }
  } catch (e) { check('no exception', false, e.stack); }
  finally {
    for (const d of DIRS) fs.rmSync(d, { recursive: true, force: true });
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* an owner-only file the OS will not drop yet */ }
  }
  check('nothing left under modules/', !DIRS.some(d => fs.existsSync(d)));
  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  process.exit(n === results.length ? 0 : 1);
})();
