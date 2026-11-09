#!/usr/bin/env node
'use strict';
// goals: store rules (goal card, confirm, lesson status), routes and their access, prepareTurn,
// the agent-side guard, the shell commands in real processes, off-by-default. Temp state dir only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-'));
const STATE = path.join(tmp, 'state');
process.env.HARNESS_STATE_DIR = STATE;
for (const k of ['HARNESS_TASK_ID', 'HARNESS_TASK_DIR', 'HARNESS_NOW']) delete process.env[k];
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));
const S = require('../store');

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info ? ': ' + info : ''}`); };
const OWNER = { kind: 'owner', id: '' }, WORKER = { kind: 'worker', id: 'w' }, ANON = { kind: 'anonymous', id: '' };
const WEEKMS = 7 * 86400000;
const T0 = Date.parse('2030-01-07T12:00:00Z'); // a Monday

(async () => {
  try {
    // ---- off by default
    const off = M.registry({ modules: { goals: false } });
    check('off: nothing registered', off.errors.length === 0 && !off.listRoutes().some(r => r.module === 'goals') && !off.listCommands().includes('goal') && off.settingsFor('goals') === null);
    check('absent from config: not loaded', !M.registry({ modules: {} }).listRoutes().some(r => r.module === 'goals'));
    const offCtx = await M.prepareTurn(off.mods, { task_id: 't0' });
    check('off: prepareTurn adds nothing', offCtx.context.length === 0);

    const reg = M.registry({ modules: { goals: true }, goals: { stale_window_weeks: 2, max_lessons_in_prompt: 3 } });
    check('on: loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    check('settings merge', JSON.stringify(reg.settingsFor('goals')) === '{"stale_window_weeks":2,"max_lessons_in_prompt":3,"max_replaced_goals":50,"max_lessons":200,"max_repeats_per_lesson":100}');
    check('wrong setting type is a load error', M.registry({ modules: { goals: true }, goals: { stale_window_weeks: 'x' } }).errors.length === 1);
    check('unknown setting is a load error', M.registry({ modules: { goals: true }, goals: { nope: 1 } }).errors.length === 1);
    const routes = reg.listRoutes().filter(r => r.module === 'goals');
    check('8 routes, all owner access', routes.length === 8 && routes.every(r => (r.access || 'owner') === 'owner'), routes.map(r => r.method + r.path).join());
    check('commands goal and lesson listed', reg.listCommands().includes('goal') && reg.listCommands().includes('lesson'));

    const call = (method, p, o = {}) => {
      const f = reg.findRoute(method, '/m/goals' + p);
      return f ? reg.callRoute(f, { actor: OWNER, body: o.body, query: {}, ...o }) : Promise.resolve({ status: 'nomatch' });
    };

    // ---- goal: set, interview, confirm gate
    let r = await call('GET', '/goal');
    check('no goal: null card and the first question', r.status === 200 && r.json.goal === null && r.json.questions.length === 1);
    r = await call('POST', '/goal', { body: { verbatim: '  Make the login page faster  ' } });
    const g1 = r.json.goal;
    check('set stores the words (trimmed) unconfirmed', r.status === 201 && g1.verbatim === 'Make the login page faster' && g1.confirmed === false && r.json.questions.length === 3);
    r = await call('POST', '/goal/confirm');
    check('confirm refused while done / out of scope are missing', r.status === 409 && /done/.test(r.json.error));
    r = await call('PATCH', '/goal', { body: { done: 'p95 under 300 ms in the load test' } });
    check('edit adds done', r.status === 200 && r.json.goal.done.includes('300 ms'));
    r = await call('POST', '/goal/confirm');
    check('confirm still refused without out of scope', r.status === 409);
    r = await call('PATCH', '/goal', { body: { out_of_scope: 'no design changes' } });
    r = await call('POST', '/goal/confirm');
    check('confirm works once complete', r.status === 200 && r.json.goal.confirmed === true && !!r.json.goal.confirmed_at);
    r = await call('GET', '/goal');
    check('card has no open questions', r.json.questions.length === 0);
    r = await call('PATCH', '/goal', { body: { done: 'p95 under 200 ms' } });
    check('an edit clears the confirmation', r.json.goal.confirmed === false && r.json.goal.confirmed_at === null);
    r = await call('PATCH', '/goal', { body: {} });
    check('edit with nothing is 400', r.status === 400);
    await call('POST', '/goal/confirm');

    // ---- validation
    const bads = [{}, { verbatim: '' }, { verbatim: 5 }, { verbatim: 'x'.repeat(2001) }, { verbatim: 'a\u0000b' }, { verbatim: 'ok', done: 5 }, { verbatim: 'ok', out_of_scope: 'x'.repeat(1001) }];
    const results2 = [];
    for (const b of bads) results2.push((await call('POST', '/goal', { body: b })).status);
    check(`set rejects ${bads.length} malformed bodies`, results2.every(s => s === 400), results2.join());
    check('a bad set leaves the active goal alone', (await call('GET', '/goal')).json.goal.goal_id === g1.goal_id);
    check('non-object body is 400', (await call('POST', '/goal', { body: 'x' })).status === 400);

    // ---- replace and close
    r = await call('POST', '/goal', { body: { verbatim: 'Second goal', done: 'd', out_of_scope: 'o' } });
    const g2 = r.json.goal;
    const data = S.load(path.join(STATE, 'm', 'goals'));
    check('a new goal replaces the old one (one active)', data.goals.filter(g => g.state === 'active').length === 1 && data.goals.find(g => g.goal_id === g1.goal_id).state === 'replaced');
    r = await call('POST', '/goal/close', { body: { how: 'dropped' } });
    check('close drops the goal', r.status === 200 && r.json.goal.state === 'dropped' && g2.goal_id === r.json.goal.goal_id);
    check('no active goal after close', (await call('GET', '/goal')).json.goal === null && (await call('POST', '/goal/confirm')).status === 404);

    // ---- access
    for (const [who, label] of [[WORKER, 'worker'], [ANON, 'anonymous']]) {
      const res = [];
      for (const [m, p] of [['GET', '/goal'], ['POST', '/goal'], ['POST', '/goal/confirm'], ['GET', '/lessons'], ['POST', '/lessons']]) res.push((await call(m, p, { actor: who, body: { verbatim: 'x' } })).status);
      check(`${label} gets 403 on every route`, res.every(s => s === 403), res.join());
    }

    // ---- lessons
    const L = { what: 'Changed a config file I was told not to touch', missed_by: 'diff-scope check', fix: 'list changed files before finishing' };
    const badL = [{}, { ...L, what: '' }, { ...L, missed_by: undefined }, { ...L, fix: 5 }, { ...L, what: 'x'.repeat(501) }];
    const sts = [];
    for (const b of badL) sts.push((await call('POST', '/lessons', { body: b })).status);
    check('lesson needs what, missed_by and fix', sts.every(s => s === 400), sts.join());
    r = await call('POST', '/lessons', { body: L });
    const l1 = r.json.lesson;
    check('lesson added: new, zero repeats', r.status === 201 && l1.status === 'new' && l1.repeat_count === 0 && /^l-[0-9a-f]{12}$/.test(l1.lesson_id));
    r = await call('POST', `/lessons/${l1.lesson_id}/repeat`);
    check('repeat counts', r.status === 200 && r.json.lesson.repeat_count === 1 && Object.values(r.json.lesson.weekly).reduce((a, b) => a + b, 0) === 1);
    check('repeat of unknown / odd id is 404', (await call('POST', '/lessons/l-000000000000/repeat')).status === 404 && (await call('POST', '/lessons/nope/repeat')).status === 404);
    check('list shows the lesson', (await call('GET', '/lessons')).json.lessons.length === 1);

    // ---- lesson status over time (pure; the clock is passed in)
    const mk = (createdWeeksAgo, repeatsWeeksAgo) => ({ lesson_id: 'l-x', what: 'w', missed_by: 'm', fix: 'f', created_at: new Date(T0 - createdWeeksAgo * WEEKMS).toISOString(), repeats: repeatsWeeksAgo.map(w => new Date(T0 - w * WEEKMS).toISOString()) });
    const st = (l, w = 2) => S.status(l, w, T0);
    check('status: younger than two windows is new', st(mk(3, [0.5, 1])) === 'new');
    check('status: repeats dropped (2 then 1) is kept', st(mk(6, [2.5, 3, 0.5])) === 'kept');
    check('status: repeats dropped to zero is kept', st(mk(6, [2.5, 3])) === 'kept');
    check('status: never repeated is kept', st(mk(6, [])) === 'kept');
    check('status: same count is stale', st(mk(6, [2.5, 0.5])) === 'stale');
    check('status: repeats grew is stale', st(mk(6, [3, 0.5, 1])) === 'stale');
    check('status: repeats only now (none before) is stale', st(mk(6, [0.5])) === 'stale');
    check('status: window setting changes the verdict', st(mk(5, [0.5]), 2) === 'stale' && st(mk(5, [0.5]), 3) === 'new');
    check('weekly counts group by Monday', (() => { const w = S.weekly(mk(6, [0.1, 0.2, 1.5])); return Object.values(w).reduce((a, b) => a + b, 0) === 3 && Object.keys(w).every(k => new Date(k + 'T00:00:00Z').getUTCDay() === 1); })());
    check('weekStart: Sunday belongs to the week before, Monday starts a new one', S.weekStart(Date.parse('2030-01-06T23:59:59Z')) === '2029-12-31' && S.weekStart(Date.parse('2030-01-07T00:00:00Z')) === '2030-01-07');

    // ---- the clock seam makes status visible through the routes
    const at = w => { process.env.HARNESS_NOW = String(T0 + w * WEEKMS); };
    at(0);
    const l2 = (await call('POST', '/lessons', { body: { ...L, what: 'Clocked lesson' } })).json.lesson;
    at(2.5); await call('POST', `/lessons/${l2.lesson_id}/repeat`);
    at(5);
    const view = async id => (await call('GET', '/lessons')).json.lessons.find(x => x.lesson_id === id);
    check('route: one old repeat, none recent: kept', (await view(l2.lesson_id)).status === 'kept');
    at(4.5); await call('POST', `/lessons/${l2.lesson_id}/repeat`); at(5);
    const v2 = await view(l2.lesson_id);
    check('route: a recent repeat as well: stale', v2.status === 'stale' && v2.repeat_count === 2 && Object.keys(v2.weekly).length === 2, JSON.stringify(v2));
    delete process.env.HARNESS_NOW;

    // ---- prepareTurn
    await call('POST', '/goal', { body: { verbatim: 'Ship the report', done: 'a PDF in out/', out_of_scope: 'no new charts' } });
    let pc = await M.prepareTurn(reg.mods, { task_id: 'tA' });
    let txt = pc.context.map(c => c.text).join('\n');
    check('prepareTurn: card says unconfirmed with the words', pc.errors.length === 0 && txt.includes('Ship the report') && txt.includes('NOT confirmed') && txt.includes('a PDF in out/'), txt);
    check('prepareTurn: lesson included', txt.includes('diff-scope check') && txt.includes('list changed files'));
    await call('POST', '/goal/confirm');
    pc = await M.prepareTurn(reg.mods, { task_id: 'tA' });
    check('prepareTurn: confirmed card says so', pc.context[0].text.includes('confirmed by the owner') && !pc.context[0].text.includes('NOT confirmed'));
    // stale lessons are left out; the cap keeps the newest
    const dir = path.join(STATE, 'm', 'goals');
    const d = S.load(dir);
    const old = new Date(Date.now() - 12 * WEEKMS).toISOString();
    d.lessons = [{ lesson_id: 'l-aaaaaaaaaaaa', what: 'STALE-ONE', missed_by: 'm', fix: 'f', created_at: old, repeats: [new Date(Date.now() - 1000).toISOString()] }];
    for (let i = 0; i < 5; i++) d.lessons.push({ lesson_id: 'l-bbbbbbbbbbb' + i, what: 'LIVE-' + i, missed_by: 'm', fix: 'f', created_at: new Date().toISOString(), repeats: [] });
    S.save(dir, d);
    txt = (await M.prepareTurn(reg.mods, { task_id: 'tA' })).context.map(c => c.text).join('\n');
    check('prepareTurn: stale lesson left out, cap of 3 keeps the newest', !txt.includes('STALE-ONE') && !txt.includes('LIVE-1') && txt.includes('LIVE-2') && txt.includes('LIVE-4'), txt);
    fs.rmSync(dir, { recursive: true, force: true });
    check('prepareTurn: empty store adds nothing', (await M.prepareTurn(reg.mods, { task_id: 'tA' })).context.length === 0);

    // ---- no automatic capture: no event handlers, and nothing is written by task events
    check('module has no event handlers', !reg.mods.find(m => m.name === 'goals').on);
    await M.emit(reg.mods, 'task.start', { task_id: 'tz', request: 'SECRET-REQUEST-TEXT', workdir: tmp, resumed: false }).catch(() => {});
    check('task.start writes no rows', !fs.existsSync(path.join(dir, 'data.json')));

    // ---- journal holds metadata only, never the texts
    await call('POST', '/goal', { body: { verbatim: 'PRIVATE-WORDS-123', done: 'd', out_of_scope: 'o' } });
    const jr = J.readAll().records.filter(x => x.module === 'goals');
    check('journal has goal records without the texts', jr.length > 0 && jr.every(x => !JSON.stringify(x).includes('PRIVATE-WORDS-123')));
    check('data file is not world-readable text in the journal path', fs.existsSync(path.join(dir, 'data.json')));

    // ---- status lines
    await call('POST', '/lessons', { body: L });
    const sl = (await M.statusLines(reg.mods, J)).join('|');
    check('status lines show the goal and lessons', sl.includes('goal: PRIVATE-WORDS-123') && sl.includes('NOT confirmed') && sl.includes('lessons: '), sl);

    // ---- guard
    const guard = (tool, command, env) => { const old = process.env.HARNESS_TASK_ID; if (env) process.env.HARNESS_TASK_ID = 't1'; else delete process.env.HARNESS_TASK_ID; return M.beforeTool(reg.mods, { tool, ti: { command }, input: {} }).finally(() => { if (old === undefined) delete process.env.HARNESS_TASK_ID; else process.env.HARNESS_TASK_ID = old; }); };
    check('guard: agent confirm blocked', !!(await guard('Bash', 'node bin/harness.js goal confirm', true)));
    check('guard: agent lesson add blocked', !!(await guard('Bash', 'dantomation lesson add "x" --missed y --fix z', true)));
    check('guard: agent server call blocked', !!(await guard('Bash', 'curl http://127.0.0.1:1/m/goals/goal', true)));
    check('guard: agent goal show allowed', (await guard('Bash', 'dantomation goal show', true)) === null);
    check('guard: owner (no task) allowed', (await guard('Bash', 'dantomation goal confirm', false)) === null);

    // ---- commands in real processes
    const cfgFile = path.join(tmp, 'cfg.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ modules: { goals: true } }));
    const st2 = path.join(tmp, 'state2');
    const env = { ...process.env, HARNESS_CONFIG: cfgFile, HARNESS_STATE_DIR: st2, HARNESS_LOG_DIR: path.join(tmp, 'logs'), HARNESS_WORK_DIR: tmp };
    delete env.HARNESS_TASK_ID; delete env.HARNESS_NOW;
    const run = (verb, args, extra = {}) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), verb, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
    let p = run('goal', ['show']);
    check('cmd goal show with none', p.status === 0 && /no active goal/.test(p.stdout), p.stdout + p.stderr);
    p = run('goal', ['set', 'Tidy the inbox', '--done', 'zero unread older than 7 days']);
    check('cmd goal set prints the card and the open question', p.status === 0 && /Tidy the inbox/.test(p.stdout) && /out of scope/i.test(p.stdout) && /NOT confirmed/.test(p.stdout), p.stdout + p.stderr);
    p = run('goal', ['confirm']);
    check('cmd goal confirm refused without out of scope (exit 3)', p.status === 3 && /out of scope/i.test(p.stderr), p.stdout + p.stderr);
    p = run('goal', ['edit', '--out', 'do not delete mail']);
    p = run('goal', ['confirm']);
    check('cmd goal confirm works', p.status === 0 && /confirmed by the owner/.test(p.stdout), p.stdout + p.stderr);
    p = run('goal', ['interview']);
    check('cmd goal interview: complete', p.status === 0 && /complete and confirmed/.test(p.stdout), p.stdout);
    p = run('goal', ['confirm'], { HARNESS_TASK_ID: 'task-x' });
    check('cmd goal confirm inside a task exits 6', p.status === 6, p.stdout + p.stderr);
    p = run('goal', ['show'], { HARNESS_TASK_ID: 'task-x' });
    check('cmd goal show inside a task is allowed', p.status === 0 && /Tidy the inbox/.test(p.stdout), p.stdout + p.stderr);
    p = run('goal', ['bogus']);
    check('cmd goal bogus exits 2 with usage', p.status === 2 && /usage/.test(p.stderr));
    p = run('goal', ['set', 'a', 'b']);
    check('cmd goal set with two texts exits 2', p.status === 2);
    p = run('lesson', ['add', 'Skipped the tests', '--missed', 'no test gate']);
    check('cmd lesson add without --fix exits 3', p.status === 3 && /fix is required/.test(p.stderr), p.stdout + p.stderr);
    p = run('lesson', ['add', 'Skipped the tests', '--missed', 'no test gate', '--fix', 'run tests before done']);
    check('cmd lesson add', p.status === 0 && /added l-[0-9a-f]{12}/.test(p.stdout), p.stdout + p.stderr);
    const lid = (p.stdout.match(/l-[0-9a-f]{12}/) || [])[0];
    p = run('lesson', ['repeat', lid]);
    check('cmd lesson repeat', p.status === 0 && /counted a repeat/.test(p.stdout), p.stdout + p.stderr);
    p = run('lesson', ['list']);
    check('cmd lesson list shows status and weekly counts', p.status === 0 && p.stdout.includes(lid) && /\[new\]/.test(p.stdout) && /repeats 1/.test(p.stdout), p.stdout);
    p = run('lesson', ['add', 'x', '--missed', 'y', '--fix', 'z'], { HARNESS_TASK_ID: 'task-x' });
    check('cmd lesson add inside a task exits 6', p.status === 6);
    p = run('lesson', ['repeat', 'nope']);
    check('cmd lesson repeat with a bad id exits 2', p.status === 2);
    p = run('lesson', ['repeat', 'l-000000000000']);
    check('cmd lesson repeat unknown id exits 3', p.status === 3);

    // ---- breaker mutex: stale-lock break never removes a fresh successor's lock
    {
      const dir = fs.mkdtempSync(path.join(tmp, 'brk-')); const lf = path.join(dir, 'lock'); const brk = lf + '.break';
      const o = { staleMs: 50, waitMs: 150, transient: new Set(['EPERM', 'EACCES', 'EBUSY']), sleepMs: ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), busyError: () => new Error('busy') };
      const old = new Date(Date.now() - 20000);
      fs.writeFileSync(lf, 'dead.token'); fs.utimesSync(lf, old, old);
      let fired = 0, busy = false;
      const hooks = { afterSeen() { if (fired++) return; fs.unlinkSync(lf); fs.writeFileSync(lf, 'fresh.live'); } };
      try { S.lockAcquire(lf, { ...o, staleMs: 5000, hooks: { afterSeen: hooks.afterSeen } }); } catch (e) { busy = /busy/.test(e.message); }
      // lock is not stale at staleMs 5000 once replaced, so this alone proves little; do the real race below
      fs.writeFileSync(lf, 'dead.token'); fs.utimesSync(lf, old, old); fired = 0;
      busy = false; let got = null;
      try { got = S.lockAcquire(lf, { ...o, hooks: { afterSeen() { if (fired++) return; fs.unlinkSync(lf); fs.writeFileSync(lf, 'fresh.live'); const f = new Date(Date.now() + 60000); fs.utimesSync(lf, f, f); } } }); } catch (e) { busy = /busy/.test(e.message); }
      check('breaker: fresh lock that replaced the stale one between read and break survives', busy && got === null && fs.readFileSync(lf, 'utf8') === 'fresh.live' && !fs.existsSync(brk));
      fs.unlinkSync(lf);
      fs.writeFileSync(lf, 'dead.token'); fs.utimesSync(lf, old, old);
      fs.writeFileSync(brk, ''); // a live breaker holds the mutex: we must not break the lock
      busy = false; try { S.lockAcquire(lf, o); } catch (e) { busy = /busy/.test(e.message); }
      check('breaker: a fresh .break file blocks breaking', busy && fs.readFileSync(lf, 'utf8') === 'dead.token' && fs.existsSync(brk));
      fs.utimesSync(brk, old, old); // abandoned breaker older than 10 s
      const tk = S.lockAcquire(lf, o);
      check('breaker: a .break file older than 10 s is cleared and the stale lock is then broken', fs.readFileSync(lf, 'utf8') === tk && !fs.existsSync(brk));
      S.lockRelease(lf, tk);
      check('breaker: no leftovers', fs.readdirSync(dir).length === 0, fs.readdirSync(dir).join());
      fs.writeFileSync(lf, 'mine');
      check('lockHeld: true for own token, false after loss', S.lockHeld(lf, 'mine') && (fs.writeFileSync(lf, 'other'), !S.lockHeld(lf, 'mine')));
      {
        const gd = fs.mkdtempSync(path.join(tmp, 'gl-')); let thrown = false;
        try { S.update(gd, () => { fs.writeFileSync(path.join(gd, 'lock'), 'usurper'); return {}; }); } catch (e) { thrown = /lock was lost/.test(e.message); }
        check('lock lost before the write: throws and writes nothing', thrown && !fs.existsSync(path.join(gd, 'data.json')));
      }
    }

    // ---- review fixes: lock ownership and retention
    {
      const dir = path.join(tmp, 'lk'); fs.mkdirSync(dir, { recursive: true });
      const lf = path.join(dir, 'lock');
      const o = { staleMs: 50, waitMs: 150, transient: new Set(['EPERM', 'EACCES', 'EBUSY']), sleepMs: ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), busyError: () => new Error('busy') };
      const a = S.lockAcquire(lf, o);
      let busy = false; try { S.lockAcquire(lf, { ...o, staleMs: 60000 }); } catch (e) { busy = e.message === 'busy'; }
      check('lock: fresh lock is not taken; busy at the wait limit', busy && fs.readFileSync(lf, 'utf8') === a);
      const old = new Date(Date.now() - 5000); fs.utimesSync(lf, old, old);
      const b = S.lockAcquire(lf, o);
      S.lockRelease(lf, a);
      check('lock: stale lock broken; old holder cannot remove the successor lock', b !== a && fs.readFileSync(lf, 'utf8') === b);
      S.lockRelease(lf, b);
      check('lock: holder release removes its lock', !fs.existsSync(lf) && fs.readdirSync(dir).length === 0);
    }
    {
      const d = { goals: [], lessons: [] };
      const ret = { max_replaced_goals: 2, max_lessons: 3, max_repeats_per_lesson: 4 };
      for (let i = 0; i < 6; i++) S.setGoal(d, { verbatim: 'goal ' + i }, ret);
      check('retention: replaced goals capped, active kept, newest kept', d.goals.length === 3 && d.goals.filter(g => g.state === 'active').length === 1 && d.goals[0].verbatim === 'goal 3' && d.goals[2].verbatim === 'goal 5');
      const dd = { goals: [], lessons: [] };
      for (let i = 0; i < 80; i++) S.setGoal(dd, { verbatim: 'g' + i });
      check('retention: default keeps 50 replaced goals', dd.goals.length === 51);
      const l = { goals: [], lessons: [] };
      const old = new Date(Date.now() - 20 * WEEKMS).toISOString();
      const mk = (id, created, repeats) => ({ lesson_id: id, what: 'w', missed_by: 'm', fix: 'f', created_at: created, repeats });
      const recent = new Date().toISOString();
      l.lessons.push(mk('l-old-kept', old, []), mk('l-old-stale', old, [recent]), mk('l-new', recent, []));
      S.addLesson(l, { what: 'w', missed_by: 'm', fix: 'f' }, ret, 2);
      const ids = l.lessons.map(x => x.lesson_id);
      check('retention: over the lesson cap the stale one goes first, the added one stays', l.lessons.length === 3 && !ids.includes('l-old-stale') && ids.includes('l-old-kept') && ids.includes('l-new'), ids.join());
      S.addLesson(l, { what: 'w2', missed_by: 'm', fix: 'f' }, ret, 2);
      check('retention: then the oldest of the rest', l.lessons.length === 3 && !l.lessons.some(x => x.lesson_id === 'l-old-kept'));
      const r = S.addLesson({ goals: [], lessons: [] }, { what: 'w', missed_by: 'm', fix: 'f' });
      const dl = { goals: [], lessons: [r.lesson] };
      for (let i = 0; i < 7; i++) S.repeatLesson(dl, r.lesson.lesson_id, ret);
      check('retention: repeat timestamps capped per lesson', dl.lessons[0].repeats.length === 4);
      for (let i = 0; i < 150; i++) S.repeatLesson(dl, r.lesson.lesson_id);
      check('retention: default keeps 100 repeats', dl.lessons[0].repeats.length === 100);
      const s = M.registry({ modules: { goals: true } }).settingsFor('goals');
      check('retention settings declared with defaults', s.max_replaced_goals === 50 && s.max_lessons === 200 && s.max_repeats_per_lesson === 100);
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  const failed = results.filter(x => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('crash:', e); process.exit(1); });
