#!/usr/bin/env node
'use strict';
// The old CLI name (dantomation) is an alias: same output and exit code as taskmote.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-'));
const cfg = path.join(home, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ owner_name: 'Tester', modules: {} }));
const env = { ...process.env, HARNESS_CONFIG: cfg, HARNESS_NO_SERVER: '1', HARNESS_STATE_DIR: path.join(home, 'state'), HOME: home, USERPROFILE: home };
const run = (file, args) => spawnSync(process.execPath, [path.join(BIN, file), ...args], { env, encoding: 'utf8', cwd: home });

const res = {};
for (const args of [['bogus-verb'], ['status'], ['preset', 'v1'], ['preset', 'no-such-preset']]) {
  const a = run('taskmote.js', args), b = run('dantomation.js', args);
  const label = args.join(' ');
  res[`alias "${label}": exit code matches (${a.status})`] = a.status === b.status;
  res[`alias "${label}": stdout matches`] = a.stdout === b.stdout;
  // stderr may name the verb differently only through the program name; require equality after normalising it
  const norm = s => s.replace(/dantomation/g, 'taskmote');
  res[`alias "${label}": stderr matches`] = norm(a.stderr) === norm(b.stderr);
}
const bad = run('taskmote.js', ['bogus-verb']);
res['control: a bad verb exits non-zero'] = bad.status !== 0;
fs.rmSync(home, { recursive: true, force: true });

let ok = true;
for (const [k, v] of Object.entries(res)) { ok = ok && v; console.log(`${v ? 'PASS' : 'FAIL'} ${k}`); }
process.exit(ok ? 0 : 1);
