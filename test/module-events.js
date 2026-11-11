#!/usr/bin/env node
'use strict';
// Module contract 1, the parts past S0's first cut (docs/MODULES.md):
//  - async hooks: a slow beforeTool is a "module_timeout" block, a fast one passes
//  - dependsOn: load order, ctx.api scoping, missing / off / cycle are load errors,
//    and no module file requires another module's folder (static scan)
//  - events: core events reach on[...] in load order, after the journal write; a
//    throwing or rejecting handler is reported and never stops the rest; ctx.emit
//    only under the module's own name or a declared prefix
//  - ctx.state: lazy dir under state/m/<name>/, append() tags records with the module
//  - secret settings: never in config, never in any listing, owner-only file
//  - a legacy contract-0 module loads with a printed warning
// Temp modules go under modules/zz-ev-*, removed at the end. Runs in any mode.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-events-'));
const STATE = path.join(tmp, 'state');
process.env.HARNESS_STATE_DIR = STATE; // before the journal is required
delete process.env.HARNESS_TASK_ID;
const ROOT = path.resolve(__dirname, '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));
const tag = crypto.randomBytes(3).toString('hex');
const N = s => `zz-ev-${s}-${tag}`;
const DIRS = [];
const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };

const mod = (name, body) => {
  const d = path.join(M.DIR, name);
  DIRS.push(d);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'index.js'), `'use strict';\nmodule.exports = ${body};\n`);
  return name;
};
const cfgFile = (n, obj) => { const f = path.join(tmp, n + '.json'); fs.writeFileSync(f, JSON.stringify({ owner_name: 'Tester', ...obj })); return f; };
const env = (cfg, extra = {}) => {
  const e = { ...process.env, HARNESS_CONFIG: cfg, HARNESS_STATE_DIR: STATE, HARNESS_LOG_DIR: path.join(tmp, 'logs'), ...extra };
  delete e.HARNESS_OWNER; delete e.HARNESS_TASK_DIR; delete e.HARNESS_VOICE;
  if (!extra.HARNESS_TASK_ID) delete e.HARNESS_TASK_ID;
  return e;
};
const quiet = async fn => { const w = process.stderr.write; const out = []; process.stderr.write = s => { out.push(String(s)); return true; }; try { return [await fn(), out.join('')]; } finally { process.stderr.write = w; } };
const mods = (cfg, names) => { const r = M.load(cfg); return [r, r.mods.map(m => m.name).filter(n => !names || names.includes(n))]; };

