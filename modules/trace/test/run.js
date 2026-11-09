#!/usr/bin/env node
'use strict';
// trace: timeline, cost, predict-then-do overrun, routes, status line. In-process, fresh temp state dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const owner = { kind: 'owner', id: 'test' };
const P = '/m/trace';
const PRICES = { prices_usd_per_mtok: { opus: { input: 5, output: 25 }, default: { input: 3, output: 15 } } };
const taskFile = id => path.join(tmp, 'state', 'm', 'trace', 'tasks', `${id}.json`);
const readRec = id => JSON.parse(fs.readFileSync(taskFile(id), 'utf8'));
const writeRec = (id, f) => { const r = readRec(id); f(r); fs.writeFileSync(taskFile(id), JSON.stringify(r)); };

(async () => {
  try {
    const off = M.registry({ modules: { trace: false } });
    check('off: nothing registered', !off.listRoutes().length && !off.listJobs().length && off.settingsFor('trace') === null);

    const reg = M.registry({ modules: { trace: true }, ...PRICES });
    check('on: loads clean', reg.errors.length === 0, reg.errors.join(' | '));
    check('routes, job and panel listed', reg.listRoutes().length === 5 && reg.listJobs().length === 1 && reg.listPanels().length === 1);
    const get = (p, query) => reg.callRoute(reg.findRoute('GET', p), { query, params: undefined, actor: owner });
    const post = (p, body, actor = owner) => reg.callRoute(reg.findRoute('POST', p), { body, actor });
    const ev = (e, p) => M.emit(reg.mods, e, p);

    // timeline
    await ev('task.start', { task_id: 'a1', request: 'do a thing', workdir: '.', resumed: false });
    await ev('tool.done', { task_id: 'a1', tool: 'Read', ok: true, durationMs: 40, tool_use_id: 'u1' });
    await ev('tool.done', { task_id: 'a1', tool: 'Bash', ok: false, durationMs: 60, tool_use_id: 'u2' });
    await ev('tool.done', { task_id: 'a1', tool: 'Bash', ok: false, durationMs: 60, tool_use_id: 'u2' });
    await ev('task.end', { task_id: 'a1', code: 0, workdir: '.' });
    const t = (await get(`${P}/tasks/a1`)).json.task;
    check('timeline: start, 2 tools, end in order', t.events.map(e => e.type).join() === 'start,tool,tool,end', t.events.map(e => e.type).join());
    check('duplicate tool_use_id counted once', t.tool_count === 2 && t.tool_errors === 1);
    check('state ended with code', t.state === 'ended' && t.code === 0 && t.duration_ms >= 0);
    check('cost unknown without usage', t.cost_usd === null);
    check('tool call carries ok and duration', t.events[2].ok === false && t.events[2].duration_ms === 60);
    check('unknown task is 404', (await get(`${P}/tasks/nope`, {})).status === 404);
    check('tool.done outside a task is ignored', (await ev('tool.done', { task_id: null, tool: 'Read', ok: true }), (await get(`${P}/tasks`, {})).json.tasks.length === 1));

    // cost from usage
    await ev('task.start', { task_id: 'c1', request: 'x', workdir: '.', resumed: false });
    await ev('tool.done', { task_id: 'c1', tool: 'Read', ok: true, usage: { model: 'claude-opus-5-5', input_tokens: 1000000, output_tokens: 100000 } });
    await ev('tool.done', { task_id: 'c1', tool: 'Read', ok: true, usage: { model: 'other', input_tokens: 1000000 } });
    const c1 = (await get(`${P}/tasks/c1`)).json.task;
    check('cost = tokens x price table (opus 7.5 + default 3)', c1.cost_usd === 10.5 && c1.tokens.input === 2000000 && c1.tokens.output === 100000, JSON.stringify(c1.tokens) + ' ' + c1.cost_usd);

    // resume continues the same timeline
    await ev('task.start', { task_id: 'a2', request: 'r', workdir: '.', resumed: false });
    await ev('tool.done', { task_id: 'a2', tool: 'Read', ok: true });
    await ev('task.start', { task_id: 'a2', request: 'r', workdir: '.', resumed: true });
    const a2 = (await get(`${P}/tasks/a2`)).json.task;
    check('resume keeps the timeline and counts the resume', a2.tool_count === 1 && a2.resumed === 1 && a2.events.length === 3);

    // predict-then-do
    check('predict: bad duration is 400', (await post(`${P}/tasks/p1/predict`, { minutes: 'x' })).status === 400);
    check('predict: bad line owner is 400', (await post(`${P}/tasks/p1/predict`, { minutes: 5, line_owner: '../x' })).status === 400);
    const pr = await post(`${P}/tasks/p1/predict`, { minutes: 10, result: 'tests pass', line_owner: 'line-a' });
    check('predict: recorded before the task starts', pr.status === 200 && pr.json.prediction.duration_ms === 600000 && pr.json.prediction.line_owner === 'line-a');
    check('predict: second prediction refused', (await post(`${P}/tasks/p1/predict`, { minutes: 1 })).status === 409);
    check('predicted-only task is listed as predicted', (await get(`${P}/tasks`, {})).json.tasks.some(x => x.task_id === 'p1' && x.state === 'predicted'));
    check('predicted-only task never overruns', (await get(`${P}/overruns`, {})).json.overruns.length === 0);
    await ev('task.start', { task_id: 'p1', request: 'x', workdir: '.', resumed: false });
    check('start keeps the earlier prediction', readRec('p1').prediction.line_owner === 'line-a' && readRec('p1').started_ts > 0);
    await ev('tool.done', { task_id: 'p1', tool: 'Read', ok: true });
    check('within the prediction: no overrun', !readRec('p1').overrun);

    // push start back to 19 min: not yet over 2 x 10 min; 21 min: over
    writeRec('p1', r => { r.started_ts = Date.now() - 19 * 60000; });
    await ev('tool.done', { task_id: 'p1', tool: 'Read', ok: true });
    check('19 min of 10 predicted: no overrun', !readRec('p1').overrun);
    writeRec('p1', r => { r.started_ts = Date.now() - 21 * 60000; });
    const ov = await get(`${P}/overruns`, { line_owner: 'line-a' }); // route sweeps the running tasks
    check('21 min of 10 predicted: overrun flagged via sweep', ov.json.overruns.length === 1 && ov.json.overruns[0].overrun.line_owner === 'line-a' && ov.json.overruns[0].ratio >= 2.1, JSON.stringify(ov.json.overruns.map(o => o.ratio)));
    check('overrun filter by another line owner is empty', (await get(`${P}/overruns`, { line_owner: 'line-b' })).json.overruns.length === 0);
    check('overrun journaled with module tag', J.readAll().records.some(r => r.type === 'trace_overrun' && r.module === 'trace' && r.task_id === 'p1' && r.line_owner === 'line-a'));
    check('overrun journaled once only', J.readAll().records.filter(r => r.type === 'trace_overrun' && r.task_id === 'p1').length === 1);
    await get(`${P}/overruns`, {}); await ev('tool.done', { task_id: 'p1', tool: 'Read', ok: true });
    check('flag is not repeated by later events', J.readAll().records.filter(r => r.type === 'trace_overrun' && r.task_id === 'p1').length === 1);

    // the event and the status line, with a fake ctx on the module's own api
    {
      const mod = require('../index.js');
      const evs = [], jr = [];
      const ctx = { settings: { overrun_factor: 2, max_events_per_task: 500, max_tracked_tasks: 200 }, config: {}, emit: async (n, p) => { evs.push([n, p]); },
        state: { dir: path.join(tmp, 'state', 'm', 'trace'), append: r => { jr.push(r); } } };
      await post(P + '/tasks/ev1/predict', { minutes: 1, line_owner: 'line-c' });
      await ev('task.start', { task_id: 'ev1', request: 'x', workdir: '.', resumed: false });
      writeRec('ev1', r => { r.started_ts = Date.now() - 3 * 60000; });
      check('sweep flags the overrun and emits trace.overrun to the line owner', await mod.api.sweep(ctx) === 1 && evs.length === 1 && evs[0][0] === 'trace.overrun' && evs[0][1].line_owner === 'line-c' && evs[0][1].task_id === 'ev1' && evs[0][1].elapsed_ms > 120000, JSON.stringify(evs));
      check('second sweep does not emit again', await mod.api.sweep(ctx) === 0 && evs.length === 1);
      const lines = mod.statusLines({}, ctx);
      check('status line names the line owner, the task and the factor', lines.some(l => l.includes('[line-c] task ev1') && l.includes('over 2x its 1m00s prediction')), lines.join(' | '));
      await ev('task.end', { task_id: 'ev1', code: 0, workdir: '.' });
      check('status line drops an ended task', !mod.statusLines({}, ctx).some(l => l.includes('ev1')));
    }

    // overrun detected at task end (no job tick): predicted 1 min, ran 5
    await post(`${P}/tasks/q1/predict`, { duration_ms: 60000 });
    await ev('task.start', { task_id: 'q1', request: 'x', workdir: '.', resumed: false });
    writeRec('q1', r => { r.started_ts = Date.now() - 5 * 60000; });
    await ev('task.end', { task_id: 'q1', code: 0, workdir: '.' });
    check('overrun at task.end is flagged; default line owner is the predicting actor', readRec('q1').overrun && readRec('q1').overrun.line_owner === 'test');
    check('finished task: ratio reported', (await get(`${P}/tasks/q1`)).json.task.ratio >= 5);

    // actual result
    check('record actual result', (await post(`${P}/tasks/q1/result`, { result: 'tests failed' })).status === 200 && readRec('q1').actual_result === 'tests failed');
    check('result for unknown task is 404', (await post(`${P}/tasks/zz/result`, { result: 'x' })).status === 404);

    // caps and access
    const small = M.registry({ modules: { trace: true }, trace: { max_events_per_task: 10 }, ...PRICES });
    await M.emit(small.mods, 'task.start', { task_id: 'm1', request: 'x', workdir: '.', resumed: false });
    for (let i = 0; i < 15; i++) await M.emit(small.mods, 'tool.done', { task_id: 'm1', tool: 'Read', ok: true });
    const m1 = readRec('m1');
    check('events capped, extras counted', m1.events.length === 10 && m1.dropped_events === 6 && m1.tool_count === 15, `${m1.events.length}/${m1.dropped_events}`);
    const anon = await reg.callRoute(reg.findRoute('GET', `${P}/tasks`), { query: {}, actor: { kind: 'anonymous', id: 'x' } });
    check('anonymous is refused', anon.status === 403);
    const wk = await reg.callRoute(reg.findRoute('POST', `${P}/tasks/w1/predict`), { body: { minutes: 3 }, actor: { kind: 'worker', id: 'w' } });
    check('a worker may predict (line owner defaults to its id)', wk.status === 200 && wk.json.prediction.line_owner === 'w');
    const wkGet = await reg.callRoute(reg.findRoute('GET', `${P}/tasks`), { query: {}, actor: { kind: 'worker', id: 'w' } });
    check('a worker may not read the list', wkGet.status === 403);

    // concurrent events from several callers lose nothing
    await ev('task.start', { task_id: 'k1', request: 'x', workdir: '.', resumed: false });
    await Promise.all(Array.from({ length: 20 }, (_, i) => ev('tool.done', { task_id: 'k1', tool: 'Read', ok: true, tool_use_id: `k${i}` })));
    check('concurrent tool.done events are all counted', readRec('k1').tool_count === 20 && readRec('k1').events.length === 21, String(readRec('k1').tool_count));
    check('no leftover lock files', !fs.readdirSync(path.dirname(taskFile('k1'))).some(n => n.endsWith('.lock')));

    // prune
    const tiny = M.registry({ modules: { trace: true }, trace: { max_tracked_tasks: 10 }, ...PRICES });
    for (let i = 0; i < 14; i++) {
      await M.emit(tiny.mods, 'task.start', { task_id: `z${i}`, request: 'x', workdir: '.', resumed: false });
      await M.emit(tiny.mods, 'task.end', { task_id: `z${i}`, code: 0, workdir: '.' });
    }
    await tiny.callRoute(tiny.findRoute('GET', `${P}/tasks`), { query: {}, actor: owner });
    const left = fs.readdirSync(path.dirname(taskFile('k1'))).filter(n => n.endsWith('.json')).length;
    check('ended tasks beyond the cap are pruned', left <= 10 + 6 /* running tasks are kept */ && !fs.existsSync(taskFile('z0')), String(left));
  } catch (e) {
    check('no exception', false, e && e.stack);
  }
  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(n === results.length ? 0 : 1);
})();
