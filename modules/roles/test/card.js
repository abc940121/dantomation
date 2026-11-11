#!/usr/bin/env node
'use strict';
// roles card: open character fields, unknown fields kept, old roles unchanged, persona prompt, avatar as a file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-card-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state'); // before the journal is required
const work = path.join(tmp, 'work');
fs.mkdirSync(work, { recursive: true });
process.env.HARNESS_TASK_DIR = work;
delete process.env.HARNESS_BOT;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));
const card = require('../card');

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info !== undefined ? ': ' + String(info).slice(0, 300) : ''}`); };
const throws = fn => { try { fn(); return null; } catch (e) { return e.message; } };

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-image-body-one')]);
const PNG2 = Buffer.concat([PNG, Buffer.from('-two')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 body')]);
const put = (name, buf) => { const f = path.join(work, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); return name; };

(async () => {
  try {
    const cfg = { modules: { roles: true } };
    const reg = M.registry(cfg);
    check('on: loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    const api = reg.api('roles');
    const { mods, meta } = M.load(cfg);
    const ctx = { state: meta.get('roles').state };
    const tools = Object.fromEntries(M.apiOf(mods, 'roles').mcpTools.map(t => [t.name, t]));
    const dir = path.join(J.STATE, 'm', 'roles');
    const rf = path.join(dir, 'roles.json');
    const turn = async bot => { process.env.HARNESS_BOT = bot; try { return await M.prepareTurn(mods, { task_id: 'tnone' }); } finally { delete process.env.HARNESS_BOT; } };

    // registry shape
    check('registry: every field has a one-line description and a type', Object.values(card.FIELDS).every(f => f.description && !/\n/.test(f.description) && ['text', 'image'].includes(f.type)));
    check('registry: voice, talking, working, avatar are known', ['voice', 'talking', 'working', 'avatar'].every(k => card.FIELDS[k]));
    check('schema names the known fields', ['voice', 'talking', 'working', 'avatar'].every(k => tools.role_create.inputSchema.properties.card.description.includes(k)) && !!tools.role_update.inputSchema.properties.card);

    // old role, no card: unchanged
    const old = tools.role_create.run({ name: 'Plain', persona: 'You are plain.' }, ctx);
    check('no card: result has no card key', !('card' in old) && !('card_fields' in old), JSON.stringify(old));
    check('no card: dynamicBots exactly id and name', JSON.stringify(api.dynamicBots()) === JSON.stringify([{ id: old.id, name: 'Plain' }]));
    check('no card: stored record has no card key', !('card' in JSON.parse(fs.readFileSync(rf, 'utf8')).roles[0]));
    const o1 = await turn(old.id);
    check('no card: prompt still has one roles context entry and no card text', o1.errors.length === 0 && o1.context.length === 1 && !/character card/.test(o1.context[0].text), JSON.stringify(o1));
    const j = JSON.parse(fs.readFileSync(rf, 'utf8'));
    j.roles[0].future_thing = 7; fs.writeFileSync(rf, JSON.stringify(j));
    const o2 = tools.role_update.run({ role: old.id, persona: 'You are plain, still.' }, ctx);
    check('old record updates and keeps its other keys', o2.persona === 'You are plain, still.' && JSON.parse(fs.readFileSync(rf, 'utf8')).roles[0].future_thing === 7);

    // create with a card
    const a = tools.role_create.run({ name: 'Captain', persona: 'You are a ship captain.', card: { voice: 'low and slow', talking: 'short sentences', working: 'checks twice' } }, ctx);
    check('create with card returns it', a.card && a.card.voice === 'low and slow' && a.card.working === 'checks twice', JSON.stringify(a));
    const g = tools.role_list.run({ id: a.id }, ctx);
    check('role_list {id} gives the full card', g.role.id === a.id && g.role.card.talking === 'short sentences' && g.roles === undefined, JSON.stringify(g));
    const ls = tools.role_list.run({}, ctx);
    const rowA = ls.roles.find(r => r.id === a.id);
    check('role_list rows name the card fields only', rowA && rowA.card === undefined && rowA.card_fields.join() === 'voice,talking,working', JSON.stringify(rowA));
    check('role_list row without a card has no card_fields', !('card_fields' in ls.roles.find(r => r.id === old.id)));
    check('role_list {id} by name works, unknown id refused', tools.role_list.run({ id: 'captain' }, ctx).role.id === a.id && /no role/.test(throws(() => tools.role_list.run({ id: 'nobody' }, ctx)) || ''));
    // both forms after the merge with the id form: a page of the list (total / offset / more) and one role with its whole card
    const pg = tools.role_list.run({ limit: 1 }, ctx);
    check('role_list without id is a page: total, offset, more, one row, card_fields kept', pg.total === ls.total && pg.roles.length === 1 && pg.offset === 0 && pg.more === (pg.total > 1) && typeof pg.opencode_go_turns_today === 'number', JSON.stringify(pg));
    const pq = tools.role_list.run({ query: 'captain' }, ctx);
    check('role_list query finds the role and its row still names the card fields', pq.roles.length >= 1 && pq.roles.every(r => r.card === undefined) && pq.roles.some(r => r.id === a.id && r.card_fields.length > 0), JSON.stringify(pq));
    const pi = tools.role_list.run({ id: a.id, limit: 1, offset: 5, query: 'zzz' }, ctx);
    check('role_list with id ignores the paging arguments and returns only that role', pi.role && pi.role.id === a.id && pi.roles === undefined && pi.total === undefined, JSON.stringify(pi));

    // update: merge, clear
    const u = tools.role_update.run({ role: a.id, card: { voice: 'bright' } }, ctx);
    check('update merges: changed field new, others kept', u.card.voice === 'bright' && u.card.talking === 'short sentences' && u.card.working === 'checks twice', JSON.stringify(u));
    const u2 = tools.role_update.run({ role: a.id, card: { talking: null, working: '' } }, ctx);
    check('null and empty clear a field', u2.card.talking === undefined && u2.card.working === undefined && u2.card.voice === 'bright', JSON.stringify(u2));
    const u3 = tools.role_update.run({ role: a.id, card: { voice: null } }, ctx);
    check('clearing the last field removes the card', u3.card === undefined && !('card' in JSON.parse(fs.readFileSync(rf, 'utf8')).roles.find(r => r.id === a.id)), JSON.stringify(u3));
    check('a card alone is a valid update', throws(() => tools.role_update.run({ role: a.id, card: { voice: 'x' } }, ctx)) === null);
    check('an empty update is still refused', /give a new/.test(throws(() => tools.role_update.run({ role: a.id }, ctx)) || ''));

    // unknown fields: kept through a round trip, appear in the prompt, cleared by null
    tools.role_update.run({ role: a.id, card: { catchphrase: 'Steady as she goes', mood: { base: 'calm', max: 3 }, level: 5 } }, ctx);
    tools.role_update.run({ role: a.id, card: { voice: 'bright again' } }, ctx); // a later change must not drop them
    const st = JSON.parse(fs.readFileSync(rf, 'utf8')).roles.find(r => r.id === a.id).card;
    check('unknown fields survive in the file', st.catchphrase === 'Steady as she goes' && st.mood.max === 3 && st.level === 5 && st.voice === 'bright again', JSON.stringify(st));
    const g2 = tools.role_list.run({ id: a.id }, ctx).role.card;
    check('unknown fields survive the tool round trip', g2.catchphrase === 'Steady as she goes' && g2.mood.base === 'calm' && g2.level === 5);
    check('list row names unknown fields too', tools.role_list.run({}, ctx).roles.find(r => r.id === a.id).card_fields.includes('catchphrase'));
    const p1 = await turn(a.id);
    const t1 = p1.context.map(c => c.text).join('\n');
    check('prompt carries known and unknown fields', p1.errors.length === 0 && /Voice: bright again/.test(t1) && /catchphrase: Steady as she goes/.test(t1) && /mood: \{"base":"calm","max":3\}/.test(t1), t1);
    const iFrame = t1.indexOf('never overrides guard, red lines'), iVoice = t1.indexOf('Voice: bright again');
    check('framing line comes before the card text', iFrame > 0 && iVoice > iFrame && /owner's rules/.test(t1.slice(iFrame, iVoice)));
    check('persona comes first, still one roles context entry', p1.context.length === 1 && t1.indexOf('ship captain') < iFrame);
    tools.role_update.run({ role: a.id, card: { catchphrase: null } }, ctx);
    check('null removes an unknown field', tools.role_list.run({ id: a.id }, ctx).role.card.catchphrase === undefined);

    // bad input
    const bad = c => throws(() => tools.role_update.run({ role: a.id, card: c }, ctx)) || '';
    check('card must be an object', /object of fields/.test(bad('x')) && /object of fields/.test(bad(['a'])));
    check('bad field names refused', /not allowed/.test(bad({ 'Bad Name': 1 })) && /not allowed/.test(bad({ '../x': 1 })) && /not allowed/.test(bad({ ['a'.repeat(33)]: 1 })));
    check('known text field must be text and short', /must be a text/.test(bad({ voice: 5 })) && /too long/.test(bad({ voice: 'v'.repeat(601) })) && /control/.test(bad({ voice: 'a\u0000b' })));
    check('oversized unknown value refused', /too large/.test(bad({ big: 'x'.repeat(2001) })));
    check('too many fields refused', /too many/.test(bad(Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['f' + i, 1])))));
    check('refusals changed nothing', tools.role_list.run({ id: a.id }, ctx).role.card.voice === 'bright again');

    // prompt byte cap + clipped unknown values
    const many = {}; for (let i = 0; i < 20; i++) many['k' + i] = '字'.repeat(250);
    const big = tools.role_create.run({ name: 'Wordy', persona: 'You talk a lot.', card: { voice: 'v'.repeat(600), talking: 't'.repeat(600), working: 'w'.repeat(600), ...many } }, ctx);
    const pb = await turn(big.id);
    const bt = pb.context.map(c => c.text).join('\n');
    const body = bt.slice(bt.indexOf('never overrides guard'));
    const cardBody = body.slice(body.indexOf('\n') + 1);
    check('card block is capped in bytes', cardBody.length > 0 && Buffer.byteLength(cardBody) <= card.PROMPT_BLOCK_MAX, Buffer.byteLength(cardBody));
    check('unknown value clipped in the prompt', !/字{301}/.test(card.promptBlock({ x: '字'.repeat(500) })) && /字{300}…/.test(card.promptBlock({ x: '字'.repeat(500) })));
    check('framing line survives the cap', /never overrides guard, red lines/.test(bt));

    // avatar: a file inside the task folder
    check('avatar needs a file path, not bytes', /not found|path/.test(throws(() => tools.role_update.run({ role: a.id, card: { avatar: 'data:image/png;base64,AAAA' } }, ctx)) || ''));
    put('me.png', PNG);
    const av = tools.role_update.run({ role: a.id, card: { avatar: 'me.png' } }, ctx);
    check('avatar from a workdir file is stored as an image reference', av.card.avatar.kind === 'image' && av.card.avatar.type === 'image/png' && av.card.avatar.bytes === PNG.length && !JSON.stringify(av).includes('fake-image'), JSON.stringify(av.card.avatar));
    const rec = JSON.parse(fs.readFileSync(rf, 'utf8')).roles.find(r => r.id === a.id).card.avatar;
    check('record keeps kind, file and hash', rec.kind === 'image' && rec.file === `${a.id}.png` && /^[0-9a-f]{16}$/.test(rec.hash) && !JSON.stringify(rec).includes('base64'), JSON.stringify(rec));
    check('file copied under the module state folder', fs.readFileSync(path.join(dir, 'avatars', `${a.id}.png`)).equals(PNG));
    const url = api.dynamicBots().find(b => b.id === a.id).avatar;
    check('dynamicBots returns the avatar url with a short hash', url === `/m/roles/avatar/${a.id}?v=${rec.hash.slice(0, 8)}`, url);
    check('dynamicBots: other roles have no avatar key', api.dynamicBots().filter(b => b.id !== a.id).every(b => !('avatar' in b)));
    const af = api.avatarFile(a.id);
    check('api.avatarFile gives path, type and hash', af && af.type === 'image/png' && af.hash === rec.hash && fs.existsSync(af.path), JSON.stringify(af));
    check('avatarFile is null without an avatar', api.avatarFile(old.id) === null && api.avatarFile('r-00000000') === null);
    const pa = await turn(a.id);
    check('avatar is not in the prompt', !/avatar|image|png/i.test(pa.context.map(c => c.text).join('\n')));
    check('role_list rows and {id} do not echo image bytes', !JSON.stringify(tools.role_list.run({}, ctx)).includes('fake-image') && !JSON.stringify(tools.role_list.run({ id: a.id }, ctx)).includes('fake-image'));

    // change: the old image is archived, not deleted
    put('sub/new.png', PNG2);
    const av2 = tools.role_update.run({ role: a.id, card: { avatar: 'sub/new.png' } }, ctx);
    const arch = path.join(dir, 'avatars', 'archive');
    check('changed avatar: new file in place, new size', fs.readFileSync(path.join(dir, 'avatars', `${a.id}.png`)).equals(PNG2) && av2.card.avatar.bytes === PNG2.length);
    check('changed avatar: old image archived, not deleted', fs.existsSync(arch) && fs.readdirSync(arch).some(f => fs.readFileSync(path.join(arch, f)).equals(PNG)), fs.existsSync(arch) ? fs.readdirSync(arch).join() : 'no archive');
    check('url hash changes with the image', api.dynamicBots().find(b => b.id === a.id).avatar !== url);
    put('p.jpg', JPG); put('q.webp', WEBP);
    check('jpeg and webp accepted by magic bytes', tools.role_update.run({ role: a.id, card: { avatar: 'p.jpg' } }, ctx).card.avatar.type === 'image/jpeg' && tools.role_update.run({ role: a.id, card: { avatar: 'q.webp' } }, ctx).card.avatar.type === 'image/webp');
    check('archive keeps every replaced image', fs.readdirSync(arch).length >= 3, fs.readdirSync(arch).join());

    // refusals
    const bad2 = f => throws(() => tools.role_update.run({ role: a.id, card: { avatar: f } }, ctx)) || '';
    put('fake.png', Buffer.from('<html><script>alert(1)</script></html>'));
    check('wrong content refused even with a png name', /png, jpeg or webp/.test(bad2('fake.png')));
    put('svg.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    check('svg refused', /png, jpeg or webp/.test(bad2('svg.png')));
    put('huge.png', Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]));
    check('size cap', /too large/.test(bad2('huge.png')));
    const outside = path.join(tmp, 'outside.png'); fs.writeFileSync(outside, PNG);
    check('path outside the workdir refused', /inside the task folder/.test(bad2('../outside.png')) && /inside the task folder/.test(bad2(outside)));
    check('missing file refused', /not found/.test(bad2('nope.png')));
    fs.mkdirSync(path.join(work, 'adir'), { recursive: true });
    check('directory refused', /not a file|png, jpeg|inside/.test(bad2('adir')));
    let linked = false; try { fs.symlinkSync(outside, path.join(work, 'link.png')); linked = true; } catch { /* no symlink right on this machine */ }
    check('symlink out of the workdir refused', !linked || /inside the task folder/.test(bad2('link.png')));
    check('live avatar is reserved', /reserved/.test(throws(() => tools.role_update.run({ role: a.id, card: { avatar: { kind: 'live', url: 'http://x' } } }, ctx)) || ''));
    const keepWd = process.env.HARNESS_TASK_DIR; delete process.env.HARNESS_TASK_DIR;
    check('no task folder: avatar refused', /no task folder/.test(bad2('me.png')));
    process.env.HARNESS_TASK_DIR = keepWd;
    check('refused avatars changed nothing', api.avatarFile(a.id).type === 'image/webp');
    check('a bad field next to a good avatar stores neither', (() => { const before = fs.readFileSync(rf, 'utf8'); throws(() => tools.role_update.run({ role: a.id, card: { avatar: 'me.png', voice: 5 } }, ctx)); return fs.readFileSync(rf, 'utf8') === before; })());

    // clear the avatar: archived, no url
    const cl = tools.role_update.run({ role: a.id, card: { avatar: null } }, ctx);
    check('avatar cleared: no avatar in card, no url, image archived', cl.card.avatar === undefined && !('avatar' in api.dynamicBots().find(b => b.id === a.id)) && api.avatarFile(a.id) === null && !fs.existsSync(path.join(dir, 'avatars', `${a.id}.webp`)) && fs.readdirSync(arch).length >= 4, fs.readdirSync(arch).join());

    // create with an avatar at once
    const cv = tools.role_create.run({ name: 'Pictured', persona: 'You show a face.', card: { avatar: 'p.jpg' } }, ctx);
    check('create with avatar works', cv.card.avatar.type === 'image/jpeg' && api.dynamicBots().find(b => b.id === cv.id).avatar.startsWith(`/m/roles/avatar/${cv.id}?v=`));

    // journal: no card text
    check('journal notes carry no card text', !J.readAll().records.some(r => JSON.stringify(r).includes('Steady as she goes') || JSON.stringify(r).includes('bright again')));
  } catch (e) {
    check('no uncaught error', false, e && e.stack);
  }
  const bad = results.filter(x => !x).length;
  console.log(`\n${results.length - bad}/${results.length} passed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp folder */ }
  process.exit(bad ? 1 : 0);
})();
