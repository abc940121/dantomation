#!/usr/bin/env node
'use strict';
// roles: POST /m/roles/roles (the chat page's "new role" button): the owner makes a role by hand with no model.
// Success, validation (both languages), duplicates, and that the role looks the same as one made by the role_create tool.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-role-route-'));
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
    const route = reg.listRoutes().find(r => r.method === 'POST' && r.path === '/m/roles/roles');
    check('the route is listed under /m/roles/ and is owner-only', !!route && route.access === 'owner', JSON.stringify(route));
    check('the route is not a raw route', !!route && !route.raw);
    const store = createStore(() => path.join(process.env.HARNESS_STATE_DIR, 'm', 'roles'));
    const jobs = await reg.startJobs({});
    const post = async (body, actor = owner) => {
      const found = reg.findRoute('POST', '/m/roles/roles');
      return found ? reg.callRoute(found, { actor, body }) : { status: 404, json: {} };
    };

    const ok = await post({ name: '  Editor  ', job: '  Checks my drafts for typos  ', extra: 'ignored' });
    check('success answers 201 with the role', ok.status === 201 && /^r-[0-9a-f]{8}$/.test(ok.json.id) && ok.json.name === 'Editor' && ok.json.persona === 'Checks my drafts for typos' && ok.json.engine === 'claude', JSON.stringify(ok));
    const stored = store.get(ok.json.id);
    check('the store holds it: trimmed, a session role, claude engine, listed', stored && stored.name === 'Editor' && stored.kind === 'session' && stored.engine === 'claude' && store.list().some(r => r.id === ok.json.id), JSON.stringify(stored));

    // same shape as a role made by the role_create tool (what groups and the card route read)
    const viaStore = store.create({ name: 'ToolMade', persona: 'Checks nothing.' });
    check('a hand-made role has the same fields as a store-made one', Object.keys(stored).sort().join() === Object.keys(viaStore).sort().join(), Object.keys(stored) + ' vs ' + Object.keys(viaStore));

    // a group accepts it as a member, like any other role
    const gf = reg.findRoute('POST', '/m/roles/groups');
    const g = await reg.callRoute(gf, { actor: owner, body: { name: 'Mixed', members: [ok.json.id, viaStore.id] } });
    check('a group accepts the hand-made role as a member', g.status === 201 && g.json.members.some(m => m.id === ok.json.id), JSON.stringify(g));

    const cases = [
      ['no body', undefined], ['empty name', { name: '', job: 'x' }], ['blank name', { name: '   ', job: 'x' }], ['name not text', { name: 5, job: 'x' }],
      ['name 41 chars', { name: 'a'.repeat(41), job: 'x' }], ['name looks like a role id', { name: 'r-0123abcd', job: 'x' }], ['name with a newline', { name: 'a\nb', job: 'x' }],
      ['empty job', { name: 'NoJob', job: '' }], ['missing job', { name: 'NoJob' }], ['job not text', { name: 'NoJob', job: ['x'] }],
      ['job 201 chars', { name: 'NoJob', job: 'j'.repeat(201) }], ['job with a newline', { name: 'NoJob', job: 'a\nb' }],
    ];
    for (const [label, body] of cases) {
      const r = await post(body);
      check('400 for ' + label, r.status === 400 && typeof r.json.error === 'string' && r.json.error.length < 300, JSON.stringify(r));
    }
    const names = store.list().map(r => r.name);
    check('refused requests created nothing', !names.includes('NoJob') && !names.includes('') && names.length === 2, names.join());
    const e1 = await post({ name: 'x', job: '' });
    check('the error text is in both languages', /[一-鿿]/.test(e1.json.error) && /[A-Za-z]/.test(e1.json.error), e1.json.error);
    check('a 200-character job and a 40-character name are accepted', (await post({ name: 'n'.repeat(40), job: 'j'.repeat(200) })).status === 201);
    const dup = await post({ name: 'EDITOR', job: 'Another job' });
    check('a duplicate name (any case) is a 400 and creates nothing', dup.status === 400 && store.list().filter(r => r.name.toLowerCase() === 'editor').length === 1, JSON.stringify(dup));
    const old = store.create({ name: 'Archived', persona: 'x' }); store.archive(old.id);
    check('an archived role does not block its name', (await post({ name: 'Archived', job: 'back again' })).status === 201);
    // optional picture: base64 in JSON, checked by content, stored where role-card4 keeps avatars
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-but-sniffable-png-body')]);
    const withPic = await post({ name: 'Pictured', job: 'Has a face', avatar: { data: PNG.toString('base64') } });
    const picRec = withPic.status === 201 && store.get(withPic.json.id);
    const picFile = picRec && picRec.card && picRec.card.avatar && path.join(process.env.HARNESS_STATE_DIR, 'm', 'roles', 'avatars', picRec.card.avatar.file);
    check('a picture makes a 201 and an image avatar on the card', !!picRec && picRec.card.avatar.kind === 'image' && picRec.card.avatar.type === 'image/png' && picRec.card.avatar.bytes === PNG.length, JSON.stringify(withPic));
    check('the picture is stored as avatars/<id>.png with the same bytes', !!picFile && picFile.endsWith(withPic.json.id + '.png') && fs.existsSync(picFile) && fs.readFileSync(picFile).equals(PNG));
    const served = reg.findRoute('GET', '/m/roles/avatar/' + (withPic.json && withPic.json.id));
    const sr = served ? await reg.callRoute(served, { actor: owner, params: { id: withPic.json.id } }) : null;
    check('the avatar route serves that picture back', !!sr && sr.status === 200 && Buffer.isBuffer(sr.body) && sr.body.equals(PNG), sr && sr.status);
    const before = store.list().length;
    const notImg = await post({ name: 'NotImage', job: 'x', avatar: { data: Buffer.from('this is plain text, not an image').toString('base64') } });
    check('bytes that are not an image are a 400 and create no role', notImg.status === 400 && store.list().length === before && /png|jpeg|webp/i.test(notImg.json.error), JSON.stringify(notImg));
    for (const [label, av] of [['not base64', { data: 'not base64 !!' }], ['empty', { data: '' }], ['no data', {}], ['a string', 'abc'], ['too long', { data: 'A'.repeat(300004) }]]) {
      const r = await post({ name: 'Bad ' + label, job: 'x', avatar: av });
      check('avatar (' + label + ') is a 400 in both languages and creates no role', r.status === 400 && /[一-鿿]/.test(r.json.error) && /[A-Za-z]/.test(r.json.error) && store.list().length === before, JSON.stringify(r).slice(0, 200));
    }
    const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
    check('an image over the 1 MB avatar cap is refused', (await post({ name: 'TooBig', job: 'x', avatar: { data: big.toString('base64') } })).status === 400 && store.list().length === before);
    check('avatar: null is the same as no avatar', (await post({ name: 'NoPic', job: 'x', avatar: null })).status === 201 && !store.get('NoPic').card);
    check('a request field cannot hand the card a Buffer-like object', (await post({ name: 'Sneaky', job: 'x', card: { avatar: { bytes: [1, 2, 3] } } })).status === 201 && !store.get('Sneaky').card);
    // the cap: 50 live roles (archived ones do not count), over it -> 409 with a bilingual error
    let fi = 0; while (store.list().length < 50 && fi < 60) store.create({ name: 'Cap ' + (fi++), persona: 'filler' });
    const over = await post({ name: 'Over The Cap', job: 'x' });
    check('cap: the 51st live role is a 409 in both languages and creates nothing', store.list().length === 50 && over.status === 409 && /[一-鿿]/.test(over.json.error) && /[A-Za-z]/.test(over.json.error) && /50/.test(over.json.error) && store.get('Over The Cap') === null, JSON.stringify(over));
    const avDir = path.join(process.env.HARNESS_STATE_DIR, 'm', 'roles', 'avatars');
    const overPic = await post({ name: 'Over With Pic', job: 'x', avatar: { data: PNG.toString('base64') } });
    check('cap: a refused creation leaves no avatar file behind', overPic.status === 409 && !fs.readdirSync(avDir).some(n => n.startsWith('r-') && !store.all().some(r => n.startsWith(r.id))));
    let capErr = ''; try { store.create({ name: 'Direct', persona: 'x' }); } catch (e) { capErr = e.constructor.name; }
    check('cap: store.create itself throws RoleLimitError (so role_create is refused too)', capErr === 'RoleLimitError', capErr);
    store.archive('Cap 0');
    const after = await post({ name: 'Over The Cap', job: 'x' });
    check('cap: archiving a role makes room again (201), and the next one is 409 again', after.status === 201 && store.list().length === 50 && (await post({ name: 'Over Again', job: 'x' })).status === 409);
    // a device may create 20 roles a day; the 21st is a 429 and a journal line; the owner is not limited
    for (const r of store.list()) if (/^Cap /.test(r.name)) store.archive(r.id);
    const dev = { kind: 'owner', id: 'device:d-test' }, dev2 = { kind: 'owner', id: 'device:d-other' };
    let made = 0, last = null; for (let i = 0; i < 25 && !last; i++) { const r = await post({ name: 'Dev ' + i, job: 'x' }, dev); if (r.status === 201) made++; else last = r; }
    check('device limit: 20 creations in a day are fine, the 21st is a 429 in both languages and creates nothing', made === 20 && last && last.status === 429 && /[一-鿿]/.test(last.json.error) && /[A-Za-z]/.test(last.json.error) && /20/.test(last.json.error) && store.get('Dev 20') === null, made + ' ' + JSON.stringify(last));
    check('device limit: a refused attempt does not count and does not create (a 22nd is still 429)', (await post({ name: 'Dev 21', job: 'x' }, dev)).status === 429 && store.get('Dev 21') === null);
    check('device limit: a different device has its own count', (await post({ name: 'Other Dev One', job: 'x' }, dev2)).status === 201);
    check('device limit: the owner is not limited', (await post({ name: 'Owner One', job: 'x' }, owner)).status === 201);
    const cf = path.join(process.env.HARNESS_STATE_DIR, 'm', 'roles', 'device-creates.json');
    let cj = null; try { cj = JSON.parse(fs.readFileSync(cf, 'utf8')); } catch { /* none */ }
    check('device limit: the count is kept in the module state (device-creates.json, day + per-device counts)', cj && typeof cj.day === 'string' && cj.counts['device:d-test'] === 20 && cj.counts['device:d-other'] === 1 && !('test' in cj.counts), JSON.stringify(cj));
    cj.day = '2000-01-01'; fs.writeFileSync(cf, JSON.stringify(cj));
    check('device limit: a new day starts the count again (201)', (await post({ name: 'Dev Next Day', job: 'x' }, dev)).status === 201);
    await jobs.stop();
  } catch (e) { console.log('FAIL crashed:', e && e.stack); results.push(false); }
  const badN = results.filter(x => !x).length;
  console.log(`result: ${results.length - badN} passed, ${badN} failed`);
  process.exit(badN ? 1 : 0);
})();
