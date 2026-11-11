#!/usr/bin/env node
'use strict';
// roles: the main role (chief of staff): one main flag, lazy default, switching, roster in the turn context.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-chief-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state');
delete process.env.HARNESS_BOT;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info !== undefined ? ': ' + String(info).slice(0, 300) : ''}`); };
const throws = fn => { try { fn(); return null; } catch (e) { return e.message; } };

(async () => {
  try {
    const cfg = { modules: { roles: true } };
    const { mods, meta } = M.load(cfg);
    const ctx = { state: meta.get('roles').state, config: cfg };
    const api = M.apiOf(mods, 'roles');
    const tools = Object.fromEntries(api.mcpTools.map(t => [t.name, t]));
    const mod = require('..');
    const route = mod.routes.find(r => r.path === '/main');

    // a paired device only reads: on a fresh state it writes nothing and gets 200 {id:null}; the owner path still creates
    const octx = Object.assign({}, ctx, { actor: { kind: 'owner' } }); // what lib/server.js sets for the owner token: no id
    const dctx = Object.assign({}, ctx, { actor: { kind: 'owner', id: 'device:d-test' } });
    const rolesFile = () => fs.existsSync(path.join(tmp, 'state')) ? fs.readdirSync(path.join(tmp, 'state'), { recursive: true }).map(String).filter(p => fs.statSync(path.join(tmp, 'state', p)).isFile()).sort().join() : '';
    const before = rolesFile();
    const rd = route.handler(dctx);
    check('device GET /main on a fresh state is read-only: 200 {id:null}, no role, no file written', rd.status === 200 && JSON.stringify(rd.json) === '{"id":null}' && api.list().length === 0 && api.dynamicBots().length === 0 && rolesFile() === before, JSON.stringify(rd) + ' ' + before + ' -> ' + rolesFile());

    const others = [undefined, null, {}, { kind: 'worker' }, { kind: 'anonymous' }, { kind: 'device', id: 'd-1' }, { kind: 'owner', id: 'x' }, { kind: 'owner', id: '' }, { kind: 'Owner' }];
    const ro = others.map(a => route.handler(Object.assign({}, ctx, { actor: a })));
    check('GET /main by an actor that is neither the owner nor a device fails closed: {id:null}, no role, no file written', ro.every(x => x.status === 200 && x.json.id === null && Object.keys(x.json).join() === 'id') && api.list().length === 0 && api.dynamicBots().length === 0 && rolesFile() === before, JSON.stringify(ro.map(x => x.status)) + ' ' + before + ' -> ' + rolesFile());

    check('no main role exists before first use', api.list().length === 0 && api.dynamicBots().length === 0);
    const r1 = route.handler(octx);
    check('first use creates the default main role', r1.status === 200 && /^r-[0-9a-f]{8}$/.test(r1.json.id) && r1.json.name === 'Chief of Staff', JSON.stringify(r1));
    const rec = api.get(r1.json.id);
    check('the default is flagged main, with the chief text', rec.main === true && /chief of staff/.test(rec.persona) && /specialist/.test(rec.persona) && /ask once/.test(rec.persona) && /assumed/.test(rec.persona), rec.persona);
    check('after the owner side made it, a device GET returns the same {id, name} and nothing else', (() => { const x = route.handler(dctx); return x.status === 200 && x.json.id === rec.id && Object.keys(x.json).sort().join() === 'id,name' && api.list().length === 1; })());
    check('asking again returns the same role, nothing duplicated', route.handler(octx).json.id === rec.id && api.list().length === 1);

    const a = tools.role_create.run({ name: 'Alpha', persona: 'Writes release notes from commit logs.\nKeeps them short.' }, ctx);
    const b = tools.role_create.run({ name: 'Beta', persona: 'Reviews pull requests for security problems.' }, ctx);
    check('new roles are not main', a.main === undefined && b.main === undefined);
    check('role_list marks exactly one main', tools.role_list.run({}, ctx).roles.filter(r => r.main).map(r => r.id).join() === rec.id);

    // roster in the main role's turn
    const turn = async bot => { process.env.HARNESS_BOT = bot; try { return await M.prepareTurn(mods, { task_id: 'tnone' }); } finally { delete process.env.HARNESS_BOT; } };
    const tm = await turn(rec.id), text = tm.context.map(c => c.text).join('\n');
    check('main role context has the roster with count', /2 other roles/.test(text) && /- Alpha — Writes release notes from commit logs\./.test(text) && /- Beta — Reviews pull requests/.test(text), text);
    check('roster uses the first persona line only', !/Keeps them short/.test(text));
    check('roster points at role_list and role_ask', /role_list/.test(text) && /role_ask/.test(text));
    const ta = await turn(a.id);
    check('a specialist gets no roster', !/Your roster/.test(ta.context.map(c => c.text).join('\n')));

    for (let i = 0; i < 9; i++) tools.role_create.run({ name: 'Extra' + i, persona: 'Extra role number ' + i + ' ' + 'x'.repeat(300) }, ctx);
    const big = (await turn(rec.id)).context.map(c => c.text).join('\n');
    check('roster shows at most 8 entries and counts the rest', (big.slice(big.indexOf('Your roster')).match(/^- /gm) || []).length === 8 && /11 other roles/.test(big) && /3 more not shown/.test(big), big);
    check('roster lines are short, full texts never appear', !/x{200}/.test(big));

    // switching
    const sw = tools.role_update.run({ role: 'Alpha', main: true }, ctx);
    check('role_update main:true marks the new one and returns it', sw.main === true && sw.id === a.id);
    check('the old main is unmarked, exactly one main remains', api.list().filter(r => r.main).map(r => r.id).join() === a.id && api.get(rec.id).main === undefined);
    check('the main route follows the switch', route.handler(octx).json.id === a.id);
    const t2 = (await turn(a.id)).context.map(c => c.text).join('\n');
    check('the new main gets the roster, the old one does not', /Your roster/.test(t2) && !/Your roster/.test((await turn(rec.id)).context.map(c => c.text).join('\n')));
    check('unmarking the main role directly is refused', /always one main/.test(throws(() => tools.role_update.run({ role: 'Alpha', main: false }, ctx)) || ''));
    check('a non-boolean main is refused', /true or false/.test(throws(() => tools.role_update.run({ role: 'Beta', main: 'yes' }, ctx)) || ''));
    check('the main role cannot be removed', /main role/.test(throws(() => tools.role_remove.run({ role: 'Alpha' }, ctx)) || ''));
    check('a default name taken by a normal role does not break the default', (() => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-chief2-'));
      try {
        const { createStore } = require('../store');
        const s = createStore(d);
        s.create({ name: 'Chief of Staff', persona: 'p' });
        const m = s.ensureMain(require('../chief').DEFAULT);
        return m.main === true && m.name !== 'Chief of Staff' && s.list().length === 2;
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    })());
    check('role_update tool offers a main property', !!tools.role_update.inputSchema.properties.main);
  } catch (e) { check('suite ran without an exception', false, e && e.stack); }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir */ } }
  const fail = results.filter(x => !x).length;
  console.log(`${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
})();
