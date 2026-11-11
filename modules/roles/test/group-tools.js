#!/usr/bin/env node
'use strict';
// roles group tools in the routes' manner: a _started line first (fail closed when it cannot be written), `by` from HARNESS_BOT
// else 'tool', no restore / archived-list tool, and the card field sentences / labels coming from card.FIELDS.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-gtools-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state'); // before the journal is required
delete process.env.HARNESS_BOT;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));
const card = require(path.join(ROOT, 'modules', 'roles', 'card'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info !== undefined ? ': ' + String(info).slice(0, 300) : ''}`); };
const throws = fn => { try { fn(); return null; } catch (e) { return e.message; } };

(async () => {
  try {
    const { mods, meta } = M.load({ modules: { roles: true, rooms: true } });
    const state = meta.get('roles').state;
    const conf = { modules: { rooms: true }, bots: [{ id: 'main' }] };
    const gfile = path.join(state.dir, 'groups.json');
    const gtext = () => (fs.existsSync(gfile) ? fs.readFileSync(gfile, 'utf8') : '');
    // every journal line is seen with the groups file as it was at that moment; a type in `refuse` cannot be written
    const refuse = new Set(), seen = [];
    const ctx = { config: conf, state: { ...state, dir: state.dir, append: rec => { seen.push({ type: rec.type, file: gtext() }); if (refuse.has(rec.type)) throw new Error('journal refused'); return state.append(rec); } } };
    const api = M.apiOf(mods, 'roles');
    const tools = Object.fromEntries(api.mcpTools.map(t => [t.name, t]));
    const run = (n, a) => tools[n].run(a, ctx);
    const lines = type => J.readAll().records.filter(r => r.type === type);

    run('role_create', { name: 'Ann', persona: 'You are Ann.' });
    run('role_create', { name: 'Bob', persona: 'You are Bob.' });

    // 1. journal first
    const g = run('group_create', { name: 'Trip', members: ['Ann'] });
    const cs = seen.find(s => s.type === 'group_create_started');
    check('create: the _started line is written before the group exists', cs && !cs.file.includes('Trip'), cs && cs.file);
    check('create: _started then group_created, by "tool" via tool, same id',
      lines('group_create_started').some(r => r.id === g.id && r.by_claimed === 'tool' && r.via === 'tool') && lines('group_created').some(r => r.id === g.id && r.by_claimed === 'tool' && r.via === 'tool'));
    refuse.add('group_create_started');
    const before = gtext();
    const e1 = throws(() => run('group_create', { name: 'Nope', members: ['Ann'] })) || '';
    check('create: a refused audit line means no group (fail closed, two languages)', /audit line/.test(e1) && /[一-鿿]/.test(e1) && gtext() === before && !lines('group_created').some(r => r.name === 'Nope'), e1);
    refuse.clear();

    const ub = gtext();
    refuse.add('group_update_started');
    const e2 = throws(() => run('group_update', { group: 'Trip', name: 'Trip2', add: ['Bob'] })) || '';
    check('update: a refused audit line means no change', /audit line/.test(e2) && gtext() === ub, e2);
    refuse.clear();
    const u = run('group_update', { group: 'Trip', name: 'Trip2', add: ['Bob'] });
    const us = seen.filter(s => s.type === 'group_update_started').pop();
    check('update: _started written before the change; result line carries by', us && !us.file.includes('Trip2') && u.name === 'Trip2' && lines('group_update_started').some(r => r.group === g.id && r.by_claimed === 'tool') && lines('group_updated').some(r => r.id === g.id && r.by_claimed === 'tool'), us && us.file);
    const nBefore = lines('group_update_started').length;
    check('update: a bad request leaves no _started line', !!throws(() => run('group_update', { group: 'Trip2', add: ['Zed'] })) && !!throws(() => run('group_update', { group: 'nobody', name: 'X' })) && lines('group_update_started').length === nBefore);

    const rb = gtext();
    refuse.add('group_remove_started');
    const e3 = throws(() => run('group_remove', { group: 'Trip2' })) || '';
    check('remove: a refused audit line means nothing archived', /audit line/.test(e3) && gtext() === rb && !gtext().includes('archived_at'), e3);
    refuse.clear();
    const rm = run('group_remove', { group: 'Trip2' });
    const rs = seen.filter(s => s.type === 'group_remove_started').pop();
    check('remove: _started first (group still live then), result line carries by', rm.archived === true && rs && !rs.file.includes('archived_at') && lines('group_archived').some(r => r.id === g.id && r.by_claimed === 'tool'), rs && rs.file);

    // 2. by from HARNESS_BOT, never an argument
    process.env.HARNESS_BOT = 'helper';
    const g2 = run('group_create', { name: 'Bot made', members: ['Bob'], by: 'owner' });
    check('by_claimed is HARNESS_BOT when set, and a "by" argument is ignored; tool journal lines carry no plain by', lines('group_create_started').some(r => r.id === g2.id && r.by_claimed === 'helper') && lines('group_created').some(r => r.id === g2.id && r.by_claimed === 'helper') && ['group_create_started', 'group_created', 'group_update_started', 'group_updated', 'group_remove_started', 'group_archived'].every(ty => lines(ty).filter(r => r.via === 'tool').every(r => !('by' in r) && typeof r.by_claimed === 'string')));
    delete process.env.HARNESS_BOT;
    run('group_remove', { group: 'Bot made' });

    // 3. no restore and no archived listing in the role tool set (a role has no identity the tools can trust, see DECISIONS)
    check('the tool list has no restore tool and no archived listing', !Object.keys(tools).some(n => /restore/.test(n)) && Object.keys(tools).length === 9 && !('archived' in tools.group_list.inputSchema.properties) && !/archiv/.test(tools.group_list.description) && run('group_list', { archived: true }).groups.every(x => !x.archived_at), Object.keys(tools).join());

    // 4. card field sentences and labels
    const words = Object.keys(card.FIELDS).map(k => card.FIELDS[k].label_en.toLowerCase());
    const want = words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
    check('role_create / role_update descriptions list the card fields from card.FIELDS', tools.role_create.inputSchema.properties.card.description.includes(want) && tools.role_update.description.includes(want) && tools.role_update.inputSchema.properties.card.description.includes(want), want);
    check('every known field has a label_zh (Chinese) and a label_en', Object.values(card.FIELDS).every(f => /[一-鿿]/.test(f.label_zh) && /^[A-Za-z ]+$/.test(f.label_en)));
  } catch (e) { console.log('FAIL crashed:', e && e.stack); results.push(false); }
  const bad = results.filter(x => !x).length;
  console.log(`result: ${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
