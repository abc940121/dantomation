#!/usr/bin/env node
'use strict';
// roles: the card routes the chat page uses: GET /m/roles/avatar/:id (raw image), GET and PATCH /m/roles/cards/:id.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-cardroute-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state');
delete process.env.HARNESS_BOT;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const { createStore } = require(path.join(ROOT, 'modules', 'roles', 'store'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info !== undefined ? ': ' + String(info).slice(0, 300) : ''}`); };
const owner = { kind: 'owner', id: 'test' };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(40)]);

(async () => {
  try {
    const reg = M.registry({ modules: { roles: true }, bots: [{ id: 'main', name: 'Main' }] });
    check('loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    const work = path.join(tmp, 'work'); fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'a.png'), PNG);
    const store = createStore(() => path.join(process.env.HARNESS_STATE_DIR, 'm', 'roles'), work);
    const withImg = store.create({ name: 'Ann', persona: 'You are Ann.', card: { voice: 'soft', avatar: 'a.png' } });
    const plain = store.create({ name: 'Bob', persona: 'You are Bob.' });
    const gone = store.create({ name: 'Old', persona: 'You are Old.', card: { avatar: 'a.png' } });
    store.archive(gone.id);
    const call = (method, p, o = {}) => { const f = reg.findRoute(method, p); return f ? reg.callRoute(f, { actor: owner, ...o }) : { status: 404, json: { error: 'no route' } }; };

    const a = await call('GET', `/m/roles/avatar/${withImg.id}`);
    check('avatar: 200 raw png with an etag', a.status === 200 && Buffer.isBuffer(a.body) && a.body.equals(PNG) && a.type === 'image/png' && /^[A-Za-z0-9._-]{1,64}$/.test(a.etag || ''), JSON.stringify(a).slice(0, 200));
    for (const [label, id] of [['a role with no avatar', plain.id], ['an archived role', gone.id], ['an unknown id', 'r-00000000'], ['a malformed id', 'r-xyz'], ['a name', 'Ann']]) {
      const r = await call('GET', `/m/roles/avatar/${encodeURIComponent(id)}`);
      check(`avatar: ${label} -> 404`, r.status === 404 && r.body === undefined, JSON.stringify(r).slice(0, 120));
    }
    // path safety: the id shape is checked before any path join, the stored name must be this role's own file, and the
    // resolved path must stay under avatars/ (the avatars folder is the only place the route reads from)
    for (const id of ['../x', '..%2f..%2froles.json', `${withImg.id}/../${plain.id}`, `${withImg.id}/x`, `${withImg.id}x`, withImg.id.toUpperCase(), `${withImg.id}.png`, '..\\x', `${withImg.id}%00`]) {
      const r = await call('GET', `/m/roles/avatar/${id}`);
      check(`avatar: hostile id ${JSON.stringify(id)} -> not served`, r.status !== 200 && r.body === undefined, JSON.stringify(r).slice(0, 120));
    }
    {
      const rdir = path.join(process.env.HARNESS_STATE_DIR, 'm', 'roles'), rf = path.join(rdir, 'roles.json');
      const orig = fs.readFileSync(rf, 'utf8'), own = JSON.parse(orig).roles.find(q => q.id === withImg.id).card.avatar.file;
      const secret = path.join(tmp, 'secret.png'); fs.writeFileSync(secret, PNG);
      for (const f of ['../roles.json', `../../../secret.png`, secret, `${gone.id}.png`, 'x.png', `${withImg.id}.png/../${own}`]) {
        const j = JSON.parse(orig); j.roles.find(q => q.id === withImg.id).card.avatar.file = f; fs.writeFileSync(rf, JSON.stringify(j));
        const r = await call('GET', `/m/roles/avatar/${withImg.id}`);
        check(`avatar: a tampered file name ${JSON.stringify(f)} is not served`, r.status === 404 && r.body === undefined, JSON.stringify(r).slice(0, 100));
      }
      fs.writeFileSync(rf, orig);
      const ownPath = path.join(rdir, 'avatars', own), keep = fs.readFileSync(ownPath);
      let linked = false;
      try { fs.unlinkSync(ownPath); fs.symlinkSync(secret, ownPath); linked = true; } catch { /* no symlink right on this machine */ }
      if (linked) {
        const r = await call('GET', `/m/roles/avatar/${withImg.id}`);
        check('avatar: a symlink pointing out of avatars/ is not served', r.status === 404 && r.body === undefined, JSON.stringify(r).slice(0, 100));
        fs.unlinkSync(ownPath);
      } else check('avatar: symlink case skipped (no symlink right here)', true);
      fs.writeFileSync(ownPath, keep);
      check('avatar: the real image is served again after the checks', (await call('GET', `/m/roles/avatar/${withImg.id}`)).status === 200);
    }
    // raw limits: the avatar route is declared raw, its result passes the trunk's checks (allow-listed type, under 2 MB),
    // and a file over the cap gives a clean 413 from the route, never a 500 from the trunk
    {
      const rt = reg.listRoutes().find(q => q.method === 'GET' && q.path === '/m/roles/avatar/:id');
      check('avatar: the route is declared raw: true', rt && rt.raw === true, JSON.stringify(rt && rt.raw));
      check('avatar: result type is on the raw allow list and the size is under the cap', M.RAW_TYPES.includes(a.type) && a.body.length <= M.RAW_MAX);
      const rdir2 = path.join(process.env.HARNESS_STATE_DIR, 'm', 'roles');
      const own2 = path.join(rdir2, 'avatars', JSON.parse(fs.readFileSync(path.join(rdir2, 'roles.json'), 'utf8')).roles.find(q => q.id === withImg.id).card.avatar.file);
      const keep2 = fs.readFileSync(own2);
      fs.writeFileSync(own2, Buffer.alloc(M.RAW_MAX + 1, 1));
      const big = await call('GET', `/m/roles/avatar/${withImg.id}`);
      check('avatar: a file over 2 MB -> 413, clean error, no bytes, not a 500', big.status === 413 && big.body === undefined && big.json && typeof big.json.error === 'string', JSON.stringify(big).slice(0, 120));
      fs.writeFileSync(own2, keep2);
      check('avatar: served again once the file is back', (await call('GET', `/m/roles/avatar/${withImg.id}`)).status === 200);
    }
    check('avatar: a worker is refused', (await call('GET', `/m/roles/avatar/${withImg.id}`, { actor: { kind: 'worker', id: 'w' } })).status === 403);

    const c = (await call('GET', `/m/roles/cards/${withImg.id}`)).json;
    const keys = (c.fields || []).map(f => f.key);
    check('card: the field list comes from the registry', ['voice', 'talking', 'working', 'avatar'].every(k => keys.includes(k)) && c.name === 'Ann', JSON.stringify(c));
    check('card: every known field carries label_zh and label_en from the registry; an unknown field has none', c.fields.filter(x => x.known).every(x => /[\u4e00-\u9fff]/.test(x.label_zh) && /^[A-Za-z ]+$/.test(x.label_en)) && c.fields.find(x => x.key === 'voice').label_zh === '聲音' && c.fields.find(x => x.key === 'voice').label_en === 'Voice' && c.fields.filter(x => !x.known).every(x => x.label_zh === undefined), JSON.stringify(c.fields).slice(0, 300));
    check('card: values shown, avatar reduced to facts', c.card.voice === 'soft' && c.card.avatar && !('file' in c.card.avatar) && /\/m\/roles\/avatar\//.test(c.avatar || ''), JSON.stringify(c));
    check('card: unknown role -> 404', (await call('GET', '/m/roles/cards/r-00000000')).status === 404 && (await call('GET', `/m/roles/cards/${gone.id}`)).status === 404);

    const p = await call('PATCH', `/m/roles/cards/${plain.id}`, { body: { card: { talking: 'short', mood: 'calm' } } });
    check('save: text and a new unknown field, listed after the known ones', p.status === 200 && p.json.card.talking === 'short' && p.json.card.mood === 'calm' && p.json.fields.some(f => f.key === 'mood' && !f.known), JSON.stringify(p));
    check('save: persisted', store.get(plain.id).card.talking === 'short');
    const clr = await call('PATCH', `/m/roles/cards/${plain.id}`, { body: { card: { talking: null } } });
    check('save: null clears a field', clr.status === 200 && !('talking' in clr.json.card) && clr.json.card.mood === 'calm', JSON.stringify(clr));
    const bad = async (label, body) => { const r = await call('PATCH', `/m/roles/cards/${plain.id}`, { body }); check(label, r.status === 400 && typeof r.json.error === 'string', JSON.stringify(r)); };
    await bad('save: an empty patch is refused', { card: {} });
    await bad('save: no card is refused', {});
    await bad('save: the avatar cannot be set from the page', { card: { avatar: 'a.png' } });
    await bad('save: a too-long text is refused', { card: { voice: 'x'.repeat(601) } });
    await bad('save: a bad field name is refused', { card: { 'Bad Name': 'x' } });
    check('save: unknown role -> 404', (await call('PATCH', '/m/roles/cards/r-00000000', { body: { card: { voice: 'x' } } })).status === 404);
    check('save: a worker is refused', (await call('PATCH', `/m/roles/cards/${plain.id}`, { actor: { kind: 'worker', id: 'w' }, body: { card: { voice: 'x' } } })).status === 403);
    // POST /m/roles/avatar/:id: set or clear a picture (owner and paired device), journal without image data
    {
      const J = require(path.join(ROOT, 'lib', 'journal'));
      const dev = { kind: 'owner', id: 'device:d-test' };
      const png2 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(60)]);
      const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(60)]);
      const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x30, 0, 0, 0]), Buffer.from('WEBP'), crypto.randomBytes(40)]);
      const set = (id, data, actor = owner) => call('POST', `/m/roles/avatar/${id}`, { actor, body: { avatar: { data: data.toString('base64') } } });
      const r1 = await set(plain.id, PNG, dev);
      const got = await call('GET', `/m/roles/avatar/${plain.id}`);
      check('avatar set: a paired device (owner actor device:<id>) sets a png; the answer has the new URL and the image is served', r1.status === 200 && r1.json.id === plain.id && /^\/m\/roles\/avatar\/r-[0-9a-f]{8}\?v=/.test(r1.json.avatar) && got.status === 200 && got.body.equals(PNG), JSON.stringify(r1).slice(0, 200));
      const r2 = await set(plain.id, jpg), r3 = await set(plain.id, webp);
      const g3 = await call('GET', `/m/roles/avatar/${plain.id}`);
      check('avatar set: jpeg and webp are accepted (checked by content) and replace the earlier picture', r2.status === 200 && r3.status === 200 && g3.type === 'image/webp' && g3.body.equals(webp) && r3.json.avatar !== r1.json.avatar);
      for (const [label, body] of [['text bytes sent as a picture', { avatar: { data: Buffer.from('this is only text, long enough to look like a file').toString('base64') } }], ['a gif', { avatar: { data: Buffer.concat([Buffer.from('GIF89a'), crypto.randomBytes(40)]).toString('base64') } }], ['not base64', { avatar: { data: 'not base64!!' } }], ['no avatar field', {}], ['avatar is a string path', { avatar: '../../evil.png' }], ['avatar object with a path', { avatar: { path: '/etc/passwd' } }]]) {
        const before = (await call('GET', `/m/roles/avatar/${plain.id}`)).body;
        const r = await call('POST', `/m/roles/avatar/${plain.id}`, { body });
        const after = (await call('GET', `/m/roles/avatar/${plain.id}`)).body;
        check(`avatar set: ${label} -> 400 and the picture is unchanged`, r.status === 400 && typeof r.json.error === 'string' && after.equals(before), JSON.stringify(r).slice(0, 160));
      }
      const huge = await call('POST', `/m/roles/avatar/${plain.id}`, { body: { avatar: { data: Buffer.alloc(300004, 65).toString('base64') } } });
      check('avatar set: a body over the size limit is refused', huge.status === 400);
      for (const [label, id] of [['an archived role', gone.id], ['an unknown id', 'r-00000000'], ['a malformed id', 'r-xyz']]) {
        const r = await set(id, PNG);
        check(`avatar set: ${label} -> 404`, r.status === 404);
      }
      check('avatar set: a worker is refused', (await set(plain.id, PNG, { kind: 'worker', id: 'w' })).status === 403);
      const rc = await call('POST', `/m/roles/avatar/${plain.id}`, { actor: dev, body: { avatar: null } });
      const g4 = await call('GET', `/m/roles/avatar/${plain.id}`);
      check('avatar clear: {avatar:null} removes the picture (the GET is 404, the answer has avatar null)', rc.status === 200 && rc.json.avatar === null && g4.status === 404);
      const recs = J.readAll().records.filter(x => x.type === 'role_avatar_changed');
      check('journal: one role_avatar_changed per change with the role id and who, cleared marked, and no image data anywhere', recs.length === 4 && recs[0].id === plain.id && recs[0].by === 'device:d-test' && recs[1].by === 'test' && recs[3].cleared === true && recs.every(x => x.module === 'roles') && !JSON.stringify(recs).includes(PNG.toString('base64').slice(0, 20)) && !JSON.stringify(recs).includes('data'), JSON.stringify(recs).slice(0, 300));
      check('the old picture is moved to avatars/archive, not deleted', (() => { const d = path.join(process.env.HARNESS_STATE_DIR, 'm', 'roles', 'avatars'); try { return fs.readdirSync(path.join(d, 'archive')).some(f => f.startsWith(plain.id)); } catch { return false; } })());
      // condition 1: 20 changes a day per paired device, the owner is not limited, plain text when hit
      {
        const devL = { kind: 'owner', id: 'device:d-limit' }, devM = { kind: 'owner', id: 'device:d-other' };
        let okN = 0;
        for (let i = 0; i < 20; i++) { const x = await set(plain.id, i % 2 ? PNG : png2, devL); if (x.status === 200) okN++; }
        const over = await set(plain.id, PNG, devL), overClear = await call('POST', `/m/roles/avatar/${plain.id}`, { actor: devL, body: { avatar: null } });
        check('limit: a device makes 20 picture changes in a day, the 21st (set or clear) is 429 with the plain two-language text', okN === 20 && over.status === 429 && overClear.status === 429 && over.json.error.includes('Too many picture changes today. Try again tomorrow.') && over.json.error.includes('今天更換圖片的次數已達上限，請明天再試。'), JSON.stringify(over));
        const other = await set(plain.id, PNG, devM);
        check('limit: another device is not affected', other.status === 200);
        let ownerOk = 0; for (let i = 0; i < 25; i++) if ((await set(plain.id, i % 2 ? PNG : png2, owner)).status === 200) ownerOk++;
        check('limit: the owner is not limited (25 changes in a row)', ownerOk === 25);
        const afterBytes = (await call('GET', `/m/roles/avatar/${plain.id}`)).body;
        const refused = await set(plain.id, jpg, devL);
        check('limit: a refused (429) change writes nothing', refused.status === 429 && (await call('GET', `/m/roles/avatar/${plain.id}`)).body.equals(afterBytes));
        const rl = J.readAll().records.filter(x => x.type === 'role_rate_limited' && x.by === 'device:d-limit');
        check('limit: the journal notes the limit hit with the device and no image data', rl.length >= 3 && rl.every(x => x.what === 'avatar' && x.limit === 20) && !JSON.stringify(rl).includes('data'));
        const cnt = JSON.parse(fs.readFileSync(path.join(process.env.HARNESS_STATE_DIR, 'm', 'roles', 'device-avatar-changes.json'), 'utf8'));
        check('limit: refused attempts and the owner do not count; the counter file holds only device ids and counts', cnt.counts['device:d-limit'] === 20 && cnt.counts['device:d-other'] === 1 && !Object.keys(cnt.counts).includes('test'), JSON.stringify(cnt));
      }
      // condition 2: archived or unknown -> 404 and no write; clearing archives the file, never deletes it
      {
        const rdir = path.join(process.env.HARNESS_STATE_DIR, 'm', 'roles'), listAv = () => fs.readdirSync(path.join(rdir, 'avatars')).filter(f => f !== 'archive').sort().join();
        const rolesBefore = fs.readFileSync(path.join(rdir, 'roles.json'), 'utf8'), filesBefore = listAv(), nJ = J.readAll().records.length;
        const r404 = [await set(gone.id, PNG), await set('r-00000000', PNG), await call('POST', `/m/roles/avatar/${gone.id}`, { body: { avatar: null } })];
        check('archived or unknown role: 404, roles.json, the avatars folder and the journal are unchanged', r404.every(r => r.status === 404) && fs.readFileSync(path.join(rdir, 'roles.json'), 'utf8') === rolesBefore && listAv() === filesBefore && J.readAll().records.length === nJ);
        await set(plain.id, webp);
        const live = listAv().split(',').filter(f => f.startsWith(plain.id)), content = fs.readFileSync(path.join(rdir, 'avatars', live[0]));
        const archBefore = fs.existsSync(path.join(rdir, 'avatars', 'archive')) ? fs.readdirSync(path.join(rdir, 'avatars', 'archive')).length : 0;
        await call('POST', `/m/roles/avatar/${plain.id}`, { body: { avatar: null } });
        const arch = fs.readdirSync(path.join(rdir, 'avatars', 'archive'));
        check('clear: the picture file moves to avatars/archive with its bytes intact and is gone from avatars/ (never deleted)', arch.length === archBefore + 1 && !listAv().split(',').some(f => f.startsWith(plain.id)) && arch.some(f => f.startsWith(plain.id) && fs.readFileSync(path.join(rdir, 'avatars', 'archive', f)).equals(content)));
      }
      // condition 3: the type comes only from the decoded bytes (png, jpeg, webp); svg and anything else is refused whatever it is called
      {
        const before = (await call('GET', `/m/roles/avatar/${plain.id}`)).status;
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), svgPng = Buffer.concat([Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'), PNG]);
        const html2 = Buffer.from('<html><body>hi</body></html>'), pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(30)]);
        for (const [label, bytes, extra] of [['an SVG', svg, {}], ['an SVG called image/png', svg, { type: 'image/png', name: 'a.png', ext: 'png' }], ['an SVG with a PNG after it', svgPng, {}], ['html', html2, {}], ['a pdf', pdf, { type: 'image/jpeg' }], ['a gif', Buffer.concat([Buffer.from('GIF89a'), crypto.randomBytes(30)]), {}], ['a PNG header cut to 3 bytes', PNG.subarray(0, 3), {}]]) {
          const r = await call('POST', `/m/roles/avatar/${plain.id}`, { body: { avatar: { data: bytes.toString('base64'), ...extra }, ...extra } });
          check(`sniff: ${label} -> 400 and nothing is written`, r.status === 400 && (await call('GET', `/m/roles/avatar/${plain.id}`)).status === before, JSON.stringify(r).slice(0, 140));
        }
        const okJ = await set(plain.id, jpg), tj = await call('GET', `/m/roles/avatar/${plain.id}`);
        check('sniff: a real jpeg is stored under the type found in its bytes, whatever the request called it', okJ.status === 200 && tj.type === 'image/jpeg');
        const mis = await call('POST', `/m/roles/avatar/${plain.id}`, { body: { avatar: { data: webp.toString('base64'), type: 'image/png' } } });
        check('sniff: a webp sent as "image/png" is stored as webp (the claimed type is ignored)', mis.status === 200 && (await call('GET', `/m/roles/avatar/${plain.id}`)).type === 'image/webp');
        check('size: the decoded bytes are checked (a valid png over the decoded limit is refused, and base64 text over 300000 characters too)', (await set(plain.id, Buffer.concat([PNG, Buffer.alloc(226000, 1)]))).status === 400 && (await call('POST', `/m/roles/avatar/${plain.id}`, { body: { avatar: { data: 'A'.repeat(300004) } } })).status === 400);
      }
      check('PATCH /cards/:id still refuses the avatar field', (await call('PATCH', `/m/roles/cards/${plain.id}`, { body: { card: { avatar: { data: PNG.toString('base64') } } } })).status === 400);
    }
  } catch (e) {
    check('card-route suite ran', false, (e && e.stack) || String(e));
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  const bad = results.filter(x => !x).length;
  console.log(`\n${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})();
