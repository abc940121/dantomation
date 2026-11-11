#!/usr/bin/env node
'use strict';
// roles: POST /m/roles/groups (the chat page's "new group" button): the owner makes a group with no model
// in between. Success, access, name and member validation, de-duplication, and the room showing up.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-route-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state'); // before the journal is required
delete process.env.HARNESS_BOT;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const { createStore } = require(path.join(ROOT, 'modules', 'roles', 'store'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info !== undefined ? ': ' + String(info).slice(0, 300) : ''}`); };
const owner = { kind: 'owner', id: 'test' };

(async () => {
  try {
    const cfg = { modules: { roles: true, rooms: true }, bots: [{ id: 'main', name: 'Main' }] };
    const reg = M.registry(cfg);
    check('loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    check('the route is listed under /m/roles/', reg.listRoutes().some(r => r.method === 'POST' && r.path === '/m/roles/groups'));
    const store = createStore(() => path.join(process.env.HARNESS_STATE_DIR, 'm', 'roles'));
    const ann = store.create({ name: 'Ann', persona: 'You are Ann.' });
    const bob = store.create({ name: 'Bob', persona: 'You are Bob.' });
    const old = store.create({ name: 'Old', persona: 'You are Old.' });
    store.archive(old.id);
    const jobs = await reg.startJobs({}); // the rooms-source job lets the rooms module list the groups
    const post = async (body, actor = owner) => {
      const found = reg.findRoute('POST', '/m/roles/groups');
      return found ? reg.callRoute(found, { actor, body }) : { status: 404, json: {} };
    };
    const rooms = async () => { const f = reg.findRoute('GET', '/m/rooms/rooms'); return f ? (await reg.callRoute(f, { actor: owner })).json : null; };

    const ok = await post({ name: '  Weekend  ', members: [ann.id, bob.id, ann.id], extra: 'ignored' });
    check('success answers 201 with the group', ok.status === 201 && /^g-[0-9a-f]{8}$/.test(ok.json.id) && ok.json.name === 'Weekend', JSON.stringify(ok));
    check('the name is trimmed and duplicate ids are dropped', ok.json.members.map(m => m.id).join() === [ann.id, bob.id].join(), JSON.stringify(ok.json));
    const rl = await rooms();
    check('the new group is a room (the answer id opens it)', rl && Array.isArray(rl.rooms) && rl.rooms.some(r => r.id === ok.json.id), JSON.stringify(rl));
    check('the group is saved', fs.readFileSync(path.join(process.env.HARNESS_STATE_DIR, 'm', 'roles', 'groups.json'), 'utf8').includes(ok.json.id));

    const bad = async (label, body, re) => { const r = await post(body); check(label, r.status === 400 && typeof r.json.error === 'string' && re.test(r.json.error), JSON.stringify(r)); };
    check('a worker or public caller is refused', (await post({ name: 'X', members: [ann.id] }, { kind: 'worker', id: 'w' })).status === 403 && (await post({ name: 'X', members: [ann.id] }, { kind: 'public' })).status === 403);
    await bad('no name', { members: [ann.id] }, /name/);
    await bad('a blank name', { name: '   ', members: [ann.id] }, /name/);
    await bad('a name over 40 characters', { name: 'x'.repeat(41), members: [ann.id] }, /name/);
    await bad('a name that is not text', { name: 5, members: [ann.id] }, /name/);
    await bad('empty members', { name: 'Solo', members: [] }, /members/);
    await bad('members that are not a list', { name: 'Solo', members: ann.id }, /members/);
    await bad('more than 16 members', { name: 'Big', members: Array.from({ length: 17 }, () => ann.id) }, /members/);
    await bad('a 41-character name', { name: 'y'.repeat(41), members: [ann.id] }, /name/);
    await bad('an empty name', { name: '', members: [ann.id] }, /name/);
    await bad('an unknown role id is not skipped', { name: 'Ghost', members: [ann.id, 'r-00000000'] }, /r-00000000/);
    await bad('a role name is not an id', { name: 'ByName', members: ['Ann'] }, /Ann/);
    await bad('an archived role is refused', { name: 'Gone', members: [old.id] }, new RegExp(old.id));
    await bad('a duplicate group name is refused', { name: 'weekend', members: [bob.id] }, /weekend|Weekend/i);
    check('a refused request left only the one group', JSON.parse(fs.readFileSync(path.join(process.env.HARNESS_STATE_DIR, 'm', 'roles', 'groups.json'), 'utf8')).groups.length === 1);
    check('a missing body is a 400, not a crash', (await post(undefined)).status === 400);

    const off = M.registry({ modules: { roles: true, rooms: false }, bots: [{ id: 'main' }] });
    const f2 = off.findRoute('POST', '/m/roles/groups');
    const r2 = await off.callRoute(f2, { actor: owner, body: { name: 'NoRooms', members: [ann.id] } });
    check('rooms off: a clear 400 and nothing saved', r2.status === 400 && /rooms/i.test(r2.json.error) && JSON.parse(fs.readFileSync(path.join(process.env.HARNESS_STATE_DIR, 'm', 'roles', 'groups.json'), 'utf8')).groups.length === 1, JSON.stringify(r2));
    const devNote = await post({ name: 'Phone Made', members: [bob.id] }, { kind: 'owner', id: 'device:abc12345' });
    const jr = fs.readFileSync(path.join(process.env.HARNESS_STATE_DIR, 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.type === 'group_created' && r.id === devNote.json.id)[0];
    check('the journal note holds the name, the member ids and who made the group', devNote.status === 201 && jr && jr.name === 'Phone Made' && jr.members.join() === bob.id && jr.by === 'device:abc12345', JSON.stringify(jr));
    // device callers: the audit line is fail-closed (written first; no line, no group)
    const J = require(path.join(ROOT, 'lib', 'journal'));
    const realAppend = J.append, gfile = path.join(process.env.HARNESS_STATE_DIR, 'm', 'roles', 'groups.json');
    const groupsNow = () => JSON.parse(fs.readFileSync(gfile, 'utf8')).groups;
    const lines = type => { try { return fs.readFileSync(path.join(process.env.HARNESS_STATE_DIR, 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.type === type); } catch { return []; } };
    const phone = { kind: 'owner', id: 'device:abc12345' };
    let seen = null;
    J.append = rec => { if (rec && rec.type === 'group_created') seen = { count: groupsNow().length, rec }; return realAppend.call(J, rec); };
    const before = groupsNow().length;
    const dOk = await post({ name: 'Phone Order', members: [ann.id] }, phone);
    check('device: normal create answers 201', dOk.status === 201, JSON.stringify(dOk));
    check('device: the journal line was written before the group was stored', seen && seen.count === before && groupsNow().length === before + 1, JSON.stringify(seen));
    check('device: the line holds the group id, name, members and by', seen && seen.rec.id === dOk.json.id && seen.rec.name === 'Phone Order' && seen.rec.members.join() === ann.id && seen.rec.by === phone.id, JSON.stringify(seen));
    J.append = rec => { if (rec && rec.type === 'group_created') throw new Error('journal is full'); return realAppend.call(J, rec); };
    const n1 = groupsNow().length;
    const dFail = await post({ name: 'Phone Fail', members: [ann.id] }, phone);
    check('device: a journal failure is a 500 with a short error', dFail.status === 500 && typeof dFail.json.error === 'string' && dFail.json.error.length < 200, JSON.stringify(dFail));
    check('device: a journal failure creates no group', groupsNow().length === n1 && !groupsNow().some(g => g.name === 'Phone Fail'));
    const oFail = await post({ name: 'Owner Best Effort', members: [ann.id] }, owner);
    check('owner: a journal failure is a 500 and creates no group (same path as a phone)', oFail.status === 500 && groupsNow().length === n1 && !groupsNow().some(g => g.name === 'Owner Best Effort'), JSON.stringify(oFail));
    const c0 = lines('group_created').length;
    J.append = rec => { if (rec && rec.type === 'group_created') seen = rec; return realAppend.call(J, rec); };
    const dBad = await post({ name: 'Phone Bad', members: ['r-00000000'] }, phone);
    const dDup = await post({ name: 'phone order', members: [ann.id] }, phone);
    check('device: an invalid request is a 400 and writes no group_created line', dBad.status === 400 && dDup.status === 400 && lines('group_created').length === c0 && groupsNow().length === n1, JSON.stringify([dBad, dDup]));
    J.append = realAppend;
    await jobs.stop();
  } catch (e) { console.log('FAIL crashed:', e && e.stack); results.push(false); }
  const badN = results.filter(x => !x).length;
  console.log(`result: ${results.length - badN} passed, ${badN} failed`);
  process.exit(badN ? 1 : 0);
})();
