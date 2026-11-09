#!/usr/bin/env node
'use strict';
// evidence (claim-audit): family check, question generation, answer citation check,
// the task.end flow in-process (flag event, refusal, pending, answered), prepareTurn,
// and an end-to-end fake-engine task with a reviewer configured. Temp dirs only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const cur = require(path.join(ROOT, 'lib', 'config')).load();
const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
if (!cur.modules['claim-audit']) { console.log('SKIP: claim-audit is not enabled in this config'); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'inproc-state');
const J = require(path.join(ROOT, 'lib', 'journal'));
const mod = require('../index');
const { familyOf, checkDifferent } = require('../family');
const I = require('../interrogate');
const { checkCitations } = require('../audit');

(async () => {
  // ---- family
  check('families: claude / openai / deepseek / gemini', familyOf('claude-sonnet-4') === 'claude' && familyOf('gpt-5') === 'openai' && familyOf('deepseek-v3') === 'deepseek' && familyOf('gemini-2.5-pro') === 'gemini');
  check('unknown name is unknown', familyOf('my-local-thing') === 'unknown' && familyOf('') === 'unknown');
  check('same family refused', !checkDifferent('opus', 'claude').ok && /both claude/.test(checkDifferent('opus', 'claude').reason));
  check('unknown reviewer refused', !checkDifferent('my-local-thing', 'claude').ok);
  check('unknown worker refused', !checkDifferent('gpt-5', '').ok);
  check('different family accepted', checkDifferent('gpt-5', 'claude').ok);

  // ---- questions
  const claims = [
    { text: 'All tests pass.', verified: true },
    { text: 'The bug is fixed.', verified: false, reason: 'no citation' },
    { text: 'The deploy to production is done [j:s1-write].', verified: true },
    { text: 'The docs are done.', verified: false, reason: 'no citation' },
    { text: 'Lint is clean.', verified: true },
  ];
  const qs = I.makeQuestions(claims);
  check('at most 3 questions; flagged first', qs.length === 3 && qs[0].why === 'flagged' && qs[1].why === 'flagged' && qs[2].why === 'high-stakes', qs.map(q => q.why).join(','));
  check('question wording: "Which line shows"', /^Which line shows that "The bug is fixed\."\?$/.test(qs[0].q), qs[0].q);
  check('citations stripped from the question', !/\[j:/.test(qs[2].q), qs[2].q);
  const one = I.makeQuestions([{ text: 'The bug is fixed.', verified: false }]);
  check('one claim still yields 3 short questions', one.length === 3 && new Set(one.map(q => q.q)).size === 3);
  check('no flagged and no high-stakes claim: no questions', I.makeQuestions([{ text: 'All tests pass.', verified: true }]).length === 0);
  check('high-stakes word list is configurable', I.makeQuestions([{ text: 'Lint is clean.', verified: true }], ['lint']).length === 3);

  // ---- answer citation check
  const T = 'tev-1';
  const ev = { records: [{ id: 'r1', type: 'effect_done', effect_id: 's1-write', task_id: T }], outputs: [{ text: 'Tests: 5/5 passed\n', exit: 0 }], files: [] };
  check('answer with real journal cite is supported', checkCitations('see [j:s1-write]', ev).ok);
  check('answer with real quote is supported', checkCitations('[t:"Tests: 5/5 passed"]', ev).ok);
  check('answer with invented quote is not supported', !checkCitations('[t:"Tests: 9/9 passed"]', ev).ok);
  check('answer with no citation is not supported', checkCitations('trust me', ev).cited === 0 && !checkCitations('trust me', ev).ok);

  // ---- task.end in-process
  const events = [];
  const mkCtx = settings => ({
    settings: { ask_to_cite: true, reviewer_engine: '', worker_model: 'claude', high_stakes_words: I.DEFAULT_STAKES, ...settings },
    state: { dir: path.join(tmp, 'mstate'), append: r => J.append({ ...r, module: 'claim-audit' }) },
    emit: async (e, p) => { events.push([e, p]); },
  });
  const seed = (id, result) => {
    J.append({ type: 'task_start', task_id: id });
    J.append({ type: 'effect_done', task_id: id, effect_id: 's1-write' });
    fs.mkdirSync(J.STATE, { recursive: true });
    fs.writeFileSync(path.join(J.STATE, `engine-${id}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'npm test' } }] } }) + '\n' +
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'Tests: 5/5 passed\n' }] } }) + '\n' +
      JSON.stringify({ type: 'result', result }) + '\n');
  };
  const rep = 'The bug is fixed. Tests pass [t:"Tests: 5/5 passed"]. The migration is done.';
  const lastQ = id => J.readAll().records.filter(r => r.type === 'claim_interrogation' && r.task_id === id).pop();

  seed('t-off', rep);
  await mod.on['task.end']({ task_id: 't-off' }, mkCtx({}));
  const audit = J.readAll().records.find(r => r.type === 'claim_audit' && r.task_id === 't-off');
  check('flagged report: audit record and claim-audit.flagged event', audit && audit.unverified === 2 && events.some(([e, p]) => e === 'claim-audit.flagged' && p.unverified === 2 && p.task_id === 't-off'));
  check('no reviewer set: no interrogation', !lastQ('t-off'));
  check('status shows the flagged lines', mod.statusLines(J).some(l => /claims: 3 checked, 2 unverified/.test(l)));

  seed('t-same', rep);
  await mod.on['task.end']({ task_id: 't-same' }, mkCtx({ reviewer_engine: 'claude-opus' }));
  check('same-family reviewer refused, zero questions', lastQ('t-same') && lastQ('t-same').status === 'refused' && lastQ('t-same').questions === 0);
  check('refusal shown in status', mod.statusLines(J).some(l => /interrogation: refused \(reviewer and worker are both claude\)/.test(l)));

  seed('t-pend', rep);
  await mod.on['task.end']({ task_id: 't-pend' }, mkCtx({ reviewer_engine: 'gpt-5' }));
  const stored = I.load(path.join(tmp, 'mstate'), 't-pend');
  check('different family, no engine client: pending_engine with 3 stored questions', lastQ('t-pend').status === 'pending_engine' && stored.questions.length === 3 && stored.reviewer_family === 'openai');
  check('journal record carries no question text', !JSON.stringify(lastQ('t-pend')).includes('Which line'));

  // answers through the client seam
  let sent = null;
  mod.api.setReviewerClient(async ({ engine, questions }) => { sent = { engine, questions }; return ['[t:"Tests: 5/5 passed"]', 'it just works', '[j:s1-write]']; });
  seed('t-ans', rep);
  await mod.on['task.end']({ task_id: 't-ans' }, mkCtx({ reviewer_engine: 'gpt-5' }));
  const ans = I.load(path.join(tmp, 'mstate'), 't-ans');
  check('client got engine and 3 questions', sent && sent.engine === 'gpt-5' && sent.questions.length === 3 && sent.questions[0].q.startsWith('Which line shows'));
  check('answers stored: 2 supported, 1 uncited', ans.status === 'answered' && ans.answers.filter(a => a.supported).length === 2 && ans.answers[1].cited === 0);
  check('status shows answered counts', mod.statusLines(J).some(l => /interrogation: answered \(3 questions, 3 answered, 2 supported\)/.test(l)));

  mod.api.setReviewerClient(async () => { throw new Error('engine down'); });
  seed('t-err', rep);
  await mod.on['task.end']({ task_id: 't-err' }, mkCtx({ reviewer_engine: 'gpt-5' }));
  check('engine failure: engine_error, task end still returns', lastQ('t-err').status === 'engine_error');
  mod.api.setReviewerClient(null);

  seed('t-clean', 'Tests pass [t:"Tests: 5/5 passed"].');
  await mod.on['task.end']({ task_id: 't-clean' }, mkCtx({ reviewer_engine: 'gpt-5' }));
  check('clean low-stakes report: no interrogation', !lastQ('t-clean'));

  seed('t-stakes', 'The deploy to production is done [j:s1-write].');
  await mod.on['task.end']({ task_id: 't-stakes' }, mkCtx({ reviewer_engine: 'gpt-5' }));
  check('verified high-stakes claim is questioned', lastQ('t-stakes') && lastQ('t-stakes').status === 'pending_engine');

  // ---- prepareTurn
  const pt = mod.prepareTurn({ task_id: 't-off', resumed: false, settings: { ask_to_cite: true } });
  check('prepareTurn asks to cite', pt && pt.context.length === 1 && /\[j:/.test(pt.context[0]));
  const pr = mod.prepareTurn({ task_id: 't-off', resumed: true, settings: { ask_to_cite: true } });
  check('prepareTurn on resume mentions the 2 flagged claims', pr.context.length === 2 && /2 claim/.test(pr.context[1]));
  check('ask_to_cite false: no context', mod.prepareTurn({ task_id: 't-off', resumed: true, settings: { ask_to_cite: false } }) === null);

  // ---- end to end, real processes
  const stream = path.join(tmp, 'stream.jsonl');
  fs.writeFileSync(stream,
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'node --test' } }] } }) + '\n' +
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Tests: 39/39 passed\n' }] } }) + '\n' +
    JSON.stringify({ type: 'result', result: 'The bug is fixed. All tests pass [t:"Tests: 39/39 passed"].' }) + '\n');
  const e2e = (name, section) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ owner_name: 'Tester', modules: { ...cur.modules, 'claim-audit': true }, claim_audit: section }));
    const env = { ...process.env, HARNESS_CONFIG: cfg, HARNESS_STATE_DIR: path.join(dir, 'state'), HARNESS_LOG_DIR: path.join(dir, 'logs'),
      HARNESS_WORK_DIR: path.join(dir, 'work'), HARNESS_ENGINE_SCRIPT: path.join(ROOT, 'test', 'fake-engine.js'), HARNESS_FAKE_DELAY_MS: '0', HARNESS_FAKE_STREAM: stream };
    delete env.HARNESS_OWNER; delete env.HARNESS_TASK_ID; delete env.HARNESS_TASK_DIR; delete env.HARNESS_FAKE_GUARD;
    const run = a => spawnSync(process.execPath, [path.join(ROOT, 'bin', /^claim-/.test(a[0]) ? 'harness.js' : 'dantomation.js'), ...a], { env, encoding: 'utf8', timeout: 60000 });
    const s = run(['do', 'evidence task']);
    const st = run(['status']);
    let recs = [];
    try { recs = fs.readFileSync(path.join(dir, 'state', 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { /* none */ }
    return { s, status: st.stdout, recs, run };
  };
  const a = e2e('e2e-on', { reviewer_engine: 'gpt-5' });
  const aq = a.recs.find(r => r.type === 'claim_interrogation');
  check('e2e: task completes with a reviewer set', a.s.status === 0 && a.recs.some(r => r.type === 'task_done'), `exit ${a.s.status}`);
  check('e2e: interrogation pending_engine with 3 questions', aq && aq.status === 'pending_engine' && aq.questions === 3, JSON.stringify(aq));
  check('e2e: status shows interrogation line', /interrogation: pending_engine \(3 questions\)/.test(a.status));
  const tid = aq && aq.task_id;
  const q = a.run(['claim-questions', tid]);
  check('e2e: claim-questions prints the stored questions', /Which line shows that \\"The bug is fixed\.\\"\?|Which line shows that "The bug is fixed\."\?/.test(q.stdout), q.stdout.slice(0, 80));
  const r = a.run(['claim-answer', tid, '[t:"Tests: 39/39 passed"]', 'because', '[j:nope]']);
  check('e2e: claim-answer records answers (1 supported)', /recorded 3 answers \(1 supported\)/.test(r.stdout), r.stdout.trim() + r.stderr.slice(0, 100));
  const b = e2e('e2e-off', {});
  check('e2e: no reviewer set: audit only, no interrogation', b.recs.some(r => r.type === 'claim_audit') && !b.recs.some(r => r.type === 'claim_interrogation'));

  fs.rmSync(tmp, { recursive: true, force: true });
  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  process.exit(n === results.length ? 0 : 1);
})().catch(e => { console.log('FAIL crashed: ' + (e && e.stack || e)); process.exit(1); });
