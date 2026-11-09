#!/usr/bin/env node
'use strict';
// tripwires: rule engine, settings validation, the task.end flow in-process (journal record,
// event, status line, retention cap), owner routes. Temp dirs only; fixtures are built at runtime.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tripwires-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));
const { scan, redact } = require('../rules');

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const ids = (t) => t.map(x => x.rule).join(',');

const FAKE_KEY = 'sk-' + 'x'.repeat(40);
const FAKE_GH = 'ghp_' + 'y'.repeat(30);
const FAKE_BEARER = 'Bearer ' + 'z'.repeat(30);
const FAKE_PEM = '-----BEGIN ' + 'RSA PRIVATE KEY' + '-----';
const WIN_HOME = 'C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'someone' + String.fromCharCode(92) + 'proj';
const NIX_HOME = '/' + 'home' + '/someone/proj';
const IP10 = ['10', '1', '2', '3'].join('.');
const IP192 = ['192', '168', '0', '9'].join('.');
const IPPUB = ['8', '8', '8', '8'].join('.');

(async () => {
  try {
    // ---- rules
    check('clean reply: no trip', scan('I updated the parser and ran the tests; 12 passed.').length === 0);
    for (const [name, s] of [['openai-shape key', `key is ${FAKE_KEY} ok`], ['github token', `token ${FAKE_GH}`], ['bearer', `Authorization: ${FAKE_BEARER}`], ['private key header', `${FAKE_PEM}\nabc`]]) {
      const t = scan(s);
      check(`secrets: ${name}`, ids(t) === 'secrets', ids(t));
      check(`secrets: ${name} snippet has no secret`, t[0] && !/xxxx|yyyy|zzzz|PRIVATE KEY/.test(t[0].snippet) && /\[secret\]/.test(t[0].snippet), t[0] && t[0].snippet);
    }
    check('paths: windows home', ids(scan(`saved to ${WIN_HOME}\\out.txt`)) === 'paths');
    check('paths: unix home', ids(scan(`saved to ${NIX_HOME}/out.txt`)) === 'paths');
    check('paths snippet hides the account name', !/someone/.test(scan(`saved to ${NIX_HOME}/out.txt`)[0].snippet));
    check('paths: relative path is fine', scan('see src/home/user.js').length === 0);
    check('private ips: two private ranges', ids(scan(`host ${IP10}`)) === 'private_ips' && ids(scan(`host ${IP192}`)) === 'private_ips');
    check('private ips: public ip is fine, snippet hides ip', scan(`dns ${IPPUB}`).length === 0 && !scan(`host ${IP10} here`)[0].snippet.includes(IP10));
    check('banned phrase, case-insensitive, phrase not stored', (() => { const t = scan('Well, As An AI model I cannot', { bannedPhrases: ['as an ai model'] }); return ids(t) === 'banned' && !/as an ai/i.test(t[0].snippet); })());
    {
      const sec = 'sk-' + 'Qw9zLm3xT7vB2nK8pR4yD6hJ';
      const t1 = scan('a'.repeat(23) + ' ' + FAKE_KEY + ' ' + sec + ' tail');
      const t2 = scan('ctx ' + 'b'.repeat(16) + sec + ' ' + FAKE_KEY);
      const t3 = scan('Done fixed. ' + 'c'.repeat(80) + ' ' + sec + ' all done', { code: 1 });
      const leak = sn => { for (let k = 0; k + 6 <= sec.length; k++) if (sn.includes(sec.slice(k, k + 6))) return true; return false; };
      check('snippet slice edge: no secret fragment', [t1, t2, t3].every(t => t.length && t.every(x => !leak(x.snippet))), JSON.stringify([t1, t2, t3].map(t => t.map(x => x.snippet))));
    }
    check('oversize', ids(scan('a'.repeat(120), { maxChars: 100 })) === 'oversize' && scan('a'.repeat(100), { maxChars: 100 }).length === 0);
    check('success claim with exit 1', ids(scan('All done. Tests pass.', { code: 1 })) === 'success_claim');
    check('success claim ignored with exit 0 or unknown', scan('All done. Tests pass.', { code: 0 }).length === 0 && scan('All done.', {}).length === 0);
    check('honest failure report is not a claim', scan('The build failed and the fix is not done.', { code: 1 }).length === 0);
    check('rule toggle off', scan(`k ${FAKE_KEY}`, { rules: { secrets: false } }).length === 0);
    check('several rules at once', ids(scan(`${FAKE_KEY} at ${IP10}`)) === 'secrets,private_ips');
    check('non-string input never throws', scan(null).length === 0 && scan(undefined).length === 0 && scan({}).length === 0);
    const red = redact(`k ${FAKE_KEY} in ${NIX_HOME}/a at ${IP10}`);
    check('redact masks secret, path and ip', !red.includes(FAKE_KEY) && !red.includes('someone') && !red.includes(IP10) && /\[REDACTED\]/.test(red), red);

    // ---- manifest and settings
    const off = M.registry({ modules: {} });
    check('off by default: nothing registered', off.settingsFor('tripwires') === null);
    const reg = M.registry({ modules: { tripwires: true }, tripwires: { banned_phrases: ['forbidden words'], retention: 3 } });
    check('on: loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    check('contract 2, failMode closed', (() => { const m = reg.modules().find(x => x.name === 'tripwires'); const raw = require('../index'); return m.contract === 2 && raw.failMode === 'closed' && raw.hookTimeoutMs === 1000; })());
    check('bad setting rejected', M.registry({ modules: { tripwires: true }, tripwires: { mode: 'nope' } }).errors.length > 0);

    // ---- task.end flow
    const events = [];
    const rec = M.registry({ modules: { tripwires: true }, tripwires: { banned_phrases: ['forbidden words'], retention: 3 } });
    const origEmit = rec.emit;
    check('beforeReply seam shape: flag keeps, redact redacts', (() => {
      const api = rec.api('tripwires');
      const keep = api.beforeReply({ settings: { mode: 'flag' } }, `x ${FAKE_KEY}`) === `x ${FAKE_KEY}`;
      const cut = !api.beforeReply({ settings: { mode: 'redact', rule_secrets: true } }, `x ${FAKE_KEY}`).includes(FAKE_KEY);
      return keep && cut;
    })());
    {
      const mk = (mode, extra) => M.registry({ modules: { tripwires: true }, tripwires: { mode, ...extra } });
      const hook = async (r, text) => M.beforeReply(r.mods, text, { task_id: 'br1' });
      const flag = await hook(mk('flag'), `x ${FAKE_KEY}`);
      check('beforeReply flag: reply unchanged', !flag.blocked && flag.reply === `x ${FAKE_KEY}`);
      const red = await hook(mk('redact'), `x ${FAKE_KEY} at ${IP10}`);
      check('beforeReply redact: masked', !red.blocked && !red.reply.includes(FAKE_KEY) && !red.reply.includes(IP10), red.reply);
      const blk = await hook(mk('block'), `x ${FAKE_KEY}`);
      check('beforeReply block: blocked, reason has no secret', blk.blocked && blk.code === 'blocked' && /secrets/.test(blk.reason) && !blk.reason.includes('xxxx'), blk.reason);
      const ok = await hook(mk('block'), 'plain reply, nothing to see');
      check('beforeReply block: clean reply passes', !ok.blocked && ok.reply === 'plain reply, nothing to see');
      const bn = await hook(mk('block', { banned_phrases: ['secret sauce'] }), 'the Secret Sauce is here');
      check('beforeReply block: banned phrase, reason hides it', bn.blocked && !/sauce/i.test(bn.reason), bn.reason);
      const rl = await hook(mk('block', { rule_secrets: false }), `x ${FAKE_KEY}`);
      check('beforeReply block: rule toggle honored', !rl.blocked);
      const hk = mk('block').mods.find(m => m.name === 'tripwires').beforeReply;
      check('beforeReply tolerates non-string', hk(null, { settings: { mode: 'block' } }) === undefined);
      const tw = tid => J.readAll().records.filter(r => r.type === 'tripwire' && r.task_id === tid);
      const rr = mk('redact');
      await M.beforeReply(rr.mods, `x ${FAKE_KEY}`, { task_id: 'enf-r' });
      check('redact: masked trip recorded at the hook (enforced)', tw('enf-r').length === 1 && tw('enf-r')[0].rule === 'secrets' && tw('enf-r')[0].enforced === true && !JSON.stringify(tw('enf-r')).includes(FAKE_KEY));
      const rb = mk('block');
      const bb = await M.beforeReply(rb.mods, `x ${FAKE_KEY}`, { task_id: 'enf-b' });
      check('block: withheld trip recorded at the hook (enforced)', bb.blocked && tw('enf-b').length === 1 && tw('enf-b')[0].enforced === true);
      J.append({ type: 'reply', task_id: 'enf-b', text: '(reply withheld by tripwires)' });
      await M.emit(rb.mods, 'task.end', { task_id: 'enf-b', code: 0, workdir: tmp });
      check('block: task.end after a block does not double-record', tw('enf-b').length === 1);
      await M.beforeReply(rr.mods, 'plain reply', { task_id: 'enf-c' });
      check('redact: clean reply records nothing', tw('enf-c').length === 0);
      fs.rmSync(path.join(J.STATE, 'm', 'tripwires', 'trips.json'), { force: true }); // later route checks start from an empty list
    }
    const run = async (tid, reply, code) => {
      if (reply != null) J.append({ type: 'reply', task_id: tid, text: reply });
      await M.emit(rec.mods, 'task.end', { task_id: tid, code, workdir: tmp });
    };
    // collect tripwires.tripped via a plain wrapper around the module's own emit path
    const Emitted = [];
    const mod = require('../index');
    const realOn = mod.on['task.end'];
    const ctxOf = () => ({ state: { dir: path.join(tmp, 'direct'), append: r => J.append({ ...r, module: 'tripwires' }) }, emit: async (e, p) => { Emitted.push([e, p]); }, settings: { mode: 'flag', rule_secrets: true, rule_paths: true, rule_private_ips: true, rule_banned: true, rule_oversize: true, rule_success_claim: true, banned_phrases: [], max_reply_chars: 3000, retention: 2 } });
    J.append({ type: 'reply', task_id: 'd1', text: `leak ${FAKE_KEY} and ${IP10}` });
    await realOn({ task_id: 'd1', code: 0 }, ctxOf());
    check('direct: emits tripwires.tripped with rules', Emitted.length === 1 && Emitted[0][0] === 'tripwires.tripped' && Emitted[0][1].rules.join() === 'secrets,private_ips' && Emitted[0][1].enforced === false, JSON.stringify(Emitted));
    const recs = J.readAll().records.filter(r => r.type === 'tripwire' && r.task_id === 'd1');
    check('direct: journal holds rule + redacted snippet only', recs.length === 2 && recs.every(r => r.rule && r.snippet) && !JSON.stringify(J.readAll().records.filter(r => r.type === 'tripwire')).includes(FAKE_KEY));
    check('direct: retention cap applied', JSON.parse(fs.readFileSync(path.join(tmp, 'direct', 'trips.json'), 'utf8')).length === 2);
    await realOn({ task_id: 'd1', code: 0 }, ctxOf());
    check('direct: cap holds after more trips', JSON.parse(fs.readFileSync(path.join(tmp, 'direct', 'trips.json'), 'utf8')).length === 2);
    await realOn({ task_id: 'nope', code: 0 }, { ...ctxOf(), state: null });
    check('a broken ctx never throws', true);

    await run('t1', 'Everything is done and tests pass.', 2);
    await run('t2', 'plain and honest', 0);
    await run('t3', `this has forbidden words in it`, 0);
    await run('t4', null, 1);
    const tr = J.readAll().records.filter(r => r.type === 'tripwire' && r.module === 'tripwires');
    check('registry: success claim and banned phrase journaled, honest/no-reply skipped', tr.filter(r => r.task_id === 't1').map(r => r.rule).join() === 'success_claim' && tr.filter(r => r.task_id === 't3').map(r => r.rule).join() === 'banned' && !tr.some(r => r.task_id === 't2' || r.task_id === 't4'), JSON.stringify(tr.map(r => [r.task_id, r.rule])));

    // ---- status and routes
    const lines = M.statusLines ? await M.statusLines(rec.mods, J) : [];
    check('status line shows last trip', lines.some(l => /tripwires: \d+ tripped, last banned/.test(typeof l === 'string' ? l : l.text || '')), JSON.stringify(lines));
    const actor = { kind: 'owner', id: 'test' };
    const list = await rec.callRoute(rec.findRoute('GET', '/m/tripwires/trips'), { query: {}, actor });
    check('route: lists newest first, capped at retention 3', list.status === 200 && list.json.trips.length === 2 && list.json.trips[0].rule === 'banned', JSON.stringify(list.json.trips.map(t => t.rule)));
    const byRule = await rec.callRoute(rec.findRoute('GET', '/m/tripwires/trips?rule=success_claim'), { query: { rule: 'success_claim' }, actor });
    check('route: rule filter', byRule.json.trips.length === 1 && byRule.json.trips[0].rule === 'success_claim');
    const anon = await rec.callRoute(rec.findRoute('GET', '/m/tripwires/trips'), { query: {}, actor: { kind: 'anonymous' } });
    check('route: anonymous refused', anon.status === 403);
    const del = await rec.callRoute(rec.findRoute('DELETE', '/m/tripwires/trips'), { actor });
    const after = await rec.callRoute(rec.findRoute('GET', '/m/tripwires/trips'), { query: {}, actor });
    check('route: delete clears the list', del.json.cleared === 2 && after.json.trips.length === 0);
    void origEmit; void events;
  } catch (e) { check('no exception', false, e.stack); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  process.exit(n === results.length ? 0 : 1);
})();
