#!/usr/bin/env node
'use strict';
// roles: GET /m/roles/main through the registry, as lib/server.js calls it. actorOf turns the owner token {kind:'owner'}
// into id '' (not undefined), so the route must treat '' as the owner token. Calling the handler directly hides this.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-main-route-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state');
delete process.env.HARNESS_BOT;
const M = require(path.join(__dirname, '..', '..', '..', 'lib', 'modules'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && info !== undefined ? ': ' + String(info).slice(0, 300) : ''}`); };
const rolesFile = () => path.join(tmp, 'state', 'm', 'roles', 'roles.json');

(async () => {
  try {
    const reg = M.registry({ modules: { roles: true } });
    const f = reg.findRoute('GET', '/m/roles/main');
    const call = actor => reg.callRoute(f, { actor });
    for (const a of [undefined, { kind: 'anonymous' }, { kind: 'worker' }, { kind: 'owner', id: 'x' }]) {
      const r = await call(a);
      check('read-only caller ' + JSON.stringify(a) + ' on a fresh state: no role is made', r.status !== 200 ? r.status === 403 : (r.json.id === null && !fs.existsSync(rolesFile())), JSON.stringify(r));
    }
    const ro = await call({ kind: 'owner' });
    check('the owner token (no id) creates the default main role on first use', ro.status === 200 && /^r-[0-9a-f]{8}$/.test(String(ro.json.id)) && ro.json.name === 'Chief of Staff', JSON.stringify(ro));
    const rd = await call({ kind: 'owner', id: 'device:d-reg' });
    check('a paired device gets the same role, nothing more is made', rd.status === 200 && rd.json.id === ro.json.id && JSON.parse(fs.readFileSync(rolesFile(), 'utf8')).roles.length === 1, JSON.stringify(rd));
    const again = await call({ kind: 'owner' });
    check('a second owner call returns the same id', again.status === 200 && again.json.id === ro.json.id, JSON.stringify(again));
  } catch (e) { check('suite ran without an exception', false, e && e.stack); }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir */ } }
  const fail = results.filter(x => !x).length;
  console.log(`${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
})();
