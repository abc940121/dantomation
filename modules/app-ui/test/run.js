#!/usr/bin/env node
'use strict';
// Runs every modules/app-ui/test/*.test.js in its own node process. Exit 1 when any fails.
// Area packages add their own <area>.test.js files here; nothing in this runner changes.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', timeout: 120000, env: process.env });
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.trim().split('\n');
  const bad = lines.filter(l => /^FAIL/.test(l));
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${f}: ${lines.filter(l => /^PASS/.test(l)).length} checks${bad.length ? ', failing: ' + bad.join(' | ').slice(0, 300) : ''}`);
  if (!ok && !bad.length) console.log(out.slice(-1500));
}
console.log(`result: ${files.length} file(s), ${failed} failing`);
process.exit(failed ? 1 : 0);
