#!/usr/bin/env node
'use strict';
// voice: a voice turn that never unlocks must not block typed tasks for the life
// of the long-lived voice claude. No model calls: a fake bridge (stands in for
// voice/bridge.py) spawns a fake claude that, like `claude -p --input-format
// stream-json`, exits CLAUDE_EXIT_MS after its stdin closes.
//   A. same bridge, turn-begin twice with no turn-end -> 2nd turn gets the lock
//   B. typed task during a live turn: waits (short wait -> exit 4, long wait -> runs)
//   C. kill the bridge between turn-begin and turn-end, restart it, start a task -> runs
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HARNESS = path.join(ROOT, 'bin', 'harness.js');
const SEAM = path.join(ROOT, 'modules', 'voice', 'harness_seam.js');
if (!require(path.join(ROOT, 'lib', 'config')).load().modules.voice) { console.log('SKIP: voice is not enabled in this config'); process.exit(0); }
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-'));
const state = path.join(base, 'state');
const env = { ...process.env, HARNESS_STATE_DIR: state, HARNESS_LOG_DIR: path.join(base, 'logs'), HARNESS_ENGINE_SCRIPT: path.join(ROOT, 'test', 'fake-engine.js'), HARNESS_FAKE_DELAY_MS: '200' };
delete env.HARNESS_OWNER;
const tick = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const waitFor = async (fn, ms = 30000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await tick(100); return fn(); };
const killOnly = pid => execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); // no /T: the claude child survives
const journal = () => fs.readFileSync(path.join(state, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const lockFile = path.join(state, 'executor.lock');
const readLock = () => { try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return null; } };

// fake claude: lives until stdin closes, then exits after CLAUDE_EXIT_MS
const CLAUDE = path.join(base, 'fake-claude.js');
fs.writeFileSync(CLAUDE, `process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => process.exit(0), Number(process.env.CLAUDE_EXIT_MS || 0))); setInterval(() => {}, 1000);\n`);
// fake bridge: spawns claude (detached, like a python child that outlives a
// killed parent), then runs the turns named in argv: b = turn-begin, e = turn-end.
const BRIDGE = path.join(base, 'fake-bridge.js');
fs.writeFileSync(BRIDGE, `
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const [out, turns] = process.argv.slice(2);
const c = spawn(process.execPath, [${JSON.stringify(CLAUDE)}], { stdio: ['pipe', 'ignore', 'ignore'], detached: true, windowsHide: true });
const log = [];
let nonce = null;
for (const t of turns.split(',')) {
  if (t === 'b') { const r = JSON.parse(execFileSync(process.execPath, [${JSON.stringify(SEAM)}, 'turn-begin', 'voice-1', String(process.pid), String(c.pid)], { encoding: 'utf8' })); nonce = r.nonce; log.push({ begin: r.locked }); }
  if (t === 'e') { execFileSync(process.execPath, [${JSON.stringify(SEAM)}, 'turn-end', String(nonce)]); log.push({ end: true }); }
}
fs.writeFileSync(out, JSON.stringify({ bridge: process.pid, claude: c.pid, log }));
if (process.env.BRIDGE_EXIT) { c.stdin.end(); setTimeout(() => process.exit(0), 50); } else setInterval(() => {}, 1000);
`);
let nb = 0;
async function bridge(turns, extra = {}) {
  const out = path.join(base, `b${++nb}.json`);
  const p = spawn(process.execPath, [BRIDGE, out, turns], { env: { ...env, ...extra }, stdio: 'ignore', windowsHide: true });
  await waitFor(() => fs.existsSync(out));
  return { proc: p, ...JSON.parse(fs.readFileSync(out, 'utf8')) };
}
const start = (req, extra = {}) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HARNESS, 'start', req, '--workdir', path.join(base, 'w-' + req.replace(/\W/g, ''))], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000 });
  return { ...r, ms: Date.now() - t0 };
};

