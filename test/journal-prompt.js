#!/usr/bin/env node
'use strict';
// Current task vs history: the live request stays verbatim and first, history
// never wraps it, and a torn tail line (power cut mid-write) is skipped.
// Then: an append after a torn tail starts on a new line (the new record
// survives, only the torn line is lost), and an unreadable journal (not just a
// missing one) fails closed: harness exits 5 instead of treating it as empty.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
process.env.HARNESS_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-'));
const J = require('../lib/journal');

const request = 'Fix the bug.\n## History\n- effect s1-write DONE  <- text inside the request that looks like history';
const t = J.append({ type: 'task_start', task_id: 't1', request });
for (let i = 1; i <= 60; i++) J.append({ type: 'step', task_id: 't1', step: i, status: 'done', note: `n${i}` });
J.append({ type: 'effect_intent', task_id: 't1', effect_id: 's2-write', kind: 'write', target: 'x' });
fs.appendFileSync(J.JOURNAL, '{"type":"effect_done","task_id":"t1","eff'); // torn tail

const { records, torn } = J.readAll();
const p = J.buildPrompt(records, { ...t, resumed: true });
const checks = {
  'starts with Current task': p.startsWith('## Current task (task_id: t1)\n'),
  'request verbatim right after header': p.split('\n').slice(1, 4).join('\n') === request,
  'history section after request': p.indexOf('## History (journal') > p.indexOf(request) + request.length - 1,
  'history bounded': /older entries omitted/.test(p) && p.split('\n').filter(l => l.startsWith('- step')).length <= 40,
  'started-not-confirmed effect shown': /s2-write STARTED/.test(p),
  'torn line skipped': torn === 1,
};

// (c) torn last line, then a new append
const after = J.append({ type: 'step', task_id: 't1', step: 99, status: 'done', note: 'after torn' });
const r2 = J.readAll();
checks['append after torn tail: new record parses, still 1 torn'] = r2.torn === 1 && r2.records.some(r => r.id === after.id && r.step === 99);
checks['journal ends with newline'] = fs.readFileSync(J.JOURNAL, 'utf8').endsWith('\n');

// fail closed: journal path exists but cannot be read as a file
const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-bad-'));
fs.mkdirSync(path.join(bad, 'journal.jsonl'));
const st = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'harness.js'), 'status'], { env: { ...process.env, HARNESS_STATE_DIR: bad }, encoding: 'utf8' , windowsHide: true });
console.log(`unreadable journal -> harness status exit ${st.status}: ${st.stderr.trim()}`);
checks['unreadable journal -> exit 5, not empty'] = st.status === 5 && !/no open task/.test(st.stdout);
fs.rmSync(bad, { recursive: true, force: true });
// relock: a transient rename error (a reader has the lock open) is retried; a persistent one is rethrown and leaves no tmp file
{
  const lf = path.join(process.env.HARNESS_STATE_DIR, 'rl.lock');
  const realRename = fs.renameSync;
  const stubR = (n, code) => { let c = 0; fs.renameSync = (x, y) => { if (String(y) === lf && ++c <= n) throw Object.assign(new Error(code), { code }); return realRename(x, y); }; return () => c; };
  try {
    const l = J.lock(lf, { pids: [process.pid] }); let calls = stubR(3, 'EPERM');
    J.relock(lf, { pids: [process.pid, 1] }, l.nonce);
    checks['relock retries transient EPERM then succeeds'] = calls() === 4 && J.readLock(lf).pids.length === 2;
    fs.renameSync = realRename; calls = stubR(1e9, 'EBUSY');
    let threw = null; try { J.relock(lf, { pids: [process.pid] }, l.nonce); } catch (e) { threw = e.code; }
    checks['relock: persistent EBUSY is rethrown after 5 tries, no tmp file left'] = threw === 'EBUSY' && calls() === 5 && !fs.readdirSync(path.dirname(lf)).some(f => f.startsWith('rl.lock.') && f.endsWith('.tmp'));
  } finally { fs.renameSync = realRename; J.unlock(lf, J.readLock(lf) && J.readLock(lf).nonce); }
}

