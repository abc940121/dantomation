#!/usr/bin/env node
'use strict';
// approval-cards: parseAnswer is strict; a risky call stops with a card, a clear yes
// approves exactly that input once, a changed input needs a new card, no and timeout
// deny, a crash before the answer keeps the one pending card, guard-base hard blocks
// stay hard blocks. Needs the approval-cards module enabled (SKIP otherwise).
// The guard hook and the dantomation verbs run as real processes; HARNESS_NOW is the clock seam.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GUARD = path.join(ROOT, 'guards', 'guard.js');
const DANT = path.join(ROOT, 'bin', 'dantomation.js');
const cur = require(path.join(ROOT, 'lib', 'config')).load();
const { parseAnswer } = require('..');
const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };

// ---- parseAnswer: pure, runs whether or not the module is on
const AMBIGUOUS = ['maybe', 'I guess', 'probably', 'sure, why not', 'let me think', 'not sure', 'whatever', 'hmm', 'later', 'ok but wait',
  'yes but not now', 'yes, but only the first one', 'yeah right', 'yes?', 'is that ok', 'can you do it', 'yes no', 'no yes', 'do not approve', 'not ok', 'yes (no)',
  '好像可以吧', '嗯', '等一下', '我再想想', '不知道', '可以嗎', '好但是不要現在', '不要好', '好吧?', '', '   ', '...', '12345'];
const yesCount = AMBIGUOUS.filter(t => parseAnswer(t) === 'yes').length;
const leaked = AMBIGUOUS.filter(t => parseAnswer(t) === 'yes');
check(`ambiguous answers give 0 yes (${AMBIGUOUS.length} tried)`, yesCount === 0, `yes count ${yesCount}${leaked.length ? ' leaked: ' + JSON.stringify(leaked) : ''}`);
check('ambiguous answers are all "unclear", none read as no either', AMBIGUOUS.every(t => parseAnswer(t) === 'unclear'));
const YES = ['yes', 'Yes', 'y', 'Y', 'ok', 'OK!', 'okay', 'approve', 'yeah', 'yess', 'yes please', '是', '好', '可以', '確定', '同意', '好的', '是的', ' yes. '];
check('clear yes answers are yes (English and Chinese)', YES.every(t => parseAnswer(t) === 'yes'), YES.filter(t => parseAnswer(t) !== 'yes').join(' | '));
const NO = ['no', 'No', 'n', 'nope', 'deny', 'stop', 'cancel', 'no!', '不要', '不', '否', '取消', '不行', '拒絕'];
check('clear no answers are no (English and Chinese)', NO.every(t => parseAnswer(t) === 'no'), NO.filter(t => parseAnswer(t) !== 'no').join(' | '));
check('non-strings are unclear', [null, undefined, 5, {}, ['yes']].every(v => parseAnswer(v) === 'unclear'));

if (!cur.modules['approval-cards']) {
  console.log('SKIP: approval-cards is not enabled in this config (only the parseAnswer checks above ran)');
  const n0 = results.filter(Boolean).length;
  console.log(`\nresult: ${n0}/${results.length}`);
  process.exit(n0 === results.length ? 0 : 1);
}

// ---- the flow
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cards-'));
const state = path.join(tmp, 'state'), logs = path.join(tmp, 'logs'), work = path.join(tmp, 'work');
fs.mkdirSync(work, { recursive: true });
const cfgFile = path.join(tmp, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ owner_name: 'Tester', modules: cur.modules,
  approval_cards: { timeout_minutes: 10, risky: [{ id: 'deploy', match: 'shell', pattern: '\\bdeploy-site\\b', summary: 'deploys the site' }] } }));
const T0 = Date.parse('2030-01-01T00:00:00Z');
const base = { ...process.env, HARNESS_CONFIG: cfgFile, HARNESS_STATE_DIR: state, HARNESS_LOG_DIR: logs, HARNESS_WORK_DIR: work,
  HARNESS_ENGINE_SCRIPT: path.join(ROOT, 'test', 'fake-engine.js'), HARNESS_FAKE_DELAY_MS: '0', HARNESS_NOW: String(T0) };
