#!/usr/bin/env node
'use strict';
// Reconcile rules for write / message / push (no model calls, local repos only).
//   write  : intent + file missing -> redo; file with other content -> UNCERTAIN,
//            file untouched; rerun with another body after done -> UNCERTAIN
//   message: outbox written via tmp+rename; missing -> redo; other recipient or
//            unparseable -> UNCERTAIN
//   push   : redo pushes intent.local_sha, not today's tip; remote already
//            contains local_sha -> RECONCILED; remote diverged -> plain push,
//            refused by git, remote unchanged, no done line
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const EFFECT = path.join(__dirname, '..', 'bin', 'effect.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-'));
const state = path.join(base, 'state');
fs.mkdirSync(state);
const env = { ...process.env, HARNESS_STATE_DIR: state, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const eff = (args, input = '', cwd = base) => spawnSync(process.execPath, [EFFECT, ...args], { cwd, env, input, encoding: 'utf8' });
const intent = rec => fs.appendFileSync(path.join(state, 'journal.jsonl'), JSON.stringify({ id: 'i' + Math.random(), type: 'effect_intent', ...rec }) + '\n');
const journal = () => fs.readFileSync(path.join(state, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const done = (t, e) => journal().filter(r => r.task_id === t && r.effect_id === e && r.type === 'effect_done');
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const res = {};
const show = (k, r) => console.log(`${k}: exit ${r.status} "${r.stdout.trim()}"`);

// ---- write
{
  const f = path.join(base, 'w1.txt');
  intent({ task_id: 'W1', effect_id: 's1-write', kind: 'write', target: f, params: { target: f, sha256: sha('one\n') }, sha256: sha('one\n') });
  const r = eff(['write', 'W1', 's1-write', f], 'one\n'); show('W1 missing file', r);
  res['write: intent + missing file -> redo'] = /DONE/.test(r.stdout) && fs.readFileSync(f, 'utf8') === 'one\n';

  const f2 = path.join(base, 'w2.txt');
  fs.writeFileSync(f2, 'someone else\n');
  intent({ task_id: 'W2', effect_id: 's1-write', kind: 'write', target: f2, params: { target: f2, sha256: sha('two\n') }, sha256: sha('two\n') });
  const r2 = eff(['write', 'W2', 's1-write', f2], 'two\n'); show('W2 other content', r2);
  res['write: other content -> UNCERTAIN, not overwritten'] = r2.status === 3 && /different content/.test(r2.stdout) && fs.readFileSync(f2, 'utf8') === 'someone else\n';

  const r3 = eff(['write', 'W1', 's1-write', f], 'changed body\n'); show('W1 rerun, other body', r3);
  res['write: rerun with other body after done -> UNCERTAIN'] = r3.status === 3 && /sha256/.test(r3.stdout) && fs.readFileSync(f, 'utf8') === 'one\n';
}

// ---- message
{
  const out = id => path.join(state, 'outbox', `${id}__s1-message.json`);
  const r = eff(['message', 'M1', 's1-message', 'owner'], 'hello'); show('M1 fresh', r);
  const m = JSON.parse(fs.readFileSync(out('M1'), 'utf8'));
  res['message: written, parses, no tmp left'] = /DONE/.test(r.stdout) && m.to === 'owner' && m.body === 'hello' && fs.readdirSync(path.dirname(out('M1'))).every(x => x.endsWith('.json'));

  intent({ task_id: 'M2', effect_id: 's1-message', kind: 'message', target: 'owner', params: { target: 'owner', sha256: sha('hi') }, sha256: sha('hi') });
  fs.writeFileSync(out('M2'), JSON.stringify({ to: 'someone-else', body: 'hi' }));
  const r2 = eff(['message', 'M2', 's1-message', 'owner'], 'hi'); show('M2 other recipient', r2);
  res['message: other recipient in outbox -> UNCERTAIN'] = r2.status === 3 && /different message/.test(r2.stdout);

  intent({ task_id: 'M3', effect_id: 's1-message', kind: 'message', target: 'owner', params: { target: 'owner', sha256: sha('hi') }, sha256: sha('hi') });
  fs.writeFileSync(out('M3'), '{"to":"owner","bo');
  const r3 = eff(['message', 'M3', 's1-message', 'owner'], 'hi'); show('M3 torn outbox file', r3);
  res['message: unparseable outbox file -> UNCERTAIN'] = r3.status === 3 && /not valid JSON/.test(r3.stdout);

  intent({ task_id: 'M4', effect_id: 's1-message', kind: 'message', target: 'owner', params: { target: 'owner', sha256: sha('hi') }, sha256: sha('hi') });
  const r4 = eff(['message', 'M4', 's1-message', 'owner'], 'hi'); show('M4 intent, no file', r4);
  res['message: intent + missing file -> redo'] = /DONE/.test(r4.stdout) && JSON.parse(fs.readFileSync(out('M4'), 'utf8')).to === 'owner';
}

// ---- push
function repo(name) {
  const bare = path.join(base, name + '.git');
  g(base, 'init', '-q', '--bare', bare);
  const w = path.join(base, name);
  fs.mkdirSync(w); g(w, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(w, 'a.txt'), 'a'); g(w, 'add', '.'); g(w, 'commit', '-qm', 'a');
  g(w, 'remote', 'add', 'origin', bare);
  return { w, bare };
}
const commit = (w, name) => { fs.writeFileSync(path.join(w, name), name); g(w, 'add', name); g(w, 'commit', '-qm', name); return g(w, 'rev-parse', 'HEAD'); };
{
  // P1: local branch moved on after the intent; redo must push the intent's sha
  const { w, bare } = repo('p1');
  const A = g(w, 'rev-parse', 'HEAD');
  intent({ task_id: 'P1', effect_id: 's1-push', kind: 'push', target: 'origin/main', params: { target: 'origin/main' }, local_sha: A });
  const B = commit(w, 'b.txt');
  const r = eff(['push', 'P1', 's1-push', 'origin', 'main'], '', w); show('P1 tip moved', r);
  res['push: redo pushes intent.local_sha, not the new tip'] = /DONE/.test(r.stdout) && g(bare, 'rev-parse', 'refs/heads/main') === A && A !== B;
}
{
  // P2: remote already holds local_sha plus a later commit -> reconciled
  const { w, bare } = repo('p2');
  const A = g(w, 'rev-parse', 'HEAD');
  const C = commit(w, 'c.txt');
  g(w, 'push', '-q', 'origin', 'main');
  g(w, 'reset', '-q', '--hard', A); // local back at A, remote at C (descendant of A)
  intent({ task_id: 'P2', effect_id: 's1-push', kind: 'push', target: 'origin/main', params: { target: 'origin/main' }, local_sha: A });
  const r = eff(['push', 'P2', 's1-push', 'origin', 'main'], '', w); show('P2 remote ahead, contains sha', r);
  res['push: local_sha is ancestor of remote tip -> RECONCILED, remote untouched'] = /RECONCILED/.test(r.stdout) && g(bare, 'rev-parse', 'refs/heads/main') === C;
}
{
  // P3: remote diverged (does not contain local_sha) -> plain push, git refuses
  const { w, bare } = repo('p3');
  const base0 = g(w, 'rev-parse', 'HEAD');
  const D = commit(w, 'd.txt');
  g(w, 'push', '-q', 'origin', 'main');
  g(w, 'reset', '-q', '--hard', base0);
  const E = commit(w, 'e.txt'); // sibling of D
  intent({ task_id: 'P3', effect_id: 's1-push', kind: 'push', target: 'origin/main', params: { target: 'origin/main' }, local_sha: E });
  const r = eff(['push', 'P3', 's1-push', 'origin', 'main'], '', w);
  console.log(`P3 remote diverged: exit ${r.status}; stderr has "rejected"=${/rejected/.test(r.stderr)}`);
  res['push: diverged remote -> plain push refused, remote unchanged, no done'] = r.status !== 0 && g(bare, 'rev-parse', 'refs/heads/main') === D && done('P3', 's1-push').length === 0;
}
{
  // P4: rerun for another branch than the intent -> UNCERTAIN
  const { w } = repo('p4');
  intent({ task_id: 'P4', effect_id: 's1-push', kind: 'push', target: 'origin/main', params: { target: 'origin/main' }, local_sha: g(w, 'rev-parse', 'HEAD') });
  g(w, 'branch', 'dev');
  const r = eff(['push', 'P4', 's1-push', 'origin', 'dev'], '', w); show('P4 other branch', r);
  res['push: rerun for another branch -> UNCERTAIN'] = r.status === 3 && /params differ/.test(r.stdout);
}

let ok = true;
for (const [k, v] of Object.entries(res)) { ok = ok && v; console.log(`${v ? 'PASS' : 'FAIL'} ${k}`); }
fs.rmSync(base, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
