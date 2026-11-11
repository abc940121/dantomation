#!/usr/bin/env node
'use strict';
// roles: editing a group stops the room turns of the people it removes. A queued turn of a removed member is dropped, a running
// one is aborted at once and its task cancelled on the next poll, and archiving a group drops every pending turn. The queue is
// already clean when the PATCH answers 200.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-gturns-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state'); // before the journal is required
delete process.env.HARNESS_BOT;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const { createStore } = require(path.join(ROOT, 'modules', 'roles', 'store'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + label + (!ok && info !== undefined ? ': ' + String(info).slice(0, 300) : '')); };
const owner = { kind: 'owner' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); } return false; };

(async () => {
  const timer = setTimeout(() => { console.log('FAIL timed out'); process.exit(1); }, 60000);
  try {
    const enq = [], cancelled = [];
    let hold = 'main'; // the bot whose task stays running; every other task ends at once
    const tasks = { enqueue: async bot => { const id = 'tk' + (enq.length + 1); enq.push({ bot, id }); return { id }; }, get: async id => ({ state: (enq.find(e => e.id === id) || {}).bot === hold ? 'running' : 'failed' }), cancel: async id => { cancelled.push(id); } };
    const reg = M.registry({ modules: { roles: true, rooms: true }, bots: [{ id: 'main', name: 'Main' }] }, { tasks });
    const store = createStore(() => path.join(process.env.HARNESS_STATE_DIR, 'm', 'roles'));
    const ann = store.create({ name: 'Ann', persona: 'You are Ann.' });
    const bob = store.create({ name: 'Bob', persona: 'You are Bob.' });
    const cy = store.create({ name: 'Cy', persona: 'You are Cy.' });
    await reg.startJobs({});
    const call = async (method, p, body) => { const f = reg.findRoute(method, p); return f ? reg.callRoute(f, { actor: owner, body }) : { status: 404, json: { error: 'no route' } }; };
    const bots = () => enq.map(e => e.bot);
    const status = id => call('GET', '/m/rooms/rooms/' + id + '/status').then(r => r.json);

    // 1. a queued turn of a removed member is dropped
    const g = (await call('POST', '/m/roles/groups', { name: 'Crew', members: [ann.id, bob.id, cy.id] })).json;
    const s1 = await call('POST', '/m/rooms/rooms/' + g.id + '/say', { text: '@everyone go' });
    check('say is accepted', s1.status === 202, JSON.stringify(s1));
    check('the first turn is running', await until(() => bots().length === 1), JSON.stringify(bots()));
    const q0 = await status(g.id);
    check('the others wait in the queue', q0.queue && q0.queue.includes(bob.id) && q0.queue.includes(cy.id), JSON.stringify(q0));
    const r1 = await call('PATCH', '/m/roles/groups/' + g.id, { remove: [bob.id] });
    check('remove answers 200', r1.status === 200, JSON.stringify(r1));
    const q1 = await status(g.id);
    check('the removed member is out of the queue when the 200 comes back', q1.queue && !q1.queue.includes(bob.id) && q1.queue.includes(cy.id), JSON.stringify(q1));
    hold = null;
    await until(() => bots().includes(cy.id) && bots().includes(ann.id), 8000);
    await sleep(700);
    check('the removed member never gets the work', !bots().includes(bob.id), JSON.stringify(bots()));
    check('the others still do', bots().includes(ann.id) && bots().includes(cy.id), JSON.stringify(bots()));

    // 2. a running turn of a removed member is cancelled
    hold = ann.id; enq.length = 0; cancelled.length = 0;
    const g2 = (await call('POST', '/m/roles/groups', { name: 'Two', members: [ann.id, bob.id, cy.id] })).json;
    await call('POST', '/m/rooms/rooms/' + g2.id + '/say', { text: '@everyone go' });
    check('the member turns run until Ann, whose task is held', await until(() => bots().includes(ann.id)), JSON.stringify(bots()));
    const annTask = enq.find(e => e.bot === ann.id).id;
    const r2 = await call('PATCH', '/m/roles/groups/' + g2.id, { remove: [ann.id] });
    check('remove of the running member answers 200', r2.status === 200, JSON.stringify(r2));
    check('the running turn of the removed member is cancelled (within one poll)', await until(() => cancelled.includes(annTask), 3000), JSON.stringify({ cancelled, annTask }));
    hold = null;
    await sleep(900);
    check('the rest of the queue still runs', bots().includes(bob.id) && bots().includes(cy.id), JSON.stringify(bots()));

    // 3. archive drops every pending turn
    hold = 'main'; enq.length = 0; cancelled.length = 0;
    const g3 = (await call('POST', '/m/roles/groups', { name: 'Three', members: [ann.id, bob.id, cy.id] })).json;
    await call('POST', '/m/rooms/rooms/' + g3.id + '/say', { text: '@everyone go' });
    await until(() => bots().length === 1);
    const r3 = await call('PATCH', '/m/roles/groups/' + g3.id, { archived: true });
    check('archive answers 200', r3.status === 200, JSON.stringify(r3));
    const q3 = await status(g3.id).catch(() => null);
    check('the queue is empty when the 200 comes back', !q3 || !q3.queue || q3.queue.length === 0, JSON.stringify(q3));
    check('the running turn is cancelled (within one poll)', await until(() => cancelled.length >= 1, 3000), JSON.stringify(cancelled));
    hold = null;
    await sleep(900);
    check('no further turn is started for the archived group', bots().length === 1, JSON.stringify(bots()));
  } catch (e) { check('no crash', false, e && e.stack); }
  clearTimeout(timer);
  const bad = results.filter(x => !x).length;
  console.log(`result: ${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
