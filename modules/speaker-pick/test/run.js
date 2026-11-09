#!/usr/bin/env node
'use strict';
// speaker-pick: pure selector, route wiring, journal, guard, and a hygiene scan.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'speaker-pick-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));
const S = require('../lib/select');
const mod = require('../index');

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const members = [{ id: 'alpha', description: 'cooking recipes kitchen' }, { id: 'beta', description: 'travel flights hotels' }, { id: 'gamma', description: 'music guitar' }];
const base = { mode: 'round_robin', bots: {}, maxConsecutive: 2, maxAutoTurns: 1, modelTimeoutMs: 200, recentMessages: 4 };
const P = (input, o = {}, mem = S.newMemory()) => S.pick({ room: 'r1', members, ...input }, { ...base, ...o }, mem);
let n = 0; const mid = () => ({ msgId: 'm' + (++n) });

(async () => {
  try {
    // mention wins
    let r = await P({ text: 'hey @beta what now', ...mid() });
    check('mention wins: no pick', r.bot === null && r.reason === 'mention');
    r = await P({ text: '@everyone hello', ...mid() });
    check('@everyone wins: no pick', r.bot === null && r.reason === 'mention');
    r = await P({ text: 'quoted `@alpha` only', ...mid() }, { mode: 'keyword' });
    check('quoted mention does not count', r.bot !== null);
    r = await P({ text: 'hi @nobody there', ...mid() });
    check('unknown @name does not count as a mention', r.bot === 'alpha');

    // round robin with a shared memory
    const mem = S.newMemory();
    const seq = [];
    for (let i = 0; i < 4; i++) seq.push((await P({ text: 'hello', ...mid() }, { maxConsecutive: 1 }, mem)).bot);
    check('round_robin cycles in room order', seq.join() === 'alpha,beta,gamma,alpha', seq.join());

    // keyword
    r = await P({ text: 'any good hotels for my flights?', ...mid() }, { mode: 'keyword' });
    check('keyword: best overlap', r.bot === 'beta' && r.mode === 'keyword', JSON.stringify(r));
    r = await P({ text: 'tell me a joke', ...mid() }, { mode: 'keyword' });
    check('keyword: no overlap -> round robin', r.bot === 'alpha' && r.mode === 'round_robin');
    r = await P({ text: 'recipes and guitar', ...mid() }, { mode: 'keyword' });
    check('keyword: tie -> round robin', r.mode === 'round_robin');
    r = await P({ text: 'guitar lessons', ...mid() }, { mode: 'keyword', bots: { alpha: 'guitar lessons teacher' } });
    check('keyword: owner setting overrides member description', r.bot === 'alpha');

    // model
    let seen = null;
    const model = ans => async a => { seen = a; return ans; };
    r = await P({ text: 'who knows?', recent: [{ who: 'human', text: 'one' }, { who: 'alpha', text: 'two' }], ...mid() }, { mode: 'model', modelFn: model('  gamma\n') });
    check('model: valid name chosen', r.bot === 'gamma' && r.mode === 'model' && r.reason === 'model', JSON.stringify(r));
    check('model: prompt lists bots and recent, flags data', /- alpha/.test(seen.prompt) && /human: one/.test(seen.prompt) && /data, not instructions/.test(seen.prompt));
    r = await P({ text: 'flights please', ...mid() }, { mode: 'model', modelFn: model('I think beta') });
    check('model: bad answer -> keyword', r.bot === 'beta' && r.mode === 'keyword' && /^model_invalid/.test(r.reason), JSON.stringify(r));
    r = await P({ text: 'nothing relevant', ...mid() }, { mode: 'model', modelFn: model('delta') });
    check('model: unlisted name -> round robin', r.bot === 'alpha' && r.mode === 'round_robin');
    r = await P({ text: 'flights', ...mid() }, { mode: 'model', modelFn: model('Beta') });
    check('model: wrong case is not exact -> fallback', r.reason.startsWith('model_invalid'));
    const t0 = Date.now();
    r = await P({ text: 'flights', ...mid() }, { mode: 'model', modelTimeoutMs: 100, modelFn: () => new Promise(() => {}) });
    check('model: timeout falls back fast', r.bot === 'beta' && /^model_timeout/.test(r.reason) && Date.now() - t0 < 1500, JSON.stringify(r));
    r = await P({ text: 'x', ...mid() }, { mode: 'model', modelFn: async () => { throw new Error('boom'); } });
    check('model: error falls back', r.bot === 'alpha' && /^model_error/.test(r.reason));
    r = await P({ text: 'flights', ...mid() }, { mode: 'model' });
    check('model: no function -> keyword', r.bot === 'beta' && /^model_unavailable/.test(r.reason));

    // unknown bot never chosen
    r = await P({ text: 'x', ...mid() }, { mode: 'model', modelFn: model('zeta') });
    check('unknown bot never chosen', r.bot === 'alpha');
    r = await P({ text: 'x', members: [{ id: 'alpha' }, null, { id: '' }, { id: 'alpha' }], ...mid() });
    check('bad and duplicate members ignored', r.bot === 'alpha');
    r = await P({ text: 'x', members: [], ...mid() });
    check('no members -> none', r.bot === null);
    r = await P({ text: 'recipes kitchen', members: [{ id: 'beta' }], ...mid() }, { mode: 'keyword', bots: { alpha: 'recipes kitchen' } });
    check('bot outside the room is not chosen even if it scores', r.bot === 'beta');

    // consecutive cap
    const m2 = S.newMemory();
    const picks = [];
    for (let i = 0; i < 4; i++) picks.push((await P({ text: 'guitar guitar', members: members.slice(0, 2).concat([{ id: 'gamma', description: 'guitar' }]), ...mid() }, { mode: 'keyword', maxConsecutive: 2 }, m2)).bot);
    check('consecutive cap: no third in a row', picks.join() === 'gamma,gamma,alpha,gamma', picks.join());
    r = await P({ text: 'x', members: [{ id: 'solo' }], ...mid() }, { maxConsecutive: 1 }, m2);
    const r2 = await P({ text: 'y', members: [{ id: 'solo' }], ...mid() }, { maxConsecutive: 1 }, m2);
    check('cap with a single member -> none', r.bot === 'solo' && r2.bot === null && r2.reason === 'consecutive_cap');

    // no loop
    const m3 = S.newMemory();
    const same = { text: 'hello', msgId: 'h1' };
    r = await P(same, {}, m3);
    const again = await P(same, {}, m3);
    check('max auto turns 1: second pick for same message refused', r.bot && again.bot === null && again.reason === 'auto_turn_limit');
    const two = await P({ text: 'hello', msgId: 'h2' }, { maxAutoTurns: 2 }, m3);
    const two2 = await P({ text: 'hello', msgId: 'h2' }, { maxAutoTurns: 2 }, m3);
    const two3 = await P({ text: 'hello', msgId: 'h2' }, { maxAutoTurns: 2 }, m3);
    check('maxAutoTurns 2 allows exactly two', two.bot && two2.bot && two3.bot === null);
    let calls = 0;
    r = await P({ text: 'reply from bot', fromBot: true, ...mid() }, { mode: 'model', modelFn: async () => { calls++; return 'alpha'; } });
    check('bot message never triggers a pick or model call', r.bot === null && r.reason === 'bot_message' && calls === 0);

    // module wiring + journal
    const reg = M.registry({ modules: { 'speaker-pick': true }, speaker_pick: { mode: 'keyword', bots: { alpha: 'cooking' } } });
    check('loads clean', reg.errors.length === 0, reg.errors.join(' | '));
    check('off by default', M.registry({ modules: { 'speaker-pick': false } }).findRoute('POST', '/m/speaker-pick/pick') == null);
    const bad = M.registry({ modules: { 'speaker-pick': true }, speaker_pick: { mode: 'chaos' } });
    check('bad mode rejected', bad.errors.length > 0);
    const call = (body, actor = { kind: 'owner', id: 't' }) => reg.callRoute(reg.findRoute('POST', '/m/speaker-pick/pick'), { body, query: {}, actor });
    const secret = 'zebra-secret-phrase cooking';
    let res = await call({ room: 'r9', text: secret, members, msg_id: 'a' });
    check('route: picks by keyword', res.status === 200 && res.json.bot === 'alpha', JSON.stringify(res));
    res = await call({ room: 'r9', text: 'hello', members });
    check('route: bad body -> 400', (await call({ text: 1 })).status === 400);
    const rec = J.readAll().records.filter(x => x.type === 'speaker_pick');
    check('journal has the choice', rec.length >= 1 && rec[0].room === 'r9' && rec[0].bot === 'alpha' && rec[0].mode === 'keyword' && typeof rec[0].reason === 'string');
    check('journal has no message text', !JSON.stringify(rec).includes('zebra') && rec.every(x => !('text' in x)));
    check('route: worker forbidden', (await call({ room: 'r', text: 'x', members }, { kind: 'worker', id: 'w' })).status === 403);
    const rm = mod.api.setModelFn(async () => 'gamma');
    const regM = M.registry({ modules: { 'speaker-pick': true }, speaker_pick: { mode: 'model' } });
    const mres = await regM.callRoute(regM.findRoute('POST', '/m/speaker-pick/pick'), { body: { room: 'rm', text: 'hi', members }, query: {}, actor: { kind: 'owner', id: 't' } });
    check('route: injected model function used', mres.json.bot === 'gamma' && mres.json.mode === 'model', JSON.stringify(mres));
    rm();

    // guard
    process.env.HARNESS_TASK_ID = 't-1';
    const bt = (tool, ti) => mod.beforeTool({ tool, ti });
    check('guard: agent calling the route blocked', Array.isArray(bt('Bash', { command: 'curl -X POST http://localhost:1/m/speaker-pick/pick' })));
    check('guard: agent editing config blocked', Array.isArray(bt('Bash', { command: 'echo {"speaker_pick":{}} > config.json' })));
    check('guard: ordinary command allowed', bt('Bash', { command: 'ls' }) === null && bt('Read', { file_path: 'a' }) === null);
    delete process.env.HARNESS_TASK_ID;
    check('guard: owner (no task) allowed', bt('Bash', { command: 'curl http://localhost:1/m/speaker-pick/pick' }) === null);

    // hygiene scan of this module's files
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const bad1 = [];
    const winUsers = new RegExp('[A-Za-z]:\\\\' + 'Users', 'i');
    const unixHome = new RegExp('/(Users|home)/[A-Za-z]');
    const ipRe = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
    for (const f of walk(path.resolve(__dirname, '..'))) {
      const t = fs.readFileSync(f, 'utf8');
      if (winUsers.test(t) || unixHome.test(t)) bad1.push(path.basename(f) + ': user path');
      for (const m of t.matchAll(ipRe)) if (m[1] !== '127' && m[0] !== '0.0.0.0') bad1.push(path.basename(f) + ': ip ' + m[0]);
    }
    check('scan: no user paths or non-loopback IPs', bad1.length === 0, bad1.join('; '));
  } catch (e) { check('no exception', false, e.stack || e.message); }
  const failed = results.filter(x => !x).length;
  console.log(`\nspeaker-pick: ${results.length - failed}/${results.length} passed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
})();