(async () => {
  try {
    // ---- static scan: no module reaches into another module's folder
    const cross = [];
    const scan = (dir, owner) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') scan(p, owner); continue; }
        if (!/\.(c|m)?js$/.test(e.name)) continue;
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/(?:require\s*\(\s*|import\s*\(\s*|from\s+)['"](\.{1,2}\/[^'"]*)['"]/g)) {
          const target = path.resolve(path.dirname(p), m[1]);
          const rel = path.relative(M.DIR, target);
          if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // outside modules/: lib/, etc.
          const into = rel.split(path.sep)[0];
          if (into !== owner) cross.push(`${path.relative(ROOT, p)} -> ${m[1]}`);
        }
      }
    };
    for (const e of fs.readdirSync(M.DIR, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('zz-')) scan(path.join(M.DIR, e.name), e.name);
    check('static scan: no module requires another module\'s folder (use dependsOn + ctx.api)', cross.length === 0, cross.join(', '));

    // ---- async beforeTool + timeout
    const slow = mod(N('slow'), `{ contract: 1, name: '${N('slow')}', beforeTool: () => new Promise(r => setTimeout(() => r(null), 400)) }`);
    const fast = mod(N('fast'), `{ contract: 1, name: '${N('fast')}', beforeTool: async ({ ti }) => { await new Promise(r => setTimeout(r, 5)); return /nope/.test(ti.command) ? ['fast_block', 'async no'] : null; } }`);
    let [r] = mods({ modules: { [fast]: true }, modules_hook_timeout_ms: 150 });
    check('fast async beforeTool passes', (await M.beforeTool(r.mods, { tool: 'Bash', ti: { command: 'echo ok' } })) === null);
    const fb = await M.beforeTool(r.mods, { tool: 'Bash', ti: { command: 'nope' } });
    check('fast async beforeTool can block', fb && fb[0] === 'fast_block', JSON.stringify(fb));
    [r] = mods({ modules: { [fast]: true, [slow]: true }, modules_hook_timeout_ms: 150 });
    const t0 = Date.now();
    const sb = await M.beforeTool(r.mods, { tool: 'Bash', ti: { command: 'echo ok' } });
    check('slow async beforeTool is blocked as module_timeout', sb && sb[0] === 'module_timeout' && sb[1].includes(slow) && Date.now() - t0 < 390, JSON.stringify(sb));
    const badT = M.load({ modules: { [fast]: true }, modules_hook_timeout_ms: 0 });
    check('bad modules_hook_timeout_ms is a config error', badT.errors.some(e => /modules_hook_timeout_ms/.test(e)), badT.errors.join(' | '));
    const cs = cfgFile('slow', { modules: { [slow]: true }, modules_hook_timeout_ms: 100 });
    const g = spawnSync(process.execPath, [path.join(ROOT, 'guards', 'guard.js')], { input: JSON.stringify({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'echo hi' }, cwd: tmp }), env: env(cs), encoding: 'utf8' , windowsHide: true });
    check('real guard: slow module blocks (module_timeout), exit 2', g.status === 2 && /BLOCKED \(module_timeout\)/.test(g.stderr), g.stderr.trim().split('\n')[0]);

    // ---- dependsOn
    const base = mod(N('base'), `{ contract: 1, name: '${N('base')}', priority: 50, api: { hi: () => 'from base' } }`);
    const user = mod(N('user'), `{ contract: 1, name: '${N('user')}', priority: 0, dependsOn: ['${base}'],
      beforeTool({ ti, api }) { if (ti.command === 'peek') return ['peek', api('${base}').hi()]; if (ti.command === 'sneak') api('${fast}'); return null; } }`);
    [r] = mods({ modules: { [user]: true, [base]: true, [fast]: true } });
    const order = r.mods.map(m => m.name);
    check('load order: dependency first despite priority, then priority, then config order', r.errors.length === 0 && order.join() === [fast, base, user].join() , order.join());
    const pk = await M.beforeTool(r.mods, { tool: 'Bash', ti: { command: 'peek' } });
    check('ctx.api reaches a module listed in dependsOn', pk && pk[1] === 'from base', JSON.stringify(pk));
    const sn = await M.beforeTool(r.mods, { tool: 'Bash', ti: { command: 'sneak' } });
    check('ctx.api refuses a module not in dependsOn (fail closed)', sn && sn[0] === 'module' && /without listing it in dependsOn/.test(sn[1]), JSON.stringify(sn));
    let e = M.load({ modules: { [user]: true } });
    check('missing dependency is a load error', e.mods.length === 0 && e.errors.some(x => x.startsWith(`${user}: depends on "${base}"`) && /not in config/.test(x)), e.errors.join(' | '));
    e = M.load({ modules: { [user]: true, [base]: false } });
    check('disabled dependency is a load error', e.mods.length === 0 && e.errors.some(x => /depends on .* which is off/.test(x)), e.errors.join(' | '));
    const top = mod(N('top'), `{ contract: 1, name: '${N('top')}', dependsOn: ['${user}'] }`);
    e = M.load({ modules: { [top]: true, [user]: true, [base]: false } });
    check('a dependent of a dropped module is dropped too', e.mods.length === 0 && e.errors.some(x => x.startsWith(`${top}: depends on "${user}"`)), e.errors.join(' | '));
    const ca = N('ca'), cb = N('cb');
    mod(ca, `{ contract: 1, name: '${ca}', dependsOn: ['${cb}'] }`);
    mod(cb, `{ contract: 1, name: '${cb}', dependsOn: ['${ca}'] }`);
    e = M.load({ modules: { [ca]: true, [cb]: true, [fast]: true } });
    check('dependency cycle is a load error; other modules still load', e.mods.map(m => m.name).join() === fast && e.errors.some(x => x.includes(`dependency cycle: ${ca} -> ${cb} -> ${ca}`)), e.errors.join(' | '));

    // ---- optionalDependsOn (modules change only at restart: load() builds peers once, there is no reload path)
    const opt = N('opt');
    mod(opt, `{ contract: 1, name: '${opt}', priority: 0, optionalDependsOn: ['${base}'],
      beforeTool({ ti, api }) { if (ti.command === 'opt') { const b = api('${base}'); return ['opt', b ? b.hi() : 'null']; } if (ti.command === 'sneak') api('${fast}'); return null; } }`);
    [r] = mods({ modules: { [opt]: true } });
    let op = await M.beforeTool(r.mods, { tool: 'Bash', ti: { command: 'opt' } });
    check('optionalDependsOn: dep off -> module loads without error, ctx.api returns null', r.errors.length === 0 && r.mods.length === 1 && op && op[1] === 'null', JSON.stringify(op) + r.errors.join(' | '));
    [r] = mods({ modules: { [opt]: true, [base]: true } });
    op = await M.beforeTool(r.mods, { tool: 'Bash', ti: { command: 'opt' } });
    check('optionalDependsOn: dep on -> loaded after it, ctx.api works', r.errors.length === 0 && r.mods.map(m => m.name).join() === [base, opt].join() && op && op[1] === 'from base', JSON.stringify(op) + r.mods.map(m => m.name));
    const sn2 = await M.beforeTool(r.mods, { tool: 'Bash', ti: { command: 'sneak' } });
    check('optionalDependsOn: a name in neither list still throws', sn2 && /without listing it in dependsOn/.test(sn2[1]), JSON.stringify(sn2));
    const both = N('both');
    mod(both, `{ contract: 1, name: '${both}', dependsOn: ['${base}'], optionalDependsOn: ['${base}'] }`);
    e = M.load({ modules: { [both]: true, [base]: true } });
    check('optionalDependsOn: a name in both lists is a load error', e.errors.some(x => x.startsWith(`${both}:`) && /both/.test(x)), e.errors.join(' | '));
    const oa = N('oa'), ob = N('ob');
    mod(oa, `{ contract: 1, name: '${oa}', optionalDependsOn: ['${ob}'] }`);
    mod(ob, `{ contract: 1, name: '${ob}', dependsOn: ['${oa}'] }`);
    e = M.load({ modules: { [oa]: true, [ob]: true } });
    check('optionalDependsOn: a cycle through an optional dep is a load error', e.errors.some(x => /dependency cycle/.test(x)), e.errors.join(' | '));

    // ---- events
    const seen = [];
    global.__zzSeen = seen;
    const ea = mod(N('ea'), `{ contract: 1, name: '${N('ea')}', priority: 1, emits: ['zzthing'],
      on: { 'task.start': (p) => { global.__zzSeen.push('a:' + p.task_id); try { p.task_id = 'changed'; } catch {} },
            '${N('eb')}.ping': async (p, ctx) => { global.__zzSeen.push('a got ping ' + p.n); } },
      commands: { zzemit: async (args, ctx) => {
        const out = [];
        for (const ev of args) { try { await ctx.emit(ev, { n: 1 }); out.push(ev + ':ok'); } catch (e) { out.push(ev + ':' + e.message); } }
        return out;
      } } }`);
    const eb = mod(N('eb'), `{ contract: 1, name: '${N('eb')}', priority: 2,
      on: { 'task.start': () => { throw new Error('boom'); }, 'task.end': async () => { throw new Error('async boom'); },
            'zzthing.x': async (p, ctx) => { global.__zzSeen.push('b got zzthing'); await ctx.emit('${N('eb')}.ping', { n: 2 }); } } }`);
    const ec = mod(N('ec'), `{ contract: 1, name: '${N('ec')}', priority: 3,
      on: { 'task.start': (p, ctx) => { global.__zzSeen.push('c:' + p.task_id); ctx.state.append({ type: 'saw_start', task_id: p.task_id }); }, 'task.end': () => { global.__zzSeen.push('c:end'); } } }`);
    [r] = mods({ modules: { [ec]: true, [eb]: true, [ea]: true } });
    check('event modules load', r.errors.length === 0, r.errors.join(' | '));
    let [res, err] = await quiet(() => M.emit(r.mods, 'task.start', { task_id: 'T1' }));
    check('task.start reaches handlers in load order; payload is frozen per handler', seen.join() === 'a:T1,c:T1', seen.join());
    check('a throwing handler is reported and the next handler still runs', res.errors.length === 1 && res.errors[0].includes(`${eb} on task.start failed: boom`) && err.includes('boom'), res.errors.join(' | '));
    seen.length = 0;
    [res] = await quiet(() => M.emit(r.mods, 'task.end', { task_id: 'T1' }));
    check('a rejecting handler is reported and never breaks the others', seen.join() === 'c:end' && res.errors.length === 1 && /async boom/.test(res.errors[0]), seen.join());
    seen.length = 0;
    const out = await M.commands(r.mods).zzemit(['zzthing.x', `${ea}.hello`, 'task.start', 'tool.done', `${eb}.ping`, 'nodot']);
    check('ctx.emit: declared prefix and own name are delivered (nested emits too)', out[0] === 'zzthing.x:ok' && out[1] === `${ea}.hello:ok` && seen.join() === 'b got zzthing,a got ping 2', out.join(' | ') + ' / ' + seen.join());
    check('ctx.emit: core prefixes and other modules\' names are refused', /may emit only/.test(out[2]) && /may emit only/.test(out[3]) && /may emit only/.test(out[4]) && /prefix\.name/.test(out[5]), out.slice(2).join(' | '));
    e = M.load({ modules: { [mod(N('rs'), `{ contract: 1, name: '${N('rs')}', emits: ['task'] }`)]: true } });
    check('emits may not claim a core prefix', e.mods.length === 0 && /core's/.test(e.errors.join()), e.errors.join(' | '));
    e = M.load({ modules: { [ea]: true, [mod(N('cl'), `{ contract: 1, name: '${N('cl')}', emits: ['zzthing'] }`)]: true } });
    check('two modules may not claim one prefix', e.errors.some(x => /already declared by module/.test(x)), e.errors.join(' | '));
    e = M.load({ modules: { [mod(N('old'), `{ contract: 1, name: '${N('old')}', onTaskEnd() {} }`)]: true } });
    check('contract 1 rejects onTaskEnd with a pointer to on', e.mods.length === 0 && /on: \{"task\.end": fn\}/.test(e.errors.join()), e.errors.join(' | '));

    // events in real processes: task.start after engine_start, tool.done from guard --after
    const ev = mod(N('ev'), `{ contract: 1, name: '${N('ev')}',
      on: {
        'task.start': (p, { state }) => { const J = require(${JSON.stringify(path.join(ROOT, 'lib', 'journal'))}); state.append({ type: 'saw', ev: 'task.start', task_id: p.task_id, after_engine_start: J.readAll().records.some(r => r.type === 'engine_start' && r.task_id === p.task_id) }); },
        'task.end': (p, { state }) => { state.append({ type: 'saw', ev: 'task.end', task_id: p.task_id, code: p.code }); },
        'tool.done': (p, { state }) => { state.append({ type: 'saw', ev: 'tool.done', tool: p.tool, task_id: p.task_id }); } } }`);
    const ce = cfgFile('ev', { modules: { [ev]: true } });
    fs.mkdirSync(path.join(tmp, 'w'), { recursive: true });
    const run = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'start', 'events task', '--workdir', path.join(tmp, 'w')],
      { env: env(ce, { HARNESS_ENGINE_SCRIPT: path.join(ROOT, 'test', 'fake-engine.js'), HARNESS_FAKE_DELAY_MS: '0', HARNESS_FAKE_HOOKS: '1' }), encoding: 'utf8', timeout: 60000 , windowsHide: true });
    const saw = J.readAll().records.filter(x => x.type === 'saw' && x.module === ev);
    const st = saw.find(x => x.ev === 'task.start'), en = saw.find(x => x.ev === 'task.end');
    check('real run: task.start fires after the engine_start journal write', run.status === 0 && st && st.after_engine_start === true && st.task_id, `exit ${run.status} ${JSON.stringify(saw)} ${run.stderr.trim().split('\n').slice(-1)[0] || ''}`);
    check('real run: task.end fires with the exit code', en && en.task_id === st.task_id && en.code === 0, JSON.stringify(en));
    const tdRec = J.readAll().records.find(x => x.type === 'tool_done' && x.task_id === st.task_id);
    check('real run: the generated settings carry a PostToolUse hook, so tool_done is journaled (ok, durationMs, tool_use_id)', tdRec && tdRec.ok === true && tdRec.tool_use_id === 'toolu_fake1' && Number.isFinite(tdRec.durationMs), JSON.stringify(tdRec));
    const tdEv = saw.find(x => x.ev === 'tool.done' && x.task_id === st.task_id);
    check('real run: a module on handler sees tool.done from the engine hook', !!tdEv && tdEv.tool === 'Bash', JSON.stringify(saw));
    const ga = spawnSync(process.execPath, [path.join(ROOT, 'guards', 'guard.js'), '--after'], { input: JSON.stringify({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'echo hi' }, cwd: tmp }), env: env(ce, { HARNESS_TASK_ID: 'T9' }), encoding: 'utf8' , windowsHide: true });
    const td = J.readAll().records.find(x => x.type === 'saw' && x.ev === 'tool.done' && x.task_id === 'T9');
    check('real guard --after: tool.done reaches the module, exit 0', ga.status === 0 && td && td.tool === 'Bash' && td.task_id === 'T9', `exit ${ga.status} ${JSON.stringify(td)}`);

    // ---- ctx.state
    const sm = mod(N('st'), `{ contract: 1, name: '${N('st')}', commands: { zzstate: (a, { state }) => ({ dir: state.dir, rec: state.append({ type: 'note_x', v: 1 }), bad: (() => { try { state.append({ type: 'y', module: 'other' }); return 'no throw'; } catch (e) { return e.message; } })(), untyped: (() => { try { state.append({ v: 1 }); return 'no throw'; } catch (e) { return e.message; } })() }) } }`);
    [r] = mods({ modules: { [sm]: true } });
    const sdir = path.join(STATE, 'm', sm);
    const existedBefore = fs.existsSync(sdir);
    const so = await M.commands(r.mods).zzstate([]);
    check('ctx.state.dir is state/m/<name>/, created on first use', !existedBefore && so.dir === sdir && fs.statSync(sdir).isDirectory(), so.dir);
    check('ctx.state.append writes a journal record tagged with the module', so.rec.module === sm && so.rec.type === 'note_x' && so.rec.id && J.readAll().records.some(x => x.id === so.rec.id));
    check('ctx.state.append refuses another module\'s tag and untyped records', /must be/.test(so.bad) && /"type"/.test(so.untyped), `${so.bad} | ${so.untyped}`);

    // ---- secrets
    const SECRET = `s3cr3t-${tag}-value`;
    const sec = mod(N('sec'), `{ contract: 1, name: '${N('sec')}',
      settings: { token: { type: 'secret', description: 'test token' }, label: { type: 'string', default: 'x', description: 'a label' } },
      routes: [{ method: 'GET', path: '/t', description: 'has token?', handler: ({ secret }) => ({ status: 200, json: { len: secret('token') ? secret('token').length : 0 } }) }],
      commands: { zzsecret: (a, { secret }) => secret('token') } }`);
    const secKey = M.sectionKey(sec);
    e = M.load({ modules: { [sec]: true }, [secKey]: { token: 'inline-value' } });
    const em = e.errors.join(' | ');
    check('an inline secret in config is a load error that says where it goes', e.mods.length === 0 && em.includes(`config "${secKey}.token" is a secret and must not be in the config file`) && em.includes(`bin/harness.js secret ${sec} token`) && !em.includes('inline-value'), em);
    e = M.load({ modules: { [mod(N('sd'), `{ contract: 1, name: '${N('sd')}', settings: { k: { type: 'secret', default: 'x', description: 'k' } } }`)]: true } });
    check('a secret setting may not have a default', e.mods.length === 0 && /default/.test(e.errors.join()), e.errors.join(' | '));
    let reg = M.registry({ modules: { [sec]: true } });
    check('unset secret: settings show "missing", the module sees null', reg.errors.length === 0 && reg.settingsFor(sec).token === 'missing' && (await M.commands(reg.mods).zzsecret([])) === null, JSON.stringify(reg.settingsFor(sec)));
    const cset = cfgFile('sec', { modules: { [sec]: true } });
    const agent = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'secret', sec, 'token'], { input: SECRET + '\n', env: env(cset, { HARNESS_TASK_ID: 'T1' }), encoding: 'utf8' , windowsHide: true });
    check('the secret verb refuses inside an agent task', agent.status !== 0 && !fs.existsSync(M.secretsFile(sec)), agent.stderr.trim());
    const set = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'secret', sec, 'token'], { input: SECRET + '\n', env: env(cset), encoding: 'utf8' , windowsHide: true });
    const sf = M.secretsFile(sec);
    check('harness secret <module> <key> stores it under state/secrets/, not in config', set.status === 0 && fs.existsSync(sf) && JSON.parse(fs.readFileSync(sf, 'utf8')).token === SECRET && !fs.readFileSync(cset, 'utf8').includes(SECRET), (set.stdout + set.stderr).trim());
    if (process.platform === 'win32') {
      const acl = spawnSync('icacls', [sf], { encoding: 'utf8', windowsHide: true }).stdout;
      const aces = acl.split(/\r?\n/).map(l => l.replace(sf, '').trim()).filter(l => /:\(/.test(l));
      check('secrets file is owner-only (one ACE, nothing inherited)', aces.length === 1 && !/\(I\)/.test(acl), aces.join(' ; '));
    } else {
      check('secrets file is owner-only (mode 600, dir 700)', (fs.statSync(sf).mode & 0o777) === 0o600 && (fs.statSync(path.dirname(sf)).mode & 0o777) === 0o700);
    }
    reg = M.registry({ modules: { [sec]: true } });
    check('set secret: the module sees the value', (await M.commands(reg.mods).zzsecret([])) === SECRET && (await reg.callRoute(reg.findRoute('GET', `/m/${sec}/t`), { actor: { kind: 'owner', id: 'test' } })).json.len === SECRET.length);
    const listings = JSON.stringify([reg.listRoutes(), reg.listPanels(), reg.listJobs(), reg.modules(), reg.settingsFor(sec), reg.listCommands()]);
    check('the value is in no listing: routes, panels, jobs, modules, settings', !listings.includes(SECRET) && reg.settingsFor(sec).token === 'configured' && reg.modules().find(m => m.name === sec).secrets.token === 'configured', listings.slice(0, 160));
    const status = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'status'], { env: env(cset), encoding: 'utf8' , windowsHide: true });
    check('the value is not printed by status', !(status.stdout + status.stderr).includes(SECRET));
    spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'secret', sec, 'token'], { input: '', env: env(cset), encoding: 'utf8' , windowsHide: true });
    check('an empty value removes the secret', M.registry({ modules: { [sec]: true } }).settingsFor(sec).token === 'missing');

    // ---- legacy contract 0
    const v0 = mod(N('v0'), `{ name: '${N('v0')}', contract: 0, beforeTool() { return null; }, onTaskStart() {} }`);
    const gv = spawnSync(process.execPath, [path.join(ROOT, 'guards', 'guard.js')], { input: JSON.stringify({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'echo hi' }, cwd: tmp }), env: env(cfgFile('v0', { modules: { [v0]: true } })), encoding: 'utf8' , windowsHide: true });
    check('a contract-0 module still loads, with a printed warning', gv.status === 0 && gv.stderr.includes(`module ${v0} uses legacy contract 0`), gv.stderr.trim());
    const nc = mod(N('nc'), `{ name: '${N('nc')}', beforeTool() { return null; } }`);
    const gn = spawnSync(process.execPath, [path.join(ROOT, 'guards', 'guard.js')], { input: JSON.stringify({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'echo hi' }, cwd: tmp }), env: env(cfgFile('nc', { modules: { [nc]: true } })), encoding: 'utf8' , windowsHide: true });
    check('a manifest without a contract field is refused', gn.stderr.includes(`module ${nc} has no contract field; add "contract": 2`), gn.stderr.trim());
    const inRepo = fs.readdirSync(M.DIR).filter(n => !n.startsWith('zz-') && fs.existsSync(path.join(M.DIR, n, 'index.js')));
    const legacy = inRepo.filter(n => require(path.join(M.DIR, n, 'index.js')).contract !== 2);
    check('every in-repo module sets contract 2', legacy.length === 0, legacy.join(', '));
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
