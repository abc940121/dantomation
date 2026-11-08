#!/usr/bin/env node
'use strict';
// device-pairing: (1) the store (expiry, reuse, lockout, revocation, hash-only storage,
// allowlist, token TTL) in-process; (2) the real server over HTTP on 127.0.0.1 (mint by the
// owner, redeem without a token, allowlist denial, device audit, revocation, the old owner path).
// Needs the device-pairing module enabled (SKIP otherwise). Scratch state dir, loopback only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const cur = require(path.join(ROOT, 'lib', 'config')).load();
if (!cur.modules['device-pairing']) { console.log('SKIP: device-pairing is not enabled in this config'); process.exit(0); }

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devpair-'));
const state = path.join(base, 'state');
process.env.HARNESS_STATE_DIR = state;
const S = require('../store');
const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !info ? '' : ': ' + info}`); };
const files = () => { try { return fs.readdirSync(S.dir()).map(f => fs.readFileSync(path.join(S.dir(), f), 'utf8')).join('\n'); } catch { return ''; } };
const journal = () => { try { return fs.readFileSync(path.join(state, 'journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

// ------------------------------------------------------------ 1. the store
{
  const t0 = 1_000_000_000_000;
  const m = S.mintCode(t0);
  check('mint: long code for the QR and six digits as the fallback', /^pc_[\w-]{30,}$/.test(m.code) && /^\d{6}$/.test(m.short));
  check('mint: only digests are on disk, never a code', !files().includes(m.code) && !files().includes(m.short));
  const r = S.redeem(m.code, 'My Phone', t0 + 1000);
  check('redeem: the long code gives a device token', r.ok && /^dvt_[0-9a-f]{8}\.[\w-]{40,}$/.test(r.token) && r.label === 'My Phone');
  check('hash-only storage: the token is not in any file, its sha256 is', !files().includes(r.token) && files().includes(require('crypto').createHash('sha256').update(r.token).digest('hex')));
  check('device record: label, created, last seen, revoked', (() => { const d = S.list(t0 + 2000)[0]; return d && d.id === r.id && d.label === 'My Phone' && d.created && d.revoked === false && 'lastSeen' in d; })());
  check('list never shows the token or its hash', !JSON.stringify(S.list()).includes(r.token) && !/hash/.test(JSON.stringify(S.list())));
  const again = S.redeem(m.code, 'x', t0 + 2000), short = S.redeem(m.short, 'x', t0 + 2000);
  check('reuse: a spent code is dead (long and short)', !again.ok && again.status === 401 && !short.ok);
  const a = S.authenticate(r.token, t0 + 3000);
  check('authenticate: the device token works and names the device', a && a.id === r.id && a.label === 'My Phone');
  check('authenticate: wrong, truncated and foreign tokens fail', !S.authenticate(r.token + 'x', t0) && !S.authenticate(r.token.slice(0, -1), t0) && !S.authenticate('dvt_00000000.' + 'a'.repeat(43), t0) && !S.authenticate('', t0) && !S.authenticate(undefined, t0));
  check('last seen is recorded', S.list(t0 + 4000)[0].lastSeen === new Date(t0 + 3000).toISOString());
  check('revoke: unknown id is refused', S.revoke('ffffffff') === false);
  check('revoke: the device token stops working at once', S.revoke(r.id) === true && !S.authenticate(r.token, t0 + 5000) && S.list()[0].revoked === true);
  // six digits redeem too, and tolerate a space or dash
  const m2 = S.mintCode(t0 + 10000);
  const r2 = S.redeem(m2.short.slice(0, 3) + ' ' + m2.short.slice(3), undefined, t0 + 11000);
  check('redeem: the six digits work (spaces ignored); default label', r2.ok && r2.label === 'phone');
  // expiry
  const m3 = S.mintCode(t0 + 20000);
  const late = S.redeem(m3.code, 'x', t0 + 20000 + S.CODE_TTL_MS + 1);
  check('expiry: a code older than 2 minutes is refused', !late.ok);
  const m4 = S.mintCode(t0 + 30000);
  check('expiry: just inside 2 minutes still works', S.redeem(m4.short, 'x', t0 + 30000 + S.CODE_TTL_MS - 1).ok);
  // lockout
  const m5 = S.mintCode(t0 + 40000);
  let last;
  for (let i = 0; i < S.MAX_FAILS; i++) last = S.redeem(i % 2 ? '000000' : 'pc_wrong', 'x', t0 + 41000 + i);
  check('lockout: the 5th wrong guess wipes every pending code', !last.ok);
  const afterLock = S.redeem(m5.code, 'x', t0 + 42000);
  check('lockout: even the right code is refused during the lock (429)', !afterLock.ok && afterLock.status === 429);
  const m6 = S.mintCode(t0 + 41000 + S.LOCK_MS + 5000);
  check('lockout: ends after the lock time; a new code works', S.redeem(m6.code, 'x', t0 + 41000 + S.LOCK_MS + 6000).ok);
  const m7 = S.mintCode(t0 + 200000);
  S.redeem('999999', 'x', t0 + 200001); S.redeem('999998', 'x', t0 + 200002);
  check('few wrong guesses do not kill the code', S.redeem(m7.short, 'x', t0 + 200003).ok);
  // token ttl, sliding
  const m8 = S.mintCode(t0 + 300000), r8 = S.redeem(m8.code, 'old', t0 + 300001);
  check('ttl: a device unused for the TTL must pair again', S.authenticate(r8.token, t0 + 300001 + S.DEVICE_TTL_MS + 1000) === null);
  const m9 = S.mintCode(t0 + 400000), r9 = S.redeem(m9.code, 'busy', t0 + 400001);
  const half = S.DEVICE_TTL_MS * 0.6;
  S.authenticate(r9.token, t0 + 400001 + half);
  check('ttl: use renews it (sliding)', S.authenticate(r9.token, t0 + 400001 + 2 * half) !== null);
  // allowlist
  const ok = [['GET', '/api/bots'], ['GET', '/api/tasks'], ['GET', '/api/tasks/t1'], ['GET', '/api/cards'], ['GET', '/api/events'], ['GET', '/api/status'], ['POST', '/api/chat'], ['POST', '/api/cards/card-1a2b'], ['POST', '/api/tasks/t1/stop'], ['POST', '/m/voice-chat/utterance'], ['POST', '/m/voice-chat/poll'], ['POST', '/m/voice-chat/playback']];
  const no = [['POST', '/api/tasks'], ['POST', '/api/tasks/t1/undo'], ['POST', '/api/tasks/t1/resume'], ['GET', '/api/settings/worker'], ['PATCH', '/api/settings/worker'], ['POST', '/api/worker/claim'], ['GET', '/api/worker/x'], ['POST', '/m/device-pairing/mint'], ['GET', '/m/device-pairing/devices'], ['POST', '/m/device-pairing/devices/x/revoke'], ['POST', '/m/worker/anything'], ['GET', '/m/approval-cards/cards'], ['DELETE', '/api/chat'], ['GET', '/api/chat'], ['POST', '/api/events'], ['GET', '/api/tasks/../settings/x'], ['GET', '/api/botsx'], ['POST', '/api/cards/card-1/../../settings/x'], ['GET', '/']];
  check('allowlist: chat read/send, cards, stop, status, voice-chat are allowed', ok.every(([m, p]) => S.allows(m, p)), ok.filter(([m, p]) => !S.allows(m, p)).join(' '));
  check('allowlist: everything else is denied', no.every(([m, p]) => !S.allows(m, p)), no.filter(([m, p]) => S.allows(m, p)).join(' '));
}

// ------------------------------------------------------------ 2. over HTTP
const tick = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); let v; while (!(v = await fn()) && Date.now() - t0 < ms) await tick(80); return v; };
const state2 = path.join(base, 'state2');
const cfgFile = path.join(base, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ owner_name: 'Tester', modules: { 'device-pairing': true, 'approval-cards': true, 'chat-ui': true, 'voice-chat': true }, server: { port: 0, tick_ms: 50 } }));
const env = { ...process.env, HARNESS_CONFIG: cfgFile, HARNESS_STATE_DIR: state2, HARNESS_LOG_DIR: path.join(base, 'logs'), HARNESS_NO_SERVER: '' };
delete env.HARNESS_OWNER; delete env.HARNESS_TASK_ID; delete env.HARNESS_NO_SERVER;
const req = (port, method, p, body, token, extra) => new Promise((res, rej) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(extra || {}) } }, x => {
    let s = ''; x.on('data', c => { s += c; }); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* none */ } res({ status: x.statusCode, json: j, raw: s }); });
  });
  r.on('error', rej); if (data) r.write(data); r.end();
});

(async () => {
  // ---- 1b. cross-process serialization (state dir shared by child processes)
  const runChild = code => new Promise(res => {
    const c = spawn(process.execPath, ['-e', code], { env: { ...process.env, HARNESS_STATE_DIR: state }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let o = ''; c.stdout.on('data', d => { o += d; }); c.on('close', () => res(o.trim()));
  });
  const storePath = JSON.stringify(path.join(ROOT, 'modules', 'device-pairing', 'store.js'));
  try { fs.rmSync(path.join(S.dir(), 'pending.json')); } catch { /* none */ } // the in-process tests above used a fake clock
  const mc = S.mintCode();
  const outs = await Promise.all(Array.from({ length: 4 }, () => runChild(`const S=require(${storePath});const r=S.redeem(${JSON.stringify(mc.code)},'c');console.log(r.ok?'ok':'no')`)));
  check('lock: simultaneous redemptions of one code give exactly one token', outs.filter(x => x === 'ok').length === 1, outs.join(','));
  // a revoke running concurrently with redeems and mints in other processes is never lost
  const victim = S.redeem(S.mintCode().code, 'victim');
  const mixed = [];
  for (let i = 0; i < 4; i++) mixed.push(runChild(`const S=require(${storePath});for(let i=0;i<5;i++){const m=S.mintCode();S.redeem(m.code,'x'+i)}console.log('done')`));
  mixed.push(runChild(`const S=require(${storePath});console.log(S.revoke(${JSON.stringify(victim.id)}))`));
  await Promise.all(mixed);
  check('lock: a concurrent revoke is not resurrected by redeem or mint writes', S.authenticate(victim.token) === null && S.list().find(d => d.id === victim.id).revoked === true);
  // fail closed: a fresh lock held by someone else refuses redeem and mint
  const lf = path.join(S.dir(), 'store.lock');
  const mcl = S.mintCode();
  fs.writeFileSync(lf, '');
  const rr = S.redeem(mcl.code, 'late');
  fs.writeFileSync(lf, '');
  let threw = false; try { S.mintCode(); } catch { threw = true; }
  check('lock: when the lock cannot be taken, redeem and mint refuse (fail closed)', rr.ok === false && rr.status === 503 && threw, JSON.stringify(rr));
  fs.unlinkSync(lf);
  check('lock: after release the same code still redeems', S.redeem(mcl.code, 'late').ok === true);
  fs.writeFileSync(lf, ''); const old = new Date(Date.now() - 60000); fs.utimesSync(lf, old, old);
  check('lock: a stale lock file is broken', S.mintCode().code.startsWith('pc_'));

  const port0 = await new Promise(r => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const ownerTok = require('crypto').randomBytes(24).toString('hex');
  fs.mkdirSync(path.join(state2, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(state2, 'server.token'), ownerTok, { mode: 0o600 });
  fs.writeFileSync(path.join(state2, 'secrets', 'voice-chat.json'), JSON.stringify({ token: ownerTok }), { mode: 0o600 });
  fs.writeFileSync(cfgFile, JSON.stringify({ owner_name: 'Tester', modules: { 'device-pairing': true, 'approval-cards': true, 'chat-ui': true, 'voice-chat': true }, server: { port: port0, tick_ms: 50 }, voice_chat: { api_base: `http://127.0.0.1:${port0}` } }));
  const srv = spawn(process.execPath, [path.join(ROOT, 'bin', 'dantomation.js'), 'serve'], { env, cwd: base, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = ''; srv.stdout.on('data', d => { out += d; }); srv.stderr.on('data', d => { out += d; });
  const info = await waitFor(() => { try { const i = JSON.parse(fs.readFileSync(path.join(state2, 'server.json'), 'utf8')); return i.pid === srv.pid && i.port ? i : null; } catch { return null; } });
  if (!info) { console.log('FAIL server did not start: ' + out); process.exit(1); }
  const port = info.port;
  const owner = fs.readFileSync(path.join(state2, 'server.token'), 'utf8').trim();
  try {
    // mint: owner only
    check('mint: no token -> 401', (await req(port, 'POST', '/m/device-pairing/mint', {})).status === 401);
    const mint = await req(port, 'POST', '/m/device-pairing/mint', {}, owner);
    check('mint: the owner token gets a code', mint.status === 200 && /^pc_/.test(mint.json.code) && /^\d{6}$/.test(mint.json.short));
    check('mint: the owner token is not in the code or the link', !JSON.stringify(mint.json).includes(owner));
    // redeem needs no token, refuses a wrong code and a cross-origin page
    check('redeem: cross-origin POST is refused', (await req(port, 'POST', '/m/device-pairing/redeem', { code: mint.json.code }, null, { Origin: 'http://evil.example' })).status === 401);
    const redeem = await req(port, 'POST', '/m/device-pairing/redeem', { code: mint.json.code, label: 'Test Phone' });
    check('redeem: no owner token needed, a device token comes back', redeem.status === 200 && /^dvt_/.test(redeem.json.token) && redeem.json.token !== owner);
    const dev = redeem.json.token;
    check('redeem: the spent code is useless over HTTP', (await req(port, 'POST', '/m/device-pairing/redeem', { code: mint.json.short })).status === 401);
    // allowed
    check('device: GET /api/bots is allowed', (await req(port, 'GET', '/api/bots', undefined, dev)).status === 200);
    check('device: GET /api/cards is allowed', (await req(port, 'GET', '/api/cards', undefined, dev)).status === 200);
    const chat = await req(port, 'POST', '/api/chat', { bots: 'all' }, dev);
    check('device: POST /api/chat reaches the handler (400 for the missing text, not 403)', chat.status === 400);
    const card = await req(port, 'POST', '/api/cards/card-ffffff', { answer: 'yes' }, dev);
    check('device: answering a card reaches the handler (404 unknown card, not 403)', card.status === 404);
    // a device answers a real card: the server records the device id and phone from the token, never from the body
    const seed = id => { const t0 = Date.now(); fs.appendFileSync(path.join(state2, 'journal.jsonl'), JSON.stringify({ id: 'seed-' + id, ts: new Date(t0).toISOString(), type: 'card', module: 'approval-cards', card_id: id, task_id: 'tseed', tool: 'Bash', input: { command: 'echo ' + id }, sha256: id, summary: 'echo ' + id, rule: 'test', created_at: new Date(t0).toISOString(), expires_at: new Date(t0 + 600000).toISOString() }) + String.fromCharCode(10)); };
    seed('card-aaaa01'); seed('card-aaaa02');
    const dAns = await req(port, 'POST', '/api/cards/card-aaaa01', { answer: 'yes', device_id: 'dvt_spoofed', where: 'chat', who: 'owner' }, dev);
    const decided = id => journal2().filter(r => r.type === 'card_answer' && r.card_id === id)[0];
    const da = decided('card-aaaa01');
    check('device answer: the journal records who=device, this device id, where=phone', dAns.status === 200 && da && da.who === 'device' && da.device_id === redeem.json.id && da.where === 'phone', JSON.stringify(da));
    check('device answer: a spoofed device_id, where or who in the body is ignored', da && da.device_id !== 'dvt_spoofed' && da.where === 'phone' && da.who === 'device');
    const oAns = await req(port, 'POST', '/api/cards/card-aaaa02', { answer: 'no', device_id: 'dvt_spoofed', where: 'phone' }, owner);
    const oa = decided('card-aaaa02');
    check('owner answer: still who=owner, where=chat, no device id', oAns.status === 200 && oa && oa.who === 'owner' && oa.where === 'chat' && oa.device_id === undefined, JSON.stringify(oa));
    check('cards list exposes the decision label', (await req(port, 'GET', '/api/cards?state=all', undefined, owner)).json.some(c => c.id === 'card-aaaa01' && /^Approved · device .+ via phone$/.test(c.decision || '')));
    // a device speaks the approval: voice-chat relays it, the journal says device + voice (not owner via chat)
    seed('card-aaaa03');
    const vu = t => req(port, 'POST', '/m/voice-chat/utterance', { text: t }, dev);
    const v1 = await vu('hey assistant hello');
    check('voice: a device reaches voice-chat, the pending card is read aloud', v1.status === 200 && JSON.stringify(v1.json).includes('echo card-aaaa03'), v1.raw.slice(0, 200));
    await tick(400);
    const v2 = await vu('yes');
    const vd = decided('card-aaaa03');
    check('voice: a device-token spoken yes records who=device, this device id, where=voice', vd && vd.answer === 'yes' && vd.who === 'device' && vd.device_id === redeem.json.id && vd.where === 'voice', JSON.stringify([vd, v2.raw.slice(0, 200)]));
    seed('card-aaaa04');
    const vo = t => req(port, 'POST', '/m/voice-chat/utterance', { text: t }, owner);
    await vo('hey assistant hello'); await tick(400); await vo('no');
    const od = decided('card-aaaa04');
    check('voice: an owner spoken no records who=owner, where=voice, no device id', od && od.answer === 'no' && od.who === 'owner' && od.where === 'voice' && od.device_id === undefined, JSON.stringify(od));
    // denied
    const denied = [['POST', '/api/tasks', { prompt: 'x' }], ['POST', '/api/tasks/t1/undo', {}], ['POST', '/api/tasks/t1/resume', {}], ['GET', '/api/settings/approval-cards'], ['PATCH', '/api/settings/approval-cards', { timeout_minutes: 1 }],
      ['POST', '/api/worker/claim', {}], ['POST', '/m/device-pairing/mint', {}], ['GET', '/m/device-pairing/devices'], ['GET', '/m/approval-cards/cards']];
    const dr = [];
    for (const [m, p, b] of denied) dr.push((await req(port, m, p, b, dev)).status);
    check('device: tasks, undo, resume, settings, worker, pairing admin and other module routes -> 403', dr.every(s => s === 403), dr.join());
    check('device: a device cannot list or revoke devices or mint codes', (await req(port, 'GET', '/m/device-pairing/devices', undefined, dev)).status === 403);
    check('device: a made-up device token is 401 on a change (loopback reads stay anonymous, as with no token)', (await req(port, 'POST', '/api/chat', { bots: 'all', text: 'x' }, 'dvt_00000000.' + 'a'.repeat(43))).status === 401);
    // audit
    const j = journal2();
    const acts = j.filter(r => r.type === 'device_action');
    check('audit: each allowed change is journaled with the device id and label', acts.some(a => a.path === '/api/chat' && a.device_id === redeem.json.id && a.label === 'Test Phone') && acts.some(a => a.path === '/api/cards/card-ffffff'));
    check('audit: denied calls and reads are not logged as actions', !acts.some(a => a.path === '/api/tasks' || a.path === '/api/bots'));
    check('audit: no token, code or hash in the journal', !JSON.stringify(j).includes(dev) && !JSON.stringify(j).includes(mint.json.code) && !JSON.stringify(j).includes(owner));
    // owner still works, old path unchanged
    check('owner: the owner token still works everywhere (deprecated #t= path)', (await req(port, 'GET', '/api/settings/approval-cards', undefined, owner)).status === 200 && (await req(port, 'GET', '/m/device-pairing/devices', undefined, owner)).json.length === 1);
    const lst = await req(port, 'GET', '/m/device-pairing/devices', undefined, owner);
    check('list: the owner sees the device, no token or hash', lst.json[0].id === redeem.json.id && !lst.raw.includes(dev) && !/hash/.test(lst.raw));
    // revoke
    const rv = await req(port, 'POST', `/m/device-pairing/devices/${redeem.json.id}/revoke`, {}, owner);
    check('revoke: the owner revokes the device', rv.status === 200);
    check('revoke: the device token is dead on the next request', (await req(port, 'POST', '/api/chat', { bots: 'all', text: 'x' }, dev)).status === 401);
    // lockout over HTTP
    await req(port, 'POST', '/m/device-pairing/mint', {}, owner);
    let st = 0; for (let i = 0; i < 6; i++) st = (await req(port, 'POST', '/m/device-pairing/redeem', { code: String(100000 + i) })).status;
    check('lockout over HTTP: repeated wrong codes end in 429', st === 429);
  } finally {
    if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(srv.pid)], { stdio: 'ignore' }); else srv.kill('SIGKILL');
  }
  const bad = results.filter(x => !x).length;
  console.log(`result: ${results.length - bad}/${results.length} passed`);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(bad ? 1 : 0);

  function journal2() { try { return fs.readFileSync(path.join(state2, 'journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } }
})();
