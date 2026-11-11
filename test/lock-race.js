#!/usr/bin/env node
'use strict';
// Stale-lock takeover race. Each round: a lock file left by a dead pid, then two
// processes that wake at the same instant and both try to take it over.
// Exactly one may hold it; the other must see a live holder. Neither may remove
// a lock it does not own. 50 rounds.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROUNDS = Number(process.argv[2] || 50);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lockrace-'));
const lockFile = path.join(base, 'executor.lock');
const JOURNAL_LIB = path.join(__dirname, '..', 'lib', 'journal.js');

// ---- stall diagnostics: on a timeout, print the lock state, .break files and live children, then FAIL.
// Test-only seams (honored only when HARNESS_TEST=1): LOCKRACE_STALL_MS makes one part-4 child sleep that
// long before taking the lock; LOCKRACE_WATCHDOG_MS shortens the stall timeout.
const TEST_SEAMS = process.env.HARNESS_TEST === '1';
// The watchdog is re-armed at every step, so it fires when ONE step (a round, a breaker pair) hangs.
const WATCHDOG_MS = (TEST_SEAMS && Number(process.env.LOCKRACE_WATCHDOG_MS)) || 20000;
const STALL_MS = (TEST_SEAMS && Number(process.env.LOCKRACE_STALL_MS)) || 0;
const progress = { part: 'start', step: '' };
const children = new Map(); // pid -> { part, step, started }
const watched = new Set([lockFile]);
const aliveNow = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Only whitelisted, non-secret fields of lock / .break files are shown.
function describeFile(f) {
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { return null; }
  let j; try { j = JSON.parse(raw); } catch { return { file: path.basename(f), unparseable: true, bytes: raw.length }; }
  const o = { file: path.basename(f) };
  for (const k of ['pid', 'pids', 'nonce', 'ts', 't', 'owner']) if (j[k] !== undefined) o[k] = typeof j[k] === 'string' ? j[k].slice(0, 64) : j[k];
  const ps = (Array.isArray(j.pids) ? j.pids : []).concat(Number.isInteger(j.pid) ? [j.pid] : []);
  o.alive = Object.fromEntries(ps.filter(Number.isInteger).map(p => [p, aliveNow(p)]));
  try { o.ageMs = Date.now() - fs.statSync(f).mtimeMs | 0; } catch { /* gone */ }
  return o;
}
function stallReport(why) {
  const lines = [`STALL: ${why}; part ${progress.part}, step ${progress.step}`];
  for (const f of watched) for (const p of [f, f + '.break']) {
    const d = describeFile(p);
    lines.push(`  ${p.endsWith('.break') ? '.break file' : 'lock holder'}: ${d ? JSON.stringify(d) : path.basename(p) + ' absent'}`);
  }
  const live = [...children].filter(([pid]) => aliveNow(pid));
  lines.push(`  children still running: ${live.length ? live.map(([pid, c]) => `pid ${pid} (part ${c.part}, step ${c.step}, ${Date.now() - c.started}ms)`).join('; ') : 'none'}`);
  return lines.join('\n').slice(0, 3000);
}
let watchdog;
const armWatchdog = () => { clearTimeout(watchdog); watchdog = setTimeout(onStall, WATCHDOG_MS); };
function onStall() {
  const rep = stallReport(`no step progress for ${WATCHDOG_MS}ms`);
  console.log(rep);
  console.log(`FAIL lock-race stalled: ${rep.split('\n').slice(1).join(' | ').replace(/\s+/g, ' ').slice(0, 380)}`);
  for (const pid of children.keys()) { try { process.kill(pid); } catch { /* gone */ } }
  process.exit(1);
}
armWatchdog();
function track(c, part, step) {
  children.set(c.pid, { part, step, started: Date.now() });
  c.on('exit', () => children.delete(c.pid));
}

// child: wait for the shared start time, try the lock, hold it 300 ms, release.
const CHILD = `
const J = require(${JSON.stringify(JOURNAL_LIB)});
const [file, at, stall] = process.argv.slice(1);
while (Date.now() < Number(at)) {}
if (Number(stall) > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(stall));
const t0 = Date.now();
const l = J.lock(file, { pids: [process.pid] });
const r = { pid: process.pid, held: l.held, holder: l.held ? null : l.holder, t0 };
if (l.held) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  r.stillMine = (J.readLock(file) || {}).nonce === l.nonce;
  r.t1 = Date.now();
  r.released = J.unlock(file, l.nonce);
}
process.stdout.write(JSON.stringify(r));
`;

