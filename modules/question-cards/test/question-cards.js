#!/usr/bin/env node
'use strict';
// question-cards: validation, store (ask / answer / cancel / expire), owner routes and their
// access, events (seen by a temporary spy module), the shell command in real processes,
// the agent-side guard, off-by-default. Fresh temp state dir; no network, no fixed ports.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qcards-'));
const STATE = path.join(tmp, 'state');
process.env.HARNESS_STATE_DIR = STATE; // before the journal is required
for (const k of ['HARNESS_TASK_ID', 'HARNESS_TASK_DIR', 'HARNESS_NOW']) delete process.env[k];
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));
const S = require('../store');

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const OWNER = { kind: 'owner', id: '' }, DEVICE = { kind: 'owner', id: 'device:phone-1' }, WORKER = { kind: 'worker', id: 'w' }, ANON = { kind: 'anonymous', id: '' };
const T0 = Date.parse('2030-01-01T00:00:00Z');

(async () => {
  const spyName = 'zz-qc-spy-' + crypto.randomBytes(3).toString('hex');
  const spyDir = path.join(M.DIR, spyName);
  try {
    // ---- off by default
    const off = M.registry({ modules: { 'question-cards': false } });
    check('off: nothing registered', off.errors.length === 0 && !off.listRoutes().some(r => r.module === 'question-cards') && !off.listCommands().includes('question') && off.settingsFor('question-cards') === null);
    const none = M.registry({ modules: {} });
    check('absent from config: not loaded', !none.listRoutes().some(r => r.module === 'question-cards'));

    // ---- spy module records every question.* event into the journal
    fs.mkdirSync(spyDir, { recursive: true });
    const ev = ['asked', 'answered', 'cancelled', 'expired'].map(e => `'question.${e}': (p, { state }) => { state.append({ type: 'spy', event: 'question.${e}', p }); }`).join(', ');
    fs.writeFileSync(path.join(spyDir, 'index.js'), `'use strict';\nmodule.exports = { contract: 1, name: '${spyName}', priority: 90, on: { ${ev} } };\n`);
    const cfg = { modules: { 'question-cards': true, [spyName]: true }, question_cards: { timeout_minutes: 10, max_pending: 5 } };
    const reg = M.registry(cfg);
    check('on: loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    check('settings merge', JSON.stringify(reg.settingsFor('question-cards')) === '{"timeout_minutes":10,"max_pending":5}', JSON.stringify(reg.settingsFor('question-cards')));
    const bad = M.registry({ modules: { 'question-cards': true }, question_cards: { timeout_minutes: '10' } });
    check('wrong setting type is a load error', bad.errors.length === 1, bad.errors.join('|'));
    const routes = reg.listRoutes().filter(r => r.module === 'question-cards');
    check('6 routes, all owner access', routes.length === 6 && routes.every(r => (r.access || 'owner') === 'owner'), routes.map(r => r.method + r.path).join());
    check('panel listed', reg.listPanels().some(p => p.module === 'question-cards' && p.url === '/m/question-cards/ui/questions-panel.js'));
    check('command listed', reg.listCommands().includes('question'));

    const call = (method, p, o = {}) => {
      const f = reg.findRoute(method, '/m/question-cards' + p);
      return f ? reg.callRoute(f, { actor: OWNER, body: o.body, query: {}, ...o }) : Promise.resolve({ status: 'nomatch' });
    };
    const events = () => J.readAll().records.filter(r => r.type === 'spy').map(r => r.event);
    const ASK = { text: 'Which colour for the header?', options: ['Red', 'Green', 'Blue'] };

    // ---- validation (pure)
    const V = b => S.validateAsk(b).ok;
    check('validateAsk accepts 2..6 options', V({ text: 'q', options: ['a', 'b'] }) && V({ text: 'q', options: ['a', 'b', 'c', 'd', 'e', 'f'] }));
    check('validateAsk rejects 1 and 7 options', !V({ text: 'q', options: ['a'] }) && !V({ text: 'q', options: ['1', '2', '3', '4', '5', '6', '7'] }));
    const BADS = [null, 'x', [], {}, { text: '', options: ['a', 'b'] }, { text: 5, options: ['a', 'b'] }, { text: 'q', options: 'ab' }, { text: 'q', options: ['a', 5] }, { text: 'q', options: ['a', ''] },
      { text: 'q', options: ['a', 'A'] }, { text: 'q', options: ['a', 'b'], allow_free: 'yes' }, { text: 'q', options: ['a', 'b'], task_id: '../x' }, { text: 'q', options: ['a', 'b\nc'] },
      { text: 'q\u0000', options: ['a', 'b'] }, { text: 'x'.repeat(501), options: ['a', 'b'] }, { text: 'q', options: ['a', 'x'.repeat(101)] }];
    check(`validateAsk rejects ${BADS.length} malformed inputs`, BADS.every(b => !V(b)), BADS.filter(V).map(x => JSON.stringify(x)).join(' | '));
    check('validateAsk accepts max sizes', V({ text: 'x'.repeat(500), options: ['a', 'x'.repeat(100)] }));
    const q0 = { options: ['A', 'B'], allow_free: false }, qf = { options: ['A', 'B'], allow_free: true };
    const A = (q, i) => S.validateAnswer(q, i).ok;
    check('validateAnswer: number, option text, string number', A(q0, { choice: 2 }) && A(q0, { choice: 'b' }) && A(q0, { choice: '1' }));
    check('validateAnswer rejects 0, 3, 1.5, empty, junk', ![{ choice: 0 }, { choice: 3 }, { choice: 1.5 }, {}, { choice: 'zzz' }, { choice: {} }, { choice: [1] }, null, 'x', []].some(i => A(q0, i)));
    check('validateAnswer: free text only where allowed', !A(q0, { choice: 1, text: 'hi' }) && A(qf, { text: 'something else' }) && A(qf, { choice: 1, text: 'and more' }) && !A(qf, { text: 'x'.repeat(501) }));

    // ---- ask / list / get
    let r = await call('POST', '/questions', { body: ASK });
    check('ask: 201 with id and pending', r.status === 201 && /^q-[0-9a-f]{24}$/.test(r.json.question.question_id) && r.json.question.state === 'pending', JSON.stringify(r));
    const id1 = r.json.question.question_id;
    check('ask: event question.asked emitted', events().join() === 'question.asked');
    r = await call('POST', '/questions', { body: { text: 'q', options: ['only'] } });
    check('ask: bad body is 400 and emits nothing', r.status === 400 && events().length === 1);
    r = await call('GET', '/questions');
    check('list shows the pending one', r.status === 200 && r.json.questions.length === 1 && r.json.questions[0].question_id === id1);
    r = await call('GET', '/questions/' + id1);
    check('get one', r.status === 200 && r.json.question.text === ASK.text);
    r = await call('GET', '/questions/q-zzzzzz');
    check('get unknown/bad id is 404', r.status === 404);
    r = await call('GET', '/questions/recent');
    check('/recent is not captured by /:id', r.status === 200 && Array.isArray(r.json.questions) && r.json.questions.length === 0);

    // ---- answer
    r = await call('POST', `/questions/${id1}/answer`, { body: { choice: 9 } });
    check('answer: out-of-range choice is 400, still pending', r.status === 400 && (await call('GET', '/questions')).json.questions.length === 1);
    r = await call('POST', `/questions/${id1}/answer`, { body: { choice: 2, where: 'telepathy' } });
    check('answer: bad where is 400', r.status === 400);
    r = await call('POST', `/questions/${id1}/answer`, { body: { choice: 2 } });
    check('answer: 200, state answered, option recorded', r.status === 200 && r.json.question.state === 'answered' && r.json.question.answer.option === 'Green' && r.json.question.answer.who === 'owner' && r.json.question.answer.where === 'chat', JSON.stringify(r.json));
    check('answer: event question.answered emitted once', events().join() === 'question.asked,question.answered');
    r = await call('POST', `/questions/${id1}/answer`, { body: { choice: 1 } });
    check('answer twice: 409, first answer stands', r.status === 409 && (await call('GET', '/questions/' + id1)).json.question.answer.option === 'Green');
    check('answered question left the pending list, shows in /recent', (await call('GET', '/questions')).json.questions.length === 0 && (await call('GET', '/questions/recent')).json.questions.length === 1);
    r = await call('POST', '/questions', { body: { ...ASK, allow_free: true, task_id: 'task-7' } });
    const id2 = r.json.question.question_id;
    r = await call('POST', `/questions/${id2}/answer`, { actor: DEVICE, body: { text: 'Purple, please', where: 'cli' } });
    check('device answer: free text, source from actor (body.where ignored)', r.status === 200 && r.json.question.answer.free_text === 'Purple, please' && r.json.question.answer.who === 'device' && r.json.question.answer.device_id === 'phone-1' && r.json.question.answer.where === 'phone', JSON.stringify(r.json));
    check('answer reaches the asking task as a history note', J.readAll().records.some(x => x.type === 'history_note' && x.task_id === 'task-7' && /question q-/.test(x.note) && !x.note.includes('Purple') && !x.note.includes(ASK.text) && x.note.includes(id2)));
    check('no note when asked without a task', !J.readAll().records.some(x => x.type === 'history_note' && x.note && x.note.includes(id1)));

    // ---- access
    r = await call('POST', '/questions', { actor: WORKER, body: ASK });
    check('worker is forbidden', r.status === 403);
    r = await call('GET', '/questions', { actor: ANON });
    check('anonymous is forbidden', r.status === 403);
    r = await call('POST', '/questions', { actor: undefined, body: ASK });
    check('missing actor is forbidden', r.status === 403);
    r = await call('POST', `/questions/${id2}/answer`, { actor: { kind: 'owner', id: 'weird' }, body: { choice: 1 } });
    check('owner actor with unexpected id fails closed (400, 404 or 409, never 200)', r.status !== 200);
    const q3 = (await call('POST', '/questions', { body: ASK })).json.question.question_id;
    r = await call('POST', `/questions/${q3}/answer`, { actor: { kind: 'owner', id: 'weird' }, body: { choice: 1 } });
    check('pending question: odd owner id is 400', r.status === 400);
    r = await call('POST', `/questions/${q3}/answer`, { actor: { kind: 'owner', id: 'device:../x' }, body: { choice: 1 } });
    check('bad device id is 400', r.status === 400);
    check('path-escape ids match no route', !reg.findRoute('POST', '/m/question-cards/questions/..%2Fx/answer') && !reg.findRoute('GET', '/m/question-cards/questions/%252e%252e'));
    r = await call('POST', `/questions/${q3}/answer`, { actor: ANON, body: { choice: 1 } });
    check('anonymous cannot answer', r.status === 403 && (await call('GET', '/questions/' + q3)).json.question.state === 'pending');

    // ---- cancel
    r = await call('POST', `/questions/${q3}/cancel`, { body: {} });
    check('cancel: 200 cancelled + event', r.status === 200 && r.json.question.state === 'cancelled' && events().includes('question.cancelled'));
    r = await call('POST', `/questions/${q3}/answer`, { body: { choice: 1 } });
    check('answer after cancel is 409', r.status === 409);
    r = await call('POST', `/questions/${q3}/cancel`, { body: {} });
    check('cancel twice is 409', r.status === 409);

    // ---- expiry (clock seam)
    process.env.HARNESS_NOW = String(T0);
    const qe = (await call('POST', '/questions', { body: { ...ASK, task_id: 'task-9' } })).json.question;
    check('expires_at = created + timeout_minutes', Date.parse(qe.expires_at) - Date.parse(qe.created_at) === 10 * 60000);
    process.env.HARNESS_NOW = String(T0 + 10 * 60000 - 1);
    check('just before the deadline: still pending', (await call('GET', '/questions/' + qe.question_id)).json.question.state === 'pending');
    process.env.HARNESS_NOW = String(T0 + 10 * 60000);
    r = await call('POST', `/questions/${qe.question_id}/answer`, { body: { choice: 1 } });
    check('at the deadline: a late answer is 409 expired', r.status === 409 && /expired/.test(r.json.error));
    check('expired: event once and a note for the task', events().filter(e => e === 'question.expired').length === 1 && J.readAll().records.some(x => x.type === 'history_note' && x.task_id === 'task-9' && /expired/.test(x.note)));
    await call('GET', '/questions');
    check('sweeping again does not emit again', events().filter(e => e === 'question.expired').length === 1);
    delete process.env.HARNESS_NOW;

    // ---- texts stay out of the journal (they live in the module's vault); get still returns them
    const SECRET_Q = 'sentinel-question-zq81', SECRET_O = ['sentinel-optA-zq81', 'sentinel-optB-zq81'], SECRET_A = 'sentinel-answer-zq81 hunter2';
    const qs = (await call('POST', '/questions', { body: { text: SECRET_Q, options: SECRET_O, allow_free: true, task_id: 'task-sec' } })).json.question;
    r = await call('POST', `/questions/${qs.question_id}/answer`, { body: { choice: 2, text: SECRET_A } });
    const dump = fs.readFileSync(J.JOURNAL, 'utf8').split(String.fromCharCode(10)).filter(l => !l.includes('"type":"spy"')).join(String.fromCharCode(10)); // the spy module copies event payloads on purpose
    check('journal holds no question text, option or free-text answer', r.status === 200 && !/sentinel-/.test(dump) && !/hunter2/.test(dump), (dump.match(/.{0,80}(sentinel-|hunter2).{0,40}/) || [''])[0]);
    check('answer still readable from the module (text, option, free text)', (await call('GET', '/questions/' + qs.question_id)).json.question.answer.free_text === SECRET_A
      && (await call('GET', '/questions/' + qs.question_id)).json.question.text === SECRET_Q && r.json.question.answer.option === SECRET_O[1]);
    check('journal records for it carry metadata only', J.readAll().records.filter(x => x.question_id === qs.question_id && x.type === 'question_answer').every(x => x.free_len === SECRET_A.length && x.choice === 2 && x.free_text === undefined && x.option === undefined));

    // ---- ids: 96 bits, never reused
    const RB = crypto.randomBytes, firstId = qs.question_id;
    check('ids are q- plus 24 hex', /^q-[0-9a-f]{24}$/.test(firstId));
    let fed = 0;
    crypto.randomBytes = (n, ...a) => (n === 12 && fed++ === 0 ? Buffer.from(firstId.slice(2), 'hex') : RB(n, ...a));
    const q2 = (await call('POST', '/questions', { body: ASK })).json.question;
    crypto.randomBytes = RB;
    check('a colliding id is not reused; the old question is untouched', q2.question_id !== firstId && fed >= 2 && (await call('GET', '/questions/' + firstId)).json.question.text === SECRET_Q);

    // ---- concurrent answer + cancel (same process): exactly one wins, one record, one event, one note
    const qc = (await call('POST', '/questions', { body: { ...ASK, task_id: 'task-race' } })).json.question.question_id;
    const before = events().length;
    const rs = await Promise.all([call('POST', `/questions/${qc}/answer`, { body: { choice: 1 } }), call('POST', `/questions/${qc}/cancel`, { body: {} }), call('POST', `/questions/${qc}/answer`, { body: { choice: 2 } })]);
    const decided = J.readAll().records.filter(x => x.question_id === qc && /^question_(answer|cancel)$/.test(x.type));
    check('race: one 200, others 409', rs.filter(x => x.status === 200).length === 1 && rs.filter(x => x.status === 409).length === 2, rs.map(x => x.status).join());
    check('race: one decision record, one event, one note', decided.length === 1 && events().length === before + 1 && J.readAll().records.filter(x => x.type === 'history_note' && x.task_id === 'task-race').length === 1);
    await call('POST', `/questions/${q2.question_id}/cancel`, { body: {} });

    // ---- cap on pending
    const capStart = (await call('GET', '/questions')).json.questions.length;
    let last;
    for (let i = 0; i < 6; i++) last = await call('POST', '/questions', { body: ASK });
    check(`max_pending (5) stops asking at the cap (had ${capStart})`, last.status === 429 && (await call('GET', '/questions')).json.questions.length === 5);

    // ---- records carry the module tag; no secrets or tokens in the journal
    const mine = J.readAll().records.filter(x => /^question/.test(x.type));
    check('journal records are module-tagged', mine.length > 0 && mine.every(x => x.module === 'question-cards'));

    // ---- guard against agents
    process.env.HARNESS_TASK_ID = 'task-x';
    const g = command => M.beforeTool(reg.mods, { tool: 'Bash', ti: { command }, cwd: tmp });
    const blocked = ['taskmote question answer q-aaaaaa 1', 'node bin/harness.js question cancel q-aaaaaa', 'harness question list', 'curl http://127.0.0.1:1/m/question-cards/questions/q-aaaaaa/answer -d x'];
    let okAll = true;
    for (const c of blocked) { const h = await g(c); if (!h || h[0] !== 'question_cards') { okAll = false; console.log('  not blocked: ' + c); } }
    check('agent cannot answer, cancel, list or call the route from a task', okAll);
    check('agent may ask and get', (await g('taskmote question ask "Pick one" a b')) === null && (await g('harness question get q-aaaaaa')) === null);
    check('non-shell tools are not touched', (await M.beforeTool(reg.mods, { tool: 'Read', ti: { file_path: 'question answer' }, cwd: tmp })) === null);
    delete process.env.HARNESS_TASK_ID;
    check('outside a task the hook allows', (await g('taskmote question answer q-aaaaaa 1')) === null);
    check('status lines list pending questions', (await call('GET', '/questions')).json.questions.length === 5 && reg.mods.find(m => m.name === 'question-cards').statusLines(J, { state: { dir: path.join(STATE, 'm', 'question-cards') } }).length >= 2);
  } catch (e) { check('no exception', false, e.stack); }
  finally { try { fs.rmSync(spyDir, { recursive: true, force: true }); } catch { /* best effort */ } }

  // ---- the command, in real processes (fresh state dir, shared with nothing)
  try {
    const st2 = path.join(tmp, 'state2'), cfgFile = path.join(tmp, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ owner_name: 'Tester', modules: { 'question-cards': true }, question_cards: { timeout_minutes: 5 } }));
    const env = { ...process.env, HARNESS_CONFIG: cfgFile, HARNESS_STATE_DIR: st2, HARNESS_LOG_DIR: path.join(tmp, 'logs'), HARNESS_WORK_DIR: tmp };
    delete env.HARNESS_TASK_ID; delete env.HARNESS_NOW;
    const run = (args, extra = {}) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'question', ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
    let p = run(['ask', 'Ship it today?', 'Yes', 'Not yet', 'Ask me later', '--free'], { HARNESS_TASK_ID: 'task-cli' });
    let id = null; try { id = JSON.parse(p.stdout.trim().split('\n').pop()).question_id; } catch { /* checked below */ }
    check('cmd ask (in a task) prints the id', p.status === 0 && /^q-[0-9a-f]{24}$/.test(id), p.stdout + p.stderr);
    p = run(['ask', 'Only one', 'a']);
    check('cmd ask with 1 option exits 2', p.status === 2 && /options/.test(p.stderr));
    p = run(['get', id], { HARNESS_TASK_ID: 'task-cli' });
    check('cmd get by the asking task: pending', p.status === 0 && JSON.parse(p.stdout).state === 'pending');
    p = run(['get', id], { HARNESS_TASK_ID: 'task-other' });
    check('cmd get by another task: not found', p.status === 3);
    for (const v of ['list', 'answer', 'cancel']) {
      p = run([v, id, '1'], { HARNESS_TASK_ID: 'task-cli' });
      check(`cmd ${v} inside a task is refused (exit 6)`, p.status === 6, p.stderr);
    }
    p = run(['list']);
    check('cmd list (owner) shows it', p.status === 0 && p.stdout.includes(id) && p.stdout.includes('1) Yes') && p.stdout.includes('free text ok'), p.stdout);
    p = run(['answer', id, '3']);
    check('cmd answer by number', p.status === 0 && /answered/.test(p.stdout), p.stdout + p.stderr);
    p = run(['answer', id, '1']);
    check('cmd answer again exits 3', p.status === 3);
    p = run(['get', id], { HARNESS_TASK_ID: 'task-cli' });
    const got = JSON.parse(p.stdout);
    check('asking task sees state answered + option via get', got.state === 'answered' && got.answer.option === 'Ask me later' && got.answer.where === 'cli', p.stdout);
    p = run(['ask', 'Pick', 'x', 'y']);
    const id9 = JSON.parse(p.stdout.trim().split('\n').pop()).question_id;
    p = run(['answer', id9, 'nope']);
    check('cmd answer with a bad choice exits 3', p.status === 3);
    p = run(['answer', id9, 'Y']);
    check('cmd answer by option text, case-insensitive', p.status === 0);
    // two processes race to answer the same question
    p = run(['ask', 'Race', 'x', 'y']);
    const idr = JSON.parse(p.stdout.trim().split(String.fromCharCode(10)).pop()).question_id;
    const spawnAns = (c) => new Promise(res => { const cp = require('child_process').spawn(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'question', 'answer', idr, c], { env }); cp.on('close', code => res(code)); });
    const codes = await Promise.all([spawnAns('1'), spawnAns('2'), spawnAns('1')]);
    const ans = fs.readFileSync(path.join(st2, 'journal.jsonl'), 'utf8').split(String.fromCharCode(10)).filter(l => l.includes('"question_answer"') && l.includes(idr));
    check('cmd race: exactly one process answers, the rest exit 3', codes.filter(c => c === 0).length === 1 && codes.filter(c => c === 3).length === 2 && ans.length === 1, codes.join());
    p = run(['bogus']);
    check('cmd unknown verb prints usage, exit 2', p.status === 2 && /usage/.test(p.stderr));
    check('state dir is only the temp one', fs.existsSync(path.join(st2, 'journal.jsonl')));
  } catch (e) { check('no exception (command)', false, e.stack); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  process.exit(n === results.length ? 0 : 1);
})();
