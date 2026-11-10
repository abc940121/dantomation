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
// Retry once only when the process never started (status null, or Windows 0xC0000142 under load).
// The retry is logged, and a real FAIL is never retried.
const retries = [];
const spawn1 = (file, args) => spawnSync(process.execPath, [path.join(BIN, file), ...args], { env, encoding: 'utf8', cwd: home });
const run = (file, args) => {
  const r = spawn1(file, args);
  if (r.status !== null && r.status !== 3221225794) return r;
  retries.push(`${file} ${args.join(' ')} (status ${r.status})`);
  return spawn1(file, args);
};

const res = {};
for (const args of [['bogus-verb'], ['status'], ['preset', 'v1'], ['preset', 'no-such-preset']]) {
  const a = run('taskmote.js', args), b = run('dantomation.js', args);
  const label = args.join(' ');
  res[`alias "${label}": exit code matches (${a.status})`] = a.status === b.status;
  res[`alias "${label}": stdout matches`] = a.stdout === b.stdout;
  // stderr may name the verb differently only through the program name; require equality after normalising it
  const norm = s => s.replace(/dantomation/g, 'taskmote');
  const same = norm(a.stderr) === norm(b.stderr);
  // On a mismatch, name both sides (trimmed) so the gate's one-line summary shows the difference.
  const show = x => JSON.stringify(norm(x).slice(0, 120));
  res[`alias "${label}": stderr matches${same ? '' : ` (taskmote ${show(a.stderr)} vs alias ${show(b.stderr)})`}`] = same;
}
const bad = run('taskmote.js', ['bogus-verb']);
res['control: a bad verb exits non-zero'] = bad.status !== 0;
fs.rmSync(home, { recursive: true, force: true });

let ok = true;
for (const r of retries) console.log(`RETRY process did not start: ${r}`);
const ents = Object.entries(res);
// FAIL lines last, so the runner's one-line summary names the failing check.
for (const [k, v] of [...ents.filter(e => e[1]), ...ents.filter(e => !e[1])]) { ok = ok && v; console.log(`${v ? 'PASS' : 'FAIL'} ${k}`); }
process.exit(ok ? 0 : 1);
