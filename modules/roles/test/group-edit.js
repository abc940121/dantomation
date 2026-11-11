#!/usr/bin/env node
'use strict';
// roles: PATCH /m/roles/groups/:id (rename, add or remove members, archive). Same 400 shapes as the create route, 404 for an
// unknown or archived id, a group never ends with no role member, the audit line goes in before the change, archived stays readable.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-gedit-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state'); // before the journal is required
delete process.env.HARNESS_BOT;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));
const { createStore } = require(path.join(ROOT, 'modules', 'roles', 'store'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + label + (!ok && info !== undefined ? ': ' + String(info).slice(0, 300) : '')); };
const owner = { kind: 'owner' };
const device = { kind: 'owner', id: 'device:d1' };

(async () => {
  try {
    const cfg = { modules: { roles: true, rooms: true }, bots: [{ id: 'main', name: 'Main' }] };
    const reg = M.registry(cfg);
    check('loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    check('the route is listed', reg.listRoutes().some(r => r.method === 'PATCH' && r.path === '/m/roles/groups/:id'));
    const store = createStore(() => path.join(process.env.HARNESS_STATE_DIR, 'm', 'roles'));
    const ann = store.create({ name: 'Ann', persona: 'You are Ann.' });
    const bob = store.create({ name: 'Bob', persona: 'You are Bob.' });
    const cy = store.create({ name: 'Cy', persona: 'You are Cy.' });
    const old = store.create({ name: 'Old', persona: 'You are Old.' });
    store.archive(old.id);
    await reg.startJobs({});
    const call = async (method, p, body, actor = owner) => { const f = reg.findRoute(method, p); return f ? reg.callRoute(f, { actor, body }) : { status: 404, json: { error: 'no route' } }; };
    const post = (body, actor) => call('POST', '/m/roles/groups', body, actor);
    const patch = (id, body, actor) => call('PATCH', '/m/roles/groups/' + id, body, actor);
    const ids = g => g.members.map(m => m.id).sort().join();
    const lines = type => J.readAll().records.filter(r => r.type === type);
    const gfile = () => fs.readFileSync(path.join(process.env.HARNESS_STATE_DIR, 'm', 'roles', 'groups.json'), 'utf8');

    const g = (await post({ name: 'Team', members: [ann.id, bob.id] })).json;
    await post({ name: 'Other', members: [ann.id] });

    const r1 = await patch(g.id, { name: '  Crew  ' });
    check('rename: 200, trimmed, saved', r1.status === 200 && r1.json.name === 'Crew' && gfile().includes('Crew'), JSON.stringify(r1));
    const r2 = await patch(g.id, { add: [cy.id, cy.id] });
    check('add: member joins once', r2.status === 200 && ids(r2.json) === [ann.id, bob.id, cy.id].sort().join(), JSON.stringify(r2));
    const r3 = await patch(g.id, { remove: [bob.id] });
    check('remove: member leaves', r3.status === 200 && ids(r3.json) === [ann.id, cy.id].sort().join(), JSON.stringify(r3));
    const r4 = await patch(g.id, { name: 'Squad', add: [bob.id], remove: [cy.id] });
    check('several changes in one call', r4.status === 200 && r4.json.name === 'Squad' && ids(r4.json) === [ann.id, bob.id].sort().join(), JSON.stringify(r4));

    // refusals change nothing
    const before = gfile();
    const bad = async (label, id, body, status, re, actor) => { const r = await patch(id, body, actor); check(label, r.status === status && typeof r.json.error === 'string' && re.test(r.json.error) && gfile() === before, JSON.stringify(r)); };
    await bad('unknown id is 404', 'g-00000000', { name: 'X' }, 404, /group|群組/);
    await bad('a malformed id is 404', 'nope', { name: 'X' }, 404, /group|群組/);
    await bad('a blank name', g.id, { name: '   ' }, 400, /name|名稱/);
    await bad('a name over 40 characters', g.id, { name: 'x'.repeat(41) }, 400, /name|名稱/);
    await bad('a name taken by another group', g.id, { name: 'Other' }, 400, /Other/);
    await bad('an empty body', g.id, {}, 400, /name|add|remove|新名稱/);
    await bad('add with an unknown role id', g.id, { add: ['r-nope'] }, 400, /role|角色/);
    await bad('add with an archived role', g.id, { add: [old.id] }, 400, /role|角色/);
    await bad('remove with an unknown role id', g.id, { remove: ['r-nope'] }, 400, /role|角色/);
    await bad('add that is not a list', g.id, { add: ann.id }, 400, /add/);
    await bad('archived must be true', g.id, { archived: false }, 400, /archived/);
    await bad('archive plus other fields', g.id, { archived: true, name: 'Z' }, 400, /archive|封存/);
    await bad('removing every member (group would have none)', g.id, { remove: [ann.id, bob.id] }, 400, /member|成員/);
    const solo = (await post({ name: 'Solo', members: [ann.id] })).json;
    const before2 = gfile();
    const rs = await patch(solo.id, { remove: [ann.id] });
    check('removing the last member is refused', rs.status === 400 && /member|成員/.test(rs.json.error) && gfile() === before2, JSON.stringify(rs));
    const w = await patch(g.id, { name: 'W' }, { kind: 'worker', id: 'w' });
    const pub = await patch(g.id, { name: 'W' }, { kind: 'public' });
    check('a worker or public caller is refused', w.status === 403 && pub.status === 403 && gfile() === before2);

    // the audit line goes in first, with the caller
    const dev = await patch(g.id, { name: 'FromPhone' }, device);
    check('a device caller: renamed, audit line carries by', dev.status === 200 && lines('group_update_started').some(r => r.group === g.id && r.by === 'device:d1'), JSON.stringify(dev));
    const own = await patch(g.id, { name: 'FromDesk' });
    check('the owner: audit line carries by owner', own.status === 200 && lines('group_update_started').some(r => r.by === 'owner'));

    // archive: 200, the group is archived, stays readable, can no longer be edited
    const doomed = (await post({ name: 'Doomed', members: [bob.id] })).json;
    const ar = await patch(doomed.id, { archived: true }, device);
    check('archive: 200 with archived_at, audited first', ar.status === 200 && !!ar.json.archived_at && lines('group_remove_started').some(r => r.group === doomed.id && r.by === 'device:d1'), JSON.stringify(ar));
    check('archived group stays in the file', gfile().includes(doomed.id) && gfile().includes('archived_at'));
    const again = await patch(doomed.id, { name: 'Back' });
    check('an archived group is 404 for edits and archive', again.status === 404 && (await patch(doomed.id, { archived: true })).status === 404);
    const rl = (await call('GET', '/m/rooms/rooms', undefined)).json;
    check('live groups are listed as rooms', rl && Array.isArray(rl.rooms) && rl.rooms.some(r => r.id === g.id), JSON.stringify(rl).slice(0, 200));
    // ---- review findings (merged head): final member count, hidden main id, odd values, audit order, fail-closed
    // every journal write is seen here with the groups file as it was at that moment; a type in `failing` is refused
    const realAppend = J.append, seen = [], failing = new Set();
    J.append = rec => { seen.push({ type: rec.type, file: gfile() }); if (failing.has(rec.type)) throw new Error('journal refused'); return realAppend(rec); };
    try {
      // finding 3: a stored main-role id must not count as a role member
      const mainId = (await call('GET', '/m/roles/main')).json.id;
      check('main role exists for the count test', /^r-[0-9a-f]{8}$/.test(mainId), mainId);
      const withMain = (await post({ name: 'WithMain', members: [mainId, ann.id] })).json;
      check('a group may be made with the main role id among the members', !!withMain && /^g-/.test(withMain.id), JSON.stringify(withMain));
      const bw = gfile();
      const rm = await patch(withMain.id, { remove: [ann.id] });
      check('removing the last visible member is refused (the stored main id does not count)', rm.status === 400 && /member|成員/.test(rm.json.error) && gfile() === bw, JSON.stringify(rm));

      // finding 2: the cap counts the final deduplicated members
      const many = [];
      for (let i = 0; i < 17; i++) many.push(store.create({ name: 'Mem' + i, persona: 'You are Mem' + i + '.' }).id);
      const full = (await post({ name: 'Full', members: many.slice(0, 16) })).json;
      check('a group of 16 is made', !!full && full.members.length === 16, JSON.stringify(full));
      const bf = gfile();
      const over = await patch(full.id, { add: [many[16]] });
      check('add-one to a full group is refused (would be 17)', over.status === 400 && /16/.test(over.json.error) && gfile() === bf, JSON.stringify(over));
      const dup = await patch(full.id, { add: [many[0]] });
      check('adding a member already in a full group is not growth', dup.status === 200 && dup.json.members.length === 16, JSON.stringify(dup));
      const swap = await patch(full.id, { add: [many[16]], remove: [many[0]] });
      check('swapping one in and one out of a full group is fine', swap.status === 200 && swap.json.members.length === 16, JSON.stringify(swap));

      // finding 4: a value whose toString is not callable is a 400, never a 500
      const weird = { toString: null };
      for (const [label, body] of [['add', { add: [weird] }], ['remove', { remove: [weird] }], ['name', { name: weird }]]) {
        const r = await patch(g.id, body);
        check('an odd ' + label + ' value is 400', r.status === 400 && typeof r.json.error === 'string', JSON.stringify(r));
      }
      const rp = await post({ name: 'Odd', members: [weird] });
      check('an odd member value on create is 400', rp.status === 400, JSON.stringify(rp));

      // finding 5 and 7: audit first, and a refused audit line blocks the change
      seen.length = 0;
      const mk = await post({ name: 'OwnerMade', members: [bob.id] });
      const mkSeen = seen.find(x => x.type === 'group_created');
      check('owner create: audit line comes before the save', mk.status === 201 && !!mkSeen && !mkSeen.file.includes('OwnerMade'), JSON.stringify(mkSeen && mkSeen.file.slice(-120)));
      failing.add('group_created');
      const bm = gfile();
      const mk2 = await post({ name: 'NoAudit', members: [bob.id] });
      check('owner create: a refused audit line means 500 and no group', mk2.status === 500 && gfile() === bm && !gfile().includes('NoAudit'), JSON.stringify(mk2));
      failing.delete('group_created');

      seen.length = 0;
      const up = await patch(g.id, { name: 'OrderCheck' }, device);
      const upSeen = seen.find(x => x.type === 'group_update_started');
      check('update: the audit line is written before the change', up.status === 200 && !!upSeen && !upSeen.file.includes('OrderCheck') && gfile().includes('OrderCheck'), JSON.stringify(upSeen && upSeen.file.slice(-120)));
      failing.add('group_update_started');
      const bu = gfile();
      const up2 = await patch(g.id, { name: 'Blocked' }, device);
      check('update: a refused audit line means 500 and no change', up2.status === 500 && gfile() === bu, JSON.stringify(up2));
      failing.delete('group_update_started');

      const vic = (await post({ name: 'Victim', members: [cy.id] })).json;
      seen.length = 0;
      const ar2 = await patch(vic.id, { archived: true }, device);
      const arSeen = seen.find(x => x.type === 'group_remove_started');
      check('archive: the audit line is written before the change', ar2.status === 200 && !!arSeen && !(JSON.parse(arSeen.file).groups.find(x => x.id === vic.id) || {}).archived_at && !!(JSON.parse(gfile()).groups.find(x => x.id === vic.id) || {}).archived_at, JSON.stringify(arSeen && arSeen.file.slice(-120)));
      const vic2 = (await post({ name: 'Victim2', members: [cy.id] })).json;
      failing.add('group_remove_started');
      const ba = gfile();
      const ar3 = await patch(vic2.id, { archived: true }, device);
      check('archive: a refused audit line means 500 and the group stays', ar3.status === 500 && gfile() === ba, JSON.stringify(ar3));
      failing.delete('group_remove_started');
    } finally { J.append = realAppend; }
  } catch (e) { console.log('FAIL crashed: ' + (e && e.stack)); results.push(false); }
  const nbad = results.filter(x => !x).length;
  console.log('result: ' + (results.length - nbad) + ' passed, ' + nbad + ' failed');
  process.exit(nbad ? 1 : 0);
})();
