#!/usr/bin/env node
'use strict';
// roles: store rules, MCP tools, dynamicBots and the prepareTurn persona, in-process.
// Runs in any mode: it builds its own registry and state dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state'); // before the journal is required
delete process.env.HARNESS_BOT;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info !== undefined ? ': ' + String(info).slice(0, 300) : ''}`); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

(async () => {
  try {
    const off = M.registry({ modules: { roles: false } });
    check('off: nothing registered', off.errors.length === 0 && off.api('roles') === null);

    const cfg = { modules: { roles: true } };
    const reg = M.registry(cfg);
    check('on: loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    const api = reg.api('roles');
    check('starts with no roles', Array.isArray(api.dynamicBots()) && api.dynamicBots().length === 0);

    const { mods, meta } = M.load(cfg);
    const ctx = { state: meta.get('roles').state };
    const tools = Object.fromEntries(M.apiOf(mods, 'roles').mcpTools.map(t => [t.name, t]));
    check('four tools offered', Object.keys(tools).sort().join() === 'role_create,role_list,role_remove,role_update');
    check('tools have schemas', Object.values(tools).every(t => t.description && t.inputSchema && t.inputSchema.type === 'object'));

    const a = tools.role_create.run({ name: 'Captain', persona: 'You are a calm ship captain.\nSpeak briefly.' }, ctx);
    check('create returns id, name, persona', /^r-[0-9a-f]{8}$/.test(a.id) && a.name === 'Captain' && a.persona.startsWith('You are'), JSON.stringify(a));
    check('dynamicBots lists it at once (core call, no this.ctx)', JSON.stringify(api.dynamicBots()) === JSON.stringify([{ id: a.id, name: 'Captain' }]));
    check('state is one valid JSON file, no temp files', (() => { const d = path.join(J.STATE, 'm', 'roles'); return JSON.parse(fs.readFileSync(path.join(d, 'roles.json'), 'utf8')).roles.length === 1 && fs.readdirSync(d).join() === 'roles.json'; })());
    check('journal note has id and name, not the persona', (() => { const r = J.readAll().records.find(x => x.type === 'role_created'); return r && r.module === 'roles' && r.id === a.id && !JSON.stringify(r).includes('calm'); })());

    check('duplicate name refused (case-insensitive)', /already exists/.test(throws(() => tools.role_create.run({ name: ' captain ', persona: 'x' }, ctx)) || ''));
    check('empty name refused', /name is required/.test(throws(() => tools.role_create.run({ name: '  ', persona: 'x' }, ctx)) || ''));
    check('long name refused', /too long/.test(throws(() => tools.role_create.run({ name: 'x'.repeat(41), persona: 'x' }, ctx)) || ''));
    check('newline in name refused', /one line/.test(throws(() => tools.role_create.run({ name: 'a\nb', persona: 'x' }, ctx)) || ''));
    check('role-id-like name refused', /role id/.test(throws(() => tools.role_create.run({ name: 'r-0123abcd', persona: 'x' }, ctx)) || ''));
    check('empty persona refused', /persona is required/.test(throws(() => tools.role_create.run({ name: 'Y', persona: '' }, ctx)) || ''));
    check('long persona refused', /too long/.test(throws(() => tools.role_create.run({ name: 'Y', persona: 'p'.repeat(4001) }, ctx)) || ''));
    check('control characters in persona refused', /control/.test(throws(() => tools.role_create.run({ name: 'Y', persona: 'a\u0000b' }, ctx)) || ''));
    check('non-text name refused', /text/.test(throws(() => tools.role_create.run({ name: 5, persona: 'x' }, ctx)) || ''));
    check('refusals wrote nothing', api.list().length === 1);

    const b = tools.role_create.run({ name: '小明', persona: '你是一個愛開玩笑的朋友。' }, ctx);
    check('non-English name and persona work', b.name === '小明' && api.dynamicBots().length === 2);

    // prepareTurn: the persona of the role the task belongs to.
    const turn = async bot => { process.env.HARNESS_BOT = bot; try { return await M.prepareTurn(mods, { task_id: 'tnone' }); } finally { delete process.env.HARNESS_BOT; } };
    const r1 = await turn(a.id);
    check('persona is added for the role bot', r1.errors.length === 0 && r1.context.length === 1 && /Captain/.test(r1.context[0].text) && /calm ship captain/.test(r1.context[0].text), JSON.stringify(r1));
    check('prompt says tools stay available', /every tool/.test(r1.context[0].text));
    const r2 = await turn('main');
    check('nothing is added for a normal bot', r2.errors.length === 0 && !r2.context.some(c => c.module === 'roles'));
    const r3 = await turn('r-00000000');
    check('nothing is added for an unknown role id', !r3.context.some(c => c.module === 'roles'));
    J.append({ type: 'task_start', task_id: 'tb1', bot: b.id });
    const r4 = await M.prepareTurn(mods, { task_id: 'tb1' });
    check('the bot is read from the task_start record', r4.context.some(c => c.module === 'roles' && /愛開玩笑/.test(c.text)), JSON.stringify(r4));

    const u = tools.role_update.run({ role: 'captain', persona: 'You are a loud pirate.' }, ctx);
    check('update by name keeps the id, changes the persona', u.id === a.id && /pirate/.test(u.persona) && u.name === 'Captain');
    const u2 = tools.role_update.run({ role: a.id, name: 'Pirate' }, ctx);
    check('update by id renames, keeps persona', u2.name === 'Pirate' && /pirate/.test(u2.persona) && api.dynamicBots().some(x => x.id === a.id && x.name === 'Pirate'));
    check('rename onto an existing name refused', /already exists/.test(throws(() => tools.role_update.run({ role: a.id, name: '小明' }, ctx)) || ''));
    check('update with nothing to change refused', /new name/.test(throws(() => tools.role_update.run({ role: a.id }, ctx)) || ''));
    check('update of an unknown role refused', /no role/.test(throws(() => tools.role_update.run({ role: 'nobody', name: 'Z' }, ctx)) || ''));
    check('role is required', /role is required/.test(throws(() => tools.role_update.run({ name: 'Z' }, ctx)) || ''));
    const r5 = await turn(a.id);
    check('new persona is used on the next turn', /pirate/.test(r5.context[0].text) && !/calm/.test(r5.context[0].text));

    check('list shows both', tools.role_list.run({}, ctx).roles.length === 2);
    const rm = tools.role_remove.run({ role: 'Pirate' }, ctx);
    check('remove archives', rm.archived === true && rm.id === a.id);
    check('archived role leaves the bot list and role_list', api.dynamicBots().map(x => x.id).join() === b.id && tools.role_list.run({}, ctx).roles.length === 1);
    check('record is kept in the file', api.all().some(x => x.id === a.id && x.archived_at));
    const r6 = await turn(a.id);
    check('no persona for an archived role', !r6.context.some(c => c.module === 'roles'));
    check('removing it again is refused', /no role/.test(throws(() => tools.role_remove.run({ role: a.id }, ctx)) || ''));
    const again = tools.role_create.run({ name: 'Pirate', persona: 'Second pirate.' }, ctx);
    check('an archived name can be reused, with a new id', again.id !== a.id && api.dynamicBots().length === 2);

    // engine: default, set, update, bad value, chooseEngine.
    const eDef = tools.role_create.run({ name: 'Plain', persona: 'p' }, ctx);
    check('engine defaults to claude', eDef.engine === 'claude' && api.get(eDef.id).engine === 'claude');
    const eGpt = tools.role_create.run({ name: 'Gee', persona: 'p', engine: 'codex' }, ctx);
    check('engine codex can be set at create', eGpt.engine === 'codex' && api.get(eGpt.id).engine === 'codex');
    check('role_list shows the engine', tools.role_list.run({}, ctx).roles.find(x => x.id === eGpt.id).engine === 'codex');
    check('bad engine refused with the allowed values', /engine must be one of: claude, codex/.test(throws(() => tools.role_create.run({ name: 'Bad', persona: 'p', engine: 'gpt5' }, ctx)) || '') && !api.list().some(x => x.name === 'Bad'));
    check('bad engine on update refused', /engine must be one of/.test(throws(() => tools.role_update.run({ role: eDef.id, engine: 5 }, ctx)) || ''));
    const upE = tools.role_update.run({ role: 'Plain', engine: 'codex' }, ctx);
    check('update can set the engine alone, keeps name and persona', upE.engine === 'codex' && upE.name === 'Plain' && upE.persona === 'p');
    check('update of name keeps the engine', tools.role_update.run({ role: 'Plain', name: 'Plain2' }, ctx).engine === 'codex');
    check('update can go back to claude', tools.role_update.run({ role: 'Plain2', engine: 'claude' }, ctx).engine === 'claude');
    // a record written before the field existed
    const rf = path.join(J.STATE, 'm', 'roles', 'roles.json'), rj = JSON.parse(fs.readFileSync(rf, 'utf8'));
    delete rj.roles.find(x => x.id === eDef.id).engine; fs.writeFileSync(rf, JSON.stringify(rj));
    check('a record without engine counts as claude', tools.role_list.run({}, ctx).roles.find(x => x.id === eDef.id).engine === 'claude');
    const choose = async (workdir, bot) => { if (bot) process.env.HARNESS_BOT = bot; try { return await M.chooseEngine(mods, { task_id: 'tnone', workdir }); } finally { delete process.env.HARNESS_BOT; } };
    const c1 = await choose(path.join(tmp, 'work', 'bot-' + eGpt.id));
    check('chooseEngine says codex for a codex role (by work folder)', c1 && c1.engine === 'codex' && c1.module === 'roles', JSON.stringify(c1));
    check('chooseEngine says codex for a codex role (by task bot)', (await choose(tmp, eGpt.id) || {}).engine === 'codex');
    check('chooseEngine has no opinion for a claude role', (await choose(path.join(tmp, 'work', 'bot-' + eDef.id))) === null);
    check('chooseEngine has no opinion for a normal bot', (await choose(path.join(tmp, 'work', 'bot-main'))) === null);
    check('chooseEngine has no opinion for an unknown role id', (await choose(path.join(tmp, 'work', 'bot-r-00000000'))) === null);
    tools.role_remove.run({ role: eGpt.id }, ctx);
    check('chooseEngine has no opinion for an archived codex role', (await choose(path.join(tmp, 'work', 'bot-' + eGpt.id))) === null);

    fs.writeFileSync(path.join(J.STATE, 'm', 'roles', 'roles.json'), '{ broken');
    check('a damaged file is reported, not treated as empty', /unreadable/.test(throws(() => api.list()) || ''));
  } catch (e) { check('suite ran without an exception', false, e && e.stack); }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir */ } }
  const fail = results.filter(x => !x).length;
  console.log(`${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
})();