const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' , windowsHide: true }).stdout);
const runChild = at => new Promise(ok => {
  const c = spawn(process.execPath, ['-e', CHILD, lockFile, String(at)], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  track(c, 'rounds', progress.step);
  let out = ''; c.stdout.on('data', d => out += d);
  c.on('exit', () => { try { ok(JSON.parse(out)); } catch { ok({ error: out }); } });
});

// Stale-break specifics: the in-process seam lets a "live" lock appear after the stale one was judged.
async function breakChecks() {
  const J = require(JOURNAL_LIB);
  const out = {};
  const f = path.join(base, 'seam.lock');
  // 1. judged-stale content replaced by a live lock before the break: the live lock survives
  fs.writeFileSync(f, JSON.stringify({ pids: [deadPid()], nonce: 'old' }));
  const live = JSON.stringify({ pids: [process.pid], nonce: 'live' });
  const r1 = J.lock(f, { pids: [process.pid] }, { afterSeen() { fs.writeFileSync(f, live); } });
  out['live lock that replaced the judged-stale one survives'] = !r1.held && fs.readFileSync(f, 'utf8') === live
    && !fs.existsSync(f + '.break');
  fs.unlinkSync(f);
  // 2. replaced while the mutex is held (after our re-read point would be too late; before it must be honored)
  fs.writeFileSync(f, JSON.stringify({ pids: [deadPid()], nonce: 'old2' }));
  const r2 = J.lock(f, { pids: [process.pid] }, { afterMutex() { fs.writeFileSync(f, live); } });
  out['replacement made while mutex held survives'] = !r2.held && fs.readFileSync(f, 'utf8') === live;
  fs.unlinkSync(f);
  // 3. stale .break left by a dead pid is recovered
  const g = path.join(base, 'brk.lock');
  fs.writeFileSync(g, JSON.stringify({ pids: [deadPid()], nonce: 'x' }));
  fs.writeFileSync(g + '.break', JSON.stringify({ pid: deadPid(), t: Date.now() }));
  const r3 = J.lock(g, { pids: [process.pid] });
  out['stale .break from a dead pid is recovered'] = r3.held && !fs.existsSync(g + '.break');
  J.unlock(g, r3.nonce);
  // 3b. a live, fresh .break blocks breaking (bounded: reports contention) and is left alone
  fs.writeFileSync(g, JSON.stringify({ pids: [deadPid()], nonce: 'y' }));
  const fresh = JSON.stringify({ pid: process.pid, t: Date.now() });
  fs.writeFileSync(g + '.break', fresh);
  const r4 = J.lock(g, { pids: [process.pid] });
  out['fresh live .break is respected'] = !r4.held && fs.readFileSync(g + '.break', 'utf8') === fresh;
  fs.unlinkSync(g); fs.unlinkSync(g + '.break');
  // 4. two concurrent breakers (child processes) on a stale lock: exactly one holder
  const h = path.join(base, 'two.lock');
  watched.add(h);
  progress.part = 4;
  let ones = 0;
  for (let i = 0; i < 10; i++) {
    progress.step = `breaker pair ${i + 1}/10`; armWatchdog();
    fs.writeFileSync(h, JSON.stringify({ pids: [deadPid()], nonce: 'd' + i }));
    const at = Date.now() + 600;
    const rs = await Promise.all([lockChild(h, at, i === 0 ? STALL_MS : 0), lockChild(h, at)]);
    if (rs.filter(r => r.held).length === 1 && !fs.existsSync(h + '.break')) ones++;
  }
  out['two concurrent breakers: exactly one holder, no .break left'] = ones === 10;
  return out;
}
const lockChild = (file, at, stall) => new Promise(ok => {
  const c = spawn(process.execPath, ['-e', CHILD, file, String(at), String(stall || 0)], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  track(c, 4, progress.step);
  let out = ''; c.stdout.on('data', d => out += d);
  c.on('exit', () => { try { ok(JSON.parse(out)); } catch { ok({}); } });
});

async function main() {
  let exactlyOne = 0, overlap = 0, bad = [];
  progress.part = 'rounds';
  for (let i = 0; i < ROUNDS; i++) {
    progress.step = `round ${i + 1}/${ROUNDS}`; armWatchdog();
    fs.writeFileSync(lockFile, JSON.stringify({ pids: [deadPid()], nonce: 'dead' + i }));
    const at = Date.now() + 700; // both children are up and spinning before this
    const [a, b] = await Promise.all([runChild(at), runChild(at)]);
    const held = [a, b].filter(r => r.held);
    const loser = [a, b].find(r => !r.held);
    const ok = held.length === 1 && held[0].stillMine && held[0].released
      && loser && (loser.holder.pids || []).includes(held[0].pid);
    if (held.length === 2 && !(held[0].t1 <= held[1].t0 || held[1].t1 <= held[0].t0)) overlap++;
    if (ok) exactlyOne++; else bad.push({ round: i, a, b });
    if (fs.existsSync(lockFile)) bad.push({ round: i, note: 'lock left behind' });
  }
  const leftovers = fs.readdirSync(base).filter(f => f !== 'executor.lock' && !/^(seam|brk|two)\.lock/.test(f));
  console.log(`rounds ${ROUNDS}: exactly one holder (other saw that holder) in ${exactlyOne}; overlapping holders ${overlap}; leftover tmp/stale files ${leftovers.length}`);
  for (const x of bad.slice(0, 5)) console.log('  ' + JSON.stringify(x));
  progress.part = 'break checks'; armWatchdog();
  const extra = await breakChecks();
  const res = {
    ...extra,
    'never two holders at once': overlap === 0,
    'every round: exactly one holder, loser sees it': exactlyOne === ROUNDS,
    'holder still owned its lock at release; nothing left behind': bad.length === 0 && leftovers.length === 0,
  };
  let all = true;
  for (const [k, v] of Object.entries(res)) { all = all && v; console.log(`${v ? 'PASS' : 'FAIL'} ${k}`); }
  clearTimeout(watchdog);
  fs.rmSync(base, { recursive: true, force: true });
  process.exit(all ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
