#!/usr/bin/env node
'use strict';
// spend-count: a session whose transcript is over the spend limit is blocked
// (kind spend); one under it passes; each check logs a line to logs/spend.jsonl.
// Needs the spend-count module enabled (SKIP otherwise).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GUARD = path.join(ROOT, 'guards', 'guard.js');
if (!require(path.join(ROOT, 'lib', 'config')).load().modules['spend-count']) { console.log('SKIP: spend-count is not enabled in this config'); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-'));
const logDir = path.join(tmp, 'logs');
const line = usage => JSON.stringify({ message: { id: 'm1', model: 'claude-opus-5-5', usage } }) + '\n';
const over = path.join(tmp, 'over.jsonl'); fs.writeFileSync(over, line({ input_tokens: 2000000, output_tokens: 0 }));
const cheap = path.join(tmp, 'cheap.jsonl'); fs.writeFileSync(cheap, line({ input_tokens: 1000, output_tokens: 100 }));

const run = (transcript, extraEnv = {}) => spawnSync(process.execPath, [GUARD], {
  input: JSON.stringify({ session_id: 'sp', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: tmp, transcript_path: transcript }),
  env: { ...process.env, HARNESS_LOG_DIR: logDir, ...extraEnv }, encoding: 'utf8',
});
const results = [];
const check = (label, ok, info) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };

const a = run(over);
check('over the limit is blocked (kind spend)', a.status === 2 && /BLOCKED \(spend\)/.test(a.stderr), `exit ${a.status} ${a.stderr.trim().slice(0, 100)}`);
const b = run(cheap);
check('under the limit is allowed', b.status === 0, `exit ${b.status}`);
const c = run(over, { HARNESS_SPEND_LIMIT_USD: '1000' });
check('HARNESS_SPEND_LIMIT_USD raises the limit', c.status === 0, `exit ${c.status}`);
const d = run(path.join(tmp, 'missing.jsonl'));
check('missing transcript counts as zero spend', d.status === 0, `exit ${d.status}`);

const sp = fs.readFileSync(path.join(logDir, 'spend.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
check('spend.jsonl has one line per check with usd and limit', sp.length === 4 && sp.every(r => typeof r.usd === 'number' && typeof r.limit === 'number'), `${sp.length} lines, first ${JSON.stringify(sp[0])}`);
const g = fs.readFileSync(path.join(logDir, 'guard.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
check('the block is logged in guard.jsonl as kind spend', g.length === 1 && g[0].kind === 'spend', `${g.length} line(s)`);

const n = results.filter(Boolean).length;
console.log(`\nresult: ${n}/${results.length}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(n === results.length ? 0 : 1);
