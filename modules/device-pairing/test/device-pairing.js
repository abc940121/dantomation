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
  const ok = [['GET', '/m/question-cards/questions'], ['POST', '/m/question-cards/questions/Q-1a2b/answer'], ['GET', '/api/bots'], ['GET', '/api/tasks'], ['GET', '/api/tasks/t1'], ['GET', '/api/cards'], ['GET', '/api/events'], ['GET', '/api/status'], ['POST', '/api/chat'], ['POST', '/api/cards/card-1a2b'], ['POST', '/api/tasks/t1/stop'], ['POST', '/m/voice-chat/utterance'], ['POST', '/m/voice-chat/poll'], ['POST', '/m/voice-chat/playback'], ['GET', '/m/rooms/rooms'], ['GET', '/m/rooms/rooms/dev/messages'], ['POST', '/m/rooms/rooms/dev/say'], ['POST', '/m/roles/groups'], ['GET', '/m/roles/avatar/r-1a2b3c4d'], ['POST', '/m/roles/avatar/r-1a2b3c4d'], ['GET', '/m/roles/cards/r-1a2b3c4d']];
  const no = [['POST', '/m/question-cards/questions'], ['POST', '/m/question-cards/questions/Q-1a2b/cancel'], ['GET', '/m/question-cards/questions/recent'], ['GET', '/m/question-cards/questions/Q-1a2b'], ['POST', '/api/tasks'], ['POST', '/api/tasks/t1/undo'], ['POST', '/api/tasks/t1/resume'], ['GET', '/api/settings/worker'], ['PATCH', '/api/settings/worker'], ['POST', '/api/worker/claim'], ['GET', '/api/worker/x'], ['POST', '/m/device-pairing/mint'], ['GET', '/m/device-pairing/devices'], ['POST', '/m/device-pairing/devices/x/revoke'], ['POST', '/m/worker/anything'], ['GET', '/m/approval-cards/cards'], ['DELETE', '/api/chat'], ['GET', '/api/chat'], ['POST', '/api/events'], ['GET', '/api/tasks/../settings/x'], ['GET', '/api/botsx'], ['POST', '/api/cards/card-1/../../settings/x'], ['GET', '/'], ['POST', '/m/rooms/rooms/dev/summary'], ['POST', '/m/rooms/rooms'], ['GET', '/m/rooms/rooms/dev/say'], ['POST', '/m/rooms/rooms/dev/messages'], ['GET', '/m/rooms/rooms/../x/messages'], ['GET', '/m/rooms/rooms/dev/summary'], ['GET', '/m/roles/groups'], ['PATCH', '/m/roles/groups'], ['DELETE', '/m/roles/groups'], ['POST', '/m/roles/groups/g-1a2b3c4d'], ['POST', '/m/roles/groups/g-1a2b3c4d/update'], ['POST', '/m/roles/groups/g-1a2b3c4d/remove'], ['POST', '/m/roles/groups/g-1a2b3c4d/archive'], ['POST', '/m/roles/groups/x'], ['PATCH', '/m/roles/cards/r-1a2b3c4d'], ['POST', '/m/roles/cards/r-1a2b3c4d'], ['DELETE', '/m/roles/cards/r-1a2b3c4d'], ['PATCH', '/m/roles/avatar/r-1a2b3c4d'], ['PUT', '/m/roles/avatar/r-1a2b3c4d'], ['POST', '/m/roles/avatar/r-1a2b3c4d5'], ['POST', '/m/roles/avatar/r-1a2b3c4d/x'], ['POST', '/m/roles/avatar'], ['DELETE', '/m/roles/avatar/r-1a2b3c4d'], ['GET', '/m/roles/cards/r-1a2b3c4d5'], ['GET', '/m/roles/avatar/r-1a2b3c4d5'], ['GET', '/m/roles/cards/r-1a2b3c4d/x'], ['GET', '/m/roles/avatar/r-1a2b3c4d/x'], ['GET', '/m/roles/cards'], ['GET', '/m/roles/cards/x']];
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
    let s = ''; x.on('data', c => { s += c; }); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* none */ } res({ status: x.statusCode, json: j, raw: s, headers: x.headers }); });
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
  fs.writeFileSync(lf, ''); const old = new Date(Date.now() - 3600000); fs.utimesSync(lf, old, old);
  let umsg = ''; try { S.mintCode(); } catch (e) { umsg = e.message; }
  check('lock: an unreadable lock file is never reclaimed, even when old: the caller fails closed and the error names the file', /store\.lock/.test(umsg) && fs.existsSync(lf), umsg);
  fs.unlinkSync(lf);

  const port0 = await new Promise(r => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const ownerTok = require('crypto').randomBytes(24).toString('hex');
  fs.mkdirSync(path.join(state2, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(state2, 'server.token'), ownerTok, { mode: 0o600 });
  fs.writeFileSync(path.join(state2, 'secrets', 'voice-chat.json'), JSON.stringify({ token: ownerTok }), { mode: 0o600 });
  const roleStore = require(path.join(ROOT, 'modules', 'roles', 'store')).createStore(() => path.join(state2, 'm', 'roles')); // two roles for the group-create checks below
  const roleA = roleStore.create({ name: 'Ann', persona: 'You are Ann.' }), roleB = roleStore.create({ name: 'Bob', persona: 'You are Bob.' });
  fs.writeFileSync(cfgFile, JSON.stringify({ owner_name: 'Tester', modules: { 'device-pairing': true, 'approval-cards': true, 'chat-ui': true, 'voice-chat': true, roles: true, rooms: true }, server: { port: port0, tick_ms: 50 }, voice_chat: { api_base: `http://127.0.0.1:${port0}` } }));
  const srv = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskmote.js'), 'serve'], { env, cwd: base, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
    const qBefore = journal().filter(r => r.type === 'queue_add').length;
    const dWd = await req(port, 'POST', '/api/tasks', { prompt: 'x', workdir: state }, dev);
    check('device: POST /api/tasks with a workdir -> 403 and nothing is queued', dWd.status === 403 && journal().filter(r => r.type === 'queue_add').length === qBefore, dWd.raw);
    check('device: a device cannot list or revoke devices or mint codes', (await req(port, 'GET', '/m/device-pairing/devices', undefined, dev)).status === 403);
    check('device: a made-up device token is 401 on a change (loopback reads stay anonymous, as with no token)', (await req(port, 'POST', '/api/chat', { bots: 'all', text: 'x' }, 'dvt_00000000.' + 'a'.repeat(43))).status === 401);
    // a device may create a group (and only create): validated by the route, journaled with the device
    const gUrl = '/m/roles/groups', gBefore = () => { try { return JSON.parse(fs.readFileSync(path.join(state2, 'm', 'roles', 'groups.json'), 'utf8')).groups.length; } catch { return 0; } };
    const g1 = await req(port, 'POST', gUrl, { name: 'Weekend Plans', members: [roleA.id, roleB.id], note: 'ignored' }, dev);
    check('device group: POST /m/roles/groups answers 201 with the group', g1.status === 201 && /^g-[0-9a-f]{8}$/.test(g1.json.id) && g1.json.name === 'Weekend Plans', g1.raw.slice(0, 200));
    const gNote = journal2().filter(r => r.type === 'group_created' && r.id === g1.json.id)[0];
    check('device group: the journal holds the group name, the member ids and device:<id> as the actor', gNote && gNote.name === 'Weekend Plans' && gNote.members.join() === [roleA.id, roleB.id].join() && gNote.by === 'device:' + redeem.json.id, JSON.stringify(gNote));
    check('device group: the device_action line names the device and the path', journal2().some(r => r.type === 'device_action' && r.method === 'POST' && r.path === gUrl && r.device_id === redeem.json.id));
    const gCount = gBefore();
    const badGroup = [['unknown member id', { name: 'Ghost', members: [roleA.id, 'r-00000000'] }], ['more than 16 members', { name: 'Big', members: Array.from({ length: 17 }, () => roleA.id) }], ['a 41-character name', { name: 'x'.repeat(41), members: [roleA.id] }], ['an empty name', { name: '', members: [roleA.id] }]];
    for (const [what, b] of badGroup) { const r = await req(port, 'POST', gUrl, b, dev); check('device group: ' + what + ' -> 400 with an error', r.status === 400 && r.json && typeof r.json.error === 'string', r.raw.slice(0, 200)); }
    check('device group: refused requests saved nothing', gBefore() === gCount);
    const gDen = [];
    for (const [m, p, b] of [['POST', gUrl + '/' + g1.json.id, { name: 'x' }], ['POST', gUrl + '/' + g1.json.id + '/update', { name: 'x' }], ['POST', gUrl + '/' + g1.json.id + '/remove', {}], ['PATCH', gUrl, { name: 'x' }], ['DELETE', gUrl, undefined], ['GET', gUrl, undefined]]) gDen.push((await req(port, m, p, b, dev)).status);
    check('device group: update, remove and archive style routes -> 403', gDen.every(s => s === 403), gDen.join());
    // a device may edit a group with PATCH /m/roles/groups/:id (name, add, remove, archived) and nothing else
    const gEdit = gUrl + '/' + g1.json.id;
    const gp = await req(port, 'PATCH', gEdit, { name: 'Weekend Trip' }, dev);
    check('device group: PATCH renames the group (200)', gp.status === 200 && gp.json.name === 'Weekend Trip', gp.raw.slice(0, 200));
    check('device group: the PATCH is journaled with the device as the actor and a device_action line', journal2().some(r => r.type === 'group_updated' && r.id === g1.json.id && r.by === 'device:' + redeem.json.id) && journal2().some(r => r.type === 'device_action' && r.method === 'PATCH' && r.path === gEdit && r.device_id === redeem.json.id));
    const gArch = await req(port, 'PATCH', gEdit, { archived: true }, dev);
    const gBack = await req(port, 'PATCH', gEdit, { archived: false }, dev);
    check('device group: archive is reversible, a paired device token restores it (journal has by device:<id>)', gArch.status === 200 && !!gArch.json.archived_at && gBack.status === 200 && !gBack.json.archived_at && journal2().some(r => r.type === 'group_restored' && r.id === g1.json.id && r.by === 'device:' + redeem.json.id), JSON.stringify([gArch.status, gBack.status]));
    await req(port, 'PATCH', gEdit, { archived: true }, dev);
    const gList = await req(port, 'GET', gUrl + '/archived', undefined, dev), gListX = await req(port, 'GET', gUrl + '/archived/x', undefined, dev), gListP = await req(port, 'POST', gUrl + '/archived', {}, dev);
    check('device group: a device token reads the archived list (200, the group in it); a nearby path or method is refused (403)', gList.status === 200 && gList.json.groups.some(x => x.id === g1.json.id && Object.keys(x).sort().join() === 'archived_at,id,members,name') && gListX.status === 403 && gListP.status === 403, [gList.status, gListX.status, gListP.status].join());
    await req(port, 'PATCH', gEdit, { archived: false }, dev);
    const gx = [];
    for (const b of [{ name: 'Sneaky', persona: 'x' }, { name: 'Sneaky', tier: 'all' }, { main: true }, { owner: 'device' }, { name: 'Sneaky', members: [roleA.id] }]) gx.push((await req(port, 'PATCH', gEdit, b, dev)).status);
    check('device group: a body with any extra field is refused (400) and nothing is written', gx.every(s => s === 400) && JSON.parse(fs.readFileSync(path.join(state2, 'm', 'roles', 'groups.json'), 'utf8')).groups.find(x => x.id === g1.json.id).name === 'Weekend Trip', gx.join());
    const gPathNo = [];
    for (const [m, p] of [['PATCH', gUrl], ['PATCH', gEdit + '/x'], ['PATCH', gUrl + '/g-1234567'], ['PATCH', '/m/roles/roles' + '/' + roleA.id], ['PATCH', '/m/roles/cards/' + roleA.id], ['POST', gEdit]]) gPathNo.push((await req(port, m, p, { name: 'x' }, dev).catch(e => ({ status: String(e.code) + ' ' + m + ' ' + p }))).status);
    check('device group: the PATCH pattern matches no other path or method (403)', gPathNo.every(s => s === 403), gPathNo.join());
    // a device may create a role (and only create): the route reads name, job and a picture, caps the total, journals the device
    const rUrl = '/m/roles/roles', rDir = path.join(state2, 'm', 'roles'), rCount = () => roleStore.all().length;
    const avFiles = () => { try { return fs.readdirSync(path.join(rDir, 'avatars')).sort().join(); } catch { return ''; } };
    const rd = await req(port, 'POST', rUrl, { name: 'Dev Made', job: 'Checks drafts', engine: 'codex', model: 'x/y', tools: ['all'], powers: ['all'], access: 'owner', persona: 'ignore me', card: { name: 'x' } }, dev);
    check('device role: POST /m/roles/roles answers 201 with the role', rd.status === 201 && /^r-[0-9a-f]{8}$/.test(rd.json.id) && rd.json.name === 'Dev Made', rd.raw.slice(0, 200));
    const ro = await req(port, 'POST', rUrl, { name: 'Owner Made', job: 'Checks drafts' }, owner);
    const strip = r => { const c = { ...r }; for (const k of ['id', 'name', 'created_at', 'updated_at']) delete c[k]; return JSON.stringify(c); };
    const sd = roleStore.get(rd.json.id), so = roleStore.get(ro.json.id);
    check('device role: extra body fields (engine, model, tools, powers, access, persona, card) are ignored; only server defaults are stored', sd && sd.engine === 'claude' && !sd.model && sd.persona === 'Checks drafts' && !sd.card && !('tools' in sd) && !('powers' in sd) && !('access' in sd), JSON.stringify(sd));
    check('device role: a device-made role has exactly the same record as an owner-made one (no extra tools or grants)', so && strip(sd) === strip(so), strip(sd) + ' vs ' + strip(so));
    const rNote = journal2().filter(r => r.type === 'role_created' && r.id === rd.json.id)[0];
    check('device role: the journal holds device:<id> as the actor, and a device_action line names the path', rNote && rNote.by === 'device:' + redeem.json.id && journal2().some(r => r.type === 'device_action' && r.method === 'POST' && r.path === rUrl && r.device_id === redeem.json.id), JSON.stringify(rNote));
    const rDen = [];
    for (const [m, p, b] of [['PATCH', rUrl + '/' + rd.json.id, { name: 'x' }], ['DELETE', rUrl + '/' + rd.json.id], ['PATCH', rUrl, { name: 'x' }], ['DELETE', rUrl], ['PUT', rUrl + '/' + rd.json.id, { name: 'x' }], ['POST', rUrl + '/' + rd.json.id, { name: 'x' }], ['POST', rUrl + '/' + rd.json.id + '/archive', {}], ['POST', rUrl + '/' + rd.json.id + '/update', { name: 'x' }]]) rDen.push((await req(port, m, p, b, dev)).status);
    check('device role: PATCH, DELETE, update and archive style routes -> 403', rDen.every(s => s === 403), rDen.join());
    check('device role: the role is unchanged after those refused calls', roleStore.get(rd.json.id).name === 'Dev Made' && !roleStore.get(rd.json.id).archived_at);
    // pictures: the same content check and size cap as the owner (the handler sees the device as owner, so it cannot tell)
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const n0 = rCount(), a0 = avFiles();
    const rBad = [['text bytes sent as a picture', { name: 'Fake Pic', job: 'j', avatar: { data: Buffer.from('this is not an image, just text, long enough to pass for one').toString('base64') } }], ['a gif header', { name: 'Gif Pic', job: 'j', avatar: { data: Buffer.from('GIF89a' + 'x'.repeat(40)).toString('base64') } }], ['an oversize picture (base64 over the cap)', { name: 'Big Pic', job: 'j', avatar: { data: Buffer.alloc(250000, 7).toString('base64') } }], ['a body over the 256 KB cap', { name: 'Huge Pic', job: 'j', avatar: { data: 'A'.repeat(400000) } }]];
    for (const [what, b] of rBad) { const r = await req(port, 'POST', rUrl, b, dev).catch(e => ({ status: 413, raw: String(e.code) })); check('device role: ' + what + ' is refused (4xx, no role)', r.status >= 400 && r.status < 500 && !(r.json && r.json.id), r.status + ' ' + r.raw.slice(0, 120)); }
    check('device role: refused pictures saved no role and wrote no file', rCount() === n0 && avFiles() === a0);
    const okPic = await req(port, 'POST', rUrl, { name: 'Pic Role', job: 'j', avatar: { data: png } }, dev);
    check('device role: a real PNG is accepted and stored under avatars/', okPic.status === 201 && avFiles().includes(okPic.json.id), okPic.raw.slice(0, 160));
    // avatar file name: made by the server from the new role id; nothing in the request reaches a path
    const aN = avFiles().split(',').filter(Boolean);
    const sneaky = await req(port, 'POST', rUrl, { name: 'Sneaky Path', job: 'j', id: 'r-00000000', file: '../../evil.png', filename: '../x.png', ext: 'php', path: '/tmp/evil.png', avatar: { data: png, file: '../../evil.png', name: '../x.png', path: '/tmp/evil2.png', ext: '.svg', type: 'text/html' }, card: { avatar: { file: '../../evil3.png', kind: 'image' } } }, dev);
    const aNew = avFiles().split(',').filter(x => x && !aN.includes(x));
    check('device role: the avatar file name comes only from the server (avatars/<new id>.png; no request field reaches a path)', sneaky.status === 201 && aNew.length === 1 && aNew[0] === sneaky.json.id + '.png' && sneaky.json.id !== 'r-00000000' && !avFiles().includes('evil') && !fs.existsSync(path.join(rDir, 'evil.png')) && !fs.existsSync(path.join(rDir, '..', 'evil.png')) && roleStore.get(sneaky.json.id).card.avatar.file === sneaky.json.id + '.png', JSON.stringify({ aNew, st: sneaky.status, raw: sneaky.raw.slice(0, 150) }));
    // a device may change or clear a role picture (POST /m/roles/avatar/:id): one journal line with the device, the same record otherwise
    const chBefore = JSON.stringify(roleStore.get(rd.json.id));
    const chPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('new picture for the device change test')]);
    const chUrl = '/m/roles/avatar/' + rd.json.id;
    const ch = await req(port, 'POST', chUrl, { avatar: { data: chPng.toString('base64') }, name: 'Hacked', engine: 'codex' }, dev);
    const chRec = roleStore.get(rd.json.id);
    check('device avatar change: 200 with the new URL; only the picture changed (name, engine, persona untouched)', ch.status === 200 && /\?v=/.test(ch.json.avatar) && chRec.name === 'Dev Made' && chRec.engine === 'claude' && chRec.persona === 'Checks drafts' && !!chRec.card && Object.keys(chRec.card).join() === 'avatar', ch.raw.slice(0, 200));
    const chNote = journal2().filter(r => r.type === 'role_avatar_changed' && r.id === rd.json.id);
    check('device avatar change: the journal has role_avatar_changed with device:<id> and a device_action line, and no image data', chNote.length === 1 && chNote[0].by === 'device:' + redeem.json.id && journal2().some(r => r.type === 'device_action' && r.method === 'POST' && r.path === chUrl && r.device_id === redeem.json.id) && !JSON.stringify(journal2()).includes(chPng.toString('base64').slice(0, 24)));
    const chBad = await req(port, 'POST', chUrl, { avatar: { data: Buffer.from('plain text pretending to be a picture, long enough').toString('base64') } }, dev);
    const chGone = await req(port, 'POST', chUrl, { avatar: null }, dev);
    check('device avatar change: a non-image is refused (400) by content; {avatar:null} clears the picture', chBad.status === 400 && chGone.status === 200 && chGone.json.avatar === null && !roleStore.get(rd.json.id).card);
    check('device avatar change: no token -> 401 and the other roles routes stay closed (PATCH card, PUT/DELETE avatar -> 403)', (await req(port, 'POST', chUrl, { avatar: null })).status === 401 && (await req(port, 'PATCH', '/m/roles/cards/' + rd.json.id, { card: { voice: 'x' } }, dev)).status === 403 && (await req(port, 'PUT', chUrl, { avatar: null }, dev)).status === 403 && (await req(port, 'DELETE', chUrl, undefined, dev)).status === 403);
    void chBefore;
    // avatar GET: nosniff, a fixed content type, and a stored name with any other extension is a 404
    const avGet = await req(port, 'GET', '/m/roles/avatar/' + okPic.json.id, undefined, dev);
    check('device avatar GET: 200, X-Content-Type-Options: nosniff and Content-Type image/png from the fixed table', avGet.status === 200 && avGet.headers['x-content-type-options'] === 'nosniff' && avGet.headers['content-type'] === 'image/png', avGet.status + ' ' + JSON.stringify(avGet.headers));
    const rj = JSON.parse(fs.readFileSync(path.join(rDir, 'roles.json'), 'utf8'));
    rj.roles.find(r => r.id === okPic.json.id).card.avatar.file = okPic.json.id + '.svg';
    fs.writeFileSync(path.join(rDir, 'avatars', okPic.json.id + '.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    fs.writeFileSync(path.join(rDir, 'roles.json'), JSON.stringify(rj));
    const avSvg = await req(port, 'GET', '/m/roles/avatar/' + okPic.json.id, undefined, dev);
    check('device avatar GET: a stored file with a non-image extension (.svg) is a 404, never served', avSvg.status === 404 && !avSvg.raw.includes('<svg'), avSvg.status + ' ' + avSvg.raw.slice(0, 80));
    // card GET: only the listed keys, never the rest of the stored record
    const cg = await req(port, 'GET', '/m/roles/cards/' + rd.json.id, undefined, dev), cg2 = await req(port, 'GET', '/m/roles/cards/' + sneaky.json.id, undefined, dev);
    const cardKeys = ['id', 'name', 'fields', 'card', 'avatar'];
    check('device card GET: the top-level keys are only id, name, fields, card, avatar (no persona, engine, model, created_at, archived_at, avatar file name)', cg.status === 200 && cg2.status === 200 && Object.keys(cg.json).concat(Object.keys(cg2.json)).every(k => cardKeys.includes(k)) && !/"(persona|engine|model|created_at|updated_at|archived_at|file|hash)"/.test(cg.raw + cg2.raw), cg.raw.slice(0, 200));
    // the cap: 50 live roles (archived ones do not count), over it -> 409 and nothing saved
    let fillN = 0; while (roleStore.list().length < 50 && fillN < 60) { roleStore.create({ name: 'Fill ' + (fillN++), persona: 'filler' }); }
    check('device role cap: the store holds 50 live roles', roleStore.list().length === 50, String(roleStore.list().length));
    const r51 = await req(port, 'POST', rUrl, { name: 'Fifty First', job: 'j' }, dev);
    check('device role cap: the 51st live role is refused with 409 and a bilingual error', r51.status === 409 && r51.json && r51.json.error && /50/.test(JSON.stringify(r51.json.error)) && roleStore.list().length === 50, r51.status + ' ' + r51.raw.slice(0, 200));
    roleStore.archive('Fill 0');
    const r51b = await req(port, 'POST', rUrl, { name: 'After Archive', job: 'j' }, dev);
    const r51c = await req(port, 'POST', rUrl, { name: 'Again Over', job: 'j' }, dev);
    check('device role cap: after a role is archived there is room again (201), and the next one is 409 again', r51b.status === 201 && r51c.status === 409, r51b.status + ' ' + r51c.status);
    // archive is never open to a device: every archive / remove path is 403, the role stays live
    const arc = [];
    for (const [m, p, b] of [['POST', rUrl + '/' + rd.json.id + '/archive', {}], ['POST', rUrl + '/' + rd.json.id + '/remove', {}], ['POST', '/m/roles/archive', { role: rd.json.id }], ['POST', rUrl + '/archive', { role: rd.json.id }], ['DELETE', rUrl + '/' + rd.json.id], ['PATCH', rUrl + '/' + rd.json.id, { archived: true }], ['PATCH', '/m/roles/cards/' + rd.json.id, { card: { voice: 'x' } }]]) arc.push((await req(port, m, p, b, dev)).status);
    check('device role: no archive, remove, delete or patch path works for a device (all 403) and the role stays live', arc.every(s => s === 403) && !roleStore.get(rd.json.id).archived_at && roleStore.get(rd.json.id).name === 'Dev Made', arc.join());
    // per-device daily limit: 20 creations a day, the 21st is 429 with a journal line; the owner is not limited
    for (const r of roleStore.list()) if (/^Fill /.test(r.name)) roleStore.archive(r.id);
    const devActor = 'device:' + redeem.json.id;
    const madeByDev = () => journal2().filter(r => r.type === 'role_created' && r.by === devActor).length;
    let rlLast = null;
    for (let i = 0; i < 25 && !rlLast; i++) { const r = await req(port, 'POST', rUrl, { name: 'RL ' + i, job: 'j' }, dev); if (r.status !== 201) rlLast = r; }
    check('device role limit: the device made 20 roles in the day, then the 21st is a 429 with an error naming 20', madeByDev() === 20 && rlLast && rlLast.status === 429 && /20/.test(JSON.stringify(rlLast.json && rlLast.json.error)), madeByDev() + ' ' + (rlLast && rlLast.status + ' ' + rlLast.raw));
    const nBefore = rCount();
    const again = await req(port, 'POST', rUrl, { name: 'RL x', job: 'j' }, dev);
    check('device role limit: later attempts create nothing and each writes one role_rate_limited journal line (by device:<id>)', again.status === 429 && rCount() === nBefore && journal2().filter(r => r.type === 'role_rate_limited' && r.by === devActor && r.limit === 20).length === 2);
    check('device role limit: the owner is not limited (201)', (await req(port, 'POST', rUrl, { name: 'Owner After Limit', job: 'j' }, owner)).status === 201);
    check('device role limit: a limited device can still read (GET card -> 200)', (await req(port, 'GET', '/m/roles/cards/' + rd.json.id, undefined, dev)).status === 200);
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
    // handoff: a paired device mints one 10-minute code for the home-screen app
    const hUrl = '/m/device-pairing/handoff';
    const pairNew = async label => { const m = await req(port, 'POST', '/m/device-pairing/mint', {}, owner); return (await req(port, 'POST', '/m/device-pairing/redeem', { code: m.json.code, label })).json; };
    const hp = await pairNew('Parent Device');
    const hAnon = await req(port, 'POST', hUrl, {}), hBad = await req(port, 'POST', hUrl, {}, 'dvt_00000000.' + 'x'.repeat(43)), hOldDev = await req(port, 'POST', hUrl, {}, dev);
    check('handoff: anonymous, an unknown device token and a revoked device token are all 401 and mint nothing', hAnon.status === 401 && hBad.status === 401 && hOldDev.status === 401 && !journal2().some(r => r.type === 'device_handoff_minted'), [hAnon.status, hBad.status, hOldDev.status].join());
    const h1 = await req(port, 'POST', hUrl, {}, hp.token);
    check('handoff: a paired device gets { code, expiresAt } (a long pc_ code, six digits, about 10 minutes)', h1.status === 200 && /^pc_/.test(h1.json.code) && Object.keys(h1.json).sort().join() === 'code,expiresAt,short' && /^[0-9]{6}$/.test(h1.json.short) && Math.abs(Date.parse(h1.json.expiresAt) - Date.now() - 600000) < 30000, h1.raw);
    check('handoff: the six digits are not in the journal', !JSON.stringify(journal2()).includes(h1.json.short));
    check('handoff: the owner can mint one too', (await req(port, 'POST', hUrl, {}, owner)).status === 200);
    const hShort = await req(port, 'POST', hUrl, {}, owner), hsr = await req(port, 'POST', '/m/device-pairing/redeem', { code: hShort.json.short, label: 'typed' });
    check('handoff: the six digits redeem over HTTP like the long code, and only once', hsr.status === 200 && /^dvt_/.test(hsr.json.token) && (await req(port, 'POST', '/m/device-pairing/redeem', { code: hShort.json.short })).status === 401);
    const hr = await req(port, 'POST', '/m/device-pairing/redeem', { code: h1.json.code, label: 'phone app' });
    check('handoff: the code redeems to a normal device token, once only', hr.status === 200 && /^dvt_/.test(hr.json.token) && (await req(port, 'POST', '/m/device-pairing/redeem', { code: h1.json.code })).status === 401);
    const hl = (await req(port, 'GET', '/m/device-pairing/devices', undefined, owner)).json;
    check('handoff: the redeemed device records its parent, and list shows it (the parent has none)', hl.find(d => d.id === hr.json.id).parent === hp.id && !('parent' in hl.find(d => d.id === hp.id)));
    check('handoff: the child works like any device (GET /api/bots 200)', (await req(port, 'GET', '/api/bots', undefined, hr.json.token)).status === 200);
    const hc = await req(port, 'POST', hUrl, {}, hr.json.token);
    check('handoff: a child device cannot mint a handoff (403, depth 1)', hc.status === 403, hc.status + ' ' + hc.raw);
    let h429 = null, hOk = 1; for (let i = 0; i < 6 && !h429; i++) { const r = await req(port, 'POST', hUrl, {}, hp.token); if (r.status === 200) hOk++; else h429 = r; }
    check('handoff: 5 mints an hour per device, the 6th is 429 with a journal line, and the refusal makes no code', hOk === 5 && h429 && h429.status === 429 && !h429.json.code && journal2().filter(r => r.type === 'device_handoff_limited' && r.device_id === hp.id).length === 1, hOk + ' ' + (h429 && h429.raw));
    const hp2 = await pairNew('Other Device');
    check('handoff: the limit is per device (another device can still mint)', (await req(port, 'POST', hUrl, {}, hp2.token)).status === 200);
    check('handoff: the journal names the device and never holds a code or token', journal2().filter(r => r.type === 'device_handoff_minted' && r.device_id === hp.id).length === 5 && !JSON.stringify(journal2()).includes(h1.json.code) && !JSON.stringify(journal2()).includes(hr.json.token));
    // a handoff device has the same scope as any device: only the allow-list, never owner routes (whoever minted the code)
    const oh = await req(port, 'POST', hUrl, {}, owner), ohr = await req(port, 'POST', '/m/device-pairing/redeem', { code: oh.json.code, label: 'phone app' });
    const noRoutes = [['GET', '/m/device-pairing/devices'], ['POST', '/m/device-pairing/mint'], ['POST', `/m/device-pairing/devices/${hp.id}/revoke`]];
    const scope = async tok => { const out = []; for (const [m, p] of noRoutes) out.push((await req(port, m, p, m === 'POST' ? {} : undefined, tok)).status); return out; };
    check('handoff: a child (made by a device) reaches no owner route (403 on list, mint, revoke)', (await scope(hr.json.token)).every(x => x === 403), (await scope(hr.json.token)).join());
    check('handoff: a device made from an owner handoff is a normal limited device, not an owner (403, and it records no parent)', ohr.status === 200 && (await scope(ohr.json.token)).every(x => x === 403) && !('parent' in (await req(port, 'GET', '/m/device-pairing/devices', undefined, owner)).json.find(d => d.id === ohr.json.id)), (await scope(ohr.json.token)).join());
    const gWrong = await req(port, 'POST', '/m/device-pairing/redeem', { code: 'pc_' + 'z'.repeat(32) }), gUsed = await req(port, 'POST', '/m/device-pairing/redeem', { code: h1.json.code });
    check('handoff over HTTP: a device made from an owner handoff cannot POST /handoff (403)', (await req(port, 'POST', hUrl, {}, ohr.json.token)).status === 403);
    check('handoff: a wrong code and a used handoff code get the same status and the same body', gWrong.status === 401 && gUsed.status === gWrong.status && gUsed.raw === gWrong.raw, gWrong.raw + ' | ' + gUsed.raw);
    const hRv = await req(port, 'POST', `/m/device-pairing/devices/${hp.id}/revoke`, {}, owner);
    check('handoff: revoking the parent revokes the child and the child token stops authenticating', hRv.status === 200 && (await req(port, 'POST', '/api/chat', { bots: 'all', text: 'x' }, hr.json.token)).status === 401 && (await req(port, 'POST', '/api/chat', { bots: 'all', text: 'x' }, hp.token)).status === 401, hRv.status);
    check('handoff: each revoked device has its own device_revoked journal line (the child names its parent)', journal2().filter(r => r.type === 'device_revoked' && r.device_id === hp.id).length === 1 && journal2().filter(r => r.type === 'device_revoked' && r.device_id === hr.json.id && r.parent === hp.id).length === 1);
    // timing and the store rules, on a fake clock (the in-process store)
    {
      const T0 = Date.UTC(2030, 0, 1), MIN = 60000;
      const par = S.redeem(S.mintCode(T0).code, 'p', T0);
      const m1 = S.mintHandoff(par.id, T0), m2 = S.mintHandoff(par.id, T0);
      check('handoff store: a code works at 9m59s', S.redeem(m1.code, 'phone app', T0 + 10 * MIN - 1000).ok === true);
      check('handoff store: a code is dead after 10 minutes', S.redeem(m2.code, 'phone app', T0 + 10 * MIN + 1000).status === 401);
      const lim = []; for (let i = 1; i < 4; i++) lim.push(S.mintHandoff(par.id, T0 + i * MIN).ok);
      check('handoff store: 5 in an hour, the 6th refused (429), and allowed again an hour after the first', lim.every(x => x) && S.mintHandoff(par.id, T0 + 5 * MIN).status === 429 && S.mintHandoff(par.id, T0 + 61 * MIN).ok === true);
      const gen = S.redeem('pc_' + 'z'.repeat(32), 'x', T0 + 10 * MIN + 2000), exp = S.redeem(m2.code, 'x', T0 + 10 * MIN + 3000);
      check('handoff store: an expired handoff code and a wrong code give the same status and text', gen.status === 401 && exp.status === gen.status && exp.error === gen.error && !('token' in exp), JSON.stringify([gen, exp]));
      const m3 = S.mintHandoff(par.id, T0 + 70 * MIN);
      S.revoke(par.id);
      check('handoff store: a code whose parent was revoked does not redeem, and a revoked device cannot mint', S.redeem(m3.code, 'x', T0 + 71 * MIN).status === 401 && S.mintHandoff(par.id, T0 + 72 * MIN).status === 403 && S.mintHandoff('ffffffff', T0).status === 403);
      const ow = S.mintHandoff(null, T0 + 80 * MIN), owc = S.redeem(ow.code, 'phone app', T0 + 81 * MIN);
      check('handoff store: an owner handoff makes a normal device with no parent', ow.ok && owc.ok && !('parent' in S.list().find(d => d.id === owc.id)));
      const T1 = T0 + 200 * MIN; // past the 30 s lockout the failed redeems above may have set
      const plain = S.mintCode(T1), pr = JSON.parse(fs.readFileSync(path.join(S.dir(), 'pending.json'), 'utf8')).codes.find(c => c.exp === T1 + 2 * MIN);
      check('handoff store: ordinary owner codes are unchanged (2 minutes, six digits, no parent)', Date.parse(plain.expiresAt) === T1 + 2 * MIN && /^[0-9]{6}$/.test(plain.short) && !!pr && !('parent' in pr) && S.redeem(plain.short, 'plain', T1 + MIN).ok === true, plain.short);
    }
    // the six digits of a handoff: the typed way for a phone, same path and same rules as the long code
    {
      const T2 = Date.UTC(2029, 0, 1), MIN = 60000;
      const par = S.redeem(S.mintCode(T2).code, 'p', T2);
      const a = S.mintHandoff(par.id, T2 + MIN), b = S.mintHandoff(par.id, T2 + 2 * MIN);
      const ra = S.redeem(' ' + a.short.slice(0, 3) + ' ' + a.short.slice(3) + ' ', 'phone', T2 + 3 * MIN);
      check('handoff short: six digits (typed with spaces) redeem a handoff to a device that records its parent', /^[0-9]{6}$/.test(a.short) && a.short !== b.short && ra.ok === true && S.list().find(d => d.id === ra.id).parent === par.id);
      check('handoff short: single use, and the long code of the same record is spent with it', S.redeem(a.short, 'again', T2 + 4 * MIN).status === 401 && S.redeem(a.code, 'again', T2 + 4 * MIN).status === 401);
      check('handoff short: alive at 9m59s, dead after 10 minutes', S.redeem(b.short, 'late', T2 + 2 * MIN + 10 * MIN + 1000).status === 401 && S.mintHandoff(par.id, T2 + 20 * MIN).ok === true);
      const c = S.mintHandoff(par.id, T2 + 30 * MIN), rc = S.redeem(c.short, 'c', T2 + 30 * MIN + 9 * MIN + 59000);
      check('handoff short: a code at 9 minutes still redeems', rc.ok === true);
      check('handoff short: a child made from the six digits cannot mint (403)', S.mintHandoff(rc.id, T2 + 45 * MIN).status === 403);
      S.mintCode(T2 + 57 * MIN); // an ordinary mint starts the guess counter over, so the 3 wrong redeems above do not count
      const c2 = S.mintHandoff(par.id, T2 + 58 * MIN);
      const w = []; for (let i = 0; i < 5; i++) w.push(S.redeem(String(100000 + i), 'x', T2 + 60 * MIN + i).status);
      check('handoff short: 5 wrong numbers lock for 30 s (429), the pending handoff is wiped, then the number is dead', w.join() === '401,401,401,401,401' && S.redeem(c2.short, 'x', T2 + 60 * MIN + 10).status === 429 && S.redeem(c2.short, 'x', T2 + 61 * MIN).status === 401);
      const d = S.mintHandoff(par.id, T2 + 70 * MIN); S.revoke(par.id);
      check('handoff short: revoking the parent kills its children and the unredeemed number', S.redeem(d.short, 'x', T2 + 71 * MIN).status === 401 && S.authenticate(rc.token, T2 + 72 * MIN) === null);
      const lim = []; const par2 = S.redeem(S.mintCode(T2 + 100 * MIN).code, 'p2', T2 + 100 * MIN);
      for (let i = 0; i < 5; i++) lim.push(S.mintHandoff(par2.id, T2 + 101 * MIN + i).ok);
      const six = S.mintHandoff(par2.id, T2 + 110 * MIN);
      check('handoff short: the 5 an hour limit is the same, and a refused mint gives no number', lim.every(x => x) && six.status === 429 && !('short' in six) && !('code' in six));
      // the guess tally lives on the code: 10 wrong tries in total burn it, and neither an ordinary mint nor a new caller starts it over
      const T3 = Date.UTC(2029, 6, 1), wrong = (n, at) => { const o = []; for (let i = 0; i < n; i++) o.push(S.redeem('000000', 'g' + i, at + i).status); return o; };
      const par3 = S.redeem(S.mintCode(T3).code, 'p3', T3);
      const live = S.mintHandoff(par3.id, T3 + MIN), dead = S.mintHandoff(par3.id, T3 + MIN + 1);
      wrong(4, T3 + 2 * MIN); S.mintCode(T3 + 3 * MIN); // an ordinary mint resets the lock counter, not the tally on the code
      wrong(4, T3 + 4 * MIN); S.mintCode(T3 + 5 * MIN);
      const w9 = wrong(1, T3 + 6 * MIN);
      const okAt9 = S.redeem(live.short, 'nine', T3 + 7 * MIN);
      check('handoff burn: 9 wrong tries in total leave the code alive and it redeems', w9[0] === 401 && okAt9.ok === true);
      const w10 = wrong(1, T3 + 8 * MIN);
      check('handoff burn: the 10th wrong try burns the other code for good, even with time left and a correct number', w10[0] === 401 && S.redeem(dead.short, 'late', T3 + 9 * MIN).status === 401 && S.redeem(dead.code, 'late', T3 + 9 * MIN).status === 401);
      const pend = files();
      check('handoff burn: the store keeps only hashes of the number and the long code, and the journal has neither', !pend.includes(live.short) && !pend.includes(dead.short) && !pend.includes(dead.code) && !JSON.stringify(journal2()).includes(dead.short) && !JSON.stringify(journal2()).includes(dead.code));
    }
    // review round: revoke is one write and repairs itself; a child needs a live parent; a device made from a handoff cannot mint;
    // a handoff redeem leaves the wrong-guess counter alone; the child keeps its own sliding expiry
    {
      const T0 = Date.UTC(2031, 0, 1), MIN = 60000, DAY = 24 * 60 * MIN;
      const devFile = path.join(S.dir(), 'devices.json'), pendFile = path.join(S.dir(), 'pending.json');
      const rd = () => JSON.parse(fs.readFileSync(devFile, 'utf8'));
      const rec = id => rd().find(d => d.id === id);
      const parentAt = t => S.redeem(S.mintCode(t).code, 'p', t);
      const childOf = (pid, t) => S.redeem(S.mintHandoff(pid, t).code, 'phone app', t + 1000);
      const unlock = () => { const j = JSON.parse(fs.readFileSync(pendFile, 'utf8')); j.lockedUntil = 0; j.fails = 0; fs.writeFileSync(pendFile, JSON.stringify(j)); };
      // 1. revoke: one write, idempotent, repairs a half-done revoke, and authenticate checks the parent
      const par = parentAt(T0), k1 = childOf(par.id, T0 + MIN), k2 = childOf(par.id, T0 + 2 * MIN);
      let writes = 0; const rn = fs.renameSync;
      fs.renameSync = (a, b) => { if (path.basename(String(b)) === 'devices.json') writes++; return rn(a, b); };
      try { S.revoke(par.id); } finally { fs.renameSync = rn; }
      check('revoke: the parent and all its children are written in one devices.json write', writes === 1 && [par.id, k1.id, k2.id].every(id => rec(id).revoked), writes);
      check('revoke twice: the second call still answers true and the children stay revoked', S.revoke(par.id) === true && rec(k1.id).revoked && rec(k2.id).revoked && S.authenticate(k1.token, T0 + 3 * MIN) === null && S.authenticate(k2.token, T0 + 3 * MIN) === null);
      const par2 = parentAt(T0 + 5 * MIN), k3 = childOf(par2.id, T0 + 6 * MIN);
      { const all = rd(); all.find(d => d.id === par2.id).revoked = true; all.find(d => d.id === k3.id).revoked = false; fs.writeFileSync(devFile, JSON.stringify(all)); } // a revoke that died between the writes
      check('revoke: with the parent revoked and the child not, the child token does not authenticate', S.authenticate(k3.token, T0 + 7 * MIN) === null && rec(k3.id).revoked === false);
      check('revoke: a second revoke of the parent marks the leftover child', S.revoke(par2.id) === true && rec(k3.id).revoked === true);
      const par3 = parentAt(T0 + 8 * MIN), k4 = childOf(par3.id, T0 + 9 * MIN);
      check('authenticate: a child with a live parent works', S.authenticate(k4.token, T0 + 10 * MIN) !== null);
      fs.writeFileSync(devFile, JSON.stringify(rd().filter(d => d.id !== par3.id)));
      check('authenticate: a child whose parent record is missing does not authenticate', S.authenticate(k4.token, T0 + 11 * MIN) === null);
      // the code of a revoked parent
      const par4 = parentAt(T0 + 12 * MIN), mr = S.mintHandoff(par4.id, T0 + 13 * MIN);
      S.revoke(par4.id);
      const gRev = S.redeem(mr.code, 'x', T0 + 14 * MIN), gWr = S.redeem('pc_' + 'y'.repeat(32), 'x', T0 + 14 * MIN);
      check('handoff: the code of a revoked parent is a generic 401 (same text as a wrong code) and makes no device', gRev.status === 401 && gRev.error === gWr.error && !('token' in gRev));
      // 2. a device made from an owner handoff cannot mint
      const ow = S.mintHandoff(null, T0 + 20 * MIN), od = S.redeem(ow.code, 'phone app', T0 + 21 * MIN);
      const odm = S.mintHandoff(od.id, T0 + 22 * MIN);
      check('handoff: a device made from an owner handoff cannot make a handoff (403, same message as a child)', od.ok && rec(od.id).handoff === true && odm.status === 403 && odm.error === 'a device made from a handoff cannot make another', JSON.stringify(odm));
      const plainDev = parentAt(T0 + 23 * MIN);
      check('handoff: an ordinary paired device has no handoff mark and can still mint', !('handoff' in rec(plainDev.id)) && S.mintHandoff(plainDev.id, T0 + 24 * MIN).ok === true);
      // 3. a handoff redeem never resets the wrong-guess counter
      unlock();
      const par5 = parentAt(T0 + 30 * MIN), mh = S.mintHandoff(par5.id, T0 + 31 * MIN); // the ordinary mint above reset the counter
      const tg = T0 + 32 * MIN, wrong = i => S.redeem(String(200000 + i), 'x', tg).status;
      const w4 = [0, 1, 2, 3].map(wrong), hr = S.redeem(mh.code, 'phone app', tg), w5 = wrong(4), after = S.redeem(String(300000), 'x', tg + 1000);
      check('handoff: 4 wrong guesses, a good handoff redeem, 1 more wrong guess -> lockout', w4.every(s => s === 401) && hr.ok === true && w5 === 401 && after.status === 429, [w4, hr.ok, w5, after.status].join());
      unlock();
      const c6 = S.mintCode(T0 + 40 * MIN); [0, 1, 2, 3].forEach(i => S.redeem(String(400000 + i), 'x', T0 + 41 * MIN));
      const ord = S.redeem(c6.short, 'x', T0 + 41 * MIN), o1 = S.redeem('500000', 'x', T0 + 41 * MIN), o2 = S.redeem('500001', 'x', T0 + 41 * MIN);
      check('pairing: an ordinary pairing redeem still resets the counter (one wrong guess after it is just 401)', ord.ok === true && o1.status === 401 && o2.status === 401, [ord.ok, o1.status, o2.status].join());
      unlock();
      // 4. the child keeps its own sliding expiry: an expired (not revoked) parent does not end it
      const ep = parentAt(T0 + 50 * MIN), ec = childOf(ep.id, T0 + 51 * MIN);
      check('expiry: the child used within 30 days of its own last use authenticates', S.authenticate(ec.token, T0 + 20 * DAY) !== null);
      check('expiry: the parent unused for 40 days is expired but not revoked, and the child still authenticates', S.authenticate(ep.token, T0 + 40 * DAY) === null && rec(ep.id).revoked === false && S.list(T0 + 40 * DAY).find(d => d.id === ep.id).expired === true && S.authenticate(ec.token, T0 + 40 * DAY) !== null);
    }
    // review round 2: the store lock is owned (pid + nonce); a lost lock makes the late write throw; only a dead or very old holder is reclaimed
    {
      const lockFile = path.join(S.dir(), 'store.lock'), devFile = path.join(S.dir(), 'devices.json');
      const rd = () => JSON.parse(fs.readFileSync(devFile, 'utf8'));
      const T = Date.UTC(2032, 0, 1), MIN = 60000;
      const clean = () => { for (const f of fs.readdirSync(S.dir())) if (f === 'store.lock' || f.startsWith('store.lock.')) try { fs.unlinkSync(path.join(S.dir(), f)); } catch { /* ignore */ } };
      const putLock = (o, ageMs) => { fs.writeFileSync(lockFile, JSON.stringify(o)); const t = (Date.now() - ageMs) / 1000; fs.utimesSync(lockFile, t, t); };
      clean();
      let held = null; S.withLock(() => { held = JSON.parse(fs.readFileSync(lockFile, 'utf8')); });
      check('lock: while held the lock file names this pid and a random nonce, and it is gone after release', held && held.pid === process.pid && /^[0-9a-f]{16,}$/.test(held.nonce) && !fs.existsSync(lockFile), JSON.stringify(held));
      // the interleaving: a redeem has read devices.json, then loses the lock; another process revokes the parent and releases; the late write must not land
      const par = S.redeem(S.mintCode(T).code, 'p', T);
      let late = null;
      try {
        S.withLock(() => {
          const stale = rd();                                  // what the paused redeem read (parent not revoked)
          fs.unlinkSync(lockFile);                             // the lock is taken from under it
          const other = rd(); other.find(d => d.id === par.id).revoked = true; fs.writeFileSync(devFile, JSON.stringify(other)); // the other process revokes, then releases
          S._write('devices.json', stale);                     // the late write-back
        });
      } catch (e) { late = e; }
      check('lock: a write after the lock was lost throws and the other holder\'s revoke stays', !!late && rd().find(d => d.id === par.id).revoked === true && !fs.readdirSync(S.dir()).some(f => f.endsWith('.tmp')), late && late.message);
      clean();
      S.withLock(() => { fs.unlinkSync(lockFile); fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, nonce: 'other-holder' })); });
      check('lock: release does not remove a lock another holder now owns', fs.existsSync(lockFile) && JSON.parse(fs.readFileSync(lockFile, 'utf8')).nonce === 'other-holder');
      clean();
      const dead = spawnSync(process.execPath, ['-e', '0'], { windowsHide: true }).pid;
      putLock({ pid: dead, nonce: 'gone' }, 1000);
      const t0 = Date.now(), mc = S.mintCode(T + 5 * MIN);
      check('lock: a lock whose holder pid is dead is reclaimed at once', !!mc.code && Date.now() - t0 < 2000 && !fs.existsSync(lockFile) && !fs.readdirSync(S.dir()).some(f => f.startsWith('store.lock.')), Date.now() - t0);
      putLock({ pid: process.pid, nonce: 'very-old' }, 3600 * 1000);
      const tOld = Date.now(); let oldMsg = ''; try { S.mintCode(T + 6 * MIN); } catch (e) { oldMsg = e.message; }
      check('lock: a live holder\'s lock is not reclaimed at any age (an hour old: the caller waits, then fails closed with busy)', /busy/.test(oldMsg) && Date.now() - tOld >= 2500 && JSON.parse(fs.readFileSync(lockFile, 'utf8')).nonce === 'very-old', oldMsg);
      putLock({ pid: process.pid, nonce: 'live-holder' }, 11 * 1000);
      const busy = S.redeem('123456', 'x', T + 7 * MIN);
      check('lock: a live holder\'s 11 s old lock is not stolen (the caller gets busy, 503)', busy.status === 503 && fs.existsSync(lockFile) && JSON.parse(fs.readFileSync(lockFile, 'utf8')).nonce === 'live-holder', JSON.stringify(busy));
      // the busy text names the way out in plain words, without any path; the HTTP-facing reply stays generic
      putLock({ pid: process.pid, nonce: 'live-holder' }, 1000);
      let bmsg = ''; const errWrite = process.stderr.write.bind(process.stderr); let logged = ''; process.stderr.write = c => { logged += c; return true; };
      try { S.withLock(() => 0); } catch (e) { bmsg = e.message; }
      const h503 = S.redeem('123456', 'x', T + 7 * MIN);
      process.stderr.write = errWrite;
      check('lock: the busy error says: stop the server, remove store.lock and any leftover store.lock.reclaim in the state dir', bmsg === 'device-pairing store is busy: stop the server, then remove store.lock and any leftover store.lock.reclaim in the state dir', bmsg);
      check('lock: the busy error carries no state path', !bmsg.includes(S.dir()) && !/[\/]/.test(bmsg), bmsg);
      check('lock: the HTTP-facing reply stays generic (no way-out text, no path), the server log gets the full line with the state dir', h503.status === 503 && h503.error === 'pairing is busy; try again' && logged.includes(bmsg) && logged.includes(S.dir()), JSON.stringify(h503) + logged);
      clean();
      fs.writeFileSync(lockFile, '');
      let umsg = ''; try { S.withLock(() => 0); } catch (e) { umsg = e.message; }
      check('lock: an unreadable lock error also names the way out and no path', /stop the server, then remove store.lock and any leftover store.lock.reclaim/.test(umsg) && !umsg.includes(S.dir()), umsg);
      clean();
      clean();
      // a pid that exists but cannot be signalled (EPERM) is a live holder: never stolen from
      const realKill = process.kill;
      process.kill = (p, sig) => { if (p === 424242) { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; } return realKill.call(process, p, sig); };
      let eperm; try { putLock({ pid: 424242, nonce: 'eperm-holder' }, 3600 * 1000); eperm = S.redeem('123456', 'x', T + 8 * MIN); } finally { process.kill = realKill; }
      check('lock: a holder pid that answers EPERM counts as live (busy, lock kept)', eperm.status === 503 && JSON.parse(fs.readFileSync(lockFile, 'utf8')).nonce === 'eperm-holder', JSON.stringify(eperm));
      clean();
      // two waiters both saw dead holder D; the first reclaims and a live holder L takes the lock; the second's stale verdict must not touch L
      let stale = null, stillOwned = false;
      S.withLock(() => { S._reclaim(lockFile, { pid: dead, nonce: 'D' }); stale = JSON.parse(fs.readFileSync(lockFile, 'utf8')); stillOwned = true; });
      check('lock: a waiter holding a stale dead-holder verdict leaves a live holder lock alone (the lock is still ours, no reclaim file left)', stillOwned && stale && stale.pid === process.pid && !fs.readdirSync(S.dir()).some(f => f.endsWith('.reclaim')), JSON.stringify(stale));
      putLock({ pid: dead, nonce: 'D' }, 1000);
      S._reclaim(lockFile, { pid: dead, nonce: 'D' });
      check('lock: the same reclaim removes the lock when it is still the dead holder', !fs.existsSync(lockFile) && !fs.readdirSync(S.dir()).some(f => f.endsWith('.reclaim')));
      // a reclaim file left by a crashed process is never auto-reclaimed: the caller fails closed
      putLock({ pid: dead, nonce: 'D2' }, 1000); fs.writeFileSync(lockFile + '.reclaim', '');
      let rmsg = ''; try { S.mintCode(T + 9 * MIN); } catch (e) { rmsg = e.message; }
      check('lock: a leftover store.lock.reclaim file is not taken over (busy, both files kept)', /busy/.test(rmsg) && fs.existsSync(lockFile) && fs.existsSync(lockFile + '.reclaim'), rmsg);
      clean();
      // acquiring after the wait limit has already passed: release and throw busy, no write
      const realNow = Date.now; let calls = 0, ran = false, dmsg = '';
      const pendBefore = fs.existsSync(path.join(S.dir(), 'pending.json')) ? fs.readFileSync(path.join(S.dir(), 'pending.json'), 'utf8') : null;
      Date.now = () => realNow() + (calls++ ? 5000 : 0);
      try { S.withLock(() => { ran = true; }); } catch (e) { dmsg = e.message; } finally { Date.now = realNow; }
      const pendAfter = fs.existsSync(path.join(S.dir(), 'pending.json')) ? fs.readFileSync(path.join(S.dir(), 'pending.json'), 'utf8') : null;
      check('lock: a lock acquired after the wait limit is released and the caller gets busy, nothing runs or is written', /busy/.test(dmsg) && !ran && !fs.existsSync(lockFile) && pendBefore === pendAfter, dmsg);
      // devices.json and pending.json cannot be written without holding the lock; seen.json can
      const devBefore = fs.readFileSync(devFile, 'utf8'); let wmsg = '';
      try { S._write('devices.json', []); } catch (e) { wmsg = e.message; }
      let pmsg = ''; try { S._write('pending.json', { codes: [] }); } catch (e) { pmsg = e.message; }
      let seenOk = true; try { S._write('seen.json', {}); } catch { seenOk = false; }
      check('lock: devices.json and pending.json writes throw without the lock (seen.json is exempt)', /lock/.test(wmsg) && /lock/.test(pmsg) && fs.readFileSync(devFile, 'utf8') === devBefore && seenOk, wmsg + ' | ' + pmsg);
    }
    // taskmote device list: a home-screen app is shown right after its parent
    {
      const cmd = require('../index').commands, TT = Date.UTC(2033, 0, 1);
      const par = S.redeem(S.mintCode(TT).code, 'parent phone', TT);
      const other = S.redeem(S.mintCode(TT).code, 'other phone', TT);
      const h = S.mintHandoff(par.id, TT), kid = S.redeem(h.code, 'home-screen', TT);
      const lines = []; const log = console.log; console.log = s => lines.push(String(s));
      try { await cmd.device(['list']); } finally { console.log = log; }
      const at = id => lines.findIndex(l => l.startsWith(id));
      check('cli: device list shows a home-screen app right after its parent, marked with the parent id', h.ok && kid.ok && at(kid.id) === at(par.id) + 1 && lines[at(kid.id)].includes('home-screen app of ' + par.id) && !lines[at(par.id)].includes('home-screen app of') && at(other.id) >= 0, lines.join(' | '));
    }
    // lockout over HTTP
    await req(port, 'POST', '/m/device-pairing/mint', {}, owner);
    let st = 0; for (let i = 0; i < 6; i++) st = (await req(port, 'POST', '/m/device-pairing/redeem', { code: String(100000 + i) })).status;
    check('lockout over HTTP: repeated wrong codes end in 429', st === 429);
    // the CLI: taskmote device pair | list | revoke <id>, and the old spellings
    const tm = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'taskmote.js'), ...args], { env, cwd: base, encoding: 'utf8', timeout: 30000, windowsHide: true });
    let p = tm('device', 'list');
    check('cli: taskmote device list shows the revoked device, no token', p.status === 0 && p.stdout.includes(redeem.json.id) && /revoked/.test(p.stdout) && !p.stdout.includes(dev) && !/note:/.test(p.stderr), p.stdout + p.stderr);
    // a stuck lock: the CLI prints the way out and the state dir, exit 1
    { const st3 = path.join(base, 'st-busy'), dd = path.join(st3, 'm', 'device-pairing'); fs.mkdirSync(dd, { recursive: true });
      fs.writeFileSync(path.join(dd, 'store.lock'), JSON.stringify({ pid: process.pid, nonce: 'cli-live' }));
      const q = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'taskmote.js'), 'device', 'pair'], { env: { ...env, HARNESS_STATE_DIR: st3 }, cwd: base, encoding: 'utf8', timeout: 30000, windowsHide: true });
      check('cli: a stuck store lock prints the way out and the state dir, exit 1', q.status === 1 && /stop the server, then remove store.lock and any leftover store.lock.reclaim in the state dir/.test(q.stderr) && q.stderr.includes(dd), q.stdout + q.stderr); }
    p = tm('device', 'pair');
    check('cli: taskmote device pair prints a six-digit code', p.status === 0 && /single use\): \d{6}/.test(p.stdout));
    p = tm('device', 'revoke', 'ffffffff');
    check('cli: taskmote device revoke <unknown id> fails (exit 1)', p.status === 1 && /no such device/.test(p.stdout));
    p = tm('device');
    check('cli: taskmote device with nothing: usage, exit 2', p.status === 2 && /usage: taskmote device/.test(p.stderr));
    p = tm('device', 'revoke');
    check('cli: taskmote device revoke without an id: usage, exit 2', p.status === 2 && /usage: taskmote device/.test(p.stderr));
    p = tm('devices');
    check('cli: old "taskmote devices" still runs and names "taskmote device list"', p.status === 0 && p.stdout.includes(redeem.json.id) && /note: "taskmote devices" is now "taskmote device list"/.test(p.stderr), p.stderr);
    p = tm('pair');
    check('cli: old "taskmote pair" still runs and names "taskmote device pair"', p.status === 0 && /\d{6}/.test(p.stdout) && /note: "taskmote pair" is now "taskmote device pair"/.test(p.stderr), p.stderr);
    p = tm('revoke', 'ffffffff');
    check('cli: old "taskmote revoke" still runs and names "taskmote device revoke <id>"', p.status === 1 && /note: "taskmote revoke" is now "taskmote device revoke <id>"/.test(p.stderr), p.stderr);
  } finally {
    if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(srv.pid)], { stdio: 'ignore' }); else srv.kill('SIGKILL');
  }
  const bad = results.filter(x => !x).length;
  console.log(`result: ${results.length - bad}/${results.length} passed`);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(bad ? 1 : 0);

  function journal2() { try { return fs.readFileSync(path.join(state2, 'journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } }
})();