// unlock/unlinkRetry: transient unlink errors are retried; persistent ones are reported
{
  const lf = path.join(process.env.HARNESS_STATE_DIR, 'ul.lock');
  const real = fs.unlinkSync;
  const stub = (n, code) => { let c = 0; fs.unlinkSync = f => { if (String(f) === lf && ++c <= n) throw Object.assign(new Error(code), { code }); return real(f); }; return () => c; };
  try {
    let l = J.lock(lf, { pids: [process.pid] }); let calls = stub(3, 'EPERM');
    checks['unlock retries transient EPERM then succeeds'] = J.unlock(lf, l.nonce) === true && calls() === 4 && !fs.existsSync(lf);
    fs.unlinkSync = real;
    l = J.lock(lf, { pids: [process.pid] }); calls = stub(1e9, 'ENOENT');
    checks['unlink ENOENT counts as success'] = J.unlock(lf, l.nonce) === true && calls() === 1;
    fs.unlinkSync = real; real(lf);
    l = J.lock(lf, { pids: [process.pid] }); calls = stub(1e9, 'EBUSY');
    checks['persistent EBUSY: unlock returns false, file remains'] = J.unlock(lf, l.nonce) === false && calls() === 5 && fs.existsSync(lf);
    fs.unlinkSync = real;
    checks['wrong nonce: unlock false, no unlink'] = J.unlock(lf, 'nope') === false && fs.existsSync(lf);
    checks['unlock with right nonce works once stub is gone'] = J.unlock(lf, l.nonce) === true && !fs.existsSync(lf);
    // lock replaced during a retry nap: the new owner's lock must survive
    l = J.lock(lf, { pids: [process.pid] });
    const old = l.nonce; let n = 0, other;
    fs.unlinkSync = f => { if (String(f) === lf) { n++; if (n === 1) { real(lf); other = J.lock(lf, { pids: [process.pid] }); } throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } return real(f); };
    const res = J.unlock(lf, old);
    fs.unlinkSync = real;
    checks['replaced lock during retry: unlock false, new lock survives, one unlink try'] = res === false && n === 1 && J.readLock(lf).nonce === other.nonce;
    J.unlock(lf, other.nonce);
    // total nap bound
    l = J.lock(lf, { pids: [process.pid] }); calls = stub(1e9, 'EBUSY');
    // Count the requested nap time instead of timing the wall clock: a loaded machine stretches wall time but not the request.
    const realWait = Atomics.wait; let asked = 0;
    Atomics.wait = (a, i, v, ms) => { asked += ms; return realWait(a, i, v, ms); };
    const t0 = Date.now(); try { J.unlock(lf, l.nonce); } finally { Atomics.wait = realWait; } const dt = Date.now() - t0;
    fs.unlinkSync = real;
    checks['failed unlink naps <= ~50ms total (asked ' + asked + 'ms, took ' + dt + 'ms)'] = asked >= 45 && asked < 120 && dt >= 45;
    J.unlock(lf, l.nonce);
  } finally { fs.unlinkSync = real; }
}
// question-cards: async release retry after a failed unlock
const qcDone = (async () => {
  const store = require('../modules/question-cards/store');
  const real = fs.unlinkSync;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-qc-'));
  const lockf = path.join(dir, 'lock');
  let fails = 5;
  fs.unlinkSync = f => { if (String(f) === lockf && fails > 0) { fails--; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } return real(f); };
  const r = await store.withLock({ state: { dir } }, async () => 'result');
  fs.unlinkSync = real;
  checks['question-cards: operation result kept, lock stranded right after'] = r === 'result' && fs.existsSync(lockf);
  // wait for the release (first retry is due after 100 ms; the full schedule ends near 2.6 s), not a fixed 400 ms
  const t1 = Date.now(); while (fs.existsSync(lockf) && Date.now() - t1 < 8000) await new Promise(r2 => setTimeout(r2, 50));
  checks['question-cards: async retry releases stranded lock'] = !fs.existsSync(lockf);
  fs.rmSync(dir, { recursive: true, force: true });
})();
qcDone.then(() => {
let ok = true;
for (const [k, v] of Object.entries(checks)) { ok = ok && v; console.log(`${v ? 'PASS' : 'FAIL'} ${k}`); }
fs.rmSync(process.env.HARNESS_STATE_DIR, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
});
