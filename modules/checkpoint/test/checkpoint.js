#!/usr/bin/env node
'use strict';
// Checkpoint layer (no model calls). The guard is run as the real hook process
// with hook JSON on stdin, inside a "task" (HARNESS_TASK_ID + HARNESS_TASK_DIR).
//  1. agent deletes 3 files via a bash bypass the guard misses -> restore brings
//     them back byte-identical; files added since are removed; >5 MB and ignored
//     files are skipped (logged) and untouched; restore is itself undoable
//  2. user's git status, index, HEAD, refs and whole .git unchanged after 20 checkpoints
//  3. restore without HARNESS_OWNER -> refused (exit 6), nothing changed;
//     engine env has no HARNESS_OWNER (agents naming HARNESS_OWNER are blocked by guard-base: its test)
//  4. overhead per checkpoint on the harness repo itself, median ms
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GUARD = path.join(ROOT, 'guards', 'guard.js');
const HARNESS = path.join(ROOT, 'bin', 'harness.js');
if (!require(path.join(ROOT, 'lib', 'config')).load().modules.checkpoint) { console.log('SKIP: checkpoint is not enabled in this config'); process.exit(0); }
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));
const state = path.join(base, 'state');
const w = path.join(base, 'w');
const TASK = 'tCK';
const env = { ...process.env, HARNESS_STATE_DIR: state, HARNESS_LOG_DIR: path.join(base, 'logs'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
delete env.HARNESS_OWNER;
const taskEnv = { ...env, HARNESS_TASK_ID: TASK, HARNESS_TASK_DIR: w };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const g = (...a) => execFileSync('git', a, { cwd: w, env, encoding: 'utf8' }).trim();
const hook = (tool, ti, e = taskEnv) => spawnSync(process.execPath, [GUARD], { env: e, input: JSON.stringify({ session_id: 's', tool_name: tool, tool_input: ti, cwd: w }), encoding: 'utf8' });
const ckpts = () => { try { return fs.readFileSync(path.join(state, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.type === 'checkpoint'); } catch { return []; } };
const harness = (args, extra = {}) => spawnSync(process.execPath, [HARNESS, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
const res = {};

function dirHash(d, skip) {
  const out = [];
  (function walk(p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (skip && skip(e.name)) continue;
      if (e.isDirectory()) walk(f); else out.push(path.relative(d, f) + ' ' + sha(fs.readFileSync(f)));
    }
  })(d);
  return out.sort();
}

// ---- the user's task folder: commits, staged, modified, untracked, ignored, big, CRLF, binary
fs.mkdirSync(path.join(w, 'sub'), { recursive: true });
g('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(w, 'a.txt'), 'alpha\r\nwindows line\r\n');
fs.writeFileSync(path.join(w, 'b.bin'), crypto.randomBytes(200000));
fs.writeFileSync(path.join(w, 'sub', 'c.txt'), 'gamma\n');
fs.writeFileSync(path.join(w, '.gitignore'), 'ignored.log\n');
g('add', '.'); g('commit', '-qm', 'base');
fs.appendFileSync(path.join(w, 'a.txt'), 'modified, not staged\n');
fs.writeFileSync(path.join(w, 's.txt'), 'staged\n'); g('add', 's.txt');
fs.writeFileSync(path.join(w, 'u.txt'), 'untracked\n');
fs.writeFileSync(path.join(w, 'ignored.log'), 'ignored\n');
fs.writeFileSync(path.join(w, 'big.bin'), Buffer.alloc(6 * 1024 * 1024, 7));
// a task_start line so restore can find the folder from the journal too
fs.mkdirSync(state, { recursive: true });
fs.appendFileSync(path.join(state, 'journal.jsonl'), JSON.stringify({ id: 'x', type: 'task_start', task_id: TASK, request: 'test', workdir: w }) + '\n');

// ---- 2. user's repo untouched by 20 checkpoints
g('status', '--porcelain'); // let git refresh its own index once, before we measure
const before = { status: g('status', '--porcelain=v2', '--branch', '-uall'), index: sha(fs.readFileSync(path.join(w, '.git', 'index'))), head: g('rev-parse', 'HEAD'), refs: g('for-each-ref'), gitdir: dirHash(path.join(w, '.git')) };
const tools = [['Write', { file_path: path.join(w, 'n.txt'), content: 'x' }], ['Edit', { file_path: path.join(w, 'a.txt'), old_string: 'a', new_string: 'b' }], ['Bash', { command: 'echo hi > out.txt' }], ['NotebookEdit', { notebook_path: path.join(w, 'n.ipynb'), new_source: 'x' }], ['PowerShell', { command: 'Set-Content x.txt 1' }]];
const hookExits = [];
for (let i = 0; i < 20; i++) { const [t, ti] = tools[i % tools.length]; hookExits.push(hook(t, ti).status); }
const gitdirAfter = dirHash(path.join(w, '.git')); // before running any git command in w
const after = { index: sha(fs.readFileSync(path.join(w, '.git', 'index'))), head: g('rev-parse', 'HEAD'), refs: g('for-each-ref'), status: g('status', '--porcelain=v2', '--branch', '-uall') };
const c20 = ckpts();
console.log(`2: 20 hook calls exit codes ${[...new Set(hookExits)]}; checkpoints journaled ${c20.length}; refs ${c20.map(c => c.n).join(',')}`);
console.log(`2: index sha same=${after.index === before.index}; HEAD same=${after.head === before.head}; refs same=${after.refs === before.refs}; status same=${after.status === before.status}; .git files same=${JSON.stringify(gitdirAfter) === JSON.stringify(before.gitdir)} (${before.gitdir.length} files)`);
res['2 user git status, index, HEAD, refs and whole .git unchanged after 20 checkpoints'] = hookExits.every(x => x === 0) && c20.length === 20 && after.index === before.index && after.head === before.head && after.refs === before.refs && after.status === before.status && JSON.stringify(gitdirAfter) === JSON.stringify(before.gitdir);

const last = c20[c20.length - 1];
console.log(`skipped (journal): ${JSON.stringify(last.skipped)}; files in snapshot ${last.files}`);
res['skip: >5 MB and .gitignore files skipped and logged'] = last.skipped.over_5mb.some(s => s.startsWith('big.bin')) && last.skipped.ignored.includes('ignored.log');

// read-only shell and non-mutating tools take no checkpoint
const n0 = ckpts().length;
for (const [t, ti] of [['Bash', { command: 'git status && ls -la | grep a' }], ['PowerShell', { command: 'Get-Content a.txt | Select-String alpha' }], ['Read', { file_path: path.join(w, 'a.txt') }], ['Grep', { pattern: 'x' }]]) hook(t, ti);
res['read-only shell / Read / Grep: no checkpoint'] = ckpts().length === n0;
// outside a task (no HARNESS_TASK_ID): no checkpoint
hook('Write', { file_path: path.join(w, 'z.txt'), content: 'z' }, env);
res['outside a task: no checkpoint'] = ckpts().length === n0;

// ---- 1. delete 3 files through a bypass the guard does not catch
const files = ['a.txt', 'b.bin', path.join('sub', 'c.txt')];
const orig = Object.fromEntries(files.map(f => [f, sha(fs.readFileSync(path.join(w, f)))]));
const bypass = `node -e "for (const f of ['a.txt','b.bin','sub/c.txt']) require('fs').unlinkSync(f)"`;
const hb = hook('Bash', { command: bypass });
const ck = ckpts().pop();
execFileSync(process.execPath, ['-e', "for (const f of ['a.txt','b.bin','sub/c.txt']) require('fs').unlinkSync(f)"], { cwd: w });
fs.writeFileSync(path.join(w, 'new-after.txt'), 'added after the checkpoint\n');
const gone = files.filter(f => !fs.existsSync(path.join(w, f)));
console.log(`1: guard on bypass: exit ${hb.status} (allowed), checkpoint n=${ck.n} tool=${ck.tool} ${ck.ms} ms; deleted: ${gone.join(', ')}`);

// ---- 3. restore without HARNESS_OWNER
const r3 = harness(['restore', TASK, String(ck.n)]);
const restoresBefore = fs.readFileSync(path.join(state, 'journal.jsonl'), 'utf8').includes('"type":"restore"');
console.log(`3: restore without HARNESS_OWNER: exit ${r3.status} "${r3.stderr.trim()}"`);
res['3 restore without HARNESS_OWNER -> refused (exit 6), files still gone, no restore line'] = r3.status === 6 && files.every(f => !fs.existsSync(path.join(w, f))) && !restoresBefore;
process.env.HARNESS_OWNER = '1';
process.env.HARNESS_STATE_DIR = state;
const engEnv = require('../../../bin/harness').cleanEnv();
delete process.env.HARNESS_OWNER;
res['3 engine env has no HARNESS_OWNER'] = !('HARNESS_OWNER' in engEnv.env) && engEnv.stripped.includes('HARNESS_OWNER');

// ---- 1. restore as owner
const big0 = sha(fs.readFileSync(path.join(w, 'big.bin'))); const ign0 = fs.readFileSync(path.join(w, 'ignored.log'), 'utf8');
const r1 = harness(['restore', TASK, String(ck.n)], { HARNESS_OWNER: '1' });
console.log(`1: restore as owner: exit ${r1.status} "${r1.stdout.trim()}${r1.stderr.trim()}"`);
const back = Object.fromEntries(files.map(f => [f, fs.existsSync(path.join(w, f)) ? sha(fs.readFileSync(path.join(w, f))) : null]));
console.log(`1: sha256 before/after: ${files.map(f => `${f} ${orig[f].slice(0, 12)}/${(back[f] || 'missing').slice(0, 12)}`).join('; ')}`);
res['1 three deleted files restored byte-identical (CRLF text, binary, subdir)'] = r1.status === 0 && files.every(f => back[f] === orig[f]);
res['1 file added after the checkpoint removed; >5 MB and ignored files untouched'] = !fs.existsSync(path.join(w, 'new-after.txt')) && sha(fs.readFileSync(path.join(w, 'big.bin'))) === big0 && fs.readFileSync(path.join(w, 'ignored.log'), 'utf8') === ign0;
const undoN = (r1.stdout.match(/restore \S+ (\d+)/) || [])[1];
const ru = harness(['restore', TASK, undoN], { HARNESS_OWNER: '1' });
console.log(`1: undo (restore ${undoN}): exit ${ru.status}; files gone again=${files.every(f => !fs.existsSync(path.join(w, f)))}; new-after.txt back=${fs.existsSync(path.join(w, 'new-after.txt'))}`);
res['1 restore is undoable (restore of the pre-restore checkpoint)'] = ru.status === 0 && files.every(f => !fs.existsSync(path.join(w, f))) && fs.existsSync(path.join(w, 'new-after.txt'));
const gitAfterRestore = dirHash(path.join(w, '.git'));
res['1 user .git still byte-identical after restore + undo'] = JSON.stringify(gitAfterRestore) === JSON.stringify(before.gitdir);

// ---- 4. overhead on the harness repo itself
const st2 = path.join(base, 'state2');
const perfEnv = { ...env, HARNESS_STATE_DIR: st2, HARNESS_TASK_ID: 'tPERF', HARNESS_TASK_DIR: ROOT };
const time = (t, ti, e) => { const t0 = process.hrtime.bigint(); const r = hook(t, ti, e); if (r.status !== 0) throw new Error(r.stderr); return Number(process.hrtime.bigint() - t0) / 1e6; };
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const cold = time('Write', { file_path: path.join(ROOT, 'x'), content: 'x' }, perfEnv);
const warm = []; for (let i = 0; i < 20; i++) warm.push(time('Write', { file_path: path.join(ROOT, 'x'), content: 'x' }, perfEnv));
const plain = []; for (let i = 0; i < 20; i++) plain.push(time('Write', { file_path: path.join(ROOT, 'x'), content: 'x' }, env));
const inner = fs.readFileSync(path.join(st2, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.type === 'checkpoint').slice(1).map(r => r.ms);
const files4 = JSON.parse(fs.readFileSync(path.join(st2, 'journal.jsonl'), 'utf8').trim().split('\n').pop()).files;
console.log(`4: harness repo (${files4} files): first checkpoint hook ${cold.toFixed(0)} ms; warm hook median ${median(warm).toFixed(0)} ms vs hook without checkpoint ${median(plain).toFixed(0)} ms -> overhead ${(median(warm) - median(plain)).toFixed(0)} ms; checkpoint work alone median ${median(inner)} ms (n=20)`);
res['4 overhead measured (20 warm runs)'] = warm.length === 20;

// ---- 5. undo skips points equal to the folder now (a checkpoint before a tool that changed nothing)
const st3 = path.join(base, 'state3'), w3 = path.join(base, 'w3');
fs.mkdirSync(w3, { recursive: true }); fs.mkdirSync(st3, { recursive: true });
const env3 = { ...env, HARNESS_STATE_DIR: st3 };
fs.writeFileSync(path.join(st3, 'journal.jsonl'), JSON.stringify({ id: 'x', ts: new Date().toISOString(), type: 'task_start', task_id: 'tNOOP', request: 'r', workdir: w3 }) + '\n');
const hook3 = () => spawnSync(process.execPath, [GUARD], { env: { ...env3, HARNESS_TASK_ID: 'tNOOP', HARNESS_TASK_DIR: w3 }, input: JSON.stringify({ session_id: 's', tool_name: 'Write', tool_input: { file_path: path.join(w3, 'hello.txt'), content: 'hi' }, cwd: w3 }), encoding: 'utf8' });
hook3(); fs.writeFileSync(path.join(w3, 'hello.txt'), 'hi\n'); hook3(); hook3();
const u5 = spawnSync(process.execPath, [HARNESS, 'undo'], { env: env3, encoding: 'utf8' });
console.log(`5: undo after a no-op point: exit ${u5.status}; ${String(u5.stdout).split('\n')[0]}`);
res['5 one undo removes the file even when the newest points match the folder'] = u5.status === 0 && !fs.existsSync(path.join(w3, 'hello.txt')) && /removed 1 file/.test(u5.stdout);
const u5b = spawnSync(process.execPath, [HARNESS, 'undo'], { env: env3, encoding: 'utf8' });
res['5 next undo says nothing is left'] = u5b.status === 0 && /nothing left to undo/.test(u5b.stdout);

let ok = true;
for (const [k, v] of Object.entries(res)) { ok = ok && v; console.log(`${v ? 'PASS' : 'FAIL'} ${k}`); }
fs.rmSync(base, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
