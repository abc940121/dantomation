#!/usr/bin/env node
'use strict';
// change-card: off by default, dependencies, card text and counts, Keep, Undo, no answer, journal.
// In-process, temp state dir and temp task folder, no network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'change-card-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state'); // before the journal is required
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const OWNER = { kind: 'owner', id: '' };
const MINUS = '−';
const ON = { modules: { checkpoint: true, 'question-cards': true, 'change-card': true } };

const w = (dir, name, text) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); };
const r = (dir, name) => { try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch { return null; } };
const cards = () => J.readAll().records.filter(x => x.kind === 'change-card');

(async () => {
  try {
    // ---- off by default and dependencies
    const off = M.registry({ modules: { 'change-card': false } });
    check('off: nothing registered', off.errors.length === 0 && off.settingsFor('change-card') === null);
    const none = M.registry({ modules: {} });
    check('absent from config: not loaded', none.errors.length === 0 && none.settingsFor('change-card') === null);
    const noCk = M.registry({ modules: { 'question-cards': true, 'change-card': true } });
    check('checkpoint off: load error names it', noCk.errors.some(e => /change-card/.test(e) && /checkpoint/.test(e)) && noCk.settingsFor('change-card') === null, noCk.errors.join(' | '));
    const noQc = M.registry({ modules: { checkpoint: true, 'change-card': true } });
    check('question-cards off: load error names it', noQc.errors.some(e => /change-card/.test(e) && /question-cards/.test(e)) && noQc.settingsFor('change-card') === null, noQc.errors.join(' | '));

    const reg = M.registry(ON);
    check('on: loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    check('min_files defaults to 1', reg.settingsFor('change-card').min_files === 1);
    const ck = reg.api('checkpoint');
    const call = (method, p, body) => reg.callRoute(reg.findRoute(method, '/m/question-cards' + p), { actor: OWNER, body, query: {} });
    const pending = async () => (await call('GET', '/questions')).json.questions;
    const end = (task, dir) => M.emit(reg.mods, 'task.end', { task_id: task, code: 0, workdir: dir });
    const settle = async fn => { for (let i = 0; i < 50; i++) { if (fn()) return true; await new Promise(s => setTimeout(s, 20)); } return fn(); };
    const answer = async (id, choice) => { const a = await call('POST', `/questions/${id}/answer`, { choice }); await settle(() => cards().some(x => x.question_id === id && x.answer !== 'pending')); return a; };

    // ---- 0 changes: no card
    const d0 = path.join(tmp, 'w0'); w(d0, 'a.txt', 'one\n');
    await end('t0', d0);
    check('task without any snapshot: no card', (await pending()).length === 0 && cards().length === 0);
    ck.checkpoint('t0', d0, 'Write'); // snapshot, then nothing changes
    await end('t0', d0);
    check('0 files changed: no card, no journal line', (await pending()).length === 0 && cards().length === 0);

    // ---- card text and counts
    const d1 = path.join(tmp, 'w1');
    w(d1, 'a.txt', 'l1\nl2\nl3\n'); w(d1, 'b.txt', 'keep me\n'); w(d1, 'gone.txt', 'x\ny\n');
    ck.checkpoint('t1', d1, 'Write');
    w(d1, 'a.txt', 'l1\nL2\nl3\nl4\n'); // +2 -1
    w(d1, 'new.txt', 'n1\nn2\nn3\n');   // +3
    fs.rmSync(path.join(d1, 'gone.txt')); // -2
    ck.checkpoint('t1', d1, 'Edit');
    w(d1, 'a.txt', 'l1\nL2\nl3\nl4\nl5\n'); // later change in the same task: a.txt now +3 -1
    await end('t1', d1);
    let q = await pending();
    check('one card raised', q.length === 1 && q[0].task_id === 't1', JSON.stringify(q));
    const want = `Task t1 changed 3 files (+6 ${MINUS}3): a.txt, gone.txt, new.txt`;
    check('card text and +/- counts', q[0] && q[0].text === want, q[0] && q[0].text);
    check('card options are Keep and Undo', q[0] && q[0].options.join() === 'Keep,Undo');
    check('journal line when raised', cards().length === 1 && cards()[0].task_id === 't1' && cards()[0].files === 3 && cards()[0].added === 6 && cards()[0].removed === 3 && cards()[0].answer === 'pending', JSON.stringify(cards()));

    // ---- unanswered: nothing happens
    const before = [r(d1, 'a.txt'), r(d1, 'new.txt'), r(d1, 'gone.txt')].join('|');
    await new Promise(s => setTimeout(s, 100));
    check('unanswered card changes nothing', [r(d1, 'a.txt'), r(d1, 'new.txt'), r(d1, 'gone.txt')].join('|') === before && (await pending()).length === 1 && cards().length === 1);

    // ---- Keep leaves files
    await answer(q[0].question_id, 1);
    check('Keep: files stay as they are', r(d1, 'new.txt') === 'n1\nn2\nn3\n' && r(d1, 'gone.txt') === null && r(d1, 'a.txt') === 'l1\nL2\nl3\nl4\nl5\n');
    check('Keep: journal line', cards().some(x => x.task_id === 't1' && x.answer === 'keep' && x.files === 3 && x.added === 6 && x.removed === 3), JSON.stringify(cards()));

    // ---- Undo restores the pre-task state, deletes added files
    const d2 = path.join(tmp, 'w2');
    w(d2, 'a.txt', 'orig\n'); w(d2, 'del.txt', 'bye\n'); w(d2, 'sub/c.txt', 'c\n');
    ck.checkpoint('t2', d2, 'Write');
    w(d2, 'a.txt', 'changed\n'); w(d2, 'added.txt', 'added\n'); w(d2, 'sub/added2.txt', 'a2\n'); fs.rmSync(path.join(d2, 'del.txt'));
    await end('t2', d2);
    q = (await pending()).filter(x => x.task_id === 't2');
    check('undo case: card raised', q.length === 1 && /^Task t2 changed 4 files/.test(q[0].text), q[0] && q[0].text);
    await answer(q[0].question_id, 2);
    check('Undo: edited file restored', r(d2, 'a.txt') === 'orig\n');
    check('Undo: deleted file back', r(d2, 'del.txt') === 'bye\n');
    check('Undo: files the task added are removed', r(d2, 'added.txt') === null && r(d2, 'sub/added2.txt') === null && r(d2, 'sub/c.txt') === 'c\n');
    check('Undo: journal line', cards().some(x => x.task_id === 't2' && x.answer === 'undo' && x.files === 4), JSON.stringify(cards().filter(x => x.task_id === 't2')));
    check('Undo: executor lock released', !fs.existsSync(path.join(J.STATE, 'executor.lock')));

    // ---- 9+ files truncation and min_files
    const d3 = path.join(tmp, 'w3'); w(d3, 'seed.txt', 's\n');
    ck.checkpoint('t3', d3, 'Write');
    for (let i = 1; i <= 11; i++) w(d3, `f${String(i).padStart(2, '0')}.txt`, 'x\n');
    await end('t3', d3);
    q = (await pending()).filter(x => x.task_id === 't3');
    const names = Array.from({ length: 8 }, (_, i) => `f${String(i + 1).padStart(2, '0')}.txt`).join(', ');
    check('11 files: first 8 listed, then +3 more', q.length === 1 && q[0].text === `Task t3 changed 11 files (+11 ${MINUS}0): ${names}, +3 more`, q[0] && q[0].text);
    const exact = reg.api('change-card').cardText('t', Array.from({ length: 8 }, (_, i) => ({ path: `p${i}`, added: 1, removed: 0 })));
    check('exactly 8 files: no "more"', !/more/.test(exact.text) && exact.added === 8);

    const hi = M.registry({ ...ON, change_card: { min_files: 3 } });
    const d4 = path.join(tmp, 'w4'); w(d4, 'a.txt', 'a\n');
    ck.checkpoint('t4', d4, 'Write'); w(d4, 'a.txt', 'b\n'); w(d4, 'b.txt', 'b\n');
    const before4 = (await pending()).length;
    await M.emit(hi.mods, 'task.end', { task_id: 't4', code: 0, workdir: d4 });
    check('min_files 3: 2 changed files raise no card', (await pending()).length === before4 && !cards().some(x => x.task_id === 't4'));
    // ---- agent surface: taskmote changes --json (read-only)
    {
      const outc = [], errc = [], l0 = console.log, e0 = console.error;
      const runc = async args => { outc.length = 0; errc.length = 0; console.log = s => outc.push(String(s)); console.error = s => errc.push(String(s)); let rr; try { rr = await M.commands(reg.mods).changes(args, {}); } finally { console.log = l0; console.error = e0; } return { out: outc.join('\n'), err: errc.join('\n'), code: rr && rr.code }; };
      const dj = path.join(tmp, 'wj'); w(dj, 'a.txt', 'one\n');
      const none0 = await runc(['--json']);
      check('changes --json: empty list when nothing waits', Array.isArray(JSON.parse(none0.out).pending));
      ck.snapshot && ck.snapshot('tj', dj, { tool: 'Write' });
      const pend = (await pending()).length;
      const rj = await runc(['status', '--json']);
      const pj = JSON.parse(rj.out).pending;
      check('changes status --json: one object with a pending array', rj.code === 0 && Array.isArray(pj));
      check('changes --json: each entry has question_id, task_id, files, added, removed', pj.every(p => p.question_id && p.task_id && typeof p.files === 'number' && typeof p.added === 'number' && typeof p.removed === 'number') && pj.length === pend, String(pend) + ' ' + rj.out.slice(0, 120));
      const bad = await runc(['nope']);
      check('changes: unknown subcommand exits 2', bad.code === 2);
      const txt = await runc([]);
      check('changes (text): prints something readable', txt.code === 0 && txt.out.length > 0);
    }
  } catch (e) { check('no exception', false, e.stack); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  process.exit(n === results.length ? 0 : 1);
})();
