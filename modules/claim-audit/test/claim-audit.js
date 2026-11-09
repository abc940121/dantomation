#!/usr/bin/env node
'use strict';
// claim-audit: auditReport rules, 20 seeded reports (10 honest, 10 fake) against a
// realistic fake evidence set, module-off behaviour, and an end-to-end fake-engine
// task whose audit shows up in `taskmote status`. Needs the claim-audit module
// enabled (SKIP otherwise). Runs real processes in temp dirs only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const cur = require(path.join(ROOT, 'lib', 'config')).load();
const { auditReport } = require('../audit');
const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };

if (!cur.modules['claim-audit']) {
  console.log('SKIP: claim-audit is not enabled in this config');
  process.exit(0);
}

// ---- realistic evidence: a journal and command outputs for one task
const T = 'tfake-1';
const records = [
  { id: 'r1', type: 'task_start', task_id: T, request: 'fix the login redirect' },
  { id: 'r2', type: 'step', task_id: T, step: 1, status: 'started', note: 'fix' },
  { id: 'r3', type: 'effect_intent', task_id: T, effect_id: 's1-write', kind: 'write', target: 'src/auth.js' },
  { id: 'r4', type: 'effect_done', task_id: T, effect_id: 's1-write', mode: 'fresh' },
  { id: 'r5', type: 'step', task_id: T, step: 1, status: 'done' },
  { id: 'r6', type: 'effect_intent', task_id: T, effect_id: 's2-write', kind: 'write', target: 'test/auth.test.js' },
  { id: 'r7', type: 'effect_done', task_id: T, effect_id: 's2-write', mode: 'fresh' },
  { id: 'r8', type: 'step', task_id: T, step: 3, status: 'done' },
  { id: 'r9', type: 'effect_intent', task_id: T, effect_id: 's4-push', kind: 'push', target: 'origin master' },
  { id: 'r10', type: 'effect_uncertain', task_id: T, effect_id: 's4-push' },
];
const outputs = [
  { command: 'node --test', exit: 0, text: '> node --test\nok login redirects (3ms)\nok logout clears session (1ms)\nTests: 39/39 passed\nSuites: 4 passed\n' },
  { command: 'npm run lint', exit: 0, text: 'checked 12 files\n0 problems (0 errors, 0 warnings)\n' },
  { command: 'node --test test/legacy.test.js', exit: 1, text: 'FAIL test/legacy.test.js\nTests: 37/39 passed, 2 failed\nExit code 1\n' },
  { command: 'node bin/effect.js commit', exit: 0, text: '[master 3ac78c0] fix login redirect\n 2 files changed, 14 insertions(+)\n' },
  { command: 'npm run build', exit: 0, text: 'build ok in 1.2s\n' },
];
const EV = { records, outputs, files: ['src/auth.js', 'test/auth.test.js'] };

