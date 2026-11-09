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
    // review fixes: worker write scope
    const wA = { kind: 'worker', id: 'wa' }, wB = { kind: 'worker', id: 'wb' };
    await post(`${P}/tasks/s1/predict`, { minutes: 5 }, wA);
    check('worker B cannot preempt/overwrite A prediction', (await post(`${P}/tasks/s1/predict`, { minutes: 1 }, wB)).status === 409 && readRec('s1').prediction.duration_ms === 300000);
    await ev('task.start', { task_id: 's1', request: 'x', workdir: '.', resumed: false });
    await ev('task.start', { task_id: 's2', request: 'x', workdir: '.', resumed: false });
    check('worker cannot predict for an already started task', (await post(`${P}/tasks/s2/predict`, { minutes: 1 }, wB)).status === 403 && !readRec('s2').prediction);
    check('a worker cannot write any result (no distinct worker identity): not B, not the predicting A', (await post(`${P}/tasks/s1/result`, { result: 'evil' }, wB)).status === 403 && (await post(`${P}/tasks/s1/result`, { result: 'good' }, wA)).status === 403 && !readRec('s1').actual_result);
    const anonWorker = { kind: 'worker', id: '' };
    await post(`${P}/tasks/s3/predict`, { minutes: 1 }, anonWorker);
    check('an id-less worker cannot write a result for a task with no owner prediction', (await post(`${P}/tasks/s3/result`, { result: 'x' }, anonWorker)).status === 403 && !readRec('s3').actual_result);
    check('owner may overwrite the result', (await post(`${P}/tasks/s1/result`, { result: 'fixed' })).status === 200 && readRec('s1').actual_result === 'fixed');

    // review fixes: un-started prediction cap, age and prune
    {
      const dirOf = () => path.dirname(taskFile('k1'));
      const cap = M.registry({ modules: { trace: true }, trace: { max_unstarted_predictions: 3 }, ...PRICES });
      const pc = id => cap.callRoute(cap.findRoute('POST', `${P}/tasks/${id}/predict`), { body: { minutes: 1 }, actor: wA });
      const codes = []; for (let i = 0; i < 6; i++) codes.push((await pc(`cap${i}`)).status);
      const unstarted = fs.readdirSync(dirOf()).filter(n => /^cap\d+\.json$/.test(n)).length;
      check('un-started predictions are capped with 429', codes.filter(c => c === 429).length >= 3, codes.join());
      writeRec('cap0', r => { r.prediction.ts = Date.now() - 25 * 3600 * 1000; });
      check('a prediction under the cap is accepted again after the old one ages out', (await pc('cap9')).status === 200 && !fs.existsSync(taskFile('cap0')), String(unstarted));
      const many = M.registry({ modules: { trace: true }, trace: { max_unstarted_predictions: 50, max_tracked_tasks: 10 }, ...PRICES });
      for (let i = 0; i < 20; i++) await many.callRoute(many.findRoute('POST', `${P}/tasks/pp${i}/predict`), { body: { minutes: 1 }, actor: wA });
      const ppLeft = fs.readdirSync(dirOf()).filter(n => /^pp\d+\.json$/.test(n)).length;
      check('prediction-only records count toward max_tracked_tasks, oldest first', ppLeft <= 10 && ppLeft > 0 && !fs.existsSync(taskFile('pp0')) && fs.existsSync(taskFile('pp19')), String(ppLeft));
    }

    // review fixes: lock ownership
    {
      const lockFile = taskFile('lk1') + '.lock';
      await ev('task.start', { task_id: 'lk1', request: 'x', workdir: '.', resumed: false });
      fs.writeFileSync(lockFile, 'someone-else-token');
      const pending = ev('tool.done', { task_id: 'lk1', tool: 'Read', ok: true });
      await new Promise(r => setTimeout(r, 300));
      const held = fs.readFileSync(lockFile, 'utf8') === 'someone-else-token' && readRec('lk1').tool_count === 0;
      fs.unlinkSync(lockFile); await pending;
      check('a fresh foreign lock is not stolen; the update runs once it is released', held && readRec('lk1').tool_count === 1);
      fs.writeFileSync(lockFile, 'dead-holder'); const old = new Date(Date.now() - 60000); fs.utimesSync(lockFile, old, old);
      await ev('tool.done', { task_id: 'lk1', tool: 'Read', ok: true });
      check('a stale lock is broken and the update runs', readRec('lk1').tool_count === 2 && !fs.existsSync(lockFile));
      check('no stale-lock leftovers', !fs.readdirSync(path.dirname(taskFile('k1'))).some(n => n.includes('.stale.')));
      // the lock is replaced under a running holder: the holder must not unlink the successor's lock
      const realRename = fs.renameSync, realUnlink = fs.unlinkSync;
      let violated = false;
      fs.renameSync = (a, b) => { if (String(b).endsWith("lk1.json")) { fs.unlinkSync(lockFile); fs.writeFileSync(lockFile, "successor"); setTimeout(() => { try { realUnlink(lockFile); } catch { /* gone */ } }, 200); } return realRename(a, b); };
      fs.unlinkSync = p => { if (String(p) === lockFile && fs.readFileSync(lockFile, "utf8") === "successor") violated = true; return realUnlink(p); };
      try { await ev("task.start", { task_id: "lk1", request: "x", workdir: ".", resumed: true }); } finally { fs.renameSync = realRename; fs.unlinkSync = realUnlink; }
      check("holder does not unlink a lock that is not its own token", !violated);
      // an unexpected open error: the hook does not throw, fn does not run unlocked, a status is journaled
      const mod = require('../index.js'), jr = [];
      const fctx = { settings: { overrun_factor: 2, max_events_per_task: 500, max_tracked_tasks: 200 }, config: {}, emit: async () => {}, state: { dir: path.join(tmp, 'state', 'm', 'trace'), append: r => { jr.push(r); } } };
      const realWrite = fs.writeFileSync;
      fs.writeFileSync = (f, ...rest) => { if (String(f).endsWith('lk3.json.lock')) { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; } return realWrite(f, ...rest); };
      let threw = false;
      try { await mod.on['tool.done']({ task_id: 'lk3', tool: 'Read', ok: true }, fctx); } catch { threw = true; } finally { fs.writeFileSync = realWrite; }
      check('lock error: hook never throws, nothing written unlocked, status logged', !threw && !fs.existsSync(taskFile('lk3')) && jr.some(r => r.type === 'trace_skipped' && r.task_id === 'lk3'), JSON.stringify(jr));
    }

    // review fixes: stale-lock break is verified under a breaker mutex
    {
      const dir = path.dirname(taskFile('k1'));
      const lockFile = taskFile('sb1') + '.lock', mutex = lockFile + '.break';
      await ev('task.start', { task_id: 'sb1', request: 'x', workdir: '.', resumed: false });
      const realOpen = fs.openSync, realUnlink = fs.unlinkSync, realWrite = fs.writeFileSync, realRead = fs.readFileSync;
      fs.writeFileSync(lockFile, 'dead-holder'); const old = new Date(Date.now() - 60000); fs.utimesSync(lockFile, old, old);
      // between judging the lock stale and taking the breaker mutex, a successor replaces it with a live lock
      let violated = false, swapped = false, live = false;
      fs.openSync = (p, ...r) => {
        const fd = realOpen(p, ...r);
        if (String(p) === mutex && !swapped) { swapped = true; live = true; realUnlink(lockFile); realWrite(lockFile, 'successor'); setTimeout(() => { live = false; try { realUnlink(lockFile); } catch { /* gone */ } }, 300); }
        return fd;
      };
      fs.unlinkSync = p => { if (String(p) === lockFile && live && realRead(lockFile, 'utf8') === 'successor') violated = true; return realUnlink(p); };
      const t0 = Date.now();
      try { await ev('tool.done', { task_id: 'sb1', tool: 'Read', ok: true }); } finally { fs.openSync = realOpen; fs.unlinkSync = realUnlink; }
      check('a live successor lock is not broken by a stale-judging waiter', swapped && !violated && Date.now() - t0 >= 250 && readRec('sb1').tool_count === 1);
      check('breaker mutex and lock are cleaned up, no rename leftovers', !fs.existsSync(mutex) && !fs.existsSync(lockFile) && !fs.readdirSync(dir).some(n => n.includes('.stale.')));
      // a stale breaker mutex (crashed breaker) is cleared and the stale lock then broken
      fs.writeFileSync(lockFile, 'dead-holder'); fs.utimesSync(lockFile, old, old);
      fs.writeFileSync(mutex, 'dead-breaker'); fs.utimesSync(mutex, old, old);
      await ev('tool.done', { task_id: 'sb1', tool: 'Read', ok: true });
      check('a stale .break mutex is cleared and the update runs', readRec('sb1').tool_count === 2 && !fs.existsSync(mutex) && !fs.existsSync(lockFile));
      // a fresh breaker mutex held by someone else blocks the break
      fs.writeFileSync(lockFile, 'dead-holder'); fs.utimesSync(lockFile, old, old); fs.writeFileSync(mutex, 'live-breaker');
      const pend = ev('tool.done', { task_id: 'sb1', tool: 'Read', ok: true });
      await new Promise(r => setTimeout(r, 250));
      const blocked = fs.readFileSync(lockFile, 'utf8') === 'dead-holder' && readRec('sb1').tool_count === 2;
      fs.unlinkSync(mutex); await pend;
      check('a live breaker mutex blocks the stale break until released', blocked && readRec('sb1').tool_count === 3);
      // the lock is stolen while the holder works: the final state write is refused
      await ev('task.start', { task_id: 'sb2', request: 'x', workdir: '.', resumed: false });
      const lock2 = taskFile('sb2') + '.lock';
      fs.readFileSync = (p, ...r) => { const out = realRead(p, ...r); if (String(p) === taskFile('sb2')) realWrite(lock2, 'thief'); return out; };
      try { await ev('tool.done', { task_id: 'sb2', tool: 'Read', ok: true }); } finally { fs.readFileSync = realRead; }
      const kept = realRead(lock2, 'utf8') === 'thief' && readRec('sb2').tool_count === 0;
      fs.unlinkSync(lock2);
      check('state write is skipped when the lock is no longer ours; thief lock untouched', kept);
    }

    // review fixes: pruning takes the task lock and re-checks eligibility
    {
      const pr = M.registry({ modules: { trace: true }, trace: { max_tracked_tasks: 10 }, ...PRICES });
      const tpl = { request: '', started_ts: 1, code: 0, resumed: 0, tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 }, cost_usd: null, tool_count: 0, tool_errors: 0, tool_ms: 0, events: [], dropped_events: 0, prediction: null, overrun: null };
      for (let i = 0; i < 14; i++) fs.writeFileSync(taskFile(`pr${i}`), JSON.stringify(Object.assign({}, tpl, { task_id: `pr${i}`, ended_ts: 1 + i })));
      // pr0 is the first prune candidate; between listing and unlinking it is resumed (running again)
      const realWrite = fs.writeFileSync, lockName = taskFile('pr0') + '.lock'; let hit = false;
      fs.writeFileSync = (f, ...r) => {
        if (String(f) === lockName && !hit) { hit = true; const x = readRec('pr0'); x.ended_ts = null; x.started_ts = Date.now(); realWrite(taskFile('pr0'), JSON.stringify(x)); }
        return realWrite(f, ...r);
      };
      try { await pr.callRoute(pr.findRoute('GET', `${P}/tasks`), { query: {}, actor: owner }); } finally { fs.writeFileSync = realWrite; }
      check('prune re-checks under the lock: a task resumed meanwhile is kept', hit && fs.existsSync(taskFile('pr0')) && !readRec('pr0').ended_ts);
      check('prune still drops other old ended tasks', !fs.existsSync(taskFile('pr1')));
      check('prune leaves no lock files', !fs.readdirSync(path.dirname(taskFile('k1'))).some(n => /^pr\d+\.json\.lock$/.test(n)));
    }

    // review fixes: the unstarted-prediction cap is checked under a module-wide lock
    {
      const dir = path.dirname(taskFile('k1'));
      const cap = M.registry({ modules: { trace: true }, trace: { max_unstarted_predictions: 1, max_tracked_tasks: 5000 }, ...PRICES });
      for (const n of fs.readdirSync(dir)) if (n.endsWith('.json') && !readRec(n.slice(0, -5)).started_ts) fs.rmSync(path.join(dir, n), { force: true });
      const pc = id => cap.callRoute(cap.findRoute('POST', `${P}/tasks/${id}/predict`), { body: { minutes: 1 }, actor: wA });
      const codes = (await Promise.all(['race1', 'race2', 'race3', 'race4'].map(pc))).map(r => r.status).sort();
      check('concurrent predictions for different tasks cannot pass the cap together', codes.join() === '200,429,429,429', codes.join());
      check('predictions.lock released', !fs.existsSync(path.join(dir, 'predictions.lock')));
    }
  } catch (e) {
    check('no exception', false, e && e.stack);
  }
  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(n === results.length ? 0 : 1);
})();
