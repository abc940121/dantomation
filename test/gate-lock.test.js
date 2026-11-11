#!/usr/bin/env node
'use strict';
// The gate lock: a second taker waits (and says so), a lock whose pid is dead or that is
// older than the stale age is taken over, release removes only our own lock, and a process
// that exits normally leaves no lock behind. No fixed sleeps decide a check: each wait
// polls for the condition with a generous deadline.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const G = require('./gate-lock');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-'));
const file = path.join(dir, 'gate.lock');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(20); return !!fn(); };
const checks = {};
const o = (extra = {}) => ({ file, pollMs: 20, noHooks: true, log: () => {}, ...extra });

(async () => {
  // acquire writes pid + start; release removes it
  const rel1 = await G.acquire(o());
  const h = JSON.parse(fs.readFileSync(file, 'utf8'));
  checks['lock file holds pid and start time'] = h.pid === process.pid && Number.isFinite(h.start);

  // a second taker waits, logs, and gets the lock only after release
  const logs = []; let got = false;
  const p2 = G.acquire(o({ logEveryMs: 1, log: m => logs.push(m) })).then(r => { got = true; return r; });
  checks['second taker logs "waiting for gate lock"'] = await until(() => logs.includes('waiting for gate lock'));
  checks['second taker is still waiting while the lock is held'] = got === false;
  rel1();
  const rel2 = await p2;
  checks['second taker gets the lock after release'] = got === true && JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid;
  rel2(); rel2(); // idempotent
  checks['release removes the file'] = !fs.existsSync(file);

  // stale: pid dead
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' , windowsHide: true }).stdout);
  fs.writeFileSync(file, JSON.stringify({ pid: dead, start: Date.now(), nonce: 'x' }));
  const rel3 = await Promise.race([G.acquire(o()), sleep(20000).then(() => null)]);
  checks['lock of a dead pid is taken over'] = !!rel3 && JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid;
  if (rel3) rel3();

  // stale: live pid but older than the stale age
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, start: Date.now() - G.STALE_MS - 60000, nonce: 'y' }));
  const rel4 = await Promise.race([G.acquire(o()), sleep(20000).then(() => null)]);
  checks['lock older than 30 minutes is taken over'] = !!rel4 && JSON.parse(fs.readFileSync(file, 'utf8')).nonce !== 'y';
  if (rel4) rel4();

  // release never removes a lock that is no longer ours
  const rel5 = await G.acquire(o());
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, start: Date.now(), nonce: 'someone-else' }));
  rel5();
  checks['release leaves another owner\'s lock alone'] = fs.existsSync(file);
  fs.rmSync(file, { force: true });

  // a process that takes the lock and exits normally leaves nothing behind
  const code = `require(${JSON.stringify(path.join(__dirname, 'gate-lock.js'))}).acquire({file:${JSON.stringify(file)},log(){}}).then(()=>process.exit(3))`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 30000 , windowsHide: true });
  checks['exit releases the lock (hooked process, exit code kept)'] = r.status === 3 && !fs.existsSync(file);

  let ok = true;
  for (const [k, v] of Object.entries(checks)) { ok = ok && v; console.log(`${v ? 'PASS' : 'FAIL'} ${k}`); }
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
