#!/usr/bin/env node
'use strict';
// Fake engine for tests (HARNESS_ENGINE_SCRIPT). Gets the same argv as claude.
// Waits HARNESS_FAKE_DELAY_MS, then does one write effect, one message effect
// and a step note carrying the request text, then marks the task done.
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
const task = (prompt.match(/task_id: (\S+?)\)/) || [])[1];
const request = prompt.split('\n')[1] || '';
const EFFECT = path.join(__dirname, '..', 'bin', 'effect.js');
const eff = (a, input) => spawnSync(process.execPath, [EFFECT, ...a], { input: input || '', encoding: 'utf8' });

Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.HARNESS_FAKE_DELAY_MS || 5000));
eff(['step', task, '1', 'started', request]);
eff(['write', task, 's1-write', 'out.txt'], request + '\n');
eff(['message', task, 's1-message', 'owner'], request);
eff(['step', task, '1', 'done']);
eff(['task-done', task]);
