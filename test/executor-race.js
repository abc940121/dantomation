#!/usr/bin/env node
'use strict';
// Note: on Windows, Node kills non-detached children when the parent dies (job
// object), so the surviving child in A is spawned detached on purpose.
// Surviving-child race: a child that acts after a 5 s delay, its parent killed
// alone (child keeps running), and a resume started at once. Exactly one
// executor may perform the effect.
//   A. effect level : parent -> effect.js write (pauses 5 s before the act)
//   B. harness level: harness.js -> fake engine (waits 5 s, then acts)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EFFECT = path.join(ROOT, 'bin', 'effect.js');
const HARNESS = path.join(ROOT, 'bin', 'harness.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'race-'));
const state = path.join(base, 'state');
const env = { ...process.env, HARNESS_STATE_DIR: state, HARNESS_LOG_DIR: path.join(base, 'logs') };
const tick = ms => new Promise(r => setTimeout(r, ms));
const journal = () => fs.readFileSync(path.join(state, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const waitFor = async (fn, ms = 60000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await tick(100); return fn(); };
const killOnly = pid => execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); // no /T: children survive

async function main() {
  const res = {};
  fs.mkdirSync(state, { recursive: true });

  // ---- A. effect level
  {
    const file = path.join(base, 'a.txt');
    const parentCode = `const c=require('child_process').spawn(process.execPath,[${JSON.stringify(EFFECT)},'write','RA','s1-write',${JSON.stringify(file)}],{stdio:['pipe','ignore','ignore'],detached:true});c.stdin.end('hello\\n');require('fs').writeFileSync(${JSON.stringify(path.join(base, 'childA.pid'))},String(c.pid));setInterval(()=>{},1000);`;
    const parent = spawn(process.execPath, ['-e', parentCode], { env: { ...env, HARNESS_PAUSE_BEFORE_ACT_MS: '5000' }, stdio: 'ignore', windowsHide: true });
    await waitFor(() => fs.existsSync(path.join(state, 'paused.flag')));
    const childPid = Number(fs.readFileSync(path.join(base, 'childA.pid'), 'utf8'));
    killOnly(parent.pid);
    const second = spawnSync(process.execPath, [EFFECT, 'write', 'RA', 's1-write', file], { env, input: 'hello\n', encoding: 'utf8' });
    const childAliveAtResume = alive(childPid);
    await waitFor(() => !alive(childPid), 30000);
    const done = journal().filter(r => r.task_id === 'RA' && r.type === 'effect_done');
    const third = spawnSync(process.execPath, [EFFECT, 'write', 'RA', 's1-write', file], { env, input: 'hello\n', encoding: 'utf8' });
    console.log(`A: child alive at resume=${childAliveAtResume}; resume -> exit ${second.status} "${second.stdout.trim()}"; done lines ${JSON.stringify(done.map(d => d.mode))}; rerun after -> "${third.stdout.trim()}"`);
    res['A effect: resume gets BUSY while child lives'] = childAliveAtResume && second.status === 4 && /BUSY/.test(second.stdout);
    res['A effect: exactly one performed'] = done.length === 1 && done[0].mode === 'performed' && fs.readFileSync(file, 'utf8') === 'hello\n';
    res['A effect: later rerun skips'] = /SKIP/.test(third.stdout);
    fs.rmSync(path.join(state, 'paused.flag'), { force: true });
  }

  // ---- B. harness level (fake engine; never the real claude)
  const fenv = { ...env, HARNESS_ENGINE_SCRIPT: path.join(__dirname, 'fake-engine.js'), HARNESS_FAKE_DELAY_MS: '5000' };
  const H = (...a) => spawnSync(process.execPath, [HARNESS, ...a], { env: fenv, encoding: 'utf8', timeout: 60000 });
  const lockFile = path.join(state, 'executor.lock');
  const readLock = () => { try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return null; } };
  const startBg = (req, dir) => spawn(process.execPath, [HARNESS, 'start', req, '--workdir', path.join(base, dir)], { env: fenv, stdio: 'ignore', windowsHide: true });
  const taskOf = req => journal().find(x => x.type === 'task_start' && x.request === req).task_id;
  {
    // B1: kill harness only while the engine waits; resume at once
    const h = startBg('race task 1', 'w1');
    await waitFor(() => (readLock() || { pids: [] }).pids.length === 2);
    const enginePid = readLock().pids[1];
    killOnly(h.pid);
    const engineAlive = alive(enginePid);
    const r = H('resume');
    await waitFor(() => !alive(enginePid), 30000);
    const t = taskOf('race task 1');
    const rs = journal().filter(x => x.task_id === t);
    const done = rs.filter(x => x.type === 'effect_done');
    console.log(`B1: engine alive after harness kill=${engineAlive}; resume exit ${r.status} ${(r.stdout + r.stderr).trim()}; engine_start ${rs.filter(x => x.type === 'engine_start').length}; done ${JSON.stringify(done.map(d => d.effect_id + ':' + d.mode))}`);
    res['B1 kill parent only: each effect performed once, task done'] = (engineAlive ? r.status === 4 : r.status === 0) && done.length === 2 && done.every(d => d.mode === 'performed') && rs.some(x => x.type === 'task_done');
  }
  {
    // B2: harness dead but an engine pid in the lock still alive -> refuse
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { detached: true, stdio: 'ignore', windowsHide: true });
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    fs.writeFileSync(lockFile, JSON.stringify({ pids: [Number(dead), sleeper.pid], task_id: 'tX' }));
    const r = H('resume');
    execSync(`taskkill /F /PID ${sleeper.pid}`, { stdio: 'ignore' });
    await waitFor(() => !alive(sleeper.pid), 10000);
    const r2 = H('resume');
    console.log(`B2: surviving engine pid -> exit ${r.status} "${r.stderr.trim()}"; after it exits -> exit ${r2.status} "${r2.stdout.trim()}", lock left=${fs.existsSync(lockFile)}`);
    res['B2 surviving engine pid: resume refused'] = r.status === 4 && /still running/.test(r.stderr);
    res['B2 stale lock taken over once pids are dead'] = r2.status === 0 && /nothing to resume/.test(r2.stdout) && !fs.existsSync(lockFile);
  }
  {
    // B3: second resume while the first harness is still running -> refuse
    const h = startBg('race task 3', 'w3');
    await waitFor(() => (readLock() || { pids: [] }).pids.length === 2);
    const r = H('resume');
    await new Promise(ok => h.on('exit', ok));
    const t = taskOf('race task 3');
    const done = journal().filter(x => x.task_id === t && x.type === 'effect_done');
    console.log(`B3: concurrent resume -> exit ${r.status}; done ${JSON.stringify(done.map(d => d.effect_id + ':' + d.mode))}`);
    res['B3 concurrent resume refused, effects once'] = r.status === 4 && done.length === 2;
  }

  let ok = true;
  for (const [k, v] of Object.entries(res)) { ok = ok && v; console.log(`${v ? 'PASS' : 'FAIL'} ${k}`); }
  fs.rmSync(base, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
