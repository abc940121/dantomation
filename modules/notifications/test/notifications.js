#!/usr/bin/env node
'use strict';
// notifications: in-process, fresh temp state dir, no network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notifications-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state'); // before the journal is required
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));
const { redact } = require('../store');

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const OWNER = { kind: 'owner', id: 'test' };

(async () => {
  try {
    const off = M.registry({ modules: { notifications: false } });
    check('off: nothing registered', off.errors.length === 0 && !off.listRoutes().length && off.settingsFor('notifications') === null);

    const reg = M.registry({ modules: { notifications: true }, notifications: { max_entries: 10 } });
    check('on: loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    check('settings merged', reg.settingsFor('notifications').max_entries === 10 && reg.settingsFor('notifications').kind_task_failed === true);
    const call = (method, url, ctx = {}) => reg.callRoute(reg.findRoute(method, url), { actor: OWNER, query: Object.fromEntries(new URL(url, 'http://x').searchParams), ...ctx });
    const emit = (ev, p) => M.emit(reg.mods, ev, p);

    await emit('card.created', { card_id: 'c1', task_id: 't1', summary: 'run the made-up script', rule: 'r', expires_at: 'x' });
    await emit('task.end', { task_id: 't1', code: 1, workdir: '/w' });
    await emit('task.end', { task_id: 't2', code: 0, workdir: '/w' });
    await emit('question.asked', { question_id: 'q1', task_id: 't3', text: 'which colour?' });
    await emit('rooms.mention', { room: 'lab', target: 'owner', text: 'ping', msg_id: 'm1' });
    await emit('rooms.mention', { room: 'lab', target: 'bot-a', text: 'not for the owner' });
    let r = await call('GET', '/m/notifications/list');
    check('five events recorded, bot mention ignored', r.status === 200 && r.json.total === 5, JSON.stringify(r.json.total));
    check('newest first, kinds right', r.json.items.map(i => i.kind).join() === 'room_mention,question_asked,task_finished,task_failed,card_pending');
    check('entries unread', r.json.items.every(i => i.read === false));
    r = await call('GET', '/m/notifications/unread-count');
    check('unread count 5', r.json.unread === 5);

    r = await call('GET', '/m/notifications/list?limit=2&offset=1');
    check('paging', r.json.items.length === 2 && r.json.items[0].kind === 'question_asked' && r.json.total === 5);

    r = await call('POST', '/m/notifications/1/read');
    check('mark one read', r.status === 200 && r.json.read === true);
    r = await call('GET', '/m/notifications/list?unread=1');
    check('unread filter', r.json.total === 4 && r.json.items.every(i => !i.read));
    check('mark missing id is 404', (await call('POST', '/m/notifications/999/read')).status === 404);
    check('mark bad id is 400', (await call('POST', '/m/notifications/abc/read')).status === 400);
    check('bad limit is 400', (await call('GET', '/m/notifications/list?limit=0')).status === 400);
    check('bad offset is 400', (await call('GET', '/m/notifications/list?offset=-1')).status === 400);
    check('bad unread is 400', (await call('GET', '/m/notifications/list?unread=maybe')).status === 400);
    r = await call('POST', '/m/notifications/read-all');
    check('mark all read', r.json.marked === 4 && (await call('GET', '/m/notifications/unread-count')).json.unread === 0);

    check('non-owner is forbidden', (await call('GET', '/m/notifications/list', { actor: { kind: 'worker', id: 'w' } })).status === 403);
    check('anonymous is forbidden', (await call('POST', '/m/notifications/read-all', { actor: { kind: 'anonymous' } })).status === 403);

    // per-kind switch
    r = await call('PUT', '/m/notifications/kinds', { body: { task_finished: false } });
    check('kind switched off', r.status === 200 && r.json.kinds.task_finished === false && r.json.kinds.task_failed === true);
    await emit('task.end', { task_id: 't4', code: 0 });
    check('disabled kind not recorded', (await call('GET', '/m/notifications/unread-count')).json.unread === 0);
    await call('PUT', '/m/notifications/kinds', { body: { task_finished: null } });
    await emit('task.end', { task_id: 't5', code: 0 });
    check('override cleared, recorded again', (await call('GET', '/m/notifications/unread-count')).json.unread === 1);
    check('bad kind 400', (await call('PUT', '/m/notifications/kinds', { body: { nope: true } })).status === 400);
    check('bad value 400', (await call('PUT', '/m/notifications/kinds', { body: { task_failed: 'yes' } })).status === 400);
    check('non-object body 400', (await call('PUT', '/m/notifications/kinds', { body: [1] })).status === 400);
    check('proto key refused', (await call('PUT', '/m/notifications/kinds', { body: JSON.parse('{"__proto__":true}') })).status === 400);

    // setting default off
    const reg2 = M.registry({ modules: { notifications: true }, notifications: { kind_task_failed: false } });
    check('setting default off', reg2.errors.length === 0 && reg2.settingsFor('notifications').kind_task_failed === false);

    // bounded
    for (let i = 0; i < 30; i++) await emit('task.end', { task_id: 'b' + i, code: 1 });
    r = await call('GET', '/m/notifications/list?limit=200');
    check('cap enforced', r.json.total === 10, String(r.json.total));
    check('newest kept', r.json.items[0].task_id === 'b29');
    // read entries pruned before unread ones
    await call('POST', '/m/notifications/read-all');
    const oldestUnread = (await call('GET', '/m/notifications/list?limit=200')).json.items.slice(-1)[0].id;
    await emit('task.end', { task_id: 'z', code: 1 });
    r = await call('GET', '/m/notifications/list?limit=200');
    check('prune drops oldest read first', r.json.total === 10 && !r.json.items.some(i => i.id === oldestUnread));

    // sanitising
    const secret = 'abcdef0123456789abcdef0123456789abcdef';
    await emit('card.created', { card_id: 'c<>2', task_id: 't', summary: 'token=hunter2hunter2 and Bearer abcdefgh12345678 and ' + secret + ' ' + 'x'.repeat(500) });
    r = await call('GET', '/m/notifications/list?limit=1');
    const it = r.json.items[0];
    check('secrets hidden and text capped', !/hunter2|abcdefgh12|abcdef0123/.test(it.text) && it.text.length <= 200, it.text.slice(0, 80));
    check('ref sanitised', it.ref === 'c2');
    const recs = J.readAll().records.filter(x => x.module === 'notifications');
    check('journal has ids only', recs.length > 0 && recs.every(x => x.type === 'notification_created' && x.text === undefined));
    check('redact is bounded', redact('y '.repeat(1000)).length <= 200 && redact(null) === '');

    // survives a fresh registry (persisted)
    const reg3 = M.registry({ modules: { notifications: true } });
    const r3 = await reg3.callRoute(reg3.findRoute('GET', '/m/notifications/unread-count'), { actor: OWNER });
    check('state persisted on disk', r3.json.unread === 2);
  } catch (e) { check('no exception', false, e.stack); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  process.exit(n === results.length ? 0 : 1);
})();
