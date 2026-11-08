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
const st = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'harness.js'), 'status'], { env: { ...process.env, HARNESS_STATE_DIR: bad }, encoding: 'utf8' });
console.log(`unreadable journal -> harness status exit ${st.status}: ${st.stderr.trim()}`);
checks['unreadable journal -> exit 5, not empty'] = st.status === 5 && !/no open task/.test(st.stdout);
fs.rmSync(bad, { recursive: true, force: true });
let ok = true;
for (const [k, v] of Object.entries(checks)) { ok = ok && v; console.log(`${v ? 'PASS' : 'FAIL'} ${k}`); }
fs.rmSync(process.env.HARNESS_STATE_DIR, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