async function main() {
  const res = {};
  fs.mkdirSync(state, { recursive: true });

  // ---- A. one bridge, a turn that never ended, then the next turn
  {
    const b = await bridge('b,b');
    const released = journal().filter(r => r.type === 'voice_lock_released').length;
    console.log(`A: bridge ${b.bridge}, claude ${b.claude}; turn 1 locked=${b.log[0].begin}, (no turn-end), turn 2 locked=${b.log[1].begin}; voice_lock_released lines ${released}`);
    res['A next turn of the same bridge releases its own stale lock and gets it'] = b.log[0].begin === true && b.log[1].begin === true && released === 1;
    // B1: typed task while that turn is live and short wait -> exit 4
    const s1 = start('during turn', { HARNESS_VOICE_WAIT_MS: '1500' });
    console.log(`B: start during a live voice turn, wait 1.5 s: exit ${s1.status} after ${s1.ms} ms "${s1.stderr.trim().split('\n').pop()}"`);
    res['B start during a live voice turn waits, then exit 4 when the turn outlasts the wait'] = s1.status === 4 && s1.ms >= 1400;
    // B2: the turn ends 3 s later -> a waiting start runs
    const s2p = spawn(process.execPath, [HARNESS, 'start', 'waits for turn', '--workdir', path.join(base, 'w-b2')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const t0 = Date.now();
    await tick(3000);
    const lk = readLock();
    execFileSyncSafe([SEAM, 'turn-end', lk && lk.nonce]);
    const s2 = await new Promise(r => s2p.on('exit', code => r(code)));
    const doneB2 = journal().some(r => r.type === 'task_done' && journal().find(x => x.type === 'task_start' && x.request === 'waits for turn' && x.task_id === r.task_id));
    console.log(`B: start during turn, turn ends after 3 s: exit ${s2} after ${Date.now() - t0} ms; task done=${doneB2}`);
    res['B start waits for a voice turn to end, then runs'] = s2 === 0 && doneB2;
    killOnly(b.bridge); await waitFor(() => !alive(b.claude), 15000);
  }

  // ---- C. bridge killed between turn-begin and turn-end; claude orphan exits 4 s after stdin EOF
  {
    const b = await bridge('b', { CLAUDE_EXIT_MS: '4000' });
    const lk = readLock();
    killOnly(b.bridge);
    const orphanAlive = alive(b.claude);
    console.log(`C: bridge ${b.bridge} killed mid-turn (lock pids ${lk.pids}); claude orphan alive right after=${orphanAlive}`);
    // bridge restarts at once: its first turn-begin (orphan still holds the lock) then turn-end
    const b2 = await bridge('b,e', { BRIDGE_EXIT: '1' });
    console.log(`C: restarted bridge ${b2.bridge}: turn-begin locked=${b2.log[0].begin} (orphan still alive=${alive(b.claude)}), turn-end done`);
    const s = start('after crash');
    const orphanGone = !alive(b.claude);
    const done = journal().some(r => r.type === 'task_done' && journal().find(x => x.type === 'task_start' && x.request === 'after crash' && x.task_id === r.task_id));
    console.log(`C: start after restart: exit ${s.status} after ${s.ms} ms; task done=${done}; orphan exited on stdin EOF=${orphanGone}`);
    res['C kill bridge mid-turn, restart, start a task -> runs'] = s.status === 0 && done && orphanGone && s.ms < 60000;
    const lockLeft = readLock();
    res['C no lock left behind'] = lockLeft === null;
  }

  let ok = true;
  for (const [k, v] of Object.entries(res)) { ok = ok && v; console.log(`${v ? 'PASS' : 'FAIL'} ${k}`); }
  fs.rmSync(base, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
function execFileSyncSafe(args) { return spawnSync(process.execPath, args.map(String), { env, encoding: 'utf8' }); }
main().catch(e => { console.error(e); process.exit(1); });
