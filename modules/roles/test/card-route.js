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
  } catch (e) {
    check('card-route suite ran', false, (e && e.stack) || String(e));
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  const bad = results.filter(x => !x).length;
  console.log(`\n${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})();