delete base.HARNESS_OWNER; delete base.HARNESS_TASK_ID; delete base.HARNESS_TASK_DIR; delete base.HARNESS_FAKE_GUARD;
const jfile = path.join(state, 'journal.jsonl');
const jadd = rec => { fs.mkdirSync(state, { recursive: true }); fs.appendFileSync(jfile, JSON.stringify({ id: 'x' + Math.random(), ts: new Date(T0).toISOString(), ...rec }) + '\n'); };
const records = () => fs.existsSync(jfile) ? fs.readFileSync(jfile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const cards = () => records().filter(r => r.type === 'card');
const startTask = id => jadd({ type: 'task_start', task_id: id, request: 'cards test', workdir: work });
const hook = (command, task, env = {}, tool = 'Bash', ti) => spawnSync(process.execPath, [GUARD], {
  input: JSON.stringify({ session_id: 's', tool_name: tool, tool_input: ti || { command }, cwd: work }),
  env: { ...base, HARNESS_TASK_ID: task, HARNESS_TASK_DIR: work, ...env }, encoding: 'utf8' });
const dant = (args, env = {}) => spawnSync(process.execPath, [DANT, ...args], { cwd: ROOT, env: { ...base, ...env }, encoding: 'utf8', timeout: 120000 });
const CMD = 'git push origin main';
const cardId = r => (r.stderr.match(/card-[0-9a-f]{6}/) || [])[0];

startTask('t1');
// 1. risky call stops with a card; safe calls untouched
const safe = hook('git status', 't1');
check('a safe command passes', safe.status === 0, `exit ${safe.status}`);
const r1 = hook(CMD, 't1');
const id1 = cardId(r1);
check('git push is blocked with "waiting for approval card <id>; stop and end your turn"', r1.status === 2 && /waiting for approval card card-[0-9a-f]{6}/.test(r1.stderr) && /end your turn/.test(r1.stderr), r1.stderr.trim().slice(0, 110));
const c1 = cards()[0] || {};
check('the card has id, task, tool, exact input, sha256, summary, created_at, expires_at',
  c1.card_id === id1 && c1.task_id === 't1' && c1.tool === 'Bash' && c1.input && c1.input.command === CMD && /^[0-9a-f]{64}$/.test(c1.sha256) && c1.summary && c1.created_at && Date.parse(c1.expires_at) - Date.parse(c1.created_at) === 600000,
  JSON.stringify({ id: c1.card_id, expires_in_min: (Date.parse(c1.expires_at) - Date.parse(c1.created_at)) / 60000 }));
check('the card is mirrored to state/cards/<id>.json', fs.existsSync(path.join(state, 'cards', id1 + '.json')));
const again = hook(CMD, 't1');
check('the same call while pending reuses the card (no duplicate)', again.status === 2 && cardId(again) === id1 && cards().length === 1);

// 2. crash between card creation and the answer: nothing in memory, a fresh process finds the card pending
const st1 = dant(['status']);
check('status (a fresh process) lists the pending card with how to answer', /approval card .* is waiting/.test(st1.stdout) && st1.stdout.includes(id1) && /do yes/.test(st1.stdout), st1.stdout.split('\n').filter(l => /card/.test(l))[0]);
check('after the "crash" there is still exactly one card', cards().length === 1);
const wait = dant(['do']);
check('do with no answer does not resume while the card is pending', wait.status === 3 && /waiting for your answer/.test(wait.stdout) && !records().some(r => r.type === 'task_done'), wait.stdout.split('\n')[0]);

// 3. unclear answers never approve
const u = dant(['do', 'maybe']);
check('an unclear answer keeps the card pending and says so', u.status === 3 && /unclear/.test(u.stdout) && /nothing was approved/.test(u.stdout));
const u2 = dant(['do', 'yes but not now']);
check('"yes but not now" is unclear too; status says the answer was unclear', u2.status === 3 && /unclear/.test(dant(['status']).stdout));
check('unclear answers did not approve: the call is still blocked', hook(CMD, 't1').status === 2 && !records().some(r => r.type === 'card_answer' && (r.answer === 'yes' || r.answer === 'no')));

// 4. a clear yes approves exactly that input, once
const y = dant(['do', 'yes']);
check('"do yes" approves the pending card and resumes the task (task done)', y.status === 0 && /approved card/.test(y.stdout) && records().some(r => r.type === 'task_done' && r.task_id === 't1'), `exit ${y.status} ${y.stdout.split('\n')[0]}`);
const prompt = (() => { // the resume prompt the agent saw
  const j = records(); return j.filter(r => r.type === 'history_note' && r.task_id === 't1').map(r => r.note).join('\n'); })();
check('the resumed agent is told it was approved', /APPROVED/.test(prompt) && prompt.includes(id1));
jadd({ type: 'task_start', task_id: 't2', request: 'cards test 2', workdir: work });
// t1 is done; the approval belongs to task t1. Re-open the scenario inside t1 by calling as t1 (hooks only need the env)
const changed = hook('git push origin other-branch', 't1');
check('a changed input is not approved (needs its own new card)', changed.status === 2 && cardId(changed) && cardId(changed) !== id1 && cards().length === 2);
const pass1 = hook(CMD, 't1');
check('the identical call passes once', pass1.status === 0, `exit ${pass1.status} ${pass1.stderr.trim().slice(0, 80)}`);
check('the card is marked used', records().some(r => r.type === 'card_used' && r.card_id === id1));
const pass2 = hook(CMD, 't1');
check('a second identical call needs a new card', pass2.status === 2 && cardId(pass2) && cardId(pass2) !== id1 && cards().length === 3);

// 5. a clear no denies
fs.writeFileSync(jfile, ''); fs.rmSync(path.join(state, 'cards'), { recursive: true, force: true });
startTask('t3');
const r3 = hook('npm install left-pad', 't3');
const n = dant(['do', 'no']);
check('"do no" denies the card; the resumed agent is told', n.status === 0 && /denied card/.test(n.stdout) && records().some(r => r.type === 'card_answer' && r.answer === 'no') && records().some(r => r.type === 'history_note' && /DENIED/.test(r.note)), n.stdout.split('\n')[0]);
check('after a no, the same call is not approved (a fresh card, still blocked)', hook('npm install left-pad', 't3').status === 2);

// 6. timeout is no
fs.writeFileSync(jfile, ''); fs.rmSync(path.join(state, 'cards'), { recursive: true, force: true });
startTask('t4');
const r4 = hook(CMD, 't4');
const id4 = cardId(r4);
const late = { HARNESS_NOW: String(T0 + 11 * 60000) };
check('before the deadline status shows it waiting', /is waiting/.test(dant(['status'], { HARNESS_NOW: String(T0 + 9 * 60000) }).stdout));
const lateYes = dant(['do', 'yes'], late);
const j4 = records();
check('an answer after the deadline does not approve (card expired, counts as no)', !j4.some(r => r.card_id === id4 && r.answer === 'yes') && j4.some(r => r.card_id === id4 && r.type === 'card_answer' && r.answer === 'timeout'), lateYes.stdout.split('\n')[0]);
const note4 = j4.filter(r => r.type === 'history_note').map(r => r.note).join('\n');
check('the resumed agent is told "denied (timeout)"', /denied \(timeout\)/.test(note4));
check('the expired card does not approve a retry', hook(CMD, 't4', late).status === 2);

// 7. other rules and extension
fs.writeFileSync(jfile, ''); fs.rmSync(path.join(state, 'cards'), { recursive: true, force: true });
startTask('t5');
const blocked = c => hook(c, 't5', {}, 'Bash').status === 2 && /approval card/.test(hook(c, 't5').stderr);
check('pip/winget installs, gh release, npm publish each ask', ['pip install requests', 'winget install Foo.Bar', 'gh release create v1', 'npm publish', 'gh repo create x'].every(blocked));
check('a paid API call by URL asks (shell and fetch tool)', blocked('curl https://api.openai.com/v1/chat/completions') && hook('', 't5', {}, 'WebFetch', { url: 'https://api.anthropic.com/v1/messages' }).status === 2);
check('a rule added in config (deploy-site) asks', blocked('deploy-site --prod'));
check('rm inside the task folder passes; rm outside asks', hook('rm notes.txt', 't5').status === 0 && hook('rm ../elsewhere/notes.txt', 't5').status === 2 && hook('rm /etc/hosts', 't5').status === 2);
check('ordinary commands (ls, node script, git commit) pass', ['ls', 'node build.js', 'git commit -m x', 'npm test'].every(c => hook(c, 't5').status === 0));
check('an agent cannot answer a card (guard blocks the spelling)', ['node bin/dantomation.js do yes', 'dantomation do "yes card-abc123"', 'node bin/harness.js answer yes'].every(c => { const r = hook(c, 't5'); return r.status === 2; }));
const selfAnswer = dant(['do', 'yes'], { HARNESS_TASK_ID: 't5' });
check('the answer verb refuses inside an engine (HARNESS_TASK_ID set)', selfAnswer.status === 6 && /not by agents/.test(selfAnswer.stderr));
check('outside an engine (no HARNESS_TASK_ID) the hook does not ask', spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ session_id: 's', tool_name: 'Bash', tool_input: { command: CMD }, cwd: work }), env: base, encoding: 'utf8' }).status === 0);

