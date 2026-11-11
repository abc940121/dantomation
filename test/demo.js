#!/usr/bin/env node
'use strict';
// `taskmote demo` end to end, non-interactive: TASKMOTE_DEMO_AUTO answers the approval card.
// Each run must exit 0, show every step, report all results true and remove its sandbox.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TASKMOTE = path.join(__dirname, '..', 'bin', 'taskmote.js');
let fail = 0;
const check = (name, ok, extra) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : `\n${extra}`}`); if (!ok) fail++; };

for (const answer of ['yes', 'no']) {
  const env = { ...process.env, TASKMOTE_DEMO_AUTO: answer };
  delete env.HARNESS_TASK_ID;
  const r = spawnSync(process.execPath, [TASKMOTE, 'demo'], { env, encoding: 'utf8', timeout: 120000 , windowsHide: true });
  const out = (r.stdout || '') + (r.stderr || '');
  check(`demo (${answer}) exits 0`, r.status === 0, out);
  for (const step of ['(a) edit', '(b) block', 'crash', 'resume', '(c) card', 'answer', '(d) undo']) check(`demo (${answer}) shows ${step}`, out.includes(step), out);
  check(`demo (${answer}) has no color codes when stdout is not a TTY`, !out.includes('\x1b['));
  const m = out.match(/DEMO_RESULT (\{.*\})/);
  const res = m ? JSON.parse(m[1]) : {};
  check(`demo (${answer}) all steps succeed`, res.checkpoint && res.blocked && res.resumed && res.card && res.undone, m && m[0]);
  check(`demo (${answer}) card outcome`, res.outcome === (answer === 'yes' ? 'allow' : 'deny'), m && m[0]);
  const sb = (out.match(/\(sandbox (.+?);/) || [])[1];
  check(`demo (${answer}) removes its sandbox`, !!sb && !fs.existsSync(sb), sb);
}

console.log(fail ? `${fail} failing` : 'all passing');
process.exit(fail ? 1 : 0);
