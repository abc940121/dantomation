#!/usr/bin/env node
'use strict';
// Seam between voice/bridge.py and the harness core. The bridge never builds
// its own claude command: argv, settings (guard hook) and env stripping all
// come from bin/harness.js, the same exports test/a1-live.js uses.
//   node modules/voice/harness_seam.js argv <voice_task_id> <model> [<workdir>]
//        -> JSON {claude, args, strip, env}. env (add AFTER stripping): with a
//           workdir, HARNESS_TASK_ID/HARNESS_TASK_DIR so the guard checkpoints
//           the voice work dir before every mutating tool call, like a task.
//   node modules/voice/harness_seam.js log '<json record>'            -> one journal line
//   node modules/voice/harness_seam.js turn-begin <task> <bridge_pid> <claude_pid>
//        -> JSON {locked, nonce, status}. Takes state/executor.lock for ONE turn
//           (pids: bridge + claude). If a harness task holds it, locked=false and
//           state/voice-notools.flag is set: the voice module then blocks every
//           tool call from the voice claude (env HARNESS_VOICE=1) for that turn.
//           status = short journal summary injected at the start of the turn.
//   node modules/voice/harness_seam.js turn-end <nonce>                -> releases the lock if still ours
const fs = require('fs');
const path = require('path');
const H = require('../../bin/harness');
const J = require('../../lib/journal');

const VOICE_HINT = [
  '',
  'Voice session. Your task_id is {{TASK}}; use it for every effect.js call (steps are optional).',
  'You are spoken to by voice and your reply is read aloud. Answer in short spoken sentences.',
  'No markdown, code, file paths, URLs or long lists in the reply; say they are on screen instead.',
].join('\n');

// Short journal status for the start of a voice turn: open harness task and its last steps.
function status() {
  const { records } = J.readAll();
  const open = J.openTask(records);
  if (!open) return 'Harness: no open task.';
  const req = String(open.request || '').replace(/\s+/g, ' ');
  const steps = records.filter(r => r.task_id === open.task_id && r.type === 'step').slice(-3)
    .map(r => `step ${r.step} ${r.status}${r.note ? ' (' + String(r.note).slice(0, 60) + ')' : ''}`);
  return `Harness: open task ${open.task_id}: "${req.length > 160 ? req.slice(0, 160) + '...' : req}". Last steps: ${steps.join('; ') || 'none'}.`;
}

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === 'argv') {
  // Same argv/env/guard as runEngine (bin/harness.js engineSpec); only voice flags are added here.
  if (H.resolveClaude) H.resolveClaude();
  const spec = H.engineSpec(null);
  const proto = fs.readFileSync(H.protocolFile(), 'utf8') + VOICE_HINT.split('{{TASK}}').join(a);
  const pf = path.join(J.STATE, 'voice-protocol.md'); fs.writeFileSync(pf, proto);
  const args = spec.args.slice();
  const i = args.indexOf('--append-system-prompt-file');
  if (i < 0) throw new Error('engineSpec has no --append-system-prompt-file');
  args[i + 1] = pf;
  args.push('--input-format', 'stream-json', '--include-partial-messages', '--model', b || 'sonnet');
  J.append({ type: 'voice_session_start', task_id: a, stripped_env: spec.stripped });
  const env = c ? { HARNESS_TASK_ID: a, HARNESS_TASK_DIR: path.resolve(c), HARNESS_STATE_DIR: J.STATE } : {};
  process.stdout.write(JSON.stringify({ claude: spec.bin, args, strip: spec.stripped, env, state: J.STATE, root: path.resolve(__dirname, '..', '..') }));
} else if (cmd === 'turn-begin') {
  const [, task, bridgePid, claudePid] = process.argv.slice(2);
  const flag = path.join(J.STATE, 'voice-notools.flag');
  const pids = [Number(bridgePid), Number(claudePid)].filter(n => Number.isInteger(n) && n > 0);
  // A previous turn of this same bridge that never reached turn-end (error,
  // timeout) still holds the lock with our live pids: release it first.
  const prev = J.readLock(H.EXEC_LOCK);
  if (prev && prev.voice && Number((prev.pids || [])[0]) === Number(bridgePid) && J.unlock(H.EXEC_LOCK, prev.nonce))
    J.append({ type: 'voice_lock_released', task_id: task, reason: 'previous turn of this bridge did not unlock' });
  const l = J.lock(H.EXEC_LOCK, { pids, task_id: task, voice: true, transient: true, label: 'voice turn' });
  if (l.held) fs.rmSync(flag, { force: true });
  else fs.writeFileSync(flag, `held by ${l.holder.task_id || '?'} pids ${(l.holder.pids || []).join(',')}\n`);
  process.stdout.write(JSON.stringify({ locked: l.held, nonce: l.held ? l.nonce : null, holder: l.held ? null : (l.holder.task_id || null), status: status() }));
} else if (cmd === 'turn-end') {
  J.unlock(H.EXEC_LOCK, a);
} else if (cmd === 'log') {
  J.append(JSON.parse(a));
} else {
  console.error('usage: harness_seam.js argv <task_id> <model> | log <json> | turn-begin <task> <bridge_pid> <claude_pid> | turn-end <nonce>');
  process.exit(2);
}