const Q = s => `[t:"${s}"]`;
const HONEST = [
  ['single journal cite', 'Fixed the login redirect in src/auth.js [j:s1-write].'],
  ['single quote cite', `Tests pass. ${Q('Tests: 39/39 passed')}`],
  ['Chinese, two claims', `測試通過 ${Q('Tests: 39/39 passed')}。lint 沒問題 ${Q('0 problems (0 errors, 0 warnings)')}。`],
  ['several claims plus plans', `I fixed the bug [j:s1-write]. I added a regression test in test/auth.test.js [j:s2-write]. All tests pass ${Q('Tests: 39/39 passed')}. I did not touch billing yet; next I will update the docs.`],
  ['no claims at all', 'I will run the tests next. Not done yet: the docs. The earlier run failed on legacy.test.js. Should I also lint?'],
  ['commit quote with brackets', `Committed the change ${Q('[master 3ac78c0] fix login redirect')}.`],
  ['Chinese journal cites', '已完成修正 [j:s1-write]，並驗證過 [j:step3]。'],
  ['colon, build', `The build works: ${Q('build ok in 1.2s')}`],
  ['mixed Chinese and English', `登入問題已修好 [j:s1-write]. Verified by tests ${Q('Suites: 4 passed')}.`],
  ['honest about a known failure', `Two legacy tests failed and I did not fix them. The auth tests pass ${Q('Tests: 39/39 passed')}.`],
];
const FAKE = [
  ['no citation', 'All tests pass and the bug is fixed.'],
  ['nonexistent journal id', 'Fixed the redirect [j:s9-write].'],
  ['quote not in outputs', `Tests pass ${Q('Tests: 40/40 passed')}.`],
  ['cited output shows FAIL', `All tests pass ${Q('FAIL test/legacy.test.js')}.`],
  ['file never written', 'I fixed src/billing.js [j:s1-write].'],
  ['Chinese, no citation', '全部測試通過，問題已修好。'],
  ['near-miss quote 38/39', `All 39 tests pass ${Q('Tests: 38/39 passed')}.`],
  ['cited effect is UNCERTAIN', 'The push is done [j:s4-push].'],
  ['Chinese, quote not in outputs', `驗證過了 ${Q('所有測試通過')}。`],
  ['one honest claim, one bare claim', 'Fixed the redirect [j:s1-write]. Everything works.'],
];
let fakeFlagged = 0, honestFalse = 0;
const misses = [];
for (const [k, t] of FAKE) { const a = auditReport(t, EV); if (a.flagged > 0) fakeFlagged++; else misses.push(`fake missed: ${k}`); }
for (const [k, t] of HONEST) { const a = auditReport(t, EV); if (a.flagged > 0) { honestFalse++; misses.push(`honest flagged: ${k}: ${a.claims.filter(c => !c.verified).map(c => c.reason).join(' / ')}`); } }
const seeded = fakeFlagged >= 9 && honestFalse <= 1;
check(`seeded reports: fake flagged ${fakeFlagged}/10 (need >=9), honest false flags ${honestFalse}/10 (need <=1)`, seeded);
for (const m of misses) console.log('  ' + m);

// ---- rules, one at a time
const one = (t, ev = EV) => auditReport(t, ev);
const r1 = one(`Tests pass ${Q('Tests: 39/39 passed')}.`);
check('verified claim has cited=true verified=true', r1.claims.length === 1 && r1.claims[0].cited && r1.claims[0].verified && r1.flagged === 0);
const r2 = one('Everything is done.');
check('uncited claim: cited=false, flagged, reason "no citation"', r2.claims[0] && !r2.claims[0].cited && !r2.claims[0].verified && r2.claims[0].reason === 'no citation' && r2.flagged === 1);
const NOTCLAIMS = ['I will test it.', 'Not done yet.', 'The tests failed.', 'The fix is not finished.', 'Did the tests pass?', 'I have not verified the build.', '還沒完成。', '測試失敗了。', '我會再測試。', 'This should work after the merge.'];
const nc = NOTCLAIMS.filter(t => one(t).claims.length > 0);
check('non-claims are not claims (English and Chinese)', nc.length === 0, nc.join(' | '));
const CLAIMS = ['Done.', 'The bug is fixed.', 'It has been tested.', 'All green.', 'The build passed.', 'It works.', '完成。', '已修好。', '測試通過。', '驗證過了。', '沒問題。', 'No failures, all tests passed.'];
const cl = CLAIMS.filter(t => one(t).claims.length !== 1);
check('claim sentences are claims (English and Chinese)', cl.length === 0, cl.join(' | '));
check('empty and non-string input give no claims', [one(''), one(null), one(undefined)].every(a => a.claims.length === 0 && a.flagged === 0));
check('citation on its own after the period still attaches', one(`All tests pass. ${Q('Tests: 39/39 passed')}`).flagged === 0);
check('exit 1 output cited for a pass claim is a contradiction', one(`Tests pass ${Q('Tests: 37/39 passed, 2 failed')}.`).flagged === 1);
check('claim fraction differing from the quote is flagged', one(`All 38/38 tests pass ${Q('Tests: 39/39 passed')}.`).flagged === 1);
check('wrong step id and not-done step are flagged', one('Done [j:step7].').flagged === 1 && one('Done [j:step2].').flagged === 1);
check('journal record id (not effect id) is accepted', one('Done [j:r5].').flagged === 0);
check('every citation in a claim must hold (one bad of two)', one(`Fixed and tested [j:s1-write] ${Q('Tests: 99/99 passed')}.`).flagged === 1);

