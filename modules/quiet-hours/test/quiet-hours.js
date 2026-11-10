#!/usr/bin/env node
'use strict';
// quiet-hours: in-process, temp state dir, fake clock. The ntfy server is a stub on
// 127.0.0.1 only (no real network).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-hours-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state'); // before the journal is required
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info ? ': ' + info : ''}`); };
const at = (h, m, day = 10) => new Date(2026, 0, day, h, m, 0, 0).getTime(); // local time

(async () => {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => { hits.push({ url: req.url, headers: req.headers, body }); res.writeHead(200); res.end('{}'); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const settle = () => new Promise(r => setTimeout(r, 60));
  let jobs = null;
  let now = at(12, 0);
  const owner = { kind: 'owner', id: 'test' };

  const mk = (q, on = true) => M.registry({ modules: { ntfy: true, 'quiet-hours': on }, ntfy: { server: base }, quiet_hours: q || {} });
  const start = async q => {
    if (jobs) await jobs.stop();
    const reg = mk(q);
    reg.api('quiet-hours').setClock(() => now);
    jobs = await reg.startJobs({});
    return reg;
  };
  const run = async (reg, ...args) => {
    const out = [], err = [], log = console.log, er = console.error;
    console.log = s => out.push(s); console.error = s => err.push(s);
    let r;
    try { r = await M.commands(reg.mods).quiet(args, {}); } finally { console.log = log; console.error = er; }
    return { out: out.join('\n'), err: err.join('\n'), code: r && r.code };
  };
  const status = async reg => (await reg.callRoute(reg.findRoute('GET', '/m/quiet-hours/status'), { actor: owner })).json;
  const finished = (reg, id) => M.emit(reg.mods, 'task.end', { task_id: id, code: 0, workdir: '/w' });

  try {
    // off by default
    const off = M.registry({ modules: { ntfy: true } });
    check('off by default: nothing registered', off.errors.length === 0 && off.settingsFor('quiet-hours') === null && !off.listRoutes().some(r => r.module === 'quiet-hours'));

    // window maths, including across midnight
    const api = mk().api('quiet-hours');
    const day = api.check({ start: '09:00', end: '17:00', urgent_kinds: [] });
    check('same-day window: inside', api.inWindow(day, at(9, 0)) && api.inWindow(day, at(16, 59)));
    check('same-day window: outside', !api.inWindow(day, at(8, 59)) && !api.inWindow(day, at(17, 0)));
    const night = api.check({ start: '23:00', end: '07:30', urgent_kinds: [] });
    check('midnight window: inside late and early', api.inWindow(night, at(23, 0)) && api.inWindow(night, at(2, 0)) && api.inWindow(night, at(7, 29)));
    check('midnight window: outside by day', !api.inWindow(night, at(7, 30)) && !api.inWindow(night, at(12, 0)) && !api.inWindow(night, at(22, 59)));
    check('equal start and end: never quiet', !api.inWindow(api.check({ start: '08:00', end: '08:00', urgent_kinds: [] }), at(8, 0)));

    // bad time setting: clear error, nothing silently held
    let msg = '';
    try { api.check({ start: '25:00', end: '07:30', urgent_kinds: [] }); } catch (e) { msg = e.message; }
    check('bad time: clear error naming the setting and value', /"start" must be a 24-hour time like "23:00", got "25:00"/.test(msg), msg);
    let msg2 = '';
    try { api.check({ start: '23:00', end: '7:30', urgent_kinds: [] }); } catch (e) { msg2 = e.message; }
    check('bad time: "7:30" refused', /"end" must be a 24-hour time/.test(msg2), msg2);
    const errs = [];
    const badReg = mk({ start: 'late' });
    const j = await badReg.startJobs({}, (job, e) => errs.push(e.message));
    await j.stop();
    check('bad time: server start reports it, gate not installed', errs.length === 1 && /got "late"/.test(errs[0]), errs.join('|'));
    const rbad = await run(badReg, 'status');
    check('bad time: command exits 2 with the message', rbad.code === 2 && /got "late"/.test(rbad.err), JSON.stringify(rbad));
    const sbad = (await M.statusLines(badReg.mods, require(path.join(ROOT, 'lib', 'journal')))).join('\n');
    check('bad time: status line shows the message', /got "late"/.test(sbad), sbad);

    // ntfy needs a topic to send; set it the normal way
    mk().updateSettings('ntfy', { topic: 'zq-quiet-topic-77x' }, { save: async () => {} });

    // outside the window: pings pass straight through
    now = at(12, 0);
    let reg = await start();
    await finished(reg, 'a1');
    await settle();
    check('outside window: ping sent, nothing held', hits.length === 1 && hits[0].body === 'Task finished: a1' && (await status(reg)).held === 0, JSON.stringify(hits));

    // inside the window: held, urgent passes
    now = at(23, 30);
    await finished(reg, 'q1');
    await M.emit(reg.mods, 'task.end', { task_id: 'q2', code: 2, workdir: '/w' });
    await settle();
    check('inside window: ordinary pings held, none sent', hits.length === 1);
    let st = await status(reg);
    check('held count in status', st.held === 2 && st.quiet_now === true && st.window === '23:00-07:30', JSON.stringify(st));
    await M.emit(reg.mods, 'card.created', { card_id: 'c1', task_id: 'u1', summary: 's' });
    await settle();
    check('urgent approval ping still sent during quiet hours', hits.length === 2 && hits[1].body === 'Approval waiting: u1', hits[1] && hits[1].body);
    check('urgent ping does not release the queue', (await status(reg)).held === 2);

    // flush by command: one combined ping, queue emptied
    for (let i = 0; i < 5; i++) await finished(reg, 'm' + i);
    await settle();
    check('7 held now', (await status(reg)).held === 7);
    const before = hits.length;
    const fl = await run(reg, 'flush');
    await settle();
    check('flush sends exactly one combined ping', fl.code === 0 && hits.length === before + 1, JSON.stringify(fl));
    const lines = hits[hits.length - 1].body.split('\n');
    check('combined ping: "While quiet: N updates" + 5 titles + more', lines[0] === 'While quiet: 7 updates' && lines.length === 7 && lines[1].startsWith('- Task finished: q1') && lines[6] === 'and 2 more', JSON.stringify(lines));
    check('flush emptied the queue', (await status(reg)).held === 0);
    const none = await run(reg, 'flush');
    check('flush with nothing held sends nothing', none.out === 'nothing held' && hits.length === before + 1, none.out);

    // after the window ends, the next send attempt releases the backlog first
    await finished(reg, 'n1');
    await finished(reg, 'n2');
    now = at(7, 31, 11);
    const b2 = hits.length;
    await finished(reg, 'n3');
    await settle();
    check('after window: backlog goes as one summary, then the new ping', hits.length === b2 + 2 && hits[b2].body.startsWith('While quiet: 2 updates') && hits[b2 + 1].body === 'Task finished: n3', JSON.stringify(hits.slice(b2).map(h => h.body)));
    check('after window: queue empty', (await status(reg)).held === 0);

    // manual override: on during the day, until the next edge
    now = at(12, 0, 11);
    let r = await run(reg, 'on');
    check('quiet on: manual override says quiet now', r.code === 0 && /quiet now: yes, manual on/.test(r.out), r.out);
    const b3 = hits.length;
    await finished(reg, 'o1');
    await settle();
    check('quiet on: ping held in the daytime', hits.length === b3 && (await status(reg)).held === 1);
    now = at(22, 59, 11);
    check('override still on before the edge', (await status(reg)).quiet_now === true);
    now = at(23, 0, 11);
    st = await status(reg);
    check('override expires at the window edge (23:00), window itself is quiet', st.override === null && st.quiet_now === true, JSON.stringify(st));

    // manual off during the night: until the end edge
    now = at(1, 0, 12);
    r = await run(reg, 'off');
    check('quiet off: not quiet during the night', /quiet now: no, manual off/.test(r.out), r.out);
    const b4 = hits.length;
    await finished(reg, 'p1');
    await settle();
    check('quiet off: backlog then the new ping go out', hits.length === b4 + 2 && hits[b4].body.startsWith('While quiet: 1 update') && hits[b4 + 1].body === 'Task finished: p1', JSON.stringify(hits.slice(b4).map(h => h.body)));
    now = at(7, 29, 12);
    check('override off still active before the end edge', (await status(reg)).quiet_now === false);
    now = at(7, 30, 12);
    st = await status(reg);
    check('override off expires at 07:30', st.override === null && st.quiet_now === false, JSON.stringify(st));
    now = at(23, 10, 12);
    check('window works again after the override expired', (await status(reg)).quiet_now === true);

    // custom urgent kinds
    now = at(23, 30, 12);
    reg = await start({ urgent_kinds: ['task_finished'] });
    const b5 = hits.length;
    await finished(reg, 'z1');
    await settle();
    check('custom urgent_kinds: finished passes', hits.length === b5 + 1 && hits[b5].body === 'Task finished: z1');

    // usage and route access
    check('command: bad subcommand exits 2', (await run(reg, 'bogus')).code === 2);
    const found = reg.findRoute('GET', '/m/quiet-hours/status');
    check('route listed as GET /m/quiet-hours/status', !!found && reg.listRoutes().some(x => x.module === 'quiet-hours' && x.access === 'owner'));
    const ok = await reg.callRoute(found, { actor: owner });
    check('route: owner gets 200 with the status', ok.status === 200 && 'held' in ok.json && 'quiet_now' in ok.json, JSON.stringify(ok));
    check('route: worker gets 403', (await reg.callRoute(found, { actor: { kind: 'worker', id: 'w' } })).status === 403);
    check('route: anonymous gets 403', (await reg.callRoute(found, { actor: { kind: 'anonymous', id: '' } })).status === 403);
    check('hold queue never carries the topic', !fs.readFileSync(path.join(process.env.HARNESS_STATE_DIR, 'm', 'quiet-hours', 'quiet.json'), 'utf8').includes('zq-quiet-topic-77x'));
    // ---- agent surface: status --json is readable inside a task; changing the window is not
    {
      const reg = await start({});
      const js = await run(reg, 'status', '--json');
      let parsed = null; try { parsed = JSON.parse(js.out); } catch { /* checked below */ }
      check('quiet status --json prints one JSON object', js.code !== 2 && parsed && typeof parsed === 'object', js.out.slice(0, 100));
      const j2 = await run(reg, '--json');
      check('quiet --json works too', (() => { try { return typeof JSON.parse(j2.out) === 'object'; } catch { return false; } })());
      process.env.HARNESS_TASK_ID = 't-agent';
      try {
        const inside = await run(reg, 'status', '--json');
        check('in a task: status --json still works', (() => { try { return typeof JSON.parse(inside.out) === 'object'; } catch { return false; } })());
        for (const v of ['on', 'off', 'flush']) {
          const rr = await run(reg, v);
          check(`in a task: quiet ${v} refused with exit 2`, rr.code === 2, `${rr.code} ${rr.err}`);
        }
      } catch (e) {
    check('suite ran without throwing', false, e && e.stack);
  } finally { delete process.env.HARNESS_TASK_ID; }
    }
  } finally {
    if (jobs) await jobs.stop();
    srv.closeAllConnections && srv.closeAllConnections();
    srv.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  }
  const failed = results.filter(x => !x).length;
  console.log(`\nresult: ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
})();
