#!/usr/bin/env node
'use strict';
// task-watchdog: detection, flag, optional cancel, routes. In-process, fresh temp state dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-watchdog-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const owner = { kind: 'owner', id: 'test' };
const P = '/m/task-watchdog';

(async () => {
  try {
    const off = M.registry({ modules: { 'task-watchdog': false } });
    check('off: nothing registered', !off.listRoutes().length && !off.listJobs().length && off.settingsFor('task-watchdog') === null);

    const cancelled = [];
    const tasks = { cancel: async id => { cancelled.push(id); }, enqueue: async () => {}, get: async () => {} };
    const mk = (extra = {}, t = tasks) => M.registry({ modules: { 'task-watchdog': true }, task_watchdog: extra }, { tasks: t });
    let reg = mk();
    check('on: loads clean', reg.errors.length === 0, reg.errors.join(' | '));
    check('defaults are observe-only', reg.settingsFor('task-watchdog').cancel_enabled === false);
    check('routes and job listed', reg.listRoutes().length === 5 && reg.listJobs().length === 1);
    const get = async (p, query) => reg.callRoute(reg.findRoute('GET', p), { query, actor: owner });
    const ev = (e, p) => M.emit(reg.mods, e, p);
    const stalledIds = async () => (await get(`${P}/stalled`)).json.stalled.map(s => `${s.task_id}:${s.stalled.reason}`).join();
    const start = (id, resumed = false) => ev('task.start', { task_id: id, request: 'x', workdir: '.', resumed });

    // repeat error x3 -> flagged, not cancelled
    await start('t1');
    const fail = { task_id: 't1', tool: 'Bash', input: { command: 'make' }, ok: false };
    await ev('tool.done', fail); await ev('tool.done', fail);
    check('2 repeats: not flagged', (await stalledIds()) === '');
    await ev('tool.done', fail);
    check('3 repeats: flagged repeat_error', (await stalledIds()) === 't1:repeat_error', await stalledIds());
    check('observe-only: no cancel', cancelled.length === 0);
    check('journal record written', J.readAll().records.some(r => r.type === 'task_stalled' && r.module === 'task-watchdog' && r.task_id === 't1'));

    // different errors do not accumulate; success clears the flag
    await start('t2');
    for (const c of ['a', 'b', 'a']) await ev('tool.done', { task_id: 't2', tool: 'Bash', input: { command: c }, ok: false });
    check('varying errors not flagged', !(await stalledIds()).includes('t2'));
    await ev('tool.done', { task_id: 't1', tool: 'Bash', input: { command: 'ok' }, ok: true });
    check('success clears the flag', (await stalledIds()) === '');

    // continuations
    await start('t3');
    for (let i = 0; i < 2; i++) await start('t3', true);
    check('2 empty continuations: not flagged', !(await stalledIds()).includes('t3'));
    await start('t3', true);
    check('3 empty continuations: flagged', (await stalledIds()).includes('t3:continuations'), await stalledIds());
    await start('t4');
    for (let i = 0; i < 5; i++) { await ev('tool.done', { task_id: 't4', tool: 'Read', input: {}, ok: true }); await start('t4', true); }
    check('continuations with progress: not flagged', !(await stalledIds()).includes('t4'));

    // time stall
    await start('t5');
    check('fresh task not stalled by time', !(await stalledIds()).includes('t5'));
    const f5 = path.join(tmp, 'state', 'm', 'task-watchdog', 'tasks', 't5.json');
    const r5 = JSON.parse(fs.readFileSync(f5, 'utf8')); r5.last_progress_ts -= 21 * 60000; fs.writeFileSync(f5, JSON.stringify(r5));
    check('21 min without progress: flagged no_progress', (await stalledIds()).includes('t5:no_progress'), await stalledIds());
    await ev('task.end', { task_id: 't5', code: 0, workdir: '.' });
    const r5b = JSON.parse(fs.readFileSync(f5, 'utf8'));
    check('ended task is inactive', r5b.active === false);
    r5b.stalled = null; r5b.last_progress_ts -= 99 * 60000; fs.writeFileSync(f5, JSON.stringify(r5b));
    check('ended task is never time-flagged', !(await stalledIds()).includes('t5'));

    // cancel enabled
    reg = mk({ cancel_enabled: true });
    await start('c1');
    for (let i = 0; i < 3; i++) await ev('tool.done', { task_id: 'c1', tool: 'Edit', input: { f: 'z' }, ok: false });
    check('cancel_enabled: cancel called once', cancelled.join() === 'c1', cancelled.join());
    check('cancelled flag recorded', (await get(`${P}/tasks/c1`)).json.stalled.cancelled === true);
    // no task service: cancel rejects, recorded not thrown
    reg = M.registry({ modules: { 'task-watchdog': true }, task_watchdog: { cancel_enabled: true } });
    await start('c2');
    for (let i = 0; i < 3; i++) await ev('tool.done', { task_id: 'c2', tool: 'Edit', input: {}, ok: false });
    const c2 = (await get(`${P}/tasks/c2`)).json;
    check('cancel failure recorded, task still flagged', c2.stalled && c2.stalled.cancelled === false && !!c2.stalled.cancel_error, JSON.stringify(c2.stalled));

    // routes
    const lst = await get(`${P}/tasks`, { flagged: '1', limit: '10' });
    check('tasks?flagged=1 lists flagged', lst.status === 200 && lst.json.tasks.length >= 3 && lst.json.tasks.every(t => t.stalled));
    check('bad limit is 400', (await get(`${P}/tasks`, { limit: '9999' })).status === 400);
    check('bad flagged is 400', (await get(`${P}/tasks`, { flagged: 'x' })).status === 400);
    check('unknown task 404', (await get(`${P}/tasks/nope`)).status === 404);
    check('path-ish id never matches a route', reg.findRoute('GET', `${P}/tasks/..%2Fx`) === null);
    const dm = await reg.callRoute(reg.findRoute('POST', `${P}/tasks/c1/dismiss`), { params: { id: 'c1' }, actor: owner });
    check('dismiss hides the flag', dm.status === 200 && !(await stalledIds()).includes('c1'));
    check('dismiss of unflagged task is 409', (await reg.callRoute(reg.findRoute('POST', `${P}/tasks/t4/dismiss`), { params: { id: 't4' }, actor: owner })).status === 409);
    const found = reg.findRoute('GET', `${P}/stalled`);
    check('anonymous refused (owner access)', (await reg.callRoute(found, { actor: { kind: 'anonymous' } })).status === 403);
    check('worker refused (owner access)', (await reg.callRoute(found, { actor: { kind: 'worker', id: 'w' } })).status === 403);
    check('settings route', (await get(`${P}/settings`)).json.settings.stall_minutes === 20);

    // robustness
    await ev('tool.done', { task_id: '../evil', tool: 'Bash', ok: false });
    await ev('tool.done', { task_id: null, tool: 'Bash', ok: false });
    await ev('task.start', { task_id: 42 });
    const dir = path.join(tmp, 'state', 'm', 'task-watchdog', 'tasks');
    check('bad ids ignored', !fs.readdirSync(dir).some(n => n.includes('evil')) && !fs.existsSync(path.join(tmp, 'state', 'm', 'evil.json')));
    check('unknown setting rejected', M.registry({ modules: { 'task-watchdog': true }, task_watchdog: { bogus: 1 } }).errors.length > 0);
    check('limit below min rejected', M.registry({ modules: { 'task-watchdog': true }, task_watchdog: { repeat_error_limit: 1 } }).errors.length > 0);
    check('tool input is not stored', !fs.readFileSync(path.join(dir, 't1.json'), 'utf8').includes('make'));
    const out = []; const log = console.log; console.log = s => out.push(s);
    try { await M.commands(reg.mods).watchdog(['list'], {}); } finally { console.log = log; }
    check('command lists tasks', out.length >= 4 && out.some(l => l.startsWith('t1\t')), String(out.length));
  } catch (e) { check('suite ran without throwing', false, e && e.stack); }
  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(n === results.length ? 0 : 1);
})();
