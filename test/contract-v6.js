#!/usr/bin/env node
'use strict';
// Module contract v6 seams (docs/module-contract.md):
//   a. ctx.engines.run: only engines listed in config "engines"; timeoutMs capped; engine_call journaled without the prompt
//   b. ctx.api(dep): the peer's functions run with the peer's ctx, not the caller's
//   c. chooseEngine: load order, first non-null wins, throw/timeout/bad result count as null; engine_choice journaled
//   d. beforeReply: modify / block; failMode open (default) keeps the reply, closed blocks it, on throw and on timeout;
//      reply_hook journaled without reply text
//   e. ctx.tasks.start with workdir + forkedFrom: queue_add and task_start carry forked_from, the engine runs in workdir
//   g. chooseEngine swaps to a config-listed engine (else engine_choice_ignored); a blocked reply becomes a withheld line
//   f. everything is a no-op when no module uses a seam; contract 2 modules keep loading; contract 7 is refused
// Temp modules go under modules/zz-v6-*, removed at the end. Runs in any mode.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v6-'));
const STATE = path.join(tmp, 'state');
process.env.HARNESS_STATE_DIR = STATE; // before the journal is required
process.env.HARNESS_LOG_DIR = path.join(tmp, 'logs');
process.env.HARNESS_CONFIG = path.join(tmp, 'config.json');
delete process.env.HARNESS_TASK_ID; delete process.env.HARNESS_NO_SERVER;
const ROOT = path.resolve(__dirname, '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));
const tag = crypto.randomBytes(3).toString('hex');
const N = s => `zz-v6-${s}-${tag}`;
const DIRS = [];
const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info !== undefined ? ': ' + String(typeof info === 'string' ? info : JSON.stringify(info)).slice(0, 300) : ''}`); };
const mod = (name, body) => {
  const d = path.join(M.DIR, name);
  DIRS.push(d);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'index.js'), `'use strict';\nmodule.exports = ${body};\n`);
  return name;
};
const quiet = async fn => { const w = process.stderr.write; process.stderr.write = () => true; try { return await fn(); } finally { process.stderr.write = w; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const records = () => J.readAll().records;
const since = n => records().slice(n);
const mark = () => records().length;

// fake engines: echo prints "echo:<stdin>", slow sleeps 5 s
const echoJs = path.join(tmp, 'echo.js'), slowJs = path.join(tmp, 'slow.js');
fs.writeFileSync(echoJs, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write('echo:'+s));");
fs.writeFileSync(slowJs, "process.stdin.resume();setTimeout(()=>process.stdout.write('late'),5000);");
const ENGINES = { echo: { bin: process.execPath, args: [echoJs] }, slow: { bin: process.execPath, args: [slowJs] } };

(async () => {
  try {
    // ---- contract number
    check('trunk supports contract 7', M.CONTRACT === 7, M.CONTRACT);
    const c2 = mod(N('c2'), `{ contract: 2, name: '${N('c2')}' }`);
    const c6 = mod(N('c6'), `{ contract: 6, name: '${N('c6')}' }`);
    const c7 = mod(N('c7'), `{ contract: 7, name: '${N('c7')}' }`);
    const c8 = mod(N('c8'), `{ contract: 8, name: '${N('c8')}' }`);
    let r = M.load({ modules: { [c2]: true, [c6]: true } });
    check('contract 2 and 6 modules load', r.errors.length === 0 && r.mods.length === 2, r.errors.join(' | '));
    r = M.load({ modules: { [c7]: true } });
    check('contract 7 module loads', r.errors.length === 0 && r.mods.length === 1, r.errors.join(' | '));
    r = M.load({ modules: { [c8]: true } });
    check('contract 8 is refused', r.errors.some(e => /needs module contract 8; this core supports up to 7/.test(e)), r.errors.join(' | '));

    // ---- no-op without users
    r = M.load({ modules: { [c2]: true } });
    let n0 = mark();
    check('chooseEngine: no module has the hook -> null, nothing journaled', (await M.chooseEngine(r.mods, { task_id: 'T0' })) === null && mark() === n0);
    const same = await M.beforeReply(r.mods, 'plain', { task_id: 'T0' });
    check('beforeReply: no module has the hook -> reply unchanged, nothing journaled', same.reply === 'plain' && !same.blocked && mark() === n0);

    // ---- a. ctx.engines.run
    const ea = mod(N('ea'), `{ contract: 6, name: '${N('ea')}',
      commands: { run: async (args, ctx) => { try { const r = await ctx.engines.run(args[0], args[1], args[2] ? { timeoutMs: Number(args[2]) } : undefined); return { ok: true, ...r }; } catch (e) { return { ok: false, error: e.message, timeout: !!e.timeout }; } } } }`);
    const cfgA = { modules: { [ea]: true }, engines: ENGINES, engines_max_timeout_ms: 400 };
    r = M.load(cfgA);
    const run = (...a) => M.commands(r.mods).run(a);
    n0 = mark();
    let o = await run('echo', 'SECRETPROMPT-' + tag);
    check('engines.run: a listed engine runs and returns its output', o.ok && o.output === 'echo:SECRETPROMPT-' + tag && o.code === 0, o);
    const calls = since(n0).filter(x => x.type === 'engine_call');
    check('engine_call journaled with module, engine, ms; no prompt text', calls.length === 1 && calls[0].module === ea && calls[0].engine === 'echo' && Number.isInteger(calls[0].ms) && !JSON.stringify(since(n0)).includes('SECRETPROMPT'), calls);
    n0 = mark();
    o = await run('nope', 'x');
    check('engines.run: an unlisted engine is refused with a clear error', !o.ok && /not listed in config "engines"/.test(o.error) && since(n0).every(x => x.type !== 'engine_call'), o);
    o = await run('hasOwnProperty', 'x');
    check('engines.run: inherited object keys are not engines', !o.ok && /not listed/.test(o.error), o);
    let t0 = Date.now();
    o = await run('slow', 'x', '60000');
    let dt = Date.now() - t0;
    check('engines.run: timeoutMs is capped by config (asked 60000, cap 400)', !o.ok && o.timeout && dt < 3000, { o, dt });
    t0 = Date.now();
    o = await run('slow', 'x', '100');
    dt = Date.now() - t0;
    check('engines.run: a smaller timeoutMs is honoured', !o.ok && o.timeout && dt < 350 + 2000, { o, dt });
    o = await run('echo', 'x', '0');
    check('engines.run: a bad timeoutMs is refused', !o.ok && /timeoutMs/.test(o.error), o);
    r = M.load({ modules: { [ea]: true } });
    o = await run('echo', 'x');
    check('engines.run: with no "engines" in config nothing can run', !o.ok && /not listed/.test(o.error), o);
    const e = require(path.join(ROOT, 'lib', 'engines'));
    check('engines.run: default cap is 120000 ms', e.DEFAULT_MAX_MS === 120000 && e.maxMs({}) === 120000 && e.maxMs({ engines_max_timeout_ms: 5000 }) === 5000);

    // ---- b. peer api runs with the peer's ctx
    const bB = N('pb');
    mod(bB, `{ contract: 6, name: '${bB}', settings: { tag: { type: 'string', description: 'tag', default: 'tag-of-B' } },
      api: { tag() { return this.ctx.settings.tag; }, viaThis() { return this.tag(); }, plain: () => 'plain', n: 7 } }`);
    const aA = N('pa');
    mod(aA, `{ contract: 6, name: '${aA}', dependsOn: ['${bB}'], settings: { tag: { type: 'string', description: 'tag', default: 'tag-of-A' } },
      commands: { peer: async (args, ctx) => { const b = ctx.api('${bB}'); return { own: ctx.settings.tag, viaPeer: b.tag(), viaThis: b.viaThis(), plain: b.plain(), n: b.n }; } } }`);
    r = M.load({ modules: { [aA]: true, [bB]: true } });
    check('peer modules load', r.errors.length === 0, r.errors.join(' | '));
    o = await M.commands(r.mods).peer([]);
    check('ctx.api(dep): the peer function sees the peer\'s ctx (not the caller\'s)', o.own === 'tag-of-A' && o.viaPeer === 'tag-of-B', o);
    check('ctx.api(dep): this-calls inside the peer api, plain functions and values still work', o.viaThis === 'tag-of-B' && o.plain === 'plain' && o.n === 7, o);
    check('registry.api (core) is unchanged: the raw api object', typeof M.registry({ modules: { [bB]: true } }).api(bB).tag === 'function');

    // ---- c. chooseEngine
    const ch = (s, body, pri) => mod(N(s), `{ contract: 6, name: '${N(s)}', priority: ${pri}, chooseEngine: ${body} }`);
    const cNull = ch('cn', '() => null', 1), cThrow = ch('ct', '() => { throw new Error("boom"); }', 2),
      cSlow = ch('cs', '() => new Promise(res => setTimeout(() => res("too-late"), 1500))', 3),
      cBad = ch('cb', '() => 42', 4), cX = ch('cx', '(turn) => turn.task_id === "TX" ? "engine-x" : null', 5), cY = ch('cy', '() => "engine-y"', 6);
    r = M.load({ modules: { [cNull]: true, [cThrow]: true, [cSlow]: true, [cBad]: true, [cX]: true, [cY]: true } });
    n0 = mark(); t0 = Date.now();
    let pick = await quiet(() => M.chooseEngine(r.mods, { task_id: 'TX' }));
    dt = Date.now() - t0;
    check('chooseEngine: null, throw, timeout and bad result are skipped; first non-null wins (load order)', pick && pick.engine === 'engine-x' && pick.module === cX, pick);
    check('chooseEngine: each call is time-bounded (slow module cut at ~200 ms)', dt < 1200, dt);
    const ec = since(n0).filter(x => x.type === 'engine_choice');
    const by = m => ec.find(x => x.module === m);
    check('engine_choice journaled: error, timeout, bad_result and the choice', by(cThrow) && by(cThrow).reason === 'error' && by(cSlow).reason === 'timeout' && by(cBad).reason === 'bad_result' && by(cX).engine === 'engine-x' && by(cX).reason === 'chosen' && !by(cY), ec);
    pick = await quiet(() => M.chooseEngine(r.mods, { task_id: 'T-other' }));
    check('chooseEngine: the later module answers when the earlier ones have no opinion', pick && pick.engine === 'engine-y' && pick.module === cY, pick);
    r = M.load({ modules: { [cNull]: true, [cThrow]: true, [cSlow]: true, [cBad]: true } });
    check('chooseEngine: all null (or failing) -> null, current behaviour', (await quiet(() => M.chooseEngine(r.mods, { task_id: 'T' }))) === null);

    // ---- d. beforeReply
    const REPLY = 'REPLYTEXT-' + tag, NEW = 'MODIFIED-' + tag;
    const br = (s, body, mode) => mod(N(s), `{ contract: 6, name: '${N(s)}'${mode ? `, failMode: '${mode}'` : ''}, beforeReply: ${body} }`);
    const dMod = br('dm', `(reply) => reply.replace('REPLYTEXT', 'MODIFIED')`);
    const dBlock = br('db', `() => ({ block: true, reason: 'not allowed' })`);
    const dOpenThrow = br('dot', `() => { throw new Error('boom'); }`), dOpenSlow = br('dos', `() => new Promise(() => {})`);
    const dClThrow = br('dct', `() => { throw new Error('boom'); }`, 'closed'), dClSlow = br('dcs', `() => new Promise(() => {})`, 'closed');
    const dBad = br('dbad', `() => 12`), dClBad = br('dcbad', `() => 12`, 'closed');
    const rb = async (name, reply = REPLY) => { const m = M.load({ modules: { [name]: true }, modules_hook_timeout_ms: 100 }); n0 = mark(); const res = await quiet(() => M.beforeReply(m.mods, reply, { task_id: 'TB' })); return [res, since(n0).filter(x => x.type === 'reply_hook')]; };
    let [res, hk] = await rb(dMod);
    check('beforeReply: a returned string replaces the reply', res.reply === NEW && !res.blocked && hk[0].outcome === 'modified', res);
    [res, hk] = await rb(dBlock);
    check('beforeReply: { block: true, reason } blocks', res.blocked && /not allowed/.test(res.reason) && hk[0].outcome === 'blocked', res);
    [res, hk] = await rb(dOpenThrow);
    check('beforeReply failMode open (default): a throw keeps the original reply', !res.blocked && res.reply === REPLY && hk[0].outcome === 'error_open', { res, hk });
    [res, hk] = await rb(dOpenSlow);
    check('beforeReply failMode open: a timeout keeps the original reply', !res.blocked && res.reply === REPLY && hk[0].outcome === 'timeout_open', { res, hk });
    [res, hk] = await rb(dClThrow);
    check('beforeReply failMode closed: a throw blocks the reply', res.blocked && /fail closed/.test(res.reason) && hk[0].outcome === 'error_closed', { res, hk });
    [res, hk] = await rb(dClSlow);
    check('beforeReply failMode closed: a timeout blocks the reply', res.blocked && /timeout/.test(res.reason) && hk[0].outcome === 'timeout_closed', { res, hk });
    [res, hk] = await rb(dBad);
    check('beforeReply: a bad result follows failMode (open keeps)', !res.blocked && res.reply === REPLY && hk[0].outcome === 'error_open', { res, hk });
    [res, hk] = await rb(dClBad);
    check('beforeReply: a bad result follows failMode (closed blocks)', res.blocked, res);
    check('reply_hook journal never holds reply text', !JSON.stringify(records().filter(x => x.type === 'reply_hook')).includes('REPLYTEXT') && !JSON.stringify(records().filter(x => x.type === 'reply_hook')).includes('MODIFIED'));
    const m2 = M.load({ modules: { [dMod]: true, [dBlock]: true } });
    res = await M.beforeReply(m2.mods, REPLY, { task_id: 'TB' });
    check('beforeReply: modules run in load order on the modified reply; a later block wins', res.blocked && res.reply === NEW, res);
    const badMode = mod(N('bm'), `{ contract: 6, name: '${N('bm')}', failMode: 'maybe' }`);
    r = M.load({ modules: { [badMode]: true } });
    check('manifest failMode must be "open" or "closed"', r.errors.some(x => /failMode must be "open" or "closed"/.test(x)), r.errors.join(' | '));

    // ---- e. task fork through ctx.tasks.start
    const srvMod = N('srv');
    mod(srvMod, `{ contract: 6, name: '${srvMod}', runsOn: 'main', jobs: [{ id: 'grab', start(ctx) { global.__zzV6Tasks = ctx.tasks; return () => {}; } }] }`);
    fs.writeFileSync(process.env.HARNESS_CONFIG, JSON.stringify({ owner_name: 'Tester', modules: { [srvMod]: true }, server: { port: 0, tick_ms: 50 } }));
    process.env.HARNESS_ENGINE_SCRIPT = path.join(ROOT, 'test', 'fake-engine.js');
    process.env.HARNESS_FAKE_DELAY_MS = '0';
    process.env.HARNESS_WORK_DIR = path.join(tmp, 'work');
    delete require.cache[require.resolve(path.join(ROOT, 'lib', 'config'))];
    const server = require(path.join(ROOT, 'lib', 'server')).create();
    await server.listen();
    try {
      const tasks = global.__zzV6Tasks;
      check('ctx.tasks.start exists for modules', tasks && typeof tasks.start === 'function');
      const forkDir = path.join(tmp, 'fork-dir');
      for (const [label, bad] of [['relative workdir', { workdir: 'rel/dir' }], ['bad forkedFrom task', { forkedFrom: { task: '../x', step: 1 } }], ['bad forkedFrom step', { forkedFrom: { task: 't1', step: '; rm' } }]]) {
        let msg = null; try { await tasks.start(undefined, 'p', bad); } catch (x) { msg = x.message; }
        check(`tasks.start refuses a ${label}`, !!msg, msg);
      }
      n0 = mark();
      const made = await tasks.start(undefined, 'forked job', { workdir: forkDir, forkedFrom: { task: 't-origin', step: 3 } });
      const done = async () => { for (let i = 0; i < 300; i++) { const rs = records(); if (rs.some(x => x.type === 'task_start' && x.task_id === made.id) && rs.some(x => x.type === 'engine_exit' && x.task_id === made.id)) return true; await sleep(100); } return false; };
      check('forked task ran to engine exit', await done());
      const q = since(n0).find(x => x.type === 'queue_add' && x.task_id === made.id), ts = since(n0).find(x => x.type === 'task_start' && x.task_id === made.id);
      check('queue_add records forked_from {task, step} and workdir', q && q.forked_from && q.forked_from.task === 't-origin' && q.forked_from.step === 3 && q.workdir === forkDir, q);
      check('task_start records forked_from and runs in the given workdir', ts && ts.forked_from && ts.forked_from.task === 't-origin' && ts.forked_from.step === 3 && path.resolve(ts.workdir) === path.resolve(forkDir) && fs.existsSync(path.join(forkDir, '.git')), ts);
      const plain = await tasks.enqueue(undefined, 'plain job');
      for (let i = 0; i < 300 && !records().some(x => x.type === 'engine_exit' && x.task_id === plain.id); i++) await sleep(100);
      const pq = records().find(x => x.type === 'queue_add' && x.task_id === plain.id), pt = records().find(x => x.type === 'task_start' && x.task_id === plain.id);
      check('a plain enqueue records no forked_from or workdir (unchanged)', pq && !('forked_from' in pq) && !('workdir' in pq) && pt && !('forked_from' in pt), { pq, pt });
    } finally { await server.close(); }

    // ---- g. chooseEngine takes effect (config "engines" only); a blocked reply is a short withheld line
    const { spawnSync, execFileSync } = require('child_process');
    const resultJs = (label) => `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({type:'result',result:'${label}:'+s.length+' REPLYBODY-${tag}'})+String.fromCharCode(10)));`;
    const swapJs = path.join(tmp, 'swap.js'), defJs = path.join(tmp, 'def.js');
    fs.writeFileSync(swapJs, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write('SWAPPED:'+s.length+' REPLYBODY-"+tag+"'));");
    fs.writeFileSync(defJs, `process.stdout.write(JSON.stringify({type:'result',result:'DEFAULT REPLYBODY-${tag}'})+String.fromCharCode(10));`);
    let runN = 0;
    const turn = (cfgExtra, req = 'do a thing', engineJs = defJs) => {
      const base = path.join(tmp, 'run' + (++runN)), work = path.join(base, 'work');
      fs.mkdirSync(work, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: work });
      const cfg = path.join(base, 'config.json');
      fs.writeFileSync(cfg, JSON.stringify({ owner_name: 'Tester', ...cfgExtra }));
      const env = { ...process.env, HARNESS_STATE_DIR: path.join(base, 'state'), HARNESS_LOG_DIR: path.join(base, 'logs'), HARNESS_CONFIG: cfg, HARNESS_ENGINE_SCRIPT: engineJs, HARNESS_NO_SERVER: '1' };
      delete env.HARNESS_TASK_ID;
      const p = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'start', req, '--workdir', work], { env, encoding: 'utf8', timeout: 60000 });
      let recs = []; try { recs = fs.readFileSync(path.join(base, 'state', 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { /* none */ }
      return { p, recs, state: path.join(base, 'state'), ofType: t => recs.filter(x => x.type === t) };
    };
    const chooser = (s, nm) => mod(N(s), `{ contract: 6, name: '${N(s)}', chooseEngine: () => '${nm}' }`);
    const cSwap = chooser('cs', 'fakeswap'), cNone = chooser('cn', 'ghost'), cNoBin = chooser('cb', 'nobin');
    let t = turn({ modules: { [cSwap]: true }, engines: { fakeswap: { bin: process.execPath, args: [swapJs], turn: true } } });
    let rep = t.ofType('reply');
    check('chooseEngine swap: the configured engine is the process that ran (prompt on stdin)', rep.length === 1 && /^SWAPPED:[1-9]\d* /.test(rep[0].text), { rep, err: t.p.stderr.slice(0, 200) });
    check('chooseEngine swap: engine_used journaled, no engine_choice_ignored', t.ofType('engine_used').some(x => x.engine === 'fakeswap' && x.module === cSwap && x.task_id) && !t.ofType('engine_choice_ignored').length, t.recs.map(x => x.type));
    t = turn({ modules: { [cNone]: true }, engines: { fakeswap: { bin: process.execPath, args: [swapJs] } } });
    rep = t.ofType('reply');
    check('chooseEngine unconfigured name: default engine runs, engine_choice_ignored not_configured', rep.length === 1 && /^DEFAULT /.test(rep[0].text) && t.ofType('engine_choice_ignored').some(x => x.engine === 'ghost' && x.reason === 'not_configured') && !t.ofType('engine_used').length, { rep, types: t.recs.map(x => x.type) });
    t = turn({ modules: { [cNoBin]: true }, engines: { nobin: { args: [swapJs], turn: true } } });
    check('chooseEngine configured without a string bin: default runs, reason no_bin', /^DEFAULT /.test((t.ofType('reply')[0] || {}).text || '') && t.ofType('engine_choice_ignored').some(x => x.reason === 'no_bin'), t.recs.map(x => x.type));

    // task.end hooks run while the executor lock is still held
    {
      const wLock = mod(N('wl'), `{ contract: 6, name: '${N('wl')}', on: { 'task.end': (p) => { const st = process.env.HARNESS_STATE_DIR, fs = require('fs'), path = require('path'); fs.writeFileSync(path.join(st, 'lockseen.txt'), (fs.existsSync(path.join(st, 'executor.lock')) ? 'held' : 'free') + ':' + String(p.turn_start)); } } }`);
      t = turn({ modules: { [wLock]: true } });
      const seen = (() => { try { return fs.readFileSync(path.join(t.state, 'lockseen.txt'), 'utf8'); } catch { return 'none'; } })();
      const st = t.ofType('engine_start')[0];
      check('task.end runs while the executor lock is held, with this turn engine_start id', !!st && seen === 'held:' + st.id, seen);
    }

    // beforeReply ctx carries the final engine exit code (zero and non-zero)
    const exitJs = n => { const f = path.join(tmp, 'exit' + n + '.js'); fs.writeFileSync(f, `process.stdout.write(JSON.stringify({type:'result',result:'EXITREPLY'})+String.fromCharCode(10));process.exitCode=${n};`); return f; };
    const wCode = br('wk', `(reply, ctx) => reply + ' CODE=' + typeof ctx.code + ':' + ctx.code`);
    for (const n of [0, 3]) {
      t = turn({ modules: { [wCode]: true } }, 'do a thing', exitJs(n));
      check(`beforeReply ctx.code is the numeric engine exit code (${n})`, t.ofType('reply').length === 1 && t.ofType('reply')[0].text === `EXITREPLY CODE=number:${n}` && t.ofType('engine_exit').some(x => x.code === n), { rep: t.ofType('reply'), ex: t.ofType('engine_exit') });
    }

    const wBlock = br('wb', `() => ({ block: true, reason: 'SECRETREASON-${tag}' })`), wClosed = br('wc', `() => { throw new Error('boom'); }`, 'closed');
    for (const [label, name] of [['block', wBlock], ['fail-closed error', wClosed]]) {
      t = turn({ modules: { [name]: true } });
      rep = t.ofType('reply');
      const line = `(reply withheld by ${name})`;
      check(`beforeReply ${label}: the reply record is exactly the withheld line, nothing of the original or the reason`, rep.length === 1 && rep[0].text === line && !JSON.stringify(rep).includes('REPLYBODY') && !JSON.stringify(rep).includes('SECRETREASON') && t.ofType('reply_blocked').length === 1, { rep, types: t.recs.map(x => x.type) });
    }
    {
      const wMod = br('wm', `(reply) => reply.replace('REPLYBODY', 'REDACTED')`);
      for (const [label, name] of [['block', wBlock], ['fail-closed error', wClosed], ['modifying hook', wMod]]) {
        t = turn({ modules: { [name]: true } });
        const files = fs.readdirSync(t.state).filter(f => f.startsWith('engine-'));
        const all = files.map(f => fs.readFileSync(path.join(t.state, f), 'utf8')).join('\n');
        check(`beforeReply ${label}: no raw reply text stays in the engine output files`, files.length > 0 && !all.includes('REPLYBODY') && all.includes('withheld'), { files, all: all.slice(0, 200) });
      }
      // a descendant that outlives the engine and appends to the inherited stdout after the cleanup
      {
        const lateJs = path.join(tmp, 'late.js');
        fs.writeFileSync(lateJs, "const {spawn}=require('child_process');spawn(process.execPath,['-e',\"setTimeout(()=>process.stdout.write('LATE-REPLYBODY-" + tag + "'),1500)\"],{stdio:['ignore',1,2]}).unref();process.stdout.write(JSON.stringify({type:'result',result:'DEFAULT REPLYBODY-" + tag + "'})+String.fromCharCode(10));");
        t = turn({ modules: { [wBlock]: true } }, 'do a thing', lateJs);
        await new Promise(r => setTimeout(r, 2500));
        const lf = fs.readdirSync(t.state).filter(f => f.startsWith('engine-')).map(f => fs.readFileSync(path.join(t.state, f), 'utf8')).join(String.fromCharCode(10));
        check('beforeReply block: a descendant writing 1500 ms after the engine exit never reaches the output file', !lf.includes('REPLYBODY') && lf.includes('withheld') && t.ofType('output_withhold_failed').length === 0, lf.slice(0, 200));
      }
      // cleanup failure: recorded in the journal and warned on stderr, never silent
      process.env.HARNESS_TEST_WITHHOLD_FAIL = '1'; process.env.HARNESS_TEST = '1';
      try {
        t = turn({ modules: { [wBlock]: true } });
        const wf = t.ofType('output_withhold_failed');
        check('beforeReply block: a failed output cleanup journals output_withhold_failed (basename, code) and warns', wf.length >= 1 && wf.every(x => /^engine-.*.(jsonl|stderr)$/.test(x.file) && x.error === 'EPERM' && x.task_id) && /could not remove a withheld reply/.test(t.p.stderr), { wf, err: t.p.stderr.slice(0, 200) });
      } finally { delete process.env.HARNESS_TEST_WITHHOLD_FAIL; delete process.env.HARNESS_TEST; }
      // a plain-text turn engine's .stdout companion is cleaned too
      t = turn({ modules: { [wBlock]: true, [cSwap]: true }, engines: { fakeswap: { bin: process.execPath, args: [swapJs], turn: true } } });
      const so = fs.readdirSync(t.state).filter(f => f.startsWith('engine-')).map(f => fs.readFileSync(path.join(t.state, f), 'utf8')).join('\n');
      check('beforeReply block: the plain-text engine .stdout file holds no reply text', fs.readdirSync(t.state).some(f => f.endsWith('.stdout')) && !so.includes('REPLYBODY'), so.slice(0, 200));
    }
    res = await quiet(() => M.beforeReply(M.load({ modules: { [wBlock]: true } }).mods, REPLY, { task_id: 'TB' }));
    check('beforeReply returns the blocking module name as a field', res.blocked && res.module === wBlock, res);

    // ---- Codex review fixes
    const noOpt = turn({ modules: { [cSwap]: true }, engines: { fakeswap: { bin: process.execPath, args: [swapJs] } } });
    check('turn engine without turn:true is ignored (not_turn_engine), default runs', /^DEFAULT /.test((noOpt.ofType('reply')[0] || {}).text || '') && noOpt.ofType('engine_choice_ignored').some(x => x.reason === 'not_turn_engine') && !noOpt.ofType('engine_used').length, noOpt.recs.map(x => x.type));

    const argvJs = path.join(tmp, 'argv.js');
    fs.writeFileSync(argvJs, "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'result',result:'ARGV '+process.argv.slice(2).join(' ')})+String.fromCharCode(10)));");
    const cl = turn({ modules: { [cSwap]: true }, engines: { fakeswap: { bin: process.execPath, args: [argvJs], turn: true, format: 'claude' } } });
    const clText = (cl.ofType('reply')[0] || {}).text || '';
    check('format claude turn engine gets guard hooks and protocol, plus the allowlist and strict MCP when locked', /^ARGV /.test(clText) && ['--settings', '--append-system-prompt-file'].every(f => clText.includes(f)) && (['--allowedTools', '--strict-mcp-config'].every(f => clText.includes(f)) || /--permission-mode default/.test(clText)) && cl.ofType('engine_used').length === 1, { clText: clText.slice(0, 200), err: cl.p.stderr.slice(0, 200) });

    // full profile: one persistent Claude session per bot and workdir; locked: a fresh session each turn
    {
      const base = path.join(tmp, 'sess'), work = path.join(base, 'work');
      fs.mkdirSync(work, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: work });
      const run = (profile) => {
        const cfg = path.join(base, 'config-' + profile + '.json');
        fs.writeFileSync(cfg, JSON.stringify({ owner_name: 'Tester', engine: { profile }, modules: { [cSwap]: true }, engines: { fakeswap: { bin: process.execPath, args: [argvJs], turn: true, format: 'claude' } } }));
        const env = { ...process.env, HARNESS_STATE_DIR: path.join(base, 'state'), HARNESS_LOG_DIR: path.join(base, 'logs'), HARNESS_CONFIG: cfg, HARNESS_ENGINE_SCRIPT: defJs, HARNESS_NO_SERVER: '1' };
        delete env.HARNESS_TASK_ID; delete env.HARNESS_BOT;
        spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'start', 'session turn', '--workdir', work], { env, encoding: 'utf8', timeout: 60000 });
        const recs = fs.readFileSync(path.join(base, 'state', 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
        const tid = (recs.filter(x => x.type === 'task_start').pop() || {}).task_id;
        spawnSync(process.execPath, [path.join(ROOT, 'bin', 'effect.js'), 'task-done', tid], { env, encoding: 'utf8', timeout: 30000 });
        return { recs, argv: (recs.filter(x => x.type === 'reply').pop() || {}).text || '' };
      };
      const a = run('full'), sid = (a.argv.match(/--session-id (\S+)/) || [])[1];
      const rec = a.recs.filter(x => x.type === 'bot_session').pop();
      check('full profile: first turn starts a named session and journals it', !!sid && !!rec && rec.session_id === sid && /--permission-mode default/.test(a.argv) && !a.argv.includes('--allowedTools'), { argv: a.argv.slice(0, 300), rec });
      const b = run('full');
      check('full profile: the next turn of the same bot resumes that session', b.argv.includes('--resume ' + sid) && !b.argv.includes('--session-id') && b.recs.filter(x => x.type === 'bot_session').length === 1, b.argv.slice(0, 300));
      const c = run('locked');
      check('locked profile: no session flags, allowlist and strict MCP kept', !/--resume|--session-id/.test(c.argv) && ['--allowedTools', '--strict-mcp-config'].every(f => c.argv.includes(f)), c.argv.slice(0, 300));
      const mcpf = (a.argv.match(/--mcp-config (\S+)/) || [])[1];
      let mcp = null; try { mcp = JSON.parse(fs.readFileSync(mcpf, 'utf8')); } catch { /* checked below */ }
      const srv = mcp && mcp.mcpServers && mcp.mcpServers.taskmote;
      check('full profile: permission prompts go to our approve tool over our own MCP config', a.argv.includes('--permission-prompt-tool mcp__taskmote__approve') && !!srv && srv.args.some(x => /bin\/approve-mcp\.js$/.test(x)), { argv: a.argv.slice(0, 400), mcp });
      check('locked profile: no permission-prompt tool and no extra MCP config', !/--permission-prompt-tool|--mcp-config/.test(c.argv), c.argv.slice(0, 300));
    }

    // a hook matching only past char 4000 sees the full reply
    const longJs = path.join(tmp, 'long.js');
    fs.writeFileSync(longJs, "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('a'.repeat(4500)+'LATEMARK-" + tag + "'));");
    const wLate = br('wl', `(reply) => reply.includes('LATEMARK-${tag}') ? { block: true, reason: 'BLOCKREASON-${tag}' } : null`);
    t = turn({ modules: { [cSwap]: true, [wLate]: true }, engines: { fakeswap: { bin: process.execPath, args: [longJs], turn: true } } });
    rep = t.ofType('reply');
    check('beforeReply sees the full reply: a match past char 4000 blocks it', rep.length === 1 && rep[0].text === `(reply withheld by ${wLate})`, rep.map(x => x.text.slice(0, 60)));
    check('the journal keeps only a fixed code, never the hook reason or reply', !JSON.stringify(t.recs).includes('BLOCKREASON') && !JSON.stringify(t.recs).includes('LATEMARK') && t.ofType('reply_blocked').some(x => x.module === wLate && x.code === 'blocked'), t.recs.filter(x => /reply_/.test(x.type)));

    t = turn({ modules: { [cSwap]: true }, engines: { fakeswap: { bin: path.join(tmp, 'no-such-engine-' + tag), args: [], turn: true } } });
    const lockPath = path.join(tmp, 'run' + runN, 'state', 'executor.lock');
    check('missing engine executable: no crash, engine_error and engine_exit journaled, lock released', t.p.status !== null && t.p.signal === null && !/Unhandled|ERR_UNHANDLED/.test(t.p.stderr) && t.ofType('engine_error').length === 1 && t.ofType('engine_exit').length === 1 && !fs.existsSync(lockPath), { status: t.p.status, err: t.p.stderr.slice(0, 300), types: t.recs.map(x => x.type) });

    const plainJs = path.join(tmp, 'plain.js');
    fs.writeFileSync(plainJs, "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('NOISE');process.stdout.write('  plain answer ');});");
    t = turn({ modules: { [cSwap]: true }, engines: { fakeswap: { bin: process.execPath, args: [plainJs], turn: true } } });
    rep = t.ofType('reply');
    check('plain-text turn engine: trimmed stdout is the reply (stderr excluded)', rep.length === 1 && rep[0].text === 'plain answer', rep);

    // stderr without a trailing newline, copied before a complete stdout result line, must not corrupt the JSONL record
    const mixJs = path.join(tmp, 'mix.js');
    fs.writeFileSync(mixJs, "process.stderr.write('PARTIAL-NOISE');setTimeout(()=>{process.stdout.write(JSON.stringify({type:'result',result:'MIXED OK'})+String.fromCharCode(10));setTimeout(()=>process.stderr.write(String.fromCharCode(10)+JSON.stringify({type:'result',result:'FAKE FROM STDERR'})),50);},100);");
    t = turn({}, 'do a thing', mixJs);
    rep = t.ofType('reply');
    check('stdout and stderr interleaved: stderr can neither split the stdout result record nor supply a reply', rep.length === 1 && rep[0].text === 'MIXED OK', { rep, err: t.p.stderr.slice(0, 200) });

    // ---- Codex re-review fixes
    const wThrow = br('wt', `(reply) => { throw new Error(reply); }`), wInvalid = br('wi', `(reply) => ({ leaked: reply })`);
    for (const [label, name] of [['throw', wThrow], ['invalid result', wInvalid]]) {
      t = turn({ modules: { [name]: true } });
      check(`beforeReply ${label}: reply text appears in neither stderr nor the journal`, !t.p.stderr.includes('REPLYBODY') && !JSON.stringify(t.recs.filter(x => x.type !== 'reply')).includes('REPLYBODY') && /beforeReply hook_(error|invalid)/.test(t.p.stderr), { err: t.p.stderr.slice(0, 300) });
    }

    // lock stays held while a slow beforeReply hook runs; a concurrent resume starts no second engine
    const flag = path.join(tmp, 'hook-started');
    const wSlow = br('ws', `async () => { require('fs').writeFileSync(${JSON.stringify(flag)}, '1'); await new Promise(r => setTimeout(r, 1500)); return null; }`);
    const { spawn } = require('child_process');
    const lbase = path.join(tmp, 'lockrun'), lwork = path.join(lbase, 'work');
    fs.mkdirSync(lwork, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: lwork });
    fs.writeFileSync(path.join(lbase, 'config.json'), JSON.stringify({ owner_name: 'Tester', modules: { [wSlow]: true } }));
    const lenv = { ...process.env, HARNESS_STATE_DIR: path.join(lbase, 'state'), HARNESS_LOG_DIR: path.join(lbase, 'logs'), HARNESS_CONFIG: path.join(lbase, 'config.json'), HARNESS_ENGINE_SCRIPT: defJs, HARNESS_NO_SERVER: '1' };
    delete lenv.HARNESS_TASK_ID;
    const first = spawn(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'start', 'slow hook', '--workdir', lwork], { env: lenv, stdio: 'ignore' });
    const firstDone = new Promise(r => first.on('exit', r));
    for (let i = 0; i < 200 && !fs.existsSync(flag); i++) await sleep(50);
    const lockFile = path.join(lbase, 'state', 'executor.lock');
    const heldDuring = fs.existsSync(flag) && fs.existsSync(lockFile);
    const second = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'resume'], { env: lenv, encoding: 'utf8', timeout: 30000 });
    await firstDone;
    const lrecs = fs.readFileSync(path.join(lbase, 'state', 'journal.jsonl'), 'utf8').split(String.fromCharCode(10)).filter(Boolean).map(l => JSON.parse(l));
    check('executor lock is held through a slow beforeReply hook; a concurrent resume starts no second engine', heldDuring && lrecs.filter(x => x.type === 'engine_start').length === 1 && !fs.existsSync(lockFile), { heldDuring, starts: lrecs.filter(x => x.type === 'engine_start').length, second: second.stderr.slice(0, 200) + second.stdout.slice(0, 200) });

    // ---- f. hookTimeoutMs: per-module hook timeout and the hook time budget
    const htm = (s, extra, body) => mod(N(s), `{ contract: 6, name: '${N(s)}'${extra ? ', ' + extra : ''}, beforeTool: ${body || '() => null'} }`);
    for (const bad of ['50', '99', '1.5', "'1000'", '-5', 'null']) {
      const b = htm('hb', `hookTimeoutMs: ${bad}`);
      r = M.load({ modules: { [b]: true } });
      check(`hookTimeoutMs ${bad} is refused at load`, r.errors.some(x => /hookTimeoutMs must be a whole number of milliseconds >= 100/.test(x)) && !r.mods.length, r.errors.join(' | '));
    }
    const hSlow = htm('hs', 'hookTimeoutMs: 150', 'async () => { await new Promise(r => setTimeout(r, 1000)); return null; }');
    r = M.load({ modules: { [hSlow]: true }, modules_hook_timeout_ms: 5000 });
    t0 = Date.now();
    let hit = await M.beforeTool(r.mods, { tool: 'Bash', ti: {} });
    check('hookTimeoutMs: a beforeTool slower than the declared timeout times out (fail closed)', hit && hit[0] === 'module_timeout' && /150 ms/.test(hit[1]) && Date.now() - t0 < 900, { hit, dt: Date.now() - t0 });
    const hCap = htm('hc', 'hookTimeoutMs: 4000', 'async () => { await new Promise(r => setTimeout(r, 800)); return null; }');
    r = M.load({ modules: { [hCap]: true }, modules_hook_timeout_ms: 200 });
    hit = await M.beforeTool(r.mods, { tool: 'Bash', ti: {} });
    check('hookTimeoutMs: a declared value above the global one is capped by the global', hit && hit[0] === 'module_timeout' && /200 ms/.test(hit[1]), hit);
    const hNone = htm('hn', '', 'async () => { await new Promise(r => setTimeout(r, 300)); return null; }');
    r = M.load({ modules: { [hNone]: true }, modules_hook_timeout_ms: 5000 });
    hit = await M.beforeTool(r.mods, { tool: 'Bash', ti: {} });
    check('hookTimeoutMs: undeclared keeps the global timeout', hit === null, hit);
    const askM = htm('ka', '', "() => ['ask:install', 'installs software']");
    const allowM = htm('kl', '', "() => ['allow:card', 'approved on card card-000000']");
    const blockM = htm('kb', '', "() => ['bad', 'blocked']");
    r = M.load({ modules: { [askM]: true } });
    hit = await M.beforeTool(r.mods, { tool: 'Bash', ti: {} });
    check('ask alone: the chain asks', hit && hit[0] === 'ask:install', hit);
    r = M.load({ modules: { [askM]: true, [allowM]: true } });
    hit = await M.beforeTool(r.mods, { tool: 'Bash', ti: {} });
    check('allow: answers an earlier ask (owner approved this exact call)', hit === null, hit);
    r = M.load({ modules: { [allowM]: true, [askM]: true } });
    hit = await M.beforeTool(r.mods, { tool: 'Bash', ti: {} });
    check('allow: answers a later ask too', hit === null, hit);
    r = M.load({ modules: { [askM]: true, [allowM]: true, [blockM]: true } });
    hit = await M.beforeTool(r.mods, { tool: 'Bash', ti: {} });
    check('allow: never answers a block', hit && hit[0] === 'bad', hit);
    const twelve = (k, extra) => Object.fromEntries(Array.from({ length: 12 }, (_, i) => [htm(`${k}${i}`, extra), true]));
    r = M.load({ modules: twelve('b1', 'hookTimeoutMs: 1000') });
    check('hook budget: 12 modules declaring 1000 ms load fine', !r.errors.length && r.mods.length === 12, r.errors.join(' | '));
    r = M.load({ modules: twelve('b2', '') });
    check('hook budget: 12 modules at the default 5000 ms fail (60000 ms)', r.errors.some(x => /hook time budget/.test(x)) && /60000 ms/.test(r.errors.join(' ')), r.errors.join(' | '));
    r = M.load({ modules: twelve('b3', 'hookTimeoutMs: 9000'), modules_hook_timeout_ms: 1000 });
    check('hook budget: the effective timeout is min(declared, global)', !r.errors.length && r.mods.length === 12, r.errors.join(' | '));
  } catch (err) {
    check('suite ran without crashing', false, err && err.stack || String(err));
  } finally {
    for (const d of DIRS) fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const bad = results.filter(x => !x).length;
  console.log(`${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})();
