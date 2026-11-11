#!/usr/bin/env node
'use strict';
// Review lanes: docs/review-lanes.json + scripts/review-lane.js. Each sensitive area has a real,
// existing path that classifies as review-first (a rename breaks this test), a plain module UI file
// does not, and every error path exits 1 (never 0). Runs in any mode; no network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'review-lane.js');
const { classify, loadLanes } = require(SCRIPT);
const lanes = loadLanes(path.join(ROOT, 'docs', 'review-lanes.json'));
const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });

const AREAS = {
  'harness profile and guardArgs': 'bin/harness.js',
  'approve MCP': 'bin/approve-mcp.js',
  'guards': 'guards/guard.js',
  'pairing and tokens': 'modules/device-pairing/store.js',
  'request auth (server)': 'lib/server.js',
  'secrets handling': 'lib/redact.js',
  'public boundary': 'test/public-boundary.js',
  'gate script': 'test/run-all.js',
  'engine invocation': 'modules/roles/engines/codex.js',
  'spend limits (turn cap, models, providers)': 'modules/roles/engines/limits.js',
  'tools a session can reach': 'bin/taskmote-mcp.js',
  'module power': 'lib/modules.js',
  'owner-question routing': 'modules/roles/ask.js',
  'journal format': 'lib/journal.js',
  'lane file': 'docs/review-lanes.json',
  'lane script': 'scripts/review-lane.js',
};
for (const [area, p] of Object.entries(AREAS)) {
  check(`${area}: ${p} exists and is review-first`, fs.existsSync(path.join(ROOT, p)) && classify([p], lanes).length === 1);
}
check('a plain module UI file is push-then-review', classify(['modules/chat-ui/ui/app.js', 'README.md'], lanes).length === 0 && fs.existsSync(path.join(ROOT, 'modules/chat-ui/ui/app.js')));
check('classify normalises backslashes', classify(['lib\\server.js'], lanes).length === 1);
check('classify reports the reason', (classify(['lib/journal.js'], lanes)[0] || {}).why.length > 0);

let r = run(['HEAD', 'HEAD']);
check('empty diff -> exit 0, push-then-review', r.status === 0 && /^lane: push-then-review/m.test(r.stdout), `status ${r.status}`);
r = run(['no-such-ref-xyz', 'HEAD']);
check('bad ref -> exit 1', r.status === 1, `status ${r.status}`);
r = run(['HEAD']);
check('missing argument -> exit 1', r.status === 1, `status ${r.status}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rlane-'));
const bad = path.join(tmp, 'bad.json');
fs.writeFileSync(bad, JSON.stringify({ lanes: [{ pattern: '([', why: 'broken' }] }));
r = run(['HEAD', 'HEAD'], { REVIEW_LANE_FILE: bad });
check('invalid regex in the lane file -> exit 1', r.status === 1, `status ${r.status}`);
r = run(['HEAD', 'HEAD'], { REVIEW_LANE_FILE: path.join(tmp, 'missing.json') });
check('unreadable lane file -> exit 1', r.status === 1, `status ${r.status}`);
fs.rmSync(tmp, { recursive: true, force: true });

// unknown top-level path: review-first unless its top-level entry is in known_top
check('unknown top-level folder is review-first (unknown top-level path)', (() => { const h = classify(['newdir/a.js'], lanes); return h.length === 1 && h[0].why === 'unknown top-level path'; })());
check('unknown top-level file is review-first (unknown top-level path)', (() => { const h = classify(['stray.sh'], lanes); return h.length === 1 && h[0].why === 'unknown top-level path'; })());
check('known ordinary path is push-then-review', classify(['modules/chat-ui/ui/app.js', 'docs/notes.md', 'README.md'], lanes).length === 0);
check('one review-first path among many ordinary ones makes the whole range review-first', (() => { const h = classify(['modules/chat-ui/ui/app.js', 'README.md', 'newdir/a.js', 'docs/notes.md'], lanes); return h.length === 1 && h[0].path === 'newdir/a.js'; })());
check('every top-level entry tracked today is known, except the settings dir', (() => { const top = [...new Set(spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split(String.fromCharCode(10)).filter(Boolean).map(x => x.split('/')[0]))]; return top.filter(x => !lanes.knownTop.includes(x)).join(',') === '.claude'; })());
check('a changed settings dir is review-first', classify(['.claude/settings.json'], lanes).length === 1);
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rlane-'));
const nokt = path.join(tmp2, 'nokt.json');
fs.writeFileSync(nokt, JSON.stringify({ lanes: [{ pattern: '^lib/', why: 'x' }] }));
r = run(['HEAD', 'HEAD'], { REVIEW_LANE_FILE: nokt });
check('lane file without known_top -> exit 1 (fail closed)', r.status === 1, 'status ' + r.status);
fs.rmSync(tmp2, { recursive: true, force: true });

const nbad = results.filter(x => !x).length;
console.log(`
${results.length - nbad}/${results.length} passed`);
process.exit(nbad ? 1 : 0);
