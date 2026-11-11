#!/usr/bin/env node
'use strict';
// Push reconcile against a local bare repo used as the remote (no network).
//   1. kill effect.js between `git push` and its done line -> rerun must say RECONCILED (no second push)
//   2. intent recorded but push never ran                  -> rerun must push (PERFORMED)
//   3. remote unreachable after intent                     -> UNCERTAIN, exit 3
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync, execSync } = require('child_process');

const EFFECT = path.join(__dirname, '..', 'bin', 'effect.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
const state = path.join(base, 'state');
const env = { ...process.env, HARNESS_STATE_DIR: state, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env , windowsHide: true }).trim();
const tick = ms => new Promise(r => setTimeout(r, ms));
const journal = () => fs.readFileSync(path.join(state, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const eff = (cwd, args, extra = {}) => spawnSync(process.execPath, [EFFECT, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8' , windowsHide: true });

function repo(name, remoteUrl) {
  const bare = path.join(base, name + '.git');
  g(base, 'init', '-q', '--bare', bare);
  const w = path.join(base, name);
  fs.mkdirSync(w); g(w, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(w, 'a.txt'), 'a'); g(w, 'add', '.'); g(w, 'commit', '-qm', 'a');
  g(w, 'remote', 'add', 'origin', remoteUrl || bare);
  return { w, bare };
}

async function main() {
  const res = {};
  // 1. kill after the push landed, before done
  {
    const { w, bare } = repo('r1');
    const p = spawn(process.execPath, [EFFECT, 'push', 'T1', 's1-push', 'origin', 'main'], { cwd: w, env: { ...env, HARNESS_PAUSE_AFTER_ACT_MS: '600000', HARNESS_PAUSE_EFFECT: 's1-push' }, stdio: 'ignore', windowsHide: true });
    const t0 = Date.now();
    while (!fs.existsSync(path.join(state, 'paused.flag')) && Date.now() - t0 < 60000) await tick(200);
    execSync(`taskkill /T /F /PID ${p.pid}`, { stdio: 'ignore' , windowsHide: true }); await tick(500);
    fs.rmSync(path.join(state, 'paused.flag'));
    const before = journal().filter(r => r.task_id === 'T1').map(r => r.type).join(',');
    const reflogBefore = g(bare, 'rev-parse', 'refs/heads/main');
    const r = eff(w, ['push', 'T1', 's1-push', 'origin', 'main']);
    const done = journal().filter(r => r.task_id === 'T1' && r.type === 'effect_done');
    res['kill after push -> RECONCILED'] = before === 'effect_intent' && /RECONCILED/.test(r.stdout) && done.length === 1 && done[0].mode === 'reconciled' && reflogBefore === g(w, 'rev-parse', 'main');
  }
  // 2. intent but no push happened
  {
    const { w, bare } = repo('r2');
    fs.appendFileSync(path.join(state, 'journal.jsonl'), JSON.stringify({ id: 'x2', type: 'effect_intent', task_id: 'T2', effect_id: 's1-push', kind: 'push', target: 'origin/main', local_sha: g(w, 'rev-parse', 'main') }) + '\n');
    const r = eff(w, ['push', 'T2', 's1-push', 'origin', 'main']);
    let remote = ''; try { remote = g(bare, 'rev-parse', 'refs/heads/main'); } catch {}
    res['intent only -> push performed once'] = /DONE s1-push/.test(r.stdout) && remote === g(w, 'rev-parse', 'main');
  }
  // 3. unreachable remote
  {
    const { w } = repo('r3', path.join(base, 'does-not-exist.git'));
    fs.appendFileSync(path.join(state, 'journal.jsonl'), JSON.stringify({ id: 'x3', type: 'effect_intent', task_id: 'T3', effect_id: 's1-push', kind: 'push', target: 'origin/main', local_sha: g(w, 'rev-parse', 'main') }) + '\n');
    const r = eff(w, ['push', 'T3', 's1-push', 'origin', 'main']);
    res['unreachable -> UNCERTAIN exit 3'] = r.status === 3 && journal().some(x => x.task_id === 'T3' && x.type === 'effect_uncertain');
  }
  let ok = true;
  for (const [k, v] of Object.entries(res)) { ok = ok && v; console.log(`${v ? 'PASS' : 'FAIL'} ${k}`); }
  fs.rmSync(base, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
