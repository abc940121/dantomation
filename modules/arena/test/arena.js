#!/usr/bin/env node
'use strict';
// arena: worktrees, runs, judge, tests, keep, route, journal. No network, no real engine:
// the runner, judge, test runner and asker are stubs. Uses a temp git repo.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state'); // before the journal is required
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));
const A = require('../core');

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

function mkRepo(name) {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q');
  git(d, 'config', 'user.email', 'a@example.invalid'); git(d, 'config', 'user.name', 'tester');
  fs.writeFileSync(path.join(d, 'f.txt'), 'one\n');
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'init');
  return d;
}
const wtCount = d => git(d, 'worktree', 'list').trim().split('\n').length - 1;
const owner = { kind: 'owner', id: '' };

// stub deps: A appends a line to f.txt, B adds a new file
function deps(over = {}) {
  const calls = [];
  return Object.assign({
    calls,
    runTask: async (prompt, o) => {
      calls.push({ prompt, dir: o.dir, variant: o.variant });
      if (o.variant === 'A') fs.appendFileSync(path.join(o.dir, 'f.txt'), 'two\n'); else fs.writeFileSync(path.join(o.dir, 'g.txt'), 'new\n');
    },
    judge: async () => '{"winner":"A","reasons":["smaller diff","same behaviour"]}',
    runTests: async () => true,
  }, over);
}
const mkctx = (dir, settings, log) => ({ dir, settings: { engines: '', judge_engine: '', test_cmd: '', diff_cap: 12000, ...settings }, log: log || (() => {}) });

