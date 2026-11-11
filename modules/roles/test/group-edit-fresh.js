#!/usr/bin/env node
'use strict';
// roles: a group edited WITHOUT the engine hearing about it (the group file changed by another process, or a tool call that has no
// ctx.api so stopTurns does nothing) still stops the removed member: rooms reads the membership fresh before each turn and before
// each reply is posted. Also: a group of only the main role has no visible member and is refused (same minimum as an edit).
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-gfresh-'));
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
    const enq = [];
    let hold = 'main'; // the bot whose task stays running; every other task ends at once
    const tasks = { enqueue: async bot => { const id = 'tk' + (enq.length + 1); enq.push({ bot, id }); return { id }; }, get: async id => ({ state: (enq.find(e => e.id === id) || {}).bot === hold ? 'running' : 'failed' }), cancel: async () => {} };
    const reg = M.registry({ modules: { roles: true, rooms: true }, bots: [{ id: 'main', name: 'Main' }] }, { tasks });
    const dir = path.join(process.env.HARNESS_STATE_DIR, 'm', 'roles');
    const store = createStore(() => dir);
    const ann = store.create({ name: 'Ann', persona: 'You are Ann.' });
    const bob = store.create({ name: 'Bob', persona: 'You are Bob.' });
    const cy = store.create({ name: 'Cy', persona: 'You are Cy.' });
    await reg.startJobs({});
    const call = async (method, p, body) => { const f = reg.findRoute(method, p); return f ? reg.callRoute(f, { actor: owner, body }) : { status: 404, json: { error: 'no route' } }; };
    const bots = () => enq.map(e => e.bot);
    const groupsFile = path.join(dir, 'groups.json');
    // the group changes on disk only: no PATCH, no dropTurns, nothing the engine could hear
    const editFile = (id, fn) => { const j = JSON.parse(fs.readFileSync(groupsFile, 'utf8')); fn(j.groups.find(g => g.id === id)); fs.writeFileSync(groupsFile, JSON.stringify(j)); };

    // 1. a member removed in the file is never run; the others and a second group (the isolation control) are
    const g = (await call('POST', '/m/roles/groups', { name: 'Crew', members: [ann.id, bob.id, cy.id] })).json;
    const ctl = (await call('POST', '/m/roles/groups', { name: 'Control', members: [ann.id, bob.id, cy.id] })).json;
    await call('POST', '/m/rooms/rooms/' + g.id + '/say', { text: '@everyone go' });
    check('the first turn is running', await until(() => bots().length === 1), JSON.stringify(bots()));
    editFile(g.id, x => { x.members = x.members.filter(m => m !== bob.id); });
    hold = null;
    await until(() => bots().includes(cy.id), 8000);
    await sleep(600);
    check('a member removed in the group file never gets the work', !bots().includes(bob.id), JSON.stringify(bots()));
    check('the others in that group still do', bots().includes(ann.id) && bots().includes(cy.id), JSON.stringify(bots()));
    enq.length = 0;
    await call('POST', '/m/rooms/rooms/' + ctl.id + '/say', { text: '@everyone go' });
    await until(() => bots().length >= 3, 8000);
    check('control: the same member in the untouched group is still run', bots().includes(bob.id), JSON.stringify(bots()));

    // 2. a group archived in the file: a queued turn is not started
    hold = 'main'; enq.length = 0;
    const g2 = (await call('POST', '/m/roles/groups', { name: 'Two', members: [ann.id, bob.id, cy.id] })).json;
    await call('POST', '/m/rooms/rooms/' + g2.id + '/say', { text: '@everyone go' });
    await until(() => bots().length === 1);
    editFile(g2.id, x => { x.archived_at = new Date().toISOString(); });
    hold = null;
    await sleep(900);
    check('a group archived in the file: no further turn is started', bots().length === 1, JSON.stringify(bots()));

    // 3. a group made of only the main role has no visible member: refused, and nothing is created
    const mainRole = (await call('GET', '/m/roles/main')).json;
    const before = (await call('GET', '/m/roles/groups')).json;
    const bad = await call('POST', '/m/roles/groups', { name: 'Only main', members: [mainRole.id] });
    check('a group of only the main role id is refused with 400', bad.status === 400, JSON.stringify(bad));
    const bad2 = await call('POST', '/m/roles/groups', { name: 'Only main too', members: ['main'] });
    check('a group of only the word main is refused with 400', bad2.status === 400, JSON.stringify(bad2));
    const after = (await call('GET', '/m/roles/groups')).json;
    check('no group was created by the refused requests', JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }));
    const okMix = await call('POST', '/m/roles/groups', { name: 'Main and Ann', members: [mainRole.id, ann.id] });
    check('control: the main role plus a real member is accepted', okMix.status === 201 || okMix.status === 200, JSON.stringify(okMix));
  } catch (e) { check('no crash', false, e && e.stack); }
  clearTimeout(timer);
  const bad = results.filter(x => !x).length;
  console.log(`result: ${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
