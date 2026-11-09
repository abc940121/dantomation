#!/usr/bin/env node
'use strict';
// Fork from step N (no model calls): steps list, fork into a new dir, original untouched,
// diff, retention cap, path safety, prepareTurn note, routes and command wiring.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
if (!require(path.join(ROOT, 'lib', 'config')).load().modules.checkpoint) { console.log('SKIP: checkpoint is not enabled in this config'); process.exit(0); }
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ckf-'));
process.env.HARNESS_STATE_DIR = path.join(base, 'state');
delete process.env.HARNESS_TASK_ID;
process.env.GIT_AUTHOR_NAME = 't'; process.env.GIT_AUTHOR_EMAIL = 't@t';
const ck = require('../checkpoint');
const fk = require('../fork');
const mod = require('../index');
const w = path.join(base, 'w');
const TASK = 'tFORK';
const res = {};
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const tree = d => { const o = []; (function walk(p) { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else o.push(path.relative(d, f).replace(/\\/g, '/') + ' ' + sha(fs.readFileSync(f))); } })(d); return o.sort(); };
const throws = f => { try { f(); return false; } catch { return true; } };

fs.mkdirSync(path.join(w, 'sub'), { recursive: true });
require('../../../lib/journal').append({ type: 'task_start', task_id: TASK, request: 't', workdir: w });
fs.writeFileSync(path.join(w, 'a.txt'), 'one\r\n');
fs.writeFileSync(path.join(w, 'sub', 'b.bin'), crypto.randomBytes(5000));
ck.checkpoint(TASK, w, 'Write'); // step 1
fs.writeFileSync(path.join(w, 'a.txt'), 'two\n');
fs.writeFileSync(path.join(w, 'c.txt'), 'new\n');
fs.rmSync(path.join(w, 'sub', 'b.bin'));
ck.checkpoint(TASK, w, 'Bash'); // step 2
fs.writeFileSync(path.join(w, 'a.txt'), 'three\n');
ck.checkpoint(TASK, w, 'Edit'); // step 3
const origBefore = tree(w);

const st = fk.steps(TASK);
res['steps: 3 steps with number, tool, time and ref'] = st.length === 3 && st[1].tool === 'Bash' && st.every(s => s.step && s.time && s.ref.endsWith('/' + s.step));

const forkBase = path.join(base, 'forks');
const f1 = fk.fork(TASK, 1, { base: forkBase, max: 2 });
res['fork: new dir under base, content equals step 1 (CRLF and binary)'] = f1.path.startsWith(forkBase) && fs.readFileSync(path.join(f1.path, 'a.txt'), 'utf8') === 'one\r\n' && fs.existsSync(path.join(f1.path, 'sub', 'b.bin')) && !fs.existsSync(path.join(f1.path, 'c.txt'));
res['fork: original folder untouched'] = JSON.stringify(tree(w)) === JSON.stringify(origBefore);
const recs = fk.forks();
res['fork: record has parent task, step, new path'] = recs.length === 1 && recs[0].parent_task === TASK && recs[0].step === 1 && recs[0].path === f1.path;

const d = fk.diff(TASK, 1, 2);
const has = (s, p) => d.some(x => x.status === s && x.path === p);
res['diff 1->2: modified, added, deleted'] = has('M', 'a.txt') && has('A', 'c.txt') && has('D', 'sub/b.bin');

const f2 = fk.fork(TASK, 2, { base: forkBase, max: 2 });
const f3 = fk.fork(TASK, 3, { base: forkBase, max: 2, pruneDirs: true });
res['retention: cap 2 keeps the newest two records'] = JSON.stringify(fk.forks().map(r => r.id)) === JSON.stringify([f2.id, f3.id]);
res['retention: dropped dir removed only with pruneDirs; others kept'] = !fs.existsSync(f1.path) && fs.existsSync(f2.path) && fs.existsSync(f3.path);

const bads = ['../x', '..', 'a/b', 'a\\b', '', '.hidden', 'x\0y', 'a'.repeat(200)];
res['safety: bad task ids rejected'] = bads.every(t => throws(() => fk.fork(t, 1, { base: forkBase })) && throws(() => fk.steps(t)));
res['safety: bad step numbers rejected'] = ['0', '-1', '1.5', '../1', 'x', '99999999999'].every(n => throws(() => fk.fork(TASK, n, { base: forkBase })));
res['safety: unknown step rejected'] = throws(() => fk.fork(TASK, 50, { base: forkBase }));
res['safety: base inside the original folder refused, nothing created'] = throws(() => fk.fork(TASK, 1, { base: path.join(w, 'forks') })) && !fs.existsSync(path.join(w, 'forks'));
res['safety: original still untouched after refusals'] = JSON.stringify(tree(w)) === JSON.stringify(origBefore);
res['safety: every fork dir is a direct child of base'] = fk.forks().every(r => path.dirname(r.path) === path.resolve(forkBase));

const pt = mod.prepareTurn({ workdir: f2.path });
res['prepareTurn: note for a fork workdir names step and parent task'] = !!pt && /continuing from step 2 of task tFORK/.test(pt.context[0]);
res['prepareTurn: null for a normal workdir, never throws on junk'] = mod.prepareTurn({ workdir: w }) === null && mod.prepareTurn(null) === null && mod.prepareTurn({ workdir: 5 }) === null;

const route = (m, p) => mod.routes.find(r => r.method === m && r.path === p);
res['routes: four, owner access'] = mod.routes.length === 4 && mod.routes.every(r => !r.access || r.access === 'owner');
res['routes: steps and diff'] = route('GET', '/steps/:task').handler({ params: { task: TASK } }).json.steps.length === 3 && route('GET', '/diff/:task/:a/:b').handler({ params: { task: TASK, a: '1', b: '2' } }).json.changes.length === 3;
const rf = route('POST', '/fork/:task/:n').handler({ params: { task: TASK, n: '1' }, settings: { fork_dir: forkBase, max_forks: 5 } });
res['routes: fork ok under configured dir; bad input is 400, not a throw'] = rf.status === 200 && rf.json.fork.path.startsWith(forkBase) && route('POST', '/fork/:task/:n').handler({ params: { task: '../x', n: '1' }, settings: {} }).status === 400;

const HARNESS = path.join(ROOT, 'bin', 'harness.js');
const env = { ...process.env, HARNESS_STATE_DIR: path.join(base, 'state'), HARNESS_LOG_DIR: path.join(base, 'logs') };
const c1 = spawnSync(process.execPath, [HARNESS, 'fork', 'steps', TASK], { env, encoding: 'utf8' });
const c2 = spawnSync(process.execPath, [HARNESS, 'fork', 'steps', TASK], { env: { ...env, HARNESS_TASK_ID: 'x' }, encoding: 'utf8' });
res['command: fork steps lists 3 lines; exit 6 inside an engine'] = c1.status === 0 && c1.stdout.trim().split('\n').length === 3 && c2.status === 6;

let ok = true;
for (const [k, v] of Object.entries(res)) { ok = ok && v; console.log(`${v ? 'PASS' : 'FAIL'} ${k}`); }
fs.rmSync(base, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
