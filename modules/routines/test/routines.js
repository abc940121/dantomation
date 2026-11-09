#!/usr/bin/env node
'use strict';
// routines: schedule parsing, routes, firing, catch-up, cap. In-process, fresh temp state dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'routines-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state'); // before the journal is required
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));
const S = require('../schedule');

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const throws = (f) => { try { f(); return false; } catch { return true; } };
const owner = { kind: 'owner', id: 'test' };

(async () => {
  try {
    // schedule parsing
    check('interval parses', S.parse('every 15m').every_s === 900);
    check('bad intervals refused', ['every 1s', 'every 99d', 'every 5x', 'every', 'every -5m'].every(t => throws(() => S.parse(t))));
    check('cron parses', S.parse('*/15 9-17 * * 1-5').kind === 'cron');
    check('bad cron refused', ['* * * *', '60 * * * *', '* 24 * * *', '*/0 * * * *', '5-2 * * * *', 'a * * * *', '* * * * * *', '@daily'].every(t => throws(() => S.parse(t))));
    const p = S.parse('30 9 * * *');
    check('cron due in window', S.cronDue(p, Date.UTC(2030, 0, 1, 9, 29), Date.UTC(2030, 0, 1, 9, 30)));
    check('cron not due outside window', !S.cronDue(p, Date.UTC(2030, 0, 1, 9, 30), Date.UTC(2030, 0, 1, 10, 0)));
    check('cron dow 7 is Sunday', S.cronDue(S.parse('0 0 * * 7'), Date.UTC(2030, 0, 5, 23, 0), Date.UTC(2030, 0, 6, 0, 0))); // 2030-01-06 is a Sunday
    check('cron dom/dow either when both set', S.cronDue(S.parse('0 0 15 * 1'), Date.UTC(2030, 0, 6, 23, 0), Date.UTC(2030, 0, 7, 0, 0))); // Monday the 7th

    // module off
    const off = M.registry({ modules: { routines: false } });
    check('off: nothing registered', off.errors.length === 0 && !off.listRoutes().length && !off.listJobs().length);

    // module on, with a fake task service
    const enq = []; let failNext = false;
    const tasks = { enqueue: async (bot, prompt) => { if (failNext) { failNext = false; throw new Error('queue down'); } enq.push({ bot, prompt }); return { id: 't' + enq.length }; }, get: async () => null, cancel: async () => {} };
    const reg = M.registry({ modules: { routines: true }, routines: { max_runs_per_day: 3, max_routines: 4, max_prompt_chars: 50 } }, { tasks });
    check('on: loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    check('routes listed', reg.listRoutes().length === 8);
    check('job listed', reg.listJobs().map(j => j.id).join() === 'scheduler');
    check('all routes owner access', reg.listRoutes().every(r => r.access === 'owner'));
    const call = async (method, url, body, actor = owner) => { const f = reg.findRoute(method, url); return reg.callRoute(f, { params: f.params, body, query: {}, actor }); };
    check('anonymous refused', (await call('GET', '/m/routines/routines', undefined, { kind: 'anonymous' })).status === 403);
    check('worker refused', (await call('GET', '/m/routines/routines', undefined, { kind: 'worker', id: 'w' })).status === 403);

    const good = { id: 'morning', bot: 'helper', prompt: 'say good morning', schedule: 'every 1h' };
    let r = await call('POST', '/m/routines/routines', good);
    check('create 201', r.status === 201 && r.json.id === 'morning' && r.json.paused === false, JSON.stringify(r));
    check('duplicate 409', (await call('POST', '/m/routines/routines', good)).status === 409);
    const badBodies = [null, [], { ...good, id: '../x' }, { ...good, id: 'A' }, { ...good, bot: 'a b' }, { ...good, prompt: '' }, { ...good, prompt: 'x'.repeat(51) },
      { ...good, schedule: 'nope' }, { ...good, id: 'z', extra: 1 }, { ...good, id: 'z', paused: 'yes' }, { ...good, id: 'z', schedule: 5 }];
    let allBad = true;
    for (const b of badBodies) { const x = await call('POST', '/m/routines/routines', b); if (x.status !== 400) { allBad = false; console.log('  not 400:', JSON.stringify(b), x.status); } }
    check('invalid inputs all 400', allBad);
    check('list shows it', (await call('GET', '/m/routines/routines')).json.routines.length === 1);
    check('get 404', (await call('GET', '/m/routines/routines/nope')).status === 404);
    check('update', (await call('PATCH', '/m/routines/routines/morning', { prompt: 'new text' })).json.prompt === 'new text');
    check('update cannot rename', (await call('PATCH', '/m/routines/routines/morning', { id: 'other' })).status === 400);
    check('update 404', (await call('PATCH', '/m/routines/routines/nope', { prompt: 'x' })).status === 404);
    check('delete 404', (await call('DELETE', '/m/routines/routines/nope')).status === 404);
    for (const id of ['b', 'c', 'd']) await call('POST', '/m/routines/routines', { ...good, id });
    check('max_routines enforced', (await call('POST', '/m/routines/routines', { ...good, id: 'e' })).status === 400);
    for (const id of ['b', 'c', 'd']) await call('DELETE', '/m/routines/routines/' + id);
    check('delete works', (await call('GET', '/m/routines/routines')).json.routines.length === 1);

    // ctx for direct tick control
    const stateDir = path.join(process.env.HARNESS_STATE_DIR, 'm', 'routines');
    const ctx = { settings: reg.settingsFor('routines'), state: { dir: stateDir, append: rec => J.append({ ...rec, module: 'routines' }) }, tasks };
    const api = reg.api('routines');
    const file = path.join(stateDir, 'routines.json');
    const edit = f => { const s = JSON.parse(fs.readFileSync(file, 'utf8')); f(s); fs.writeFileSync(file, JSON.stringify(s)); };
    const now = Date.now();

    check('not due yet: no fire', (await api.tick(ctx, now)).length === 0 && enq.length === 0);
    check('interval fires when due', (await api.tick(ctx, now + 3600e3 + 1000)).join() === 'morning' && enq.length === 1 && enq[0].bot === 'helper' && enq[0].prompt === 'new text');
    check('re-armed after firing', (await api.tick(ctx, now + 3600e3 + 2000)).length === 0);

    // missed while down: 10 days overdue interval fires exactly once
    edit(s => { s.routines.morning.next_at = now - 10 * 86400e3; });
    const before = enq.length;
    const a = await api.tick(ctx, now + 7200e3), b = await api.tick(ctx, now + 7201e3);
    check('missed interval runs fire once', a.length === 1 && b.length === 0 && enq.length === before + 1);

    // cron: missed many times while down, fires once
    await call('POST', '/m/routines/routines', { ...good, id: 'cr', schedule: '* * * * *', prompt: 'cron one' });
    edit(s => { s.routines.cr.cursor = now - 5 * 86400e3; });
    const c1 = await api.tick(ctx, now + 3e3), c2 = await api.tick(ctx, now + 3e3 + 1000);
    check('missed cron runs fire once', c1.includes('cr') && !c2.includes('cr') && enq.filter(x => x.prompt === 'cron one').length === 1);

    // pause / resume
    edit(s => { s.routines.morning.next_at = 0; });
    await call('POST', '/m/routines/routines/morning/pause');
    const n1 = enq.length;
    await api.tick(ctx, now + 9e6);
    check('paused routine does not fire', enq.slice(n1).every(x => x.prompt !== 'new text'));
    r = await call('POST', '/m/routines/routines/morning/resume');
    check('resume re-arms (no backlog)', r.json.paused === false && (await api.tick(ctx, Date.now())).length === 0);

    // daily cap (3)
    const used = (await call('GET', '/m/routines/routines')).json.usage;
    check('usage counted', used.runs_today >= 2 && used.cap === 3, JSON.stringify(used));
    edit(s => { s.runs_today = 2; });
    r = await call('POST', '/m/routines/routines/morning/run');
    const r2 = await call('POST', '/m/routines/routines/morning/run');
    check('run-now fires 202 then cap 429', [r.status, r2.status].includes(429) && [r.status, r2.status].includes(202), `${r.status} ${r2.status}`);
    const nCap = enq.length;
    edit(s => { s.routines.morning.next_at = 0; });
    await api.tick(ctx, Date.now());
    check('cap blocks scheduled runs', enq.length === nCap);
    edit(s => { s.day = '2000-01-01'; });
    check('cap resets on a new day', (await call('POST', '/m/routines/routines/morning/run')).status === 202);
    check('run-now unknown 404', (await call('POST', '/m/routines/routines/nope/run')).status === 404);

    // enqueue failure is recorded, not thrown, and not counted
    edit(s => { s.day = '2000-01-01'; });
    failNext = true;
    const f = await call('POST', '/m/routines/routines/morning/run');
    check('enqueue failure reported', f.status === 502 && f.json.routine.last_error === 'queue down', JSON.stringify(f.json));

    // reservation before enqueue: state is durable while enqueue is in flight
    edit(s => { s.day = '2000-01-01'; s.runs_today = 0; s.routines.morning.next_at = 0; delete s.routines.morning.pending; });
    let snap = null;
    const ctxSnap = { ...ctx, tasks: { enqueue: async () => { snap = JSON.parse(fs.readFileSync(file, 'utf8')); return { id: 'tsnap' }; } } };
    await api.tick(ctxSnap, Date.now());
    check('occurrence reserved before enqueue', snap && snap.routines.morning.pending && snap.routines.morning.next_at > Date.now() && snap.runs_today === 1, JSON.stringify(snap && snap.routines.morning));
    check('pending cleared after confirm', JSON.parse(fs.readFileSync(file, 'utf8')).routines.morning.pending === undefined);

    // crash between enqueue and save: leftover pending is reconciled, never re-enqueued
    edit(s => { s.routines.morning.pending = 'morning@0'; s.routines.morning.next_at = Date.now() + 3600e3; });
    const nCrash = enq.length;
    await api.tick(ctx, Date.now());
    const after = JSON.parse(fs.readFileSync(file, 'utf8')).routines.morning;
    check('crash leftover not re-enqueued', enq.length === nCrash && after.pending === undefined && /interrupted/.test(after.last_error));

    // prototype safety on id lookups
    const protoBefore = ({}).polluted;
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const x = await call('PATCH', '/m/routines/routines/' + id, { prompt: 'polluted' });
      const g = await call('GET', '/m/routines/routines/' + id);
      const d = await call('DELETE', '/m/routines/routines/' + id);
      const u = await call('POST', '/m/routines/routines/' + id + '/run');
      check('proto id ' + id + ' is 404', [x.status, g.status, d.status, u.status].every(c => c === 404), `${x.status} ${g.status} ${d.status} ${u.status}`);
    }
    check('Object.prototype not polluted', ({}).prompt === undefined && ({}).polluted === protoBefore && Object.prototype.prompt === undefined);
    check('proto id create refused', (await call('POST', '/m/routines/routines', { ...good, id: '__proto__' })).status === 400);

    // journal: records exist, prompt text never journaled
    const recs = J.readAll().records.filter(x => x.module === 'routines');
    check('records written', ['routine_created', 'routine_fired', 'routine_error', 'routine_skipped'].every(t => recs.some(x => x.type === t)));
    check('prompt text not journaled', !JSON.stringify(recs).includes('cron one') && !JSON.stringify(recs).includes('new text'));

    // job: runs a pass at start and stops cleanly
    edit(s => { s.day = '2000-01-01'; s.routines.morning.next_at = 0; });
    const nJob = enq.length;
    const jobs = await reg.startJobs({});
    check('job start fires a due routine', enq.length === nJob + 1);
    await jobs.stop();
    check('job stops', true);
    check('statusLines', (await reg.mods.find(m => m.name === 'routines').statusLines(J, ctx))[0].startsWith('routines: '));
  } catch (e) { check('no exception', false, e.stack); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  process.exit(n === results.length ? 0 : 1);
})();
