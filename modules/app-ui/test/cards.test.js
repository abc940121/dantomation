#!/usr/bin/env node
'use strict';
// app-ui cards: question routes (validation, list, get, answer, pruning) and the pure card translations.
// Made-up text only; scratch state dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const APP = path.join(ROOT, 'modules', 'app-ui');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'appui-cards-'));
process.env.HARNESS_STATE_DIR = path.join(base, 'state');
fs.mkdirSync(process.env.HARNESS_STATE_DIR, { recursive: true });

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !info ? '' : ': ' + info}`); };

const mod = require(APP);
const L = require(path.join(APP, 'adapter', 'lib'));
const cfg = { bots: [{ id: 'alpha', name: 'Alpha', engine: 'claude' }, { id: 'beta', name: 'Beta', engine: 'codex' }] };
const stateDir = path.join(base, 'mod');
fs.mkdirSync(stateDir, { recursive: true });
const events = [];
const ctx = (over = {}) => ({ config: cfg, query: {}, params: {}, body: {}, state: { dir: stateDir }, emit: async (n, p) => { events.push([n, p]); }, ...over });
const route = (method, p) => mod.routes.find(r => r.method === method && r.path === p);

const mk = (over = {}) => ({ bot: 'alpha', title: 'Pick one', questions: [{ prompt: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue', description: 'cool' }] }], ...over });
const create = body => route('POST', '/api/questions').handler(ctx({ body }));

(async () => {
  // ---- routes registered
  const rc = route('POST', '/api/questions');
  check('routes: create is worker access, others owner', rc && rc.access === 'worker' && route('GET', '/api/questions').access === 'owner' && route('GET', '/api/questions/:id') && route('POST', '/api/questions/:id/answer').access === 'owner');

  // ---- create validation
  const ok = await create(mk());
  check('create: 201 with pending question', ok.status === 201 && /^q-[0-9a-f]+$/.test(ok.json.question.id) && ok.json.question.state === 'pending' && ok.json.question.expiresAt - ok.json.question.createdAt === 1800000);
  check('create: emitted question_pending', events.some(e => e[0] === 'app-ui.question_pending' && e[1].question.id === ok.json.question.id));
  const opt = n => Array.from({ length: n }, (_, i) => ({ label: 'o' + i }));
  const q = (o = {}) => ({ prompt: 'p', options: opt(2), ...o });
  const cases = [
    ['unknown bot', mk({ bot: 'nope' }), 400],
    ['missing title', mk({ title: '' }), 400],
    ['title too long', mk({ title: 'x'.repeat(201) }), 400],
    ['zero questions', mk({ questions: [] }), 400],
    ['seven questions', mk({ questions: Array.from({ length: 7 }, () => q()) }), 400],
    ['prompt too long', mk({ questions: [q({ prompt: 'x'.repeat(1001) })] }), 400],
    ['thirteen options', mk({ questions: [q({ options: opt(13) })] }), 400],
    ['label too long', mk({ questions: [q({ options: [{ label: 'x'.repeat(201) }] })] }), 400],
    ['no option and no text', mk({ questions: [q({ options: [], allowText: false })] }), 400],
    ['expires zero', mk({ expiresInSec: 0 }), 400],
    ['expires too big', mk({ expiresInSec: 86401 }), 400],
    ['expires not a number', mk({ expiresInSec: 'soon' }), 400],
  ];
  for (const [label, body, status] of cases) check('create rejects: ' + label, (await create(body)).status === status);
  const edge = await create(mk({ title: 'x'.repeat(200), questions: Array.from({ length: 6 }, () => q({ options: opt(12) })), expiresInSec: 86400 }));
  check('create: limits are inclusive', edge.status === 201);
  const free = await create(mk({ questions: [{ prompt: 'Why?', options: [], allowText: true }] }));
  check('create: free text only is fine', free.status === 201 && free.json.question.questions[0].allowText === true);

  // ---- list / get
  const pend = route('GET', '/api/questions').handler(ctx()).json.questions;
  check('list: pending by default', pend.length >= 3 && pend.every(x => x.state === 'pending'));
  const got = route('GET', '/api/questions/:id').handler(ctx({ params: { id: ok.json.question.id } }));
  check('get: one question', got.status === 200 && got.json.question.title === 'Pick one');
  check('get: unknown 404', route('GET', '/api/questions/:id').handler(ctx({ params: { id: 'q-nope' } })).status === 404);

  // ---- answer
  const ans = (id, body, over = {}) => route('POST', '/api/questions/:id/answer').handler(ctx({ params: { id }, body, ...over }));
  const id = ok.json.question.id;
  check('answer: wrong index 400', (await ans(id, { answers: [{ selected: [5] }] })).status === 400);
  check('answer: two picks on single choice 400', (await ans(id, { answers: [{ selected: [0, 1] }] })).status === 400);
  check('answer: text not allowed 400', (await ans(id, { answers: [{ selected: [0], text: 'x' }] })).status === 400);
  check('answer: empty 400', (await ans(id, { answers: [{ selected: [] }] })).status === 400);
  check('answer: wrong count 400', (await ans(id, { answers: [] })).status === 400);
  const good = await ans(id, { answers: [{ selected: [1] }] }, { actor: { kind: 'device', token: 'secret-made-up' } });
  check('answer: stored, actor kind only', good.status === 200 && good.json.question.state === 'answered' && good.json.question.answeredBy === 'device' && !JSON.stringify(good.json).includes('secret-made-up'));
  check('answer: emitted question_resolved', events.some(e => e[0] === 'app-ui.question_resolved' && e[1].questionId === id));
  check('answer: get returns it', route('GET', '/api/questions/:id').handler(ctx({ params: { id } })).json.question.answers[0].selected[0] === 1);
  check('answer: second answer 409', (await ans(id, { answers: [{ selected: [0] }] })).status === 409);
  check('list: answered hidden from pending, shown in all', !route('GET', '/api/questions').handler(ctx()).json.questions.some(x => x.id === id) && route('GET', '/api/questions').handler(ctx({ query: { state: 'all' } })).json.questions.some(x => x.id === id));
  const multi = await create(mk({ questions: [q({ multi: true, allowText: true })] }));
  const m = await ans(multi.json.question.id, { answers: [{ selected: [0, 1], text: 'both' }] });
  check('answer: multi with text', m.status === 200 && m.json.question.answers[0].text === 'both');
  const short = await create(mk({ expiresInSec: 1 }));
  await new Promise(r => setTimeout(r, 1100));
  check('answer: expired 409', (await ans(short.json.question.id, { answers: [{ selected: [0] }] })).status === 409);
  check('get: expired shows state', route('GET', '/api/questions/:id').handler(ctx({ params: { id: short.json.question.id } })).json.question.state === 'expired');

  // ---- emit failure does not fail the call
  const boom = await route('POST', '/api/questions').handler(ctx({ body: mk(), emit: async () => { throw new Error('no listener'); } }));
  check('create: emit failure ignored', boom.status === 201);

  // ---- pruning cap
  const dir2 = path.join(base, 'cap');
  fs.mkdirSync(dir2, { recursive: true });
  const cctx = body => ctx({ state: { dir: dir2 }, body });
  let first = null;
  for (let i = 0; i < 205; i++) {
    const r = await route('POST', '/api/questions').handler(cctx(mk({ title: 't' + i })));
    if (i === 0) {
      first = r.json.question.id;
      await route('POST', '/api/questions/:id/answer').handler(ctx({ state: { dir: dir2 }, params: { id: first }, body: { answers: [{ selected: [0] }] } }));
    }
  }
  const all = route('GET', '/api/questions').handler(ctx({ state: { dir: dir2 }, query: { state: 'all' } })).json.questions;
  check('prune: capped at 200', all.length === 200);
  check('prune: oldest answered goes first', !all.some(x => x.id === first) && all.some(x => x.title === 't5') && !all.some(x => x.title === 't4'));

  // ---- cards-map
  const M = await import(pathToFileURL(path.join(APP, 'adapter', 'areas', 'cards-map.mjs')).href);
  const now = Date.parse('2026-01-01T00:00:00Z');
  const core = { id: 'card-ab12', task: 'task-1', bot: 'alpha', tool: 'Bash', summary: 'ls the folder', expiresAt: '2026-01-01T00:10:00Z', state: 'pending' };
  const c1 = M.coreCardToOptionCard(core, now);
  check('map: pending core card', c1.kind === 'approval' && c1.requestId === 'card-ab12' && c1.threadId === 'main:alpha' && c1.state === 'pending' && c1.subtitle === 'ls the folder' && c1.options.join() === 'Allow,Deny');
  check('map: core card past its time is expired', M.coreCardToOptionCard(core, now + 3600e3).state === 'expired');
  check('map: resolved core card is answered', M.coreCardToOptionCard({ ...core, state: 'resolved', decision: { answer: 'yes' } }, now).answered === 'yes');
  const qc = M.questionToCard(good.json.question, Date.now());
  check('map: answered question', qc.kind === 'question' && qc.state === 'answered' && qc.questions[0].options.length === 2 && qc.answers[0].selected[0] === 1);
  const sq = M.questionToCard({ ...ok.json.question, state: 'pending', expiresAt: now - 1 }, now);
  check('map: question past its time is expired', sq.state === 'expired');
  const tq = M.questionToCard(free.json.question, Date.now());
  check('map: free-text question', tq.questions[0].options.length === 0 && tq.state === 'pending');
  const r1 = M.respondToRequest('main:alpha', { requestId: 'card-ab12', behavior: 'allow' });
  const r2 = M.respondToRequest('main:alpha', { requestId: 'card-ab12', behavior: 'deny' });
  const r3 = M.respondToRequest('main:alpha', { requestId: 'card-ab12', behavior: 'answer', message: 'maybe later' });
  const r4 = M.respondToRequest('main:alpha', { requestId: 'q-abc', behavior: 'answer', message: { answers: [{ selected: [0] }] } });
  check('map: allow -> yes', r1.path === '/api/cards/card-ab12' && r1.body.answer === 'yes');
  check('map: deny -> no', r2.body.answer === 'no');
  check('map: answer -> text', r3.body.answer === 'maybe later');
  check('map: question id goes to the module route', r4.path === '/m/app-ui/api/questions/q-abc/answer' && r4.body.answers[0].selected[0] === 0);
  const evs = [
    { type: 'card_pending', id: 'card-1', bot: 'alpha', title: 'Bash', body: 'ls', at: 100 },
    { type: 'question_pending', id: 'q-2', bot: 'beta', title: 'Pick', body: 'Which?', at: 300 },
    { type: 'card_pending', id: 'card-1', bot: 'alpha', title: 'Bash', body: 'ls', at: 100 },
    { type: 'card_resolved', id: 'card-1', bot: 'alpha', at: 200 },
  ];
  const n = M.deriveNotifications(evs, ['card-1']);
  check('map: notifications deduped, newest first, resolved skipped', n.length === 2 && n[0].id === 'q-2' && n[0].kind === 'question' && n[1].kind === 'approval');
  check('map: read flag from readIds', n[0].read === false && n[1].read === true);

  fs.rmSync(base, { recursive: true, force: true });
  const failed = results.filter(r => !r).length;
  console.log(`result: ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('FAIL test crashed: ' + (e && e.stack || e)); process.exit(1); });
