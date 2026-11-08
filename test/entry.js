#!/usr/bin/env node
'use strict';
// Entry (no model calls): the Quickstart in README.md, run literally against the fake engine.
//  - the fenced block tagged "sh quickstart" is extracted and every `node ...` line executed
//  - do runs a task to done; status shows it; undo restores out.txt; a second undo steps back
//    further; a third says nothing is left
//  - undo prints how to get back; running that restore brings the pre-undo content back exactly
//  - undo refuses with HARNESS_TASK_ID set; the guard blocks an agent Bash call naming the verb
//  - undo with checkpoint off says how to turn it on and exits non-zero
// Checkpoints come from the fake engine calling the real guard hook (HARNESS_FAKE_GUARD=1).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const res = {};
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-'));
const cfg = on => {
  const f = path.join(base, 'config-' + (on ? 'on' : 'off') + '.json');
  fs.writeFileSync(f, JSON.stringify({ owner_name: 'Tester', modules: { 'guard-base': true, checkpoint: on } }));
  return f;
};
const mkEnv = (name, on) => {
  const d = path.join(base, name);
  const env = { ...process.env, HARNESS_CONFIG: cfg(on), HARNESS_STATE_DIR: path.join(d, 'state'), HARNESS_LOG_DIR: path.join(d, 'logs'), HARNESS_WORK_DIR: path.join(d, 'work'),
    HARNESS_ENGINE_SCRIPT: path.resolve(ROOT, 'test', 'fake-engine.js'), HARNESS_FAKE_DELAY_MS: '0', HARNESS_FAKE_GUARD: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  delete env.HARNESS_OWNER; delete env.HARNESS_TASK_ID; delete env.HARNESS_TASK_DIR;
  return { d, env };
};

// ---- the Quickstart block
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const m = readme.match(/```sh quickstart\r?\n([\s\S]*?)```/);
const lines = m ? m[1].split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')) : [];
res['README has a "sh quickstart" block with do, status, undo, undo'] = lines.length === 4 && /\bdo\b/.test(lines[0]) && /\bstatus$/.test(lines[1]) && /\bundo$/.test(lines[2]) && /\bundo$/.test(lines[3]);
const tokens = l => (l.match(/"[^"]*"|\S+/g) || []).map(t => t.replace(/^"|"$/g, ''));
const run = (line, env, extra = {}) => {
  const t = tokens(line);
  if (t[0] !== 'node') throw new Error('quickstart line must start with node: ' + line);
  const r = spawnSync(process.execPath, t.slice(1), { cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

const { d, env } = mkEnv('on', true);
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const [doL, statusL, undoL, undo2L] = lines;
const doR = run(doL, env);
const journal = (read(path.join(d, 'state', 'journal.jsonl')) || '').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const start = journal.find(r => r.type === 'task_start');
const outFile = start && path.join(start.workdir, 'out.txt');
const request = start && start.request;
res['do runs the task to done (exit 0, task_done, out.txt has the 2nd change)'] = doR.status === 0 && journal.some(r => r.type === 'task_done') && /second change/.test(read(outFile) || '');
res['two agent checkpoints were made through the guard'] = journal.filter(r => r.type === 'checkpoint').length === 2;

const st = run(statusL, env);
res['status shows last finished task, undo points 2, modules, and not the raw prompt'] = st.status === 0 && /no open task/.test(st.out) && st.out.includes(request) && /undo points: 2/.test(st.out) && /modules on: guard-base, checkpoint/.test(st.out) && !/## Current task|## History/.test(st.out);

const beforeUndo = read(outFile);
const u1 = run(undoL, env);
res['undo #1 restores out.txt to the earlier content'] = u1.status === 0 && read(outFile) === request + '\n';
const back = (u1.out.match(/restore (\S+) (\d+)/) || []);
res['undo prints how to get back (restore <task> <n>)'] = back[1] === start.task_id && u1.out.includes("Undo this with: HARNESS_OWNER=1 node bin/harness.js restore");
const redo = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'restore', back[1] || 'x', back[2] || '0'], { cwd: ROOT, env: { ...env, HARNESS_OWNER: '1' }, encoding: 'utf8' });
res['undo, then redo by restore: content is back exactly'] = redo.status === 0 && beforeUndo !== null && beforeUndo !== request + '\n' && read(outFile) === beforeUndo;
const u2 = run(undo2L, env);
res['undo #2 steps back further (out.txt gone)'] = u2.status === 0 && !fs.existsSync(outFile);
const u3 = run(undo2L, env);
res['undo #3 says nothing is left (exit 0, file still gone)'] = u3.status === 0 && /nothing left to undo/.test(u3.out) && !fs.existsSync(outFile);
res['status after undos shows 0 undo points'] = /undo points: 0/.test(run(statusL, env).out);

// ---- do with an open task
const again = run(doL, env);
res['do "<request>" starts a new task once the last is done'] = again.status === 0;
fs.appendFileSync(path.join(d, 'state', 'journal.jsonl'), JSON.stringify({ id: 'x', ts: new Date().toISOString(), type: 'task_start', task_id: 'tOPEN', request: 'half done thing', workdir: path.join(d, 'work', 'tOPEN') }) + '\n');
const refuse = run(doL, env);
res['do "<request>" with an open task refuses and says how to resume'] = refuse.status !== 0 && /still open/.test(refuse.out) && /dantomation do/.test(refuse.out);
const so = run(statusL, env);
res['status shows the open task (request, steps done, last step)'] = /open task: tOPEN/.test(so.out) && /half done thing/.test(so.out) && /steps done: 0/.test(so.out) && /last step: none yet/.test(so.out);

// ---- agents cannot undo
const inEngine = run(undoL, env, { HARNESS_TASK_ID: 'tX' });
res['undo refuses with HARNESS_TASK_ID set (exit 6)'] = inEngine.status === 6 && /not for agents/.test(inEngine.out);
const GUARD = path.join(ROOT, 'guards', 'guard.js');
const hook = command => spawnSync(process.execPath, [GUARD], { cwd: ROOT, env, input: JSON.stringify({ session_id: 's', tool_name: 'Bash', tool_input: { command }, cwd: ROOT }), encoding: 'utf8' });
const verbCmds = ['node bin/dantomation.js undo', 'bin/dantomation undo', 'dantomation.cmd undo', 'node "bin/dantomation.js"   undo', 'node bin/harness.js undo'];
res['guard blocks an agent Bash call to the undo verb (5 spellings)'] = verbCmds.every(c => { const r = hook(c); return r.status === 2 && /owner_only/.test(r.stderr); });
res['guard still allows do and status for agents'] = ['node bin/dantomation.js status', 'node bin/dantomation.js do "x"'].every(c => hook(c).status === 0);

// ---- checkpoint off
const off = mkEnv('off', false);
run(doL, off.env);
const noCk = run(undoL, off.env);
res['undo with checkpoint off: non-zero, says how to turn it on'] = noCk.status !== 0 && /checkpoint/.test(noCk.out) && /"checkpoint": true/.test(noCk.out);
res['status with checkpoint off shows no undo line'] = !/undo points/.test(run(statusL, off.env).out);

fs.rmSync(base, { recursive: true, force: true });
let fails = 0;
for (const [k, v] of Object.entries(res)) { console.log((v ? 'PASS' : 'FAIL') + '  ' + k); if (!v) fails++; }
if (fails) { console.log('--- last outputs ---'); console.log(doR.out, st.out, u1.out, u2.out, u3.out); }
console.log('result: ' + (fails ? 'FAIL' : 'PASS') + ' (' + (Object.keys(res).length - fails) + '/' + Object.keys(res).length + ')');
process.exit(fails ? 1 : 0);