// 8. guard-base hard blocks stay hard blocks
if (cur.modules['guard-base']) {
  const before = cards().length;
  const f = hook('git push --force origin main', 't5');
  check('a guard-base hard block stays a hard block (no card made)', f.status === 2 && !/approval card/.test(f.stderr) && /BLOCKED \(delete\)/.test(f.stderr) && cards().length === before, f.stderr.trim().slice(0, 90));
} else console.log('SKIP: guard-base is off, so the hard-block-first check does not run');

// 9. module off: behaviour unchanged
const offCfg = path.join(tmp, 'off.json');
fs.writeFileSync(offCfg, JSON.stringify({ owner_name: 'Tester', modules: { ...cur.modules, 'approval-cards': false }, approval_cards: { timeout_minutes: 10 } }));
const offEnv = { HARNESS_CONFIG: offCfg };
const nCards = cards().length;
const offPush = hook(CMD, 't5', offEnv);
const offDo = dant(['do', 'yes'], offEnv);
const offStatus = dant(['status'], offEnv);
check('with the module off: git push is not held, "do yes" is just a request refused as before, status has no card lines',
  offPush.status === 0 && !/approval card/.test(offStatus.stdout) && cards().length === nCards, `push exit ${offPush.status}`);
check('with the module off: do "<request>" with an open task still refuses; no card record is written', offDo.status !== 0 && /still open/.test(offDo.stdout + offDo.stderr) && cards().length === nCards);

const nOk = results.filter(Boolean).length;
console.log(`\nresult: ${nOk}/${results.length}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(nOk === results.length ? 0 : 1);
