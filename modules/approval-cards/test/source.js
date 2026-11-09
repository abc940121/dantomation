#!/usr/bin/env node
'use strict';
// approval-cards: who/where of every decision, expiry that stays closed, the deny message,
// the voice hook. In-process, own state dir, runs whatever the active config enables.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cards-source-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state');
const T0 = Date.parse('2030-01-01T00:00:00Z');
process.env.HARNESS_NOW = String(T0);
process.env.HARNESS_TASK_ID = 'ts';
process.env.HARNESS_TASK_DIR = tmp;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const J = require(path.join(ROOT, 'lib', 'journal'));
const K = require('../cards');
const mod = require('../index');
const { parseAnswer } = require('../parse');
const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const at = min => { process.env.HARNESS_NOW = String(T0 + min * 60000); };

(async () => {
  try {
    const sdir = path.join(J.STATE, 'm', 'approval-cards'); fs.mkdirSync(sdir, { recursive: true });
    const emitted = [];
    const state = { dir: sdir, append: rec => J.append({ ...rec, module: 'approval-cards' }) };
    const quiet = { J, state, emit: async () => {} };
    const ctxFor = (command, extra) => ({ tool: 'Bash', ti: { command }, cwd: tmp, settings: { timeout_minutes: 15 }, state, emit: async (e, p) => emitted.push([e, p]), core: { J }, ...extra });
    const cardOf = r => (String(r && r[1]).match(/card-[0-9a-f]{6}/) || [])[0];
    const folded = id => K.fold(J.readAll().records).get(id);
    const ask = async cmd => { const r = await mod.beforeTool(ctxFor(cmd)); return { r, id: cardOf(r) }; };
    const route = p => mod.routes.find(r => r.path === p);
    const OWN = { kind: 'owner', id: '' };
    const answer = (id, body, actor) => route('/cards/:id/answer').handler({ ...ctxFor('x'), params: { id }, body, actor: actor || OWN });
    const DEV = id => ({ kind: 'owner', id: 'device:' + id });

    check('default: no deadline, a card waits until answered', K.DEFAULT_TIMEOUT_MIN === 0 && mod.settings.timeout_minutes.default === 0 && K.timeoutMs({}) === 0);

    // each source
    let { id } = await ask('git push origin a');
    let r = await answer(id, { text: 'yes' });
    check('source owner via chat (default)', r.status === 200 && folded(id).decided.who === 'owner' && folded(id).decided.where === 'chat' && folded(id).decision === 'Approved · owner via chat', folded(id).decision);
    ({ id } = await ask('git push origin b'));
    const devNo = id;
    r = await answer(id, { text: 'no' }, DEV('dev-ab12'));
    check('source device + id via phone', folded(id).decided.who === 'device' && folded(id).decided.device_id === 'dev-ab12' && folded(id).decision === 'Denied · device dev-ab12 via phone', folded(id).decision);
    ({ id } = await ask('git push origin c'));
    await answer(id, { text: 'no', where: 'cli' });
    check('where cli', folded(id).decided.where === 'cli');
    ({ id } = await ask('git push origin d'));
    at(16);
    await K.sweep(quiet);
    check('source timeout shows "Denied · timeout"', folded(id).decided.who === 'timeout' && folded(id).decision === 'Denied · timeout' && folded(id).state === 'expired', folded(id).decision);
    at(0);
    ({ id } = await ask('git push origin e'));
    await K.systemDeny(quiet, folded(id), 'broker unreachable');
    check('source system (fail closed)', folded(id).decided.who === 'system' && folded(id).decision === 'Denied · system' && J.readAll().records.some(x => x.type === 'history_note' && /could not reach/.test(x.note)), folded(id).decision);
    const rec = J.readAll().records.filter(x => x.type === 'card_answer' && x.card_id === id)[0];
    check('the journal record carries who and where', rec.who === 'system' && rec.where === null && rec.module === 'approval-cards');
    check('bad sources are rejected (fail closed)', !K.source({ who: 'robot' }) && !K.source({ where: 'fax' }) && !K.source({ device_id: 'a b!' }) && !K.source({ who: 'device' }));
    const f = await ask('git push origin f');
    r = await answer(f.id, { text: 'yes', where: 'fax' });
    check('route refuses a bad where with 400, card stays pending', r.status === 400 && folded(f.id).state === 'pending');
    await answer(f.id, { text: 'yes' }, DEV('dev1'));
    const st = await route('/cards/decided').handler(ctxFor('x'));
    check('GET /cards/decided shows the decision text for the UI', st.json.cards.some(c => c.decision === 'Approved · device dev1 via phone') && st.json.cards.some(c => c.decision === 'Denied · timeout'));

    // device actor: the id and where come from the authenticated actor only
    const sp = await ask('git push origin spoof');
    r = await answer(sp.id, { text: 'yes', device_id: 'evil-9', where: 'chat' }, DEV('dev-real'));
    check('a spoofed device_id and where in the body are ignored for a device actor', r.status === 200 && folded(sp.id).decided.device_id === 'dev-real' && folded(sp.id).decided.where === 'phone' && folded(sp.id).decision === 'Approved · device dev-real via phone', folded(sp.id).decision);
    const sp2 = await ask('git push origin spoof2');
    r = await answer(sp2.id, { text: 'yes', device_id: 'evil-9' });
    check('an owner answer stays who=owner, where=chat; a body device_id is not used', r.status === 200 && folded(sp2.id).decided.who === 'owner' && folded(sp2.id).decided.where === 'chat' && folded(sp2.id).decided.device_id === undefined, folded(sp2.id).decision);
    const sp3 = await ask('git push origin spoof3');
    const bads = [undefined, { kind: 'worker', id: '' }, { kind: 'anonymous', id: '' }, { kind: 'owner', id: 'x' }, { kind: 'owner', id: 'device:' }, { kind: 'owner', id: 'device:a b!' }];
    let closed = true;
    for (const a of bads) { const x = await route('/cards/:id/answer').handler({ ...ctxFor('x'), params: { id: sp3.id }, body: { text: 'yes' }, actor: a }); if (x.status !== 400 || folded(sp3.id).state !== 'pending') closed = false; }
    check('unknown or malformed actors are refused and the card stays pending (fail closed)', closed);
    const sp4 = await ask('git push origin spoof4');
    const vr = await route('/cards/:id/voice').handler({ ...ctxFor('x'), params: { id: sp4.id }, body: { text: 'yes', device_id: 'evil-9' }, actor: DEV('dev-v') });
    check('voice route: the device id comes from the actor, not the body', vr.status === 200 && folded(sp4.id).decision === 'Approved · device dev-v via voice', folded(sp4.id).decision);

    // expiry: stays closed, no late approve, no re-post, survives restart
    at(0);
    id = (await ask('git push origin g')).id;
    const nBefore = J.readAll().records.filter(x => x.type === 'card').length;
    at(14);
    check('still answerable just before the deadline', K.pending(J.readAll().records).some(c => c.card_id === id));
    at(15);
    r = await answer(id, { text: 'yes' });
    check('a yes at the deadline is rejected (late approve)', r.status === 404 && folded(id).state === 'expired');
    at(0);
    const ghost = await ask('git push origin h');
    at(20);
    const res = await K.answered(quiet, folded(ghost.id), 'yes', undefined, K.source({}));
    check('answered() turns a late yes that slipped past the sweep into a timeout', res === 'timeout' && folded(ghost.id).state === 'expired');
    at(30);
    const cardsBefore = J.readAll().records.filter(x => x.type === 'card').length;
    const again = await mod.beforeTool(ctxFor('git push origin g'));
    check('same call after expiry gets the denial text and no new card', again[0] === 'approval_card' && /DENIED \(timeout\)/.test(again[1]) && J.readAll().records.filter(x => x.type === 'card').length === cardsBefore);
    delete require.cache[require.resolve('../cards')];
    const K2 = require('../cards');
    await K2.sweep(quiet);
    check('a restart (fresh fold + sweep) keeps it expired and posts nothing', K2.fold(J.readAll().records).get(id).state === 'expired' && K2.pending(J.readAll().records).length === 0 && J.readAll().records.filter(x => x.type === 'card').length === cardsBefore);
    check('card.created was emitted once for it, never again', emitted.filter(e => e[0] === 'card.created' && e[1].card_id === id).length === 1);

    // deny message text
    const notes = J.readAll().records.filter(x => x.type === 'history_note').map(x => x.note);
    const dn = notes.find(n => /DENIED \(device dev-ab12\)/.test(n));
    check('deny note: skip, do not retry, tell the person why, carry on', dn && /Skip this step/.test(dn) && /do not retry or reword/.test(dn) && /Tell the person this step was not done because/.test(dn) && /continue with anything/.test(dn), dn);
    check('timeout note says why in plain words', notes.some(n => /denied \(timeout\)/.test(n) && /nobody answered it in time/.test(n) && /Skip this step/.test(n)));
    check('re-issuing a denied call is blocked with that text, not a bare error', /Skip this step/.test((await mod.beforeTool(ctxFor('git push origin b')))[1]) && folded(devNo).state === 'denied');

    // approve-once, hash-bound unchanged
    at(0);
    const a1 = await ask('npm install zed');
    await answer(a1.id, { text: 'yes' });
    check('a different input is not covered by the approval', cardOf(await mod.beforeTool(ctxFor('npm install other'))) !== a1.id);
    check('approved call passes once (allow:card, so a guard ask is answered too)', ((r0) => Array.isArray(r0) && r0[0] === 'allow:card')(await mod.beforeTool(ctxFor('npm install zed'))));
    const second = cardOf(await mod.beforeTool(ctxFor('npm install zed')));
    check('second identical call needs a new card', second && second !== a1.id);

    // no deadline by default: the card stays open, the sweep never answers it
    at(0);
    const nd = await mod.beforeTool({ ...ctxFor('git push origin nodeadline'), settings: {} });
    const ndc = folded(cardOf(nd));
    at(60 * 24 * 7);
    await K.sweep(quiet);
    check('default card has no deadline and is still pending a week later', ndc && ndc.expires_at === null && folded(ndc.card_id).state === 'pending', ndc && ndc.expires_at);

    // a live card's yes belongs to the waiting prompt tool, not to a concurrent hook call
    at(0);
    const lv = await K.create(quiet, { task_id: process.env.HARNESS_TASK_ID, tool: 'Bash', input: { command: 'npm install livepkg' }, summary: 'x', rule: 'install' }, {}, { live: true });
    await K.answered(quiet, folded(lv.card_id), 'yes', undefined, K.source({}));
    await mod.beforeTool(ctxFor('npm install livepkg'));
    check('beforeTool does not use up an approved live card', folded(lv.card_id).state === 'approved');

    // fail closed on internal error
    const bad = await mod.beforeTool({ ...ctxFor('git push origin z'), state: null });
    check('internal error blocks with an actionable message', Array.isArray(bad) && /not run/.test(bad[1]) && /Skip it, tell the person why/.test(bad[1]));

    // voice hook
    const v = await ask('git push origin voice');
    let allReask = true;
    for (const t of ['maybe', 'yes but not now', 'yes?', 'umm', '', 'sure why not']) {
      const x = await mod.api.voiceAnswer(ctxFor('x'), { card_id: v.id, text: t });
      if (!(x.json.reask === true && x.json.answer === 'unclear' && /yes or no/.test(x.json.say))) allReask = false;
    }
    check('ambiguous voice answers re-ask and decide nothing', allReask && folded(v.id).state === 'pending');
    const vx = await mod.api.voiceAnswer(ctxFor('x'), { card_id: v.id, text: 'Yes' });
    check('strict yes by voice approves, where=voice', vx.json.answer === 'yes' && folded(v.id).decided.where === 'voice' && folded(v.id).decision === 'Approved · owner via voice');
    const v2 = await ask('git push origin voice2');
    await mod.api.voiceAnswer(ctxFor('x'), { card_id: v2.id, text: 'no', device_id: 'dev-9' });
    check('strict no by voice denies, device id kept', folded(v2.id).decision === 'Denied · device dev-9 via voice');
    check('strict parser: yes, no; mixed or hedged is unclear', parseAnswer('yes') === 'yes' && parseAnswer('no') === 'no' && parseAnswer('yes but no') === 'unclear' && parseAnswer('go ahead maybe') === 'unclear');
    check('voice route exists (hook point only)', !!route('/cards/:id/voice') && route('/cards/:id/voice').method === 'POST');
  } catch (e) { check('no exception', false, e.stack); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  process.exit(n === results.length ? 0 : 1);
})();
