#!/usr/bin/env node
'use strict';
// Git mid-commit crash, two cases:
//  1. real kill while `git commit` runs (pre-commit hook sleeping). Git has
//     already released index.lock at that point; staged changes stay. Resume
//     must make the commit exactly once, with no reset.
//  2. a kill inside git's index.lock window (simulated: the lock file left
//     behind, as a killed git leaves it). Resume must mark UNCERTAIN and change
//     nothing: no reset, lock and staged changes kept, HEAD unchanged.
//  3. real kill between `git add` and `git commit` (HARNESS_PAUSE_MID_ACT_MS):
//     staged, no index.lock, HEAD unchanged; resume commits once, rerun skips.
//  4. trailer matched as a whole line: C4/s1-commit2 must not satisfy C4/s1-commit.
//  5. rerun with a different message/paths than the recorded intent -> UNCERTAIN.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync, execSync } = require('child_process');

const EFFECT = path.join(__dirname, '..', 'bin', 'effect.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
const state = path.join(base, 'state');
const w = path.join(base, 'w');
const env = { ...process.env, HARNESS_STATE_DIR: state, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const g = (...a) => execFileSync('git', a, { cwd: w, encoding: 'utf8', env }).trim();
const tick = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(w, { recursive: true });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(w, 'base.txt'), 'base'); g('add', '.'); g('commit', '-qm', 'base');
  fs.writeFileSync(path.join(w, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nsleep 60\n');
  const head0 = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(w, 'a.txt'), 'a\n');

  const p = spawn(process.execPath, [EFFECT, 'commit', 'C1', 's1-commit', 'add a', 'a.txt'], { cwd: w, env, stdio: 'ignore', windowsHide: true });
  const lockFile = path.join(w, '.git', 'index.lock');
  const t0 = Date.now();
  while (!fs.existsSync(lockFile) && Date.now() - t0 < 30000) await tick(100);
  await tick(1000); // well inside the hook
  execSync(`taskkill /T /F /PID ${p.pid}`, { stdio: 'ignore' });
  await tick(1000);

  const atKill = { lock: fs.existsSync(lockFile), staged: g('diff', '--cached', '--name-only'), head: g('rev-parse', 'HEAD') === head0 };
  const r1 = spawnSync(process.execPath, [EFFECT, 'commit', 'C1', 's1-commit', 'add a', 'a.txt'], { cwd: w, env, encoding: 'utf8', timeout: 90000 });
  const trailers = g('log', '--all', '--format=%B').split('Effect-Id: C1/s1-commit').length - 1;
  const reflog1 = g('reflog').split('\n');
  console.log(`1 at kill: index.lock=${atKill.lock}; staged=[${atKill.staged}]; HEAD unchanged=${atKill.head}`);
  console.log(`1 resume: exit ${r1.status} "${r1.stdout.trim()}"; commits with trailer=${trailers}; reflog=${JSON.stringify(reflog1.map(l => l.replace(/^\S+ /, '')))}`);

  // case 2
  fs.rmSync(path.join(w, '.git', 'hooks', 'pre-commit'));
  const head1 = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(w, 'b.txt'), 'b\n'); g('add', 'b.txt');
  fs.appendFileSync(path.join(state, 'journal.jsonl'), JSON.stringify({ id: 'c2', type: 'effect_intent', task_id: 'C2', effect_id: 's1-commit', kind: 'commit', target: w, message: 'add b' }) + '\n');
  fs.copyFileSync(path.join(w, '.git', 'index'), lockFile);
  const r2 = spawnSync(process.execPath, [EFFECT, 'commit', 'C2', 's1-commit', 'add b', 'b.txt'], { cwd: w, env, encoding: 'utf8' });
  const after = { lock: fs.existsSync(lockFile), staged: g('diff', '--cached', '--name-only'), head: g('rev-parse', 'HEAD') === head1, reflog: g('reflog').split('\n').length, file: fs.readFileSync(path.join(w, 'b.txt'), 'utf8') };
  console.log(`2 resume: exit ${r2.status} "${r2.stdout.trim()}"`);
  console.log(`2 after: index.lock=${after.lock}; staged=[${after.staged}]; HEAD unchanged=${after.head}; reflog entries=${after.reflog}; b.txt intact=${after.file === 'b\n'}`);

  // case 3: real kill between `git add` and `git commit` (fresh repo)
  const w3 = path.join(base, 'w3');
  const g3 = (...a) => execFileSync('git', a, { cwd: w3, encoding: 'utf8', env }).trim();
  fs.mkdirSync(w3); g3('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(w3, 'base.txt'), 'base'); g3('add', '.'); g3('commit', '-qm', 'base');
  const head3 = g3('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(w3, 'c.txt'), 'c\n');
  const flag = path.join(state, 'paused.flag');
  fs.rmSync(flag, { force: true });
  const p3 = spawn(process.execPath, [EFFECT, 'commit', 'C3', 's1-commit', 'add c', 'c.txt'], { cwd: w3, env: { ...env, HARNESS_PAUSE_MID_ACT_MS: '600000', HARNESS_PAUSE_EFFECT: 's1-commit' }, stdio: 'ignore', windowsHide: true });
  const t3 = Date.now();
  while (!(fs.existsSync(flag) && /MID/.test(fs.readFileSync(flag, 'utf8'))) && Date.now() - t3 < 30000) await tick(100);
  execSync(`taskkill /T /F /PID ${p3.pid}`, { stdio: 'ignore' });
  await tick(1000);
  fs.rmSync(flag, { force: true });
  const kill3 = { lock: fs.existsSync(path.join(w3, '.git', 'index.lock')), staged: g3('diff', '--cached', '--name-only'), head: g3('rev-parse', 'HEAD') === head3 };
  const r3 = spawnSync(process.execPath, [EFFECT, 'commit', 'C3', 's1-commit', 'add c', 'c.txt'], { cwd: w3, env, encoding: 'utf8' });
  const r3b = spawnSync(process.execPath, [EFFECT, 'commit', 'C3', 's1-commit', 'add c', 'c.txt'], { cwd: w3, env, encoding: 'utf8' });
  const tr3 = g3('log', '--all', '--format=%B').split('Effect-Id: C3/s1-commit').length - 1;
  console.log(`3 at kill (between add and commit): index.lock=${kill3.lock}; staged=[${kill3.staged}]; HEAD unchanged=${kill3.head}`);
  console.log(`3 resume: exit ${r3.status} "${r3.stdout.trim()}"; again: "${r3b.stdout.trim()}"; commits with trailer=${tr3}; commits=${g3('rev-list', '--count', 'HEAD')}`);

  // case 4: trailer is matched as a whole line. C4/s1-commit2 exists; an intent
  // for C4/s1-commit must not reconcile against it.
  fs.writeFileSync(path.join(w3, 'd.txt'), 'd\n');
  const r4a = spawnSync(process.execPath, [EFFECT, 'commit', 'C4', 's1-commit2', 'add d', 'd.txt'], { cwd: w3, env, encoding: 'utf8' });
  fs.writeFileSync(path.join(w3, 'e.txt'), 'e\n');
  fs.appendFileSync(path.join(state, 'journal.jsonl'), JSON.stringify({ id: 'c4', type: 'effect_intent', task_id: 'C4', effect_id: 's1-commit', kind: 'commit', target: w3, message: 'add e' }) + '\n');
  const r4 = spawnSync(process.execPath, [EFFECT, 'commit', 'C4', 's1-commit', 'add e', 'e.txt'], { cwd: w3, env, encoding: 'utf8' });
  const own4 = g3('log', '--format=%B', '-1').split('\n').includes('Effect-Id: C4/s1-commit');
  console.log(`4 s1-commit2 committed (${r4a.stdout.trim()}); intent for s1-commit -> "${r4.stdout.trim()}"; HEAD carries its own trailer=${own4}`);

  // case 5: rerun with different params than the recorded intent -> UNCERTAIN
  fs.appendFileSync(path.join(state, 'journal.jsonl'), JSON.stringify({ id: 'c5', type: 'effect_intent', task_id: 'C5', effect_id: 's1-commit', kind: 'commit', target: w3, params: { target: w3, message: 'add f', paths: ['f.txt'] } }) + '\n');
  fs.writeFileSync(path.join(w3, 'g.txt'), 'g\n');
  const head5 = g3('rev-parse', 'HEAD');
  const r5 = spawnSync(process.execPath, [EFFECT, 'commit', 'C5', 's1-commit', 'add g', 'g.txt'], { cwd: w3, env, encoding: 'utf8' });
  console.log(`5 params differ: exit ${r5.status} "${r5.stdout.trim()}"; HEAD unchanged=${g3('rev-parse', 'HEAD') === head5}`);

  const res = {
    '3 real kill between add and commit: staged, no index.lock, HEAD unchanged': kill3.staged === 'c.txt' && !kill3.lock && kill3.head,
    '3 resume commits exactly once; second rerun skips': r3.status === 0 && /DONE/.test(r3.stdout) && /SKIP/.test(r3b.stdout) && tr3 === 1,
    '4 s1-commit does not match s1-commit2 trailer': r4a.status === 0 && /DONE s1-commit/.test(r4.stdout) && !/RECONCILED/.test(r4.stdout) && own4,
    '5 rerun with other message/paths -> UNCERTAIN exit 3, no commit': r5.status === 3 && /params differ/.test(r5.stdout) && g3('rev-parse', 'HEAD') === head5,
    '1 real kill mid-commit: staged kept, HEAD unchanged': atKill.staged === 'a.txt' && atKill.head,
    '1 resume commits exactly once, no reset': r1.status === 0 && trailers === 1 && reflog1.length === 2 && !/reset/.test(reflog1.join(' ')),
    '2 leftover index.lock -> UNCERTAIN exit 3 naming it': r2.status === 3 && /index\.lock/.test(r2.stdout),
    '2 nothing destroyed (lock, staged, HEAD, reflog, file)': after.lock && after.staged === 'b.txt' && after.head && after.reflog === 2 && after.file === 'b\n',
  };
  let ok = true;
  for (const [k, v] of Object.entries(res)) { ok = ok && v; console.log(`${v ? 'PASS' : 'FAIL'} ${k}`); }
  fs.rmSync(base, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