// ---- processes: module off vs on, end to end
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-audit-'));
const stream = path.join(tmp, 'stream.jsonl');
const j = o => JSON.stringify(o) + '\n';
fs.writeFileSync(stream,
  j({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'node --test' } }] } }) +
  j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '> node --test\nTests: 39/39 passed\n' }] } }) +
  j({ type: 'result', result: 'All tests pass [t:"Tests: 39/39 passed"]. The output file is done [j:s1-write]. The bug is fixed. Next I will update the docs.' }));

function run(on) {
  const dir = path.join(tmp, on ? 'on' : 'off');
  fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ owner_name: 'Tester', modules: { ...cur.modules, 'claim-audit': on } }));
  const env = { ...process.env, HARNESS_CONFIG: cfg, HARNESS_STATE_DIR: path.join(dir, 'state'), HARNESS_LOG_DIR: path.join(dir, 'logs'),
    HARNESS_WORK_DIR: path.join(dir, 'work'), HARNESS_ENGINE_SCRIPT: path.join(ROOT, 'test', 'fake-engine.js'), HARNESS_FAKE_DELAY_MS: '0', HARNESS_FAKE_STREAM: stream };
  delete env.HARNESS_OWNER; delete env.HARNESS_TASK_ID; delete env.HARNESS_TASK_DIR; delete env.HARNESS_FAKE_GUARD;
  const s = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'taskmote.js'), 'do', 'claim audit task'], { env, encoding: 'utf8', timeout: 60000 });
  const st = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'taskmote.js'), 'status'], { env, encoding: 'utf8', timeout: 60000 });
  let recs = [];
  try { recs = fs.readFileSync(path.join(dir, 'state', 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { /* none */ }
  return { s, status: st.stdout, recs, types: recs.map(r => r.type) };
}
const off = run(false), on = run(true);
check('module off: task finishes, no claim_audit record, no claims line in status',
  off.s.status === 0 && off.types.includes('task_done') && !off.types.includes('claim_audit') && !/claims:/.test(off.status), `exit ${off.s.status}, journal ${off.types.join('>')}`);
const strip = t => t.filter(x => x !== 'claim_audit').join('>');
check('module on: same journal sequence plus one claim_audit', on.s.status === 0 && strip(on.types) === strip(off.types) && on.types.filter(x => x === 'claim_audit').length === 1, `exit ${on.s.status}`);
const rec = on.recs.find(r => r.type === 'claim_audit') || {};
check('audit ran at task end: 3 claims checked, 1 unverified (the bare "bug is fixed")', rec.checked === 3 && rec.unverified === 1 && rec.flagged && /bug is fixed/.test(rec.flagged[0].text), JSON.stringify({ checked: rec.checked, unverified: rec.unverified }));
check('audit record is small (counts, hash, flagged sentences only)', JSON.stringify(rec).length < 800 && !JSON.stringify(rec).includes('node --test'), `${JSON.stringify(rec).length} bytes`);
check('status shows "claims: 3 checked, 1 unverified" and the sentence', /claims: 3 checked, 1 unverified/.test(on.status) && /unverified: "The bug is fixed\./.test(on.status), on.status.split('\n').filter(l => /claims|unverified/.test(l)).join(' | '));
check('audit never fails the task (task_done present with unverified claims)', on.types.includes('task_done'));

fs.rmSync(tmp, { recursive: true, force: true });
const n = results.filter(Boolean).length;
console.log(`\nresult: ${n}/${results.length}`);
process.exit(n === results.length ? 0 : 1);
