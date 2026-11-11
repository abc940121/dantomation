#!/usr/bin/env node
'use strict';
// Every side effect goes through here: intent line -> act -> done line.
// Re-running the same command with the same effect_id never repeats the act:
//   done recorded            -> skip
//   intent but no done       -> reconcile (check the world), then record done
//   (write: sha256; commit: Effect-Id trailer; push: ls-remote + ancestry; message: outbox file)
// The intent records the effect's params. A rerun whose params differ from the
// recorded ones (other target / body / recipient / branch / paths) is not the
// same effect: UNCERTAIN, exit 3, nothing done.
// Usage (run from the task's work dir):
//   effect.js step     <task> <n> <started|done> [note]
//   effect.js write    <task> <effect_id> <path>        (content on stdin)
//   effect.js commit   <task> <effect_id> <message> <path...>
//   effect.js push     <task> <effect_id> <remote> <branch>
//   effect.js message  <task> <effect_id> <to>           (body on stdin; goes to outbox/)
//   effect.js task-done <task>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const J = require('../lib/journal');
const OWNER = require('../lib/config').owner();

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true, ...opts }).trim();
const quiet = { stdio: ['ignore', 'pipe', 'pipe'] };
const stdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } };
const say = (m) => process.stdout.write(m + '\n');

// Test seams: widen the window before the act (HARNESS_PAUSE_BEFORE_ACT_MS),
// inside it (HARNESS_PAUSE_MID_ACT_MS; commit: between `git add` and `git commit`)
// or between the act and its done line (HARNESS_PAUSE_AFTER_ACT_MS).
function testPause(effectId, when) {
  const ms = Number(process.env[`HARNESS_PAUSE_${when}_ACT_MS`] || 0);
  const only = process.env.HARNESS_PAUSE_EFFECT;
  if (!ms || (only && only !== effectId)) return;
  fs.writeFileSync(path.join(J.STATE, 'paused.flag'), `${effectId} ${when} ${process.pid}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// One executor per effect: a pid lock is held from reading the journal to the
// done line. A second executor (e.g. a resume while a killed parent's child is
// still running) gets BUSY, exit 4, and does nothing.
function hold(task, effectId) {
  const f = path.join(J.STATE, 'locks', `${task}__${effectId}.lock`.replace(/[^\w.-]/g, '_'));
  const l = J.lock(f, { pids: [process.pid], task, effectId });
  if (!l.held) { say(`BUSY ${effectId}: another executor (pid ${(l.holder.pids || []).join(',') || '?'}) is on it; retry after it exits`); process.exit(4); }
  process.on('exit', () => J.unlock(f, l.nonce));
}

// Params recorded in the intent vs this run's. Legacy intents (no params) are
// compared on target only.
function paramsDiffer(intent, params) {
  const rec = intent.params || { target: intent.target };
  return Object.keys({ ...rec, ...(intent.params ? params : {}) })
    .filter(k => JSON.stringify(rec[k]) !== JSON.stringify(params[k]));
}

function run(kind, task, effectId, params, act, verify) {
  hold(task, effectId);
  const { records } = J.readAll();
  const st = J.effectState(records, task).get(effectId) || {};
  const diff = st.intent ? paramsDiffer(st.intent, params) : [];
  if (st.done) {
    if (diff.length) { say(`UNCERTAIN ${effectId}: already done with different ${diff.join(', ')}; not redone; ask ${OWNER}`); process.exit(3); }
    say(`SKIP ${effectId}: already done (${st.done.mode})`); return;
  }
  if (st.uncertain) { say(`UNCERTAIN ${effectId}: ask ${OWNER} before retrying`); process.exit(3); }
  let intent = st.intent;
  if (intent) {
    if (diff.length) {
      const why = `rerun params differ from the recorded intent (${diff.join(', ')})`;
      J.append({ type: 'effect_uncertain', task_id: task, effect_id: effectId, reason: why });
      say(`UNCERTAIN ${effectId}: ${why}; ask ${OWNER}`); process.exit(3);
    }
    const v = verify(intent);
    if (v === true) { J.append({ type: 'effect_done', task_id: task, effect_id: effectId, mode: 'reconciled' }); say(`RECONCILED ${effectId}: already in place, not repeated`); return; }
    const why = v === 'unknown' ? 'cannot verify' : v && v.uncertain;
    if (why) { J.append({ type: 'effect_uncertain', task_id: task, effect_id: effectId, reason: why }); say(`UNCERTAIN ${effectId}: ${why}; ask ${OWNER}`); process.exit(3); }
    // v === false: the act never landed, safe to do it now
  } else {
    intent = J.append({ type: 'effect_intent', task_id: task, effect_id: effectId, kind, target: params.target, params, ...act.meta });
  }
  testPause(effectId, 'BEFORE');
  const out = act.fn(intent);
  testPause(effectId, 'AFTER');
  J.append({ type: 'effect_done', task_id: task, effect_id: effectId, mode: 'performed', ...(out || {}) });
  say(`DONE ${effectId}`);
}

function main(argv) {
  const [cmd, task, a, ...rest] = argv;
  if (!cmd || !task) { say('usage: see header of bin/effect.js'); process.exit(2); }
  if (cmd === 'step') {
    J.append({ type: 'step', task_id: task, step: Number(a), status: rest[0] || 'done', note: rest.slice(1).join(' ') });
    return say(`STEP ${a} ${rest[0] || 'done'}`);
  }
  if (cmd === 'task-done') { J.append({ type: 'task_done', task_id: task }); return say('TASK DONE'); }
  const effectId = a;
  if (cmd === 'write') {
    const file = path.resolve(rest[0]);
    const body = stdin();
    const h = sha(body);
    // missing -> never written, redo; same sha -> done; other content -> a file
    // we did not write (or a changed body): never overwrite, ask the owner.
    return run('write', task, effectId, { target: file, sha256: h }, {
      meta: { sha256: h },
      fn: () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return { sha256: h }; },
    }, () => {
      let cur; try { cur = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? false : 'unknown'; }
      return sha(cur) === h || { uncertain: `${file} exists with different content; not overwriting` };
    });
  }
  if (cmd === 'commit') {
    const [msg, ...paths] = rest;
    const trailer = `Effect-Id: ${task}/${effectId}`;
    // --grep is a substring match (s1-commit would hit s1-commit2): keep only
    // commits that have the trailer as a whole line.
    const find = () => git(['log', '--all', '--format=%H%x00%B%x1e', '--fixed-strings', `--grep=${trailer}`])
      .split('\x1e').map(s => s.replace(/^\s+/, '').split('\0'))
      .filter(([h, body]) => h && (body || '').split('\n').some(l => l.replace(/\r$/, '') === trailer))
      .map(([h]) => h);
    return run('commit', task, effectId, { target: process.cwd(), message: msg, paths }, {
      meta: { message: msg },
      fn: () => {
        git(['add', '--', ...paths]);
        testPause(effectId, 'MID');
        git(['commit', '-q', '-m', msg, '-m', trailer]);
        return { commit: find()[0] };
      },
    }, () => {
      try { if (find().length) return true; } catch { return 'unknown'; }
      // Killed mid-commit: git leaves index.lock (and staged changes). Never reset
      // or delete the lock here; a git may still be running. The owner decides.
      // Known limit: a commit that landed and was then lost (reset) looks like
      // "never landed" and is redone.
      const lockFile = path.resolve(git(['rev-parse', '--git-dir']), 'index.lock');
      if (fs.existsSync(lockFile)) return { uncertain: `git index.lock left at ${lockFile} (commit interrupted); staged changes kept, no reset done` };
      return false;
    });
  }
  if (cmd === 'push') {
    const [remote, branch] = [rest[0], rest[1]];
    // The intent binds the exact sha; a redo pushes that sha, not today's tip.
    // Reconcile by asking the remote:
    //   no branch there                      -> never landed, push
    //   tip == local_sha, or local_sha is an
    //   ancestor of the fetched tip          -> already in place
    //   tip reachable, local_sha not in it   -> plain (non-force) push; git
    //                                           refuses it if not a fast-forward
    //   remote unreachable / ancestry error  -> UNCERTAIN, ask the owner
    return run('push', task, effectId, { target: `${remote}/${branch}` }, {
      meta: { local_sha: git(['rev-parse', `refs/heads/${branch}`]) },
      fn: intent => { git(['push', remote, `${intent.local_sha}:refs/heads/${branch}`], quiet); return { pushed: intent.local_sha }; },
    }, intent => {
      let out;
      try { out = git(['ls-remote', remote, `refs/heads/${branch}`], { ...quiet, timeout: 30000 }); } catch { return 'unknown'; }
      const tip = out.split(/\s+/)[0] || '';
      if (!tip) return false;
      if (tip === intent.local_sha) return true;
      try { git(['fetch', '-q', remote, `refs/heads/${branch}`], { ...quiet, timeout: 60000 }); } catch { return 'unknown'; }
      const r = spawnSync('git', ['merge-base', '--is-ancestor', intent.local_sha, 'FETCH_HEAD'], { ...quiet, windowsHide: true });
      return r.status === 0 ? true : r.status === 1 ? false : 'unknown';
    });
  }
  if (cmd === 'message') {
    // Seam for dispatch/approval cards: today it lands in outbox/ as a file,
    // written to a temp name and renamed so a reader never sees half a message.
    const to = rest[0];
    const body = stdin();
    const h = sha(body);
    const out = path.join(J.STATE, 'outbox', `${task}__${effectId}.json`);
    return run('message', task, effectId, { target: to, sha256: h }, {
      meta: { sha256: h },
      fn: () => {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const tmp = `${out}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ to, body }));
        fs.renameSync(tmp, out);
        return {};
      },
    }, () => {
      let m; try { m = fs.readFileSync(out, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? false : 'unknown'; }
      try { m = JSON.parse(m); } catch { return { uncertain: `${out} is not valid JSON` }; }
      return (m.to === to && sha(m.body) === h) || { uncertain: `${out} holds a different message (recipient or body differs)` };
    });
  }
  say(`unknown command ${cmd}`); process.exit(2);
}

main(process.argv.slice(2));
