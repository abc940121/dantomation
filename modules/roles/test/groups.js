#!/usr/bin/env node
'use strict';
// roles groups: group_create / group_update / group_remove / group_list, storage, rooms-off error,
// archived roles dropping out, and the rooms module serving a group (main as lead, role members as their own bots).
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-groups-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state'); // before the journal is required
delete process.env.HARNESS_BOT;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const rooms = require(path.join(ROOT, 'modules', 'rooms'));
const rolesMod = require(path.join(ROOT, 'modules', 'roles'));
const { route } = require(path.join(ROOT, 'modules', 'rooms', 'route'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info !== undefined ? ': ' + String(info).slice(0, 300) : ''}`); };
const throws = fn => { try { fn(); return null; } catch (e) { return e.message; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  try {
    const cfg = { modules: { roles: true, rooms: true } };
    const { mods, meta } = M.load(cfg);
    const state = meta.get('roles').state;
    const conf = { modules: { rooms: true }, bots: [{ id: 'main' }] };
    const ctx = { state, config: conf };
    const ctxOff = { state, config: { modules: { rooms: false }, bots: [{ id: 'main' }] } };
    const tools = Object.fromEntries(M.apiOf(mods, 'roles').mcpTools.map(t => [t.name, t]));
    const run = (n, a, c = ctx) => tools[n].run(a, c);
    const gfile = path.join(state.dir, 'groups.json');

    check('the four group tools exist with schemas', ['group_create', 'group_update', 'group_remove', 'group_list'].every(n => tools[n] && tools[n].description && tools[n].inputSchema.type === 'object'));
    const ann = run('role_create', { name: 'Ann', persona: 'You are Ann, a careful planner.' });
    const bob = run('role_create', { name: 'Bob', persona: 'You are Bob, a quick joker.' });
    const xh = run('role_create', { name: '小紅', persona: '你是小紅。' });

    // rooms off
    for (const [n, a] of [['group_create', { name: 'G', members: ['Ann'] }], ['group_update', { group: 'G', name: 'H' }], ['group_remove', { group: 'G' }], ['group_list', {}]]) {
      const e = throws(() => run(n, a, ctxOff)) || '';
      check(`rooms off: ${n} gives a bilingual error`, /Group chats need the rooms module/.test(e) && /[一-鿿]/.test(e), e);
    }
    check('rooms off: nothing was written', !fs.existsSync(gfile));
    check('no config at all counts as off', /Group chats need/.test(throws(() => run('group_list', {}, { state })) || ''));

    // create
    const g = run('group_create', { name: '週末計畫', members: ['Ann', bob.id, 'main'] });
    check('create returns a g-id, the name, main as lead', /^g-[0-9a-f]{8}$/.test(g.id) && g.name === '週末計畫' && g.lead === 'main', JSON.stringify(g));
    check('members are the roles (main is implicit)', g.members.map(m => m.name).join() === 'Ann,Bob', JSON.stringify(g.members));
    check('stored in groups.json as role ids, no temp files', (() => { const j = JSON.parse(fs.readFileSync(gfile, 'utf8')); return j.groups.length === 1 && j.groups[0].members.join() === [ann.id, bob.id].join() && !fs.readdirSync(state.dir).some(f => f.endsWith('.tmp')); })());
    check('empty members refused', /at least one/.test(throws(() => run('group_create', { name: 'Solo', members: [] })) || ''));
    check('only main refused', /at least one/.test(throws(() => run('group_create', { name: 'Solo', members: ['main'] })) || ''));
    check('unknown role refused', /No such role/.test(throws(() => run('group_create', { name: 'X', members: ['Zed'] })) || ''));
    check('members must be a list', /must be a list/.test(throws(() => run('group_create', { name: 'X', members: 'Ann' })) || ''));
    check('duplicate name refused', /already exists/.test(throws(() => run('group_create', { name: ' 週末計畫 ', members: ['Ann'] })) || ''));
    check('empty name refused', !!throws(() => run('group_create', { name: ' ', members: ['Ann'] })));
    check('refusals wrote nothing', run('group_list', {}).groups.length === 1);

    // survives a reload of state (a fresh load reads the same file)
    const reload = M.load(cfg);
    const ctx2 = { state: reload.meta.get('roles').state, config: conf };
    const tools2 = Object.fromEntries(M.apiOf(reload.mods, 'roles').mcpTools.map(t => [t.name, t]));
    const l = tools2.group_list.run({}, ctx2).groups;
    check('list survives a reload of state', l.length === 1 && l[0].id === g.id && l[0].members.length === 2, JSON.stringify(l));

    // update
    check('add a role by name', run('group_update', { group: '週末計畫', add: ['小紅'] }).members.map(m => m.name).join() === 'Ann,Bob,小紅');
    check('add is idempotent', run('group_update', { group: g.id, add: ['Ann'] }).members.length === 3);
    check('remove a role by name', run('group_update', { group: g.id, remove: ['bob'] }).members.map(m => m.name).join() === 'Ann,小紅');
    const u3 = run('group_update', { group: g.id, name: 'Weekend', remove: [xh.id], add: [bob.id] });
    check('rename + add + remove in one call, id kept', u3.name === 'Weekend' && u3.members.map(m => m.name).join() === 'Ann,Bob' && u3.id === g.id, JSON.stringify(u3));
    check('update with nothing refused', /give a new name/.test(throws(() => run('group_update', { group: g.id })) || ''));
    check('update of an unknown group refused', /No group/.test(throws(() => run('group_update', { group: 'nope', name: 'Z' })) || ''));
    check('update needs a group', /group is required/.test(throws(() => run('group_update', { name: 'Z' })) || ''));
    check('removing main is a no-op, main stays the lead', run('group_update', { group: g.id, remove: ['main'] }).lead === 'main');
    check('add of an unknown role refused', /No such role/.test(throws(() => run('group_update', { group: g.id, add: ['Zed'] })) || ''));
    const g2 = run('group_create', { name: 'Other', members: ['Ann'] });
    check('rename onto an existing name refused', /already exists/.test(throws(() => run('group_update', { group: g2.id, name: 'weekend' })) || ''));

    // an archived role drops out of groups, on read
    run('role_remove', { role: 'Bob' });
    check('an archived role drops out of the group', run('group_list', {}).groups.find(x => x.id === g.id).members.map(m => m.name).join() === 'Ann');
    check('the stored file still holds it (dropped on read only)', JSON.parse(fs.readFileSync(gfile, 'utf8')).groups.find(x => x.id === g.id).members.includes(bob.id));

    // rooms module: the group is served through its own routes
    const job = rolesMod.jobs.find(j => j.id === 'rooms-source');
    const stop = job.start({ state, config: conf });
    check('the rooms-source job registers a source and returns a stop function', typeof stop === 'function');
    const enq = [];
    const rctx = (extra = {}) => ({
      settings: { rooms: {}, human_label: 'human', reply_timeout_s: 5, reply_grace_s: 0, poll_ms: 10 },
      state: { append: r => r }, params: {}, query: {}, body: {},
      tasks: { enqueue: async (bot, prompt) => { enq.push({ bot, prompt }); return { id: 't' + enq.length }; }, get: async () => ({ state: 'done' }), cancel: async () => {} },
      ...extra,
    });
    const h = (m, p) => rooms.routes.find(r => r.method === m && r.path === p).handler;
    const lr = h('GET', '/rooms')(rctx()).json;
    const room = lr.rooms.find(r => r.id === g.id);
    check('GET /rooms lists the group, no restart', !!room, JSON.stringify(lr.rooms.map(r => r.id)));
    check('the room carries its display name', room && room.name === 'Weekend', JSON.stringify(room));
    check('main is the lead and a member, then the roles', room && room.lead === 'main' && room.members.map(m => m.id).join() === ['main', ann.id].join(), JSON.stringify(room));
    check('members are shown by role name', room && room.members.map(m => m.name).join() === 'main,Ann');
    check('no routing problems reported', lr.problems.length === 0, JSON.stringify(lr.problems));
    check('status route knows the group, lead is main', h('GET', '/rooms/:id/status')(rctx({ params: { id: g.id } })).json.lead === 'main');
    const R = { id: g.id, lead: room.lead, members: room.members };
    check('route: no mention goes to main (the lead)', route('hello', R).ids.join() === 'main');
    check('route: @<role id> wakes the role', route(`@${ann.id} hi`, R).ids.join() === ann.id);
    check('route: @everyone wakes main and the role', route('@everyone hi', R).ids.join() === ['main', ann.id].join());
    // a turn goes to the role's own bot id
    const say = h('POST', '/rooms/:id/say');
    check('say answers 202', say(rctx({ params: { id: g.id }, body: { text: `@${ann.id} what do you think?` } })).status === 202);
    await sleep(300);
    check('the role member runs as its own bot (task bot = role id)', enq.length >= 1 && enq[0].bot === ann.id, JSON.stringify(enq.map(e => e.bot)));
    const before = enq.length;
    say(rctx({ params: { id: g.id }, body: { text: 'hello all' } }));
    await sleep(300);
    check('a plain message goes to the main bot', enq.length > before && enq[enq.length - 1].bot === 'main', JSON.stringify(enq.map(e => e.bot)));

    // a config room with the same id wins
    const clash = h('GET', '/rooms')(rctx({ settings: { rooms: { [g.id]: { lead: 'x', members: [{ id: 'x', name: 'X' }] } }, human_label: 'human', reply_timeout_s: 5, reply_grace_s: 0, poll_ms: 10 } })).json.rooms.find(r => r.id === g.id);
    check('a config room with the same id wins', clash && clash.lead === 'x', JSON.stringify(clash));

    // archive
    const rmv = run('group_remove', { group: 'Weekend' });
    check('remove archives, never deletes', rmv.archived === true && rmv.id === g.id && !!JSON.parse(fs.readFileSync(gfile, 'utf8')).groups.find(x => x.id === g.id).archived_at);
    check('an archived group leaves group_list', run('group_list', {}).groups.map(x => x.id).join() === g2.id);
    check('an archived group leaves the rooms list at once', !h('GET', '/rooms')(rctx()).json.rooms.some(r => r.id === g.id));
    check('removing it again is refused', /No group/.test(throws(() => run('group_remove', { group: g.id })) || ''));
    check('an archived group name can be reused', run('group_create', { name: 'Weekend', members: ['Ann'] }).id !== g.id);

    // damaged file
    fs.writeFileSync(gfile, '{not json');
    check('a damaged groups.json gives a clear error on the tools', /unreadable/.test(throws(() => run('group_list', {})) || ''));
    check('a failed create leaves the damaged file alone', !!throws(() => run('group_create', { name: 'Y', members: ['Ann'] })) && fs.readFileSync(gfile, 'utf8') === '{not json');
    check('a damaged groups.json adds no rooms and breaks nothing', !h('GET', '/rooms')(rctx()).json.rooms.some(r => /^g-/.test(r.id)));

    stop();
    check('stopping the job removes the source', h('GET', '/rooms')(rctx()).json.rooms.length === 0);
    const off = job.start({ state, config: ctxOff.config });
    check('rooms off: the job registers nothing', typeof off === 'function' && h('GET', '/rooms')(rctx()).json.rooms.length === 0);
  } catch (e) { console.log('FAIL crashed:', e && e.stack); results.push(false); }
  const bad = results.filter(x => !x).length;
  console.log(`result: ${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