(async () => {
  try {
    // off by default
    const off = M.registry({ modules: {} });
    check('off by default: no command, no route', !off.listCommands().includes('arena') && !off.listRoutes().some(r => r.path.startsWith('/m/arena')));
    const reg = M.registry({ modules: { arena: true } });
    check('on: loads clean, route listed', reg.errors.length === 0 && reg.listRoutes().map(r => `${r.method} ${r.path}`).includes('GET /m/arena/runs') && reg.listCommands().includes('arena'), reg.errors.join('|'));

    // two worktrees, both runs called, in order
    const repo = mkRepo('r1'), sd = path.join(tmp, 'sd1'); fs.mkdirSync(sd);
    const d = deps();
    let mid = null;
    const d1 = deps({ runTask: async (p, o) => { if (o.variant === 'B') mid = wtCount(repo); return d.runTask(p, o); } });
    d1.calls = d.calls;
    const run = await A.start(mkctx(sd), d1, 'add two', { dir: repo });
    check('two worktrees were made', mid === 2 && fs.existsSync(run.worktrees.A) && fs.existsSync(run.worktrees.B), String(mid));
    check('both runs called, A then B, with different instructions', d.calls.length === 2 && d.calls[0].variant === 'A' && d.calls[1].variant === 'B' && d.calls[0].prompt !== d.calls[1].prompt && d.calls[0].dir !== d.calls[1].dir);
    check('judge JSON parsed', run.winner === 'A' && run.reasons[0] === 'smaller diff' && run.state === 'decided');

    // bad judge output
    check('bad judge: not json -> tie', A.parseJudge('sorry, A is nicer').winner === 'tie' && !A.parseJudge('x').judged);
    check('bad judge: wrong winner / broken json -> tie', A.parseJudge('{"winner":"C"}').winner === 'tie' && A.parseJudge('{"winner":').winner === 'tie');
    check('judge wrapped in prose still parses', A.parseJudge('Here: {"winner":"B","reasons":["x"]} done').winner === 'B');
    const sd2 = path.join(tmp, 'sd2'); fs.mkdirSync(sd2);
    const repo2 = mkRepo('r2');
    const rb = await A.start(mkctx(sd2), deps({ judge: async () => { throw new Error('boom'); } }), 'x', { dir: repo2 });
    check('judge throwing -> tie, run still decided', rb.winner === 'tie' && rb.state === 'decided' && /judge failed/.test(rb.reasons[0]));
    A.keep(mkctx(sd2), rb.id, 'none');

    // tests outrank judge (judge says A, tests: A fail B pass)
    const sd3 = path.join(tmp, 'sd3'); fs.mkdirSync(sd3);
    const repo3 = mkRepo('r3');
    const rt = await A.start(mkctx(sd3, { test_cmd: 'x' }), deps({ runTests: async dir => fs.existsSync(path.join(dir, 'g.txt')) }), 'x', { dir: repo3 });
    check('tests outrank the judge', rt.winner === 'B' && rt.tests.A === 'fail' && rt.tests.B === 'pass' && /tests pass in B/.test(rt.reasons[0]), JSON.stringify(rt.tests));
    check('question text names the tests', /A fail, B pass/.test(A.questionText(rt)) && A.questionText(rt).length <= 500);
    A.keep(mkctx(sd3), rt.id, 'none');

    // no answer changes nothing
    check('no answer: target untouched, both worktrees kept', fs.readFileSync(path.join(repo, 'f.txt'), 'utf8') === 'one\n' && wtCount(repo) === 2 && A.load(sd, run.id).kept === null);

    // keep refuses on dirty target
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x');
    const rd = A.keep(mkctx(sd), run.id, 'A');
    check('keep refuses on a dirty target, changes nothing', !rd.ok && /uncommitted/.test(rd.error) && wtCount(repo) === 2 && fs.readFileSync(path.join(repo, 'f.txt'), 'utf8') === 'one\n');
    fs.unlinkSync(path.join(repo, 'dirty.txt'));

    // keep A applies the patch, removes worktrees, journals
    const logs = [];
    const ra = A.keep(mkctx(sd, {}, r => logs.push(r)), run.id, 'A');
    check('keep A applies the patch', ra.ok && fs.readFileSync(path.join(repo, 'f.txt'), 'utf8').split(String.fromCharCode(13)).join('') === 'one\ntwo\n' && !fs.existsSync(path.join(repo, 'g.txt')));
    check('keep A removes both worktrees', wtCount(repo) === 0 && !fs.existsSync(run.worktrees.A) && !fs.existsSync(run.worktrees.B));
    check('keep records kept and journals it', A.load(sd, run.id).kept === 'A' && logs.length === 1 && logs[0].kind === 'arena' && logs[0].kept === 'A');
    check('a settled run cannot be kept again', !A.keep(mkctx(sd), run.id, 'B').ok);

    // keep none removes worktrees, applies nothing
    const rn = await A.start(mkctx(sd), deps(), 'again', { dir: repo });
    const before = git(repo, 'status', '--porcelain');
    const kn = A.keep(mkctx(sd), rn.id, 'none');
    check('keep none removes worktrees, target unchanged', kn.ok && wtCount(repo) === 0 && git(repo, 'status', '--porcelain') === before && A.load(sd, rn.id).kept === 'none');
    git(repo, 'checkout', '-q', '--', '.'); // f.txt from keep A stays committed? restore state
    check('bad choice refused', !A.keep(mkctx(sd), rn.id, 'Z').ok && !A.keep(mkctx(sd), 'nope', 'A').ok);

    // question card: asked, answer maps to keep
    const asked = [];
    const sd4 = path.join(tmp, 'sd4'); fs.mkdirSync(sd4);
    const repo4 = mkRepo('r4');
    const rq = await A.start(mkctx(sd4), deps({ ask: async (text, opts) => { asked.push({ text, opts }); return 'q-abc123'; } }), 'x', { dir: repo4 });
    check('question-card asked with three options', asked.length === 1 && asked[0].opts.join() === 'Keep A,Keep B,Keep neither' && /^Arena: A \(smallest\) vs B \(cleanest\)/.test(asked[0].text) && rq.question_id === 'q-abc123' && rq.state === 'asked');

    // through the registry: command, journal, route, event answer
    const sdReg = path.join(tmp, 'sdReg'); fs.mkdirSync(sdReg);
    const repo5 = mkRepo('r5');
    const reg2 = M.registry({ modules: { arena: true, 'question-cards': false } });
    reg2.api('arena').inject(() => deps({ ask: async () => 'q-feed01' }));
    const out = []; const log = console.log; console.log = s => out.push(String(s));
    try { await M.commands(reg2.mods).arena(['add', 'two', '--dir', repo5], {}); } finally { console.log = log; }
    const line = out.find(x => /^arena a/.test(x)) || '';
    const rid = (/^arena (a[0-9a-f]{10})/.exec(line) || [])[1];
    check('command ran and printed the result', !!rid && /judge picks A/.test(line), line);
    check('journal line {kind:"arena", id, engines, winner, tests, kept}', J.readAll().records.some(x => x.kind === 'arena' && x.id === rid && Array.isArray(x.engines) && x.winner === 'A' && x.tests && x.kept === null && x.module === 'arena'));
    const r200 = await reg2.callRoute(reg2.findRoute('GET', '/m/arena/runs'), { query: {}, actor: owner });
    check('route 200 for owner with the run', r200.status === 200 && r200.json.runs.some(r => r.id === rid), JSON.stringify(r200).slice(0, 120));
    const r403 = await reg2.callRoute(reg2.findRoute('GET', '/m/arena/runs'), { query: {}, actor: { kind: 'worker', id: 'w' } });
    const r403b = await reg2.callRoute(reg2.findRoute('GET', '/m/arena/runs'), { query: {}, actor: { kind: 'anonymous', id: '' } });
    check('route 403 for non-owners', r403.status === 403 && r403b.status === 403, `${r403.status} ${r403b.status}`);
    await M.emit(reg2.mods, 'question.answered', { question_id: 'q-other', choice: 1 });
    check('an unrelated answer changes nothing', wtCount(repo5) === 2);
    await M.emit(reg2.mods, 'question.answered', { question_id: 'q-feed01', choice: 2, option: 'Keep B' });
    check('answering Keep B applies B and journals kept', wtCount(repo5) === 0 && fs.existsSync(path.join(repo5, 'g.txt')) && J.readAll().records.some(x => x.kind === 'arena' && x.id === rid && x.kept === 'B'));
    const bad = await reg2.callRoute(reg2.findRoute('GET', '/m/arena/runs'), { query: {}, actor: owner });
    check('route shows kept', bad.json.runs.find(r => r.id === rid).kept === 'B');
    // ---- queue: an agent inside a task records a request; it starts after the executor lock is free
    const cap = async fn => { const o = [], e = []; const l = console.log, er = console.error; console.log = s => o.push(String(s)); console.error = s => e.push(String(s)); const pc = process.exitCode; try { await fn(); } finally { console.log = l; console.error = er; } const code = process.exitCode; process.exitCode = pc; return { out: o.join('\n'), err: e.join('\n'), code }; };
    const regQ = M.registry({ modules: { arena: true } });
    const api = regQ.api('arena'); const cmds = M.commands(regQ.mods);
    const kicks = []; api.injectKick(() => kicks.push(1));
    const repoQ = mkRepo('rq');
    process.env.HARNESS_TASK_ID = 't-inside';
    const noq = await cap(() => cmds.arena(['add', 'two', '--json'], {}));
    check('in a task without --queue: refused, points at --queue', noq.code === 2 && /--queue/.test(noq.err) && JSON.parse(noq.out).queued === false, noq.err);
    const q1 = await cap(() => cmds.arena(['add', 'two', '--queue', '--json', '--dir', repoQ], {}));
    const j1 = JSON.parse(q1.out);
    check('--queue in a task: recorded, json has id and position, nothing started', j1.queued === true && /^q/.test(j1.id) && j1.position === 1 && kicks.length === 0 && wtCount(repoQ) === 0, q1.out);
    const q2 = await cap(() => cmds.arena(['add', 'three', '--queue', '--json', '--dir', repoQ], {}));
    check('second queued request gets position 2', JSON.parse(q2.out).position === 2);
    delete process.env.HARNESS_TASK_ID;
    const qdir = path.join(process.env.HARNESS_STATE_DIR, 'm', 'arena');
    const qfile = () => { try { return JSON.parse(fs.readFileSync(path.join(qdir, 'queue.json'), 'utf8')); } catch { return null; } };
    check('queue is stored in module state with the task id', Array.isArray(qfile()) && qfile().length === 2 && qfile()[0].task_id === 't-inside', JSON.stringify(qfile()));
    const ql = await cap(() => cmds.arena(['queue'], {}));
    check('arena queue lists both', ql.out.split('\n').length === 2);
    await M.emit(regQ.mods, 'task.end', { task_id: 't-inside' });
    check('task.end with a non-empty queue kicks the drainer once', kicks.length === 1);
    // drain while the executor is busy: nothing starts
    const dctx = { state: { dir: qdir, append: () => {} }, settings: { engines: '', judge_engine: '', test_cmd: '', diff_cap: 12000 } };
    const ranQ = []; api.inject(() => deps({ runTask: async (p, o) => { ranQ.push(o.variant); if (o.variant === 'A') fs.appendFileSync(path.join(o.dir, 'f.txt'), 'x\n'); else fs.writeFileSync(path.join(o.dir, 'g.txt'), 'n\n'); } }));
    const busy = await api.drain(dctx, { isFree: () => false, waitMs: 30, pollMs: 10 });
    check('drain while executor busy starts nothing and keeps the queue', busy.started === 0 && busy.waited_out === true && qfile().length === 2 && ranQ.length === 0);
    // free: both start, in order, queue empties
    let polls = 0;
    const free = await api.drain(dctx, { isFree: () => ++polls > 2, waitMs: 1000, pollMs: 5 });
    check('drain once the lock is free starts every queued request (A+B each)', free.started === 2 && ranQ.length === 4 && qfile().length === 0 && polls >= 3, JSON.stringify(free));
    check('drain lock released afterwards', !fs.existsSync(path.join(qdir, 'drain.lock')));
    await M.emit(regQ.mods, 'task.end', { task_id: 't-x' });
    check('task.end with an empty queue does not kick', kicks.length === 1);
    // a second drainer is turned away
    api.enqueue(qdir, { request: 'later', dir: repoQ });
    const l = J.lock(path.join(qdir, 'drain.lock'), { pids: [process.pid], task_id: null });
    const second = await api.drain(dctx, { isFree: () => true });
    check('second drainer while one holds drain.lock: not started', second.busy === true && second.started === 0);
    J.unlock(path.join(qdir, 'drain.lock'), l.nonce);
    // queue cap
    let full = null; for (let i = 0; i < 25 && !(full && full.ok === false); i++) full = api.enqueue(qdir, { request: 'r' + i, dir: repoQ });
    check('queue is capped', full && full.ok === false && /full/i.test(full.error || ''), JSON.stringify(full));
    // outside a task --queue also works and kicks
    fs.rmSync(path.join(qdir, 'queue.json'), { force: true });
    const qo = await cap(() => cmds.arena(['add', 'four', '--queue', '--dir', repoQ], {}));
    check('--queue outside a task: queued and drainer kicked', /arena queued q/.test(qo.out) && kicks.length === 2, qo.out);

  } catch (e) { check('no exception', false, e.stack); }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } }
  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  process.exit(n === results.length ? 0 : 1);
})();
