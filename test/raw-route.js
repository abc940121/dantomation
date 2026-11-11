#!/usr/bin/env node
'use strict';
// Raw module route results (docs/module-contract.md, "Raw route result"): a route may return
// { status: 200, body: Buffer, type, etag? } for an allow-listed image type. Checked over real HTTP
// against a server with one temp module (modules/zz-rr-*, removed at the end). Runs in any mode.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const tag = crypto.randomBytes(3).toString('hex');
const NAME = `zz-rr-${tag}`;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rawroute-'));
const state = path.join(base, 'state'), work = path.join(base, 'work');
fs.mkdirSync(work, { recursive: true });
const modDir = path.join(M.DIR, NAME);
const badDir = path.join(M.DIR, NAME + '-bad');
const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const killTree = pid => { if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' }); else try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
const tick = ms => new Promise(r => setTimeout(r, ms));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(40)]);
const CAP = 2 * 1024 * 1024;

function req(port, p, { token, headers = {}, method = 'GET' } = {}) {
  const h = { ...headers }; if (token) h.authorization = `Bearer ${token}`;
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, res => {
      const c = []; res.on('data', x => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) }));
    });
    r.on('error', reject); r.setTimeout(15000, () => r.destroy(new Error('timeout ' + p))); r.end();
  });
}

const MODULE_SRC = `'use strict';
const PNG = Buffer.from('${PNG.toString('hex')}', 'hex');
const raw = over => () => ({ status: 200, body: PNG, type: 'image/png', ...over });
module.exports = { contract: 1, name: '${NAME}',
  routes: [
    { method: 'GET', raw: true, path: '/png', description: 'png without etag', handler: raw() },
    { method: 'GET', raw: true, path: '/tagged', description: 'png with etag', handler: raw({ etag: 'abc123' }) },
    { method: 'GET', raw: true, path: '/jpeg', description: 'jpeg', handler: raw({ type: 'image/jpeg' }) },
    { method: 'GET', raw: true, path: '/webp', description: 'webp', handler: raw({ type: 'image/webp' }) },
    { method: 'GET', raw: true, path: '/gif', description: 'gif', handler: raw({ type: 'image/gif' }) },
    { method: 'GET', raw: true, path: '/svg', description: 'svg refused', handler: raw({ type: 'image/svg+xml' }) },
    { method: 'GET', raw: true, path: '/html', description: 'html refused', handler: raw({ type: 'text/html' }) },
    { method: 'GET', raw: true, path: '/notype', description: 'no type refused', handler: raw({ type: undefined }) },
    { method: 'GET', raw: true, path: '/big', description: 'oversize refused', handler: () => ({ status: 200, body: Buffer.alloc(${CAP + 1}, 1), type: 'image/png' }) },
    { method: 'GET', raw: true, path: '/edge', description: 'exactly the cap', handler: () => ({ status: 200, body: Buffer.alloc(${CAP}, 2), type: 'image/png' }) },
    { method: 'GET', raw: true, path: '/string', description: 'string body refused', handler: raw({ body: 'not a buffer' }) },
    { method: 'GET', raw: true, path: '/both', description: 'json and body refused', handler: raw({ json: { a: 1 } }) },
    { method: 'GET', raw: true, path: '/badetag', description: 'bad etag refused', handler: raw({ etag: 'a"b' }) },
    { method: 'GET', raw: true, path: '/s404', description: 'raw non-200 refused', handler: raw({ status: 404 }) },
    { method: 'GET', path: '/undeclared', description: 'raw without declaring it', handler: raw() },
    { method: 'GET', path: '/declared-json', raw: true, description: 'declared raw route answering JSON', handler: () => ({ status: 200, json: { ok: 'declared' } }) },
    { method: 'GET', path: '/json', description: 'plain json', handler: () => ({ status: 200, json: { ok: true } }) },
  ],
  api: { dynamicBots() { return [
    { id: 'rr-a', name: 'A', avatar: '/m/${NAME}/tagged?v=abc12345' },
    { id: 'rr-b', name: 'B', avatar: 'https://example.invalid/x.png' },
    { id: 'rr-c', name: 'C', avatar: { x: 1 } },
    { id: 'rr-e', name: 'E', avatar: '/m/roles/../../api/bots' },
    { id: 'rr-f', name: 'F', avatar: '/m/roles//x' },
    { id: 'rr-d', name: 'D' },
  ]; } },
};
`;

