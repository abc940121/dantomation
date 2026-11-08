#!/usr/bin/env node
'use strict';
// approval-cards under module contract 1: the registry sees its routes, panel and
// settings; the routes list and answer cards (400 / 404 / unclear / yes); a bad
// config section is a clear load error. In-process, with its own state dir, so it
// runs whatever the active config enables.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cards-contract-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state'); // before the journal is required
process.env.HARNESS_NOW = String(Date.parse('2030-01-01T00:00:00Z'));
delete process.env.HARNESS_TASK_ID;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));
const K = require('../cards');

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };

(async () => {
  try {
    const reg = M.registry({ modules: { 'approval-cards': true }, approval_cards: { timeout_minutes: 5 } });
    check('loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    const routes = reg.listRoutes().map(r => `${r.method} ${r.path}`);
    check('routes are namespaced under /m/approval-cards', routes.join(',') === 'GET /m/approval-cards/cards,GET /m/approval-cards/cards/decided,POST /m/approval-cards/cards/:id/voice,POST /m/approval-cards/cards/:id/answer', routes.join(','));
    const panels = reg.listPanels();
    check('panel is listed and its entry file exists', panels.length === 1 && panels[0].mount === 'chat' && panels[0].url === '/m/approval-cards/ui/cards-panel.js' && fs.existsSync(panels[0].file));
    const s = reg.settingsFor('approval-cards');
    check('settings: config value over defaults', s.timeout_minutes === 5 && Array.isArray(s.risky) && s.risky.length === 0 && Array.isArray(s.skip), JSON.stringify(s));
    check('command answer still registered', reg.listCommands().includes('answer'));

    // cards.js io: journal reads, the module's state corner for writes, emit for card.*.
    const sdir = path.join(J.STATE, 'm', 'approval-cards'); fs.mkdirSync(sdir, { recursive: true });
    const emitted = [];
    const io = { J, state: { dir: sdir, append: rec => J.append({ ...rec, module: 'approval-cards' }) }, emit: async (ev, p) => { emitted.push([ev, p]); } };
    const card = await K.create(io, { task_id: 't1', tool: 'Bash', input: { command: 'deploy-site' }, summary: 'deploys', rule: 'deploy' }, s);
    check('create emits card.created after the journal write', emitted.length === 1 && emitted[0][0] === 'card.created' && emitted[0][1].card_id === card.card_id && J.readAll().records.some(x => x.type === 'card' && x.card_id === card.card_id));
    check('the card mirror is in state/m/approval-cards/', fs.existsSync(path.join(sdir, card.card_id + '.json')));
    check('card expiry uses the timeout_minutes setting', Date.parse(card.expires_at) - Date.parse(card.created_at) === 5 * 60000);
    const call = (method, url, body) => { const f = reg.findRoute(method, url); return f ? reg.callRoute(f, { body, core: { J }, actor: { kind: 'owner', id: '' } }) : Promise.resolve({ status: 'no route' }); };
    let r = await call('GET', '/m/approval-cards/cards');
    check('GET /cards lists the pending card', r.status === 200 && r.json.cards.length === 1 && r.json.cards[0].card_id === card.card_id);
    r = await call('POST', `/m/approval-cards/cards/${card.card_id}/answer`, {});
    check('POST without text is 400', r.status === 400, JSON.stringify(r));
    r = await call('POST', '/m/approval-cards/cards/card-000000/answer', { text: 'yes' });
    check('POST to an unknown card is 404', r.status === 404, JSON.stringify(r));
    r = await call('POST', `/m/approval-cards/cards/${card.card_id}/answer`, { text: 'maybe' });
    check('unclear answer approves nothing and keeps the card', r.status === 200 && r.json.answer === 'unclear' && !r.json.resume && K.pending(J.readAll().records).length === 1);
    r = await call('POST', `/m/approval-cards/cards/${card.card_id}/answer`, { text: 'yes' });
    check('yes approves and asks for resume', r.status === 200 && r.json.answer === 'yes' && r.json.resume === true, JSON.stringify(r));
    const recs = J.readAll().records;
    check('journal has the answer and the APPROVED note, namespaced to the module', recs.some(x => x.type === 'card_answer' && x.answer === 'yes' && x.module === 'approval-cards') && recs.some(x => x.type === 'history_note' && /APPROVED/.test(x.note)));
    r = await call('POST', `/m/approval-cards/cards/${card.card_id}/answer`, { text: 'no' });
    check('answering again is 404 (no longer pending)', r.status === 404);

    const bad = M.load({ modules: { 'approval-cards': true }, approval_cards: { timeout_minutes: '10', colour: 'red' } });
    const msg = bad.errors.join(' | ');
    check('bad config section is a load error naming key and type', bad.mods.length === 0 && /config "approval_cards\.timeout_minutes" must be a number, got string "10"/.test(msg) && /unknown key "colour"/.test(msg), msg);
    const low = M.load({ modules: { 'approval-cards': true }, approval_cards: { timeout_minutes: 0.5 } });
    check('timeout_minutes under 1 is a load error', low.mods.length === 0 && /timeout_minutes/.test(low.errors.join(' ')), low.errors.join(' | '));
  } catch (e) { check('no exception', false, e.stack); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  try { // decision source, expiry, deny message, voice hook (own process and state dir)
    const sub = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'source.js')], { encoding: 'utf8', env: { ...process.env, HARNESS_STATE_DIR: path.join(tmp, 'src-state') } });
    process.stdout.write(sub.stdout || '');
    check('source.js (decision source, expiry, deny message, voice hook) passes', sub.status === 0, (sub.stderr || '').slice(0, 200));
  } catch (e) { check('source.js ran', false, e.message); }
  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  process.exit(n === results.length ? 0 : 1);
})();
