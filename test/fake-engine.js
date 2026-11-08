#!/usr/bin/env node
'use strict';
// Fake engine for tests (HARNESS_ENGINE_SCRIPT). Gets the same argv as claude.
// Waits HARNESS_FAKE_DELAY_MS, then does one write effect, one message effect
// and a step note carrying the request text, then marks the task done.
// Opt-in HARNESS_FAKE_GUARD=1: like the real engine, it first sends each mutating
// Bash call through the guard hook (guards/guard.js, hook JSON on stdin), so the
// checkpoint module snapshots the folder; it also makes a second change (step 2),
// so a test has two undo points. A guard block (exit 2) stops it, as it would stop the model.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
const task = (prompt.match(/task_id: (\S+?)\)/) || [])[1];
const request = prompt.split('\n')[1] || '';
const EFFECT = path.join(__dirname, '..', 'bin', 'effect.js');
const GUARD = path.join(__dirname, '..', 'guards', 'guard.js');
const eff = (a, input) => spawnSync(process.execPath, [EFFECT, ...a], { input: input || '', encoding: 'utf8' });
const viaGuard = process.env.HARNESS_FAKE_GUARD === '1';
function guarded(a) {
  if (!viaGuard) return;
  const command = `node "${EFFECT}" ${a.join(' ')}`;
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ session_id: 'fake', tool_name: 'Bash', tool_input: { command }, cwd: process.cwd() }), encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr || 'guard blocked'); process.exit(2); }
}

Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.HARNESS_FAKE_DELAY_MS || 5000));
eff(['step', task, '1', 'started', request]);
guarded(['write', task, 's1-write', 'out.txt']);
eff(['write', task, 's1-write', 'out.txt'], request + '\n');
eff(['message', task, 's1-message', 'owner'], request);
eff(['step', task, '1', 'done']);
if (viaGuard) {
  eff(['step', task, '2', 'started', 'second change']);
  guarded(['write', task, 's2-write', 'out.txt']);
  eff(['write', task, 's2-write', 'out.txt'], request + '\nsecond change\n');
  eff(['step', task, '2', 'done']);
}
// Opt-in HARNESS_FAKE_STREAM=<file>: its lines (stream-json, as the real engine prints) go to stdout, which the harness logs.
if (process.env.HARNESS_FAKE_STREAM) process.stdout.write(fs.readFileSync(process.env.HARNESS_FAKE_STREAM, 'utf8'));
eff(['task-done', task]);
