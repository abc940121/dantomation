#!/usr/bin/env node
'use strict';
// A3 / A3b: start a 5-step task, kill the whole process tree, resume, verify.
//   node test/a3-resume.js a3            kill as soon as step 3 starts
//   node test/a3-resume.js a3b-write     kill between s3-write's act and its journal line
//   node test/a3-resume.js a3b-commit    kill between s3-commit's act and its journal line
// Uses a throwaway state dir and work repo; the harness's own state/ is untouched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync, execSync } = require('child_process');

const mode = process.argv[2] || 'a3';
const ROOT = path.resolve(__dirname, '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), `${mode}-`));
const stateDir = path.join(base, 'state');
const work = path.join(base, 'work');
const journal = path.join(stateDir, 'journal.jsonl');
const env = { ...process.env, HARNESS_STATE_DIR: stateDir, HARNESS_LOG_DIR: path.join(base, 'logs') };
const pauseEnv = mode === 'a3' ? {} : { HARNESS_PAUSE_AFTER_ACT_MS: '600000', HARNESS_PAUSE_EFFECT: mode === 'a3b-write' ? 's3-write' : 's3-commit' };

const REQUEST = 'Five steps. For each step n from 1 to 5, in order: (a) record step n started; (b) write the file stepN.txt (N is the number) containing exactly the single line "step N", effect id sN-write; (c) commit that file with message "step N", effect id sN-commit; (d) record step n done. One Bash call per command. When all five steps are done, mark the task done. Do nothing else.';

const records = () => { try { return fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { torn: true }; } }); } catch { return []; } };
const tick = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

function survivors() {
  const out = execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -notin @('powershell.exe','cmd.exe') -and ($_.CommandLine -like '*effect.js*' -or $_.CommandLine -like '*${path.basename(base)}*') } | ForEach-Object { $_.Name + ':' + $_.ProcessId }"`, { encoding: 'utf8' , windowsHide: true });
  return out.split(/\s+/).filter(Boolean);
}

async function main() {
  fs.mkdirSync(work, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: work , windowsHide: true });
  log(`mode ${mode}; base ${base}`);
  const h = spawn(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'start', REQUEST, '--workdir', work], { env: { ...env, ...pauseEnv }, stdio: 'ignore', windowsHide: true });
  const t0 = Date.now();
  let killed = false;
  while (Date.now() - t0 < 600000) {
    await tick(300);
    const rs = records();
    const trigger = mode === 'a3'
      ? rs.some(r => r.type === 'step' && r.step === 3 && r.status === 'started')
      : fs.existsSync(path.join(stateDir, 'paused.flag'));
    if (trigger) {
      execSync(`taskkill /T /F /PID ${h.pid}`, { stdio: 'ignore' , windowsHide: true });
      killed = true;
      log(`killed tree of harness pid ${h.pid}`);
      break;
    }
  }
  if (!killed) { console.log('BLOCKED: trigger never reached'); process.exit(1); }
  await tick(1500);
  const left = survivors();
  log(`processes left after kill: ${left.length ? left.join(',') : 'none'}`);
  const before = records();
  const s3 = before.filter(r => /^s3-/.test(r.effect_id || '')).map(r => `${r.type}:${r.effect_id}${r.mode ? ':' + r.mode : ''}`);
  log(`journal at kill: ${before.length} lines; s3 records: ${s3.join(' ') || 'none'}`);
  log(`git log at kill: ${execFileSync('git', ['log', '--oneline', '--all'], { cwd: work, encoding: 'utf8' }).trim().split('\n').filter(Boolean).length} commits`);

  const tr = Date.now();
  const code = await new Promise(res => {
    const r = spawn(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'resume'], { env, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { execSync(`taskkill /T /F /PID ${r.pid}`, { stdio: 'ignore' , windowsHide: true }); res('timeout'); }, 600000);
    r.on('exit', c => { clearTimeout(timer); res(c); });
  });
  const resumeSec = Math.round((Date.now() - tr) / 1000);

  // ---- verify
  const rs = records();
  const fail = [];
  const perEffect = {};
  for (const r of rs.filter(r => r.type === 'effect_done')) {
    perEffect[r.effect_id] = perEffect[r.effect_id] || { performed: 0, reconciled: 0 };
    perEffect[r.effect_id][r.mode]++;
  }
  for (let n = 1; n <= 5; n++) for (const v of ['write', 'commit']) {
    const e = perEffect[`s${n}-${v}`];
    if (!e) fail.push(`s${n}-${v} missing`);
    else if (e.performed + e.reconciled !== 1 || e.performed > 1) fail.push(`s${n}-${v} done ${JSON.stringify(e)}`);
  }
  const logLines = execFileSync('git', ['log', '--all', '--format=%B%x00'], { cwd: work, encoding: 'utf8' , windowsHide: true }).split('\0').filter(s => s.trim());
  const trailerCounts = {};
  for (const m of logLines) { const t = (m.match(/Effect-Id: \S+\/(s\d-commit)/) || [])[1]; if (t) trailerCounts[t] = (trailerCounts[t] || 0) + 1; }
  for (let n = 1; n <= 5; n++) {
    if (trailerCounts[`s${n}-commit`] !== 1) fail.push(`git: s${n}-commit appears ${trailerCounts[`s${n}-commit`] || 0}x`);
    const f = path.join(work, `step${n}.txt`);
    const c = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : null;
    if (c !== `step ${n}`) fail.push(`step${n}.txt content ${JSON.stringify(c)}`);
  }
  const ids = rs.map(r => r.id);
  if (new Set(ids).size !== ids.length) fail.push('duplicate journal ids');
  const taskDone = rs.some(r => r.type === 'task_done');
  if (!taskDone) fail.push('task_done missing');
  if (resumeSec > 600) fail.push('resume over 10 min');

  log(`resume exit ${code} in ${resumeSec}s`);
  log(`effects: ${JSON.stringify(perEffect)}`);
  log(`git commits: ${logLines.length}; Effect-Id counts ${JSON.stringify(trailerCounts)}`);
  log(`journal lines ${rs.length}, torn ${rs.filter(r => r.torn).length}, unique ids ${new Set(ids).size}`);
  console.log(`${mode.toUpperCase()}: ${fail.length ? 'FAIL ' + fail.join('; ') : 'PASS'}`);
  console.log(`artifacts kept at ${base}`);
}

main().catch(e => { console.error(e); process.exit(1); });