(async () => {
  let srv = null;
  try {
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(path.join(modDir, 'index.js'), MODULE_SRC);
    fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ owner_name: 'Tester', modules: { [NAME]: true },
      bots: [{ id: 'main', name: 'main', engine: 'claude' }], server: { port: 0, tick_ms: 50 } }));
    const env = { ...process.env, HARNESS_CONFIG: path.join(base, 'config.json'), HARNESS_STATE_DIR: state, HARNESS_LOG_DIR: path.join(base, 'logs'),
      HARNESS_ENGINE_SCRIPT: path.join(ROOT, 'test', 'fake-engine.js'), HARNESS_WORK_DIR: work };
    delete env.HARNESS_OWNER; delete env.HARNESS_NO_SERVER; delete env.HARNESS_TASK_ID;
    srv = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskmote.js'), 'serve'], { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; srv.stdout.on('data', d => { out += d; }); srv.stderr.on('data', d => { out += d; });
    const rd = f => { try { return fs.readFileSync(path.join(state, f), 'utf8').trim(); } catch { return null; } };
    let port = null;
    for (let i = 0; i < 250 && !port; i++) { await tick(80); try { const j = JSON.parse(rd('server.json')); if (j.pid === srv.pid && j.port) port = j.port; } catch { /* not yet */ } }
    if (!port) throw new Error('server did not start: ' + out);
    const token = rd('server.token');
    const get = (p, o) => req(port, '/m/' + NAME + p, { token, ...o });

    // allowed types: served as the allow-listed type, with nosniff and a length
    for (const [p, type] of [['/png', 'image/png'], ['/jpeg', 'image/jpeg'], ['/webp', 'image/webp'], ['/gif', 'image/gif']]) {
      const r = await get(p);
      check(`${type} is served as itself`, r.status === 200 && r.headers['content-type'] === type && r.body.equals(PNG), `${r.status} ${r.headers['content-type']}`);
    }
    const png = await get('/png');
    check('nosniff and content-length are sent', png.headers['x-content-type-options'] === 'nosniff' && Number(png.headers['content-length']) === PNG.length);
    check('no etag: no long cache', !png.headers.etag && png.headers['cache-control'] === 'no-store');
    const edge = await get('/edge');
    check('exactly 2 MB is served', edge.status === 200 && edge.body.length === CAP);

    // etag: immutable cache, then 304
    const t1 = await get('/tagged');
    check('etag: ETag and private immutable cache', t1.status === 200 && t1.headers.etag === '"abc123"' && t1.headers['cache-control'] === 'private, max-age=31536000, immutable', JSON.stringify(t1.headers));
    const t2 = await get('/tagged', { headers: { 'if-none-match': '"abc123"' } });
    check('etag: If-None-Match -> 304, no body', t2.status === 304 && t2.body.length === 0 && t2.headers.etag === '"abc123"');
    const t3 = await get('/tagged', { headers: { 'if-none-match': '"other", "abc123"' } });
    check('etag: a list holding the tag -> 304', t3.status === 304);
    const t4 = await get('/tagged', { headers: { 'if-none-match': '"other"' } });
    check('etag: a different tag -> 200 with the body', t4.status === 200 && t4.body.equals(PNG));

    // refused: 500, a generic JSON error, none of the bytes
    for (const [p, why] of [['/svg', 'svg'], ['/html', 'html'], ['/notype', 'no type'], ['/big', 'over 2 MB'], ['/string', 'string body'], ['/both', 'json and body'], ['/badetag', 'bad etag'], ['/s404', 'non-200']]) {
      const r = await get(p);
      let j = null; try { j = JSON.parse(r.body.toString('utf8')); } catch { /* none */ }
      check(`refused: ${why} -> 500, generic error, no raw bytes`, r.status === 500 && /json/.test(r.headers['content-type'] || '') && j && j.error === 'internal error' && !r.body.includes(PNG.subarray(8, 20)), `${r.status} ${r.headers['content-type']}`);
    }
    await tick(200);
    const journal = rd('journal.jsonl') || '';
    check('refused results are logged (route_error), the reason names the problem', /route_error/.test(journal) && /raw route result refused/.test(journal), journal.slice(-200));

    // a route gets the raw power only by declaring raw: true
    const und = await get('/undeclared');
    let uj = null; try { uj = JSON.parse(und.body.toString('utf8')); } catch { /* none */ }
    check('undeclared route returning a png -> 500, generic error with ref, no bytes', und.status === 500 && uj && uj.error === 'internal error' && uj.ref && !und.body.includes(PNG.subarray(8, 20)), `${und.status} ${und.headers['content-type']}`);
    await tick(200);
    check('undeclared raw result is journaled as route_error', /route_error/.test(rd('journal.jsonl') || '') && /did not declare raw: true/.test(rd('journal.jsonl') || ''));
    const dj = await get('/declared-json');
    check('declared raw route may still return JSON', dj.status === 200 && /^application\/json/.test(dj.headers['content-type']) && JSON.parse(dj.body.toString()).ok === 'declared');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'index.js'), `module.exports = { contract: 1, name: '${NAME}-bad', routes: [{ method: 'GET', path: '/x', raw: 'yes', handler() {} }] };
`);
    const ld = M.load({ modules: { [NAME + '-bad']: true } });
    check('raw: "yes" (non-boolean) is refused at registration', ld.errors.length === 1 && /raw must be true or absent/.test(ld.errors[0]), ld.errors.join());

    // auth: the same as every module route
    const noTok = await get('/png', { token: null });
    check('no token -> 401/403, no image', (noTok.status === 401 || noTok.status === 403) && !noTok.body.equals(PNG), String(noTok.status));
    const badTok = await get('/png', { token: 'wrong-' + tag });
    check('wrong token -> 401/403, no image', (badTok.status === 401 || badTok.status === 403) && !badTok.body.equals(PNG), String(badTok.status));
    const noTok2 = await get('/tagged', { token: null, headers: { 'if-none-match': '"abc123"' } });
    check('no token + matching If-None-Match -> refused, not 304', noTok2.status === 401 || noTok2.status === 403, String(noTok2.status));

    // JSON routes are unchanged
    const j = await get('/json');
    check('JSON route unchanged', j.status === 200 && /^application\/json/.test(j.headers['content-type']) && j.headers['cache-control'] === 'no-store' && JSON.parse(j.body.toString()).ok === true);

    // seam: /api/bots passes avatar through only when it is a module route path
    const list = JSON.parse((await req(port, '/api/bots', { token })).body.toString());
    const by = id => list.find(b => b.id === id);
    check('/api/bots: a module-route avatar passes through', by('rr-a') && by('rr-a').avatar === `/m/${NAME}/tagged?v=abc12345`, JSON.stringify(by('rr-a')));
    check('/api/bots: an off-site, non-string or missing avatar is dropped', by('rr-b') && by('rr-c') && by('rr-d') && !('avatar' in by('rr-b')) && !('avatar' in by('rr-c')) && !('avatar' in by('rr-d')));
    check('/api/bots: avatar paths with ".." or "//" are dropped', by('rr-e') && by('rr-f') && !('avatar' in by('rr-e')) && !('avatar' in by('rr-f')));
    check('/api/bots: the config bot is unchanged', by('main') && !('avatar' in by('main')));
  } catch (e) {
    check('raw-route suite ran', false, (e && e.stack) || String(e));
  } finally {
    if (srv) killTree(srv.pid);
    await tick(300);
    try { fs.rmSync(modDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(badDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  const bad = results.filter(x => !x).length;
  console.log(`\n${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})();
