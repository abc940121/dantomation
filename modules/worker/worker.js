#!/usr/bin/env node
'use strict';
// Pull-based worker: asks the main server for jobs over OUTBOUND HTTP only, runs them
// locally behind its own checks, reports back. Opens no port. See README.md.
//   node modules/worker/worker.js --server http://<server-host>:7420   (or config worker.server)
//   flags: --max-jobs N (exit after N jobs are reported; for tests and one-shot use)
// API: server-api-v0 "Worker (pull, S3)": hello, claim (long poll), progress, result.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
// The worker keeps its own journal and checkpoints apart from any harness on this machine.
if (!process.env.HARNESS_STATE_DIR) process.env.HARNESS_STATE_DIR = path.join(ROOT, 'state', 'worker');
const J = require('../../lib/journal');
const C = require('../../lib/config');
const { log } = require('../../lib/log');
const { redact } = require('../../lib/redact');
const M = require('../../lib/modules');
const { makePolicy } = require('./policy');
const X = require('./exec');

const VERSION = '0.1.0';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const safe = s => String(s).replace(/[^\w.-]/g, '_').slice(0, 80);
const day = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

class Fatal extends Error {}

function defaultTokenFile() { return process.env.HARNESS_WORKER_TOKEN_FILE || path.join(os.homedir(), '.harness', 'worker-token'); }

function readToken(file) {
  let st;
  try { st = fs.statSync(file); } catch {
    throw new Fatal(`no worker token at ${file}. On this machine run:  node modules/worker/setup.js token   (it prints the token once; copy it to the server).`);
  }
  if (process.platform !== 'win32' && (st.mode & 0o077)) throw new Fatal(`token file ${file} is readable by other users; run: chmod 600 ${file}`);
  const t = fs.readFileSync(file, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{16,}$/.test(t)) throw new Fatal(`token file ${file} is empty or malformed; make a new one with: node modules/worker/setup.js token --force`);
  return t;
}

function settings(argv) {
  const a = { server: null, maxJobs: Infinity };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--server') a.server = argv[++i];
    else if (argv[i] === '--max-jobs') a.maxJobs = Number(argv[++i]);
    else throw new Fatal(`unknown option ${argv[i]}. Usage: node modules/worker/worker.js --server http://<server-host>:7420`);
  }
  const root = C.load();
  const w = root.worker && typeof root.worker === 'object' ? root.worker : {};
  const server = a.server || w.server;
  if (!server) throw new Fatal('no server. Use --server http://<server-host>:7420 or set "worker": {"server": ...} in the config.');
  let u;
  try { u = new URL(server); } catch { throw new Fatal(`bad server URL ${server}`); }
  if (!/^https?:$/.test(u.protocol)) throw new Fatal('server URL must start with http:// or https://');
  if (!w.work_dir) throw new Fatal('config worker.work_dir is not set. Add "worker": {"work_dir": "<absolute folder>"} to the config; the worker writes only there.');
  const cap = w.daily_cap === undefined ? 50 : w.daily_cap;
  if (!Number.isInteger(cap) || cap < 0) throw new Fatal('config worker.daily_cap must be a whole number >= 0');
  const [bmin, bmax] = Array.isArray(w.backoff_ms) ? w.backoff_ms : [1000, 30000];
  return {
    url: u, work_dir: path.resolve(w.work_dir), deny: w.deny || {}, cap,
    tokenFile: w.token_file ? path.resolve(w.token_file) : defaultTokenFile(),
    bmin, bmax, heartbeat: w.heartbeat_ms || 10000, maxRun: w.max_run_ms || 3600000,
    strip: root.strip_env, maxJobs: a.maxJobs, id: w.id || null,
  };
}

// ---- HTTP (outbound only) ---------------------------------------------------
function makeClient(S, token) {
  const mod = S.url.protocol === 'https:' ? https : http;
  return function call(method, p, body, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = mod.request({
        hostname: S.url.hostname, port: S.url.port || undefined, path: p, method, timeout: timeoutMs,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
      }, res => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
          resolve({ status: res.statusCode, json });
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  };
}

// ---- journal view -----------------------------------------------------------
// Records {type:'worker_job', phase:'start'|'done'|'posted', job_id, ...}; kept in memory after load.
function loadState() {
  const jobs = new Map(), runsByDay = new Map();
  for (const r of J.readAll().records) {
    if (r.type !== 'worker_job') continue;
    const j = jobs.get(r.job_id) || {};
    j[r.phase] = r;
    jobs.set(r.job_id, j);
    if (r.phase === 'start') runsByDay.set(r.day, (runsByDay.get(r.day) || 0) + 1);
  }
  return { jobs, runsByDay };
}

function parseDeadline(d) {
  if (d === undefined || d === null || d === '') return null;
  const n = typeof d === 'number' ? (d < 1e11 ? d * 1000 : d) : Date.parse(d);
  return Number.isFinite(n) ? n : NaN;
}

// ---- main -------------------------------------------------------------------
async function main(argv) {
  const S = settings(argv);
  const token = readToken(S.tokenFile);
  // The policy and the checkpoints come from the modules this one dependsOn, through the registry
  // (role worker). They run whatever the config's modules switch says: the jail is not optional.
  const cfg = C.load();
  const reg = M.registry({ ...cfg, modules: { ...(cfg.modules || {}), 'guard-base': true, 'guard-private-rules': true, checkpoint: true, worker: true } }, { role: 'worker' });
  if (reg.errors.length) throw new Fatal('module load error: ' + reg.errors.join('; '));
  const pol = makePolicy({ work_dir: S.work_dir, deny: S.deny }, { guardBase: reg.api('guard-base'), priv: reg.api('guard-private-rules') });
  const ckApi = reg.api('checkpoint');
  const call = makeClient(S, token);
  const lockFile = path.join(J.STATE, 'worker.lock');
  const lk = J.lock(lockFile, { pids: [process.pid], worker: true });
  if (!lk.held) throw new Fatal(`another worker is already running from this state folder (pid ${(lk.holder.pids || []).join(',') || '?'})`);
  process.on('exit', () => J.unlock(lockFile, lk.nonce));
  const idFile = path.join(J.STATE, 'worker-id');
  let workerId = S.id;
  if (!workerId) {
    try { workerId = fs.readFileSync(idFile, 'utf8').trim(); } catch { /* new */ }
    if (!workerId) { workerId = 'w-' + crypto.randomBytes(6).toString('hex'); fs.mkdirSync(J.STATE, { recursive: true }); fs.writeFileSync(idFile, workerId); }
  }
  const st = loadState();
  const caps = ['tool', 'task'];
  let pollMs = 1000, backoff = S.bmin, reported = 0;
  const say = m => process.stdout.write(`[worker] ${m}\n`);

  const bump = () => { backoff = Math.min(S.bmax, backoff * 2); };
  const wait = () => sleep(backoff / 2 + Math.random() * backoff / 2);

  // One request that survives an unreachable or unhappy server: retry with backoff.
  // Returns the response for any status the caller should interpret (2xx, 4xx other than auth).
  async function reliable(method, p, body, timeoutMs) {
    for (;;) {
      let r;
      try { r = await call(method, p, body, timeoutMs); } catch (e) {
        say(`server unreachable (${e.code || e.message}); retrying in ~${Math.round(backoff / 100) / 10}s`);
        log('worker.jsonl', { event: 'unreachable', error: String(e.code || e.message) });
        await wait(); bump(); continue;
      }
      if (r.status === 401 || r.status === 403) throw new Fatal(`the server refused the token (HTTP ${r.status}). Check that the token on the server matches this machine's token file (${S.tokenFile}); then run: node modules/worker/setup.js check --server ${S.url.origin}`);
      if (r.status >= 500) { say(`server error ${r.status}; retrying`); log('worker.jsonl', { event: 'server_error', status: r.status }); await wait(); bump(); continue; }
      backoff = S.bmin;
      return r;
    }
  }

  async function hello() {
    const r = await reliable('POST', '/api/worker/hello', { workerId, capabilities: caps, version: VERSION });
    if (r.status >= 400) throw new Fatal(`server rejected hello (HTTP ${r.status})`);
    if (r.json && Number.isFinite(r.json.pollMs)) pollMs = Math.max(50, r.json.pollMs);
    say(`connected to ${S.url.origin} as ${workerId}`);
    log('worker.jsonl', { event: 'hello', workerId });
  }

  async function postProgress(jobId, events) {
    try { await call('POST', `/api/worker/jobs/${encodeURIComponent(jobId)}/progress`, { events }, 8000); } catch { /* progress is best effort */ }
  }

  async function postResult(jobId, res) {
    const r = await reliable('POST', `/api/worker/jobs/${encodeURIComponent(jobId)}/result`, res);
    if (r.status >= 400) log('worker.jsonl', { event: 'result_rejected', job: jobId, status: r.status }); // 404/409: server has it or dropped it; do not loop
    J.append({ type: 'worker_job', phase: 'posted', job_id: jobId, status: r.status });
    st.jobs.get(jobId).posted = true;
    reported++;
    say(`job ${jobId}: result posted (HTTP ${r.status})`);
  }

  // Record the outcome locally FIRST (fsync), then post it. A crash in between is
  // repaired on restart by re-posting this record; the job is never run again.
  async function finish(jobId, res) {
    const j = st.jobs.get(jobId) || {};
    j.done = J.append({ type: 'worker_job', phase: 'done', job_id: jobId, result: res });
    st.jobs.set(jobId, j);
    if (process.env.HARNESS_WORKER_CRASH_AFTER_RUN === '1') { say('test seam: crashing before post'); process.exit(9); }
    await postResult(jobId, res);
  }

  const refuse = (jobId, why, kind) => {
    say(`job ${jobId}: REFUSED (${why})`);
    log('worker.jsonl', { event: 'refused', job: jobId, kind, reason: why });
    return finish(jobId, { ok: false, result: { refused: true, kind }, error: `refused by worker: ${why}` });
  };

  async function recover() {
    for (const [id, j] of st.jobs) {
      if (j.posted) continue;
      if (j.done) { say(`job ${id}: finished before a restart, re-posting the stored result`); await postResult(id, j.done.result); continue; }
      if (j.start) {
        say(`job ${id}: worker stopped while it ran; reporting outcome unknown (not rerun)`);
        await finish(id, { ok: false, result: { uncertain: true }, error: 'worker stopped while running this job; the outcome is unknown and the job was NOT rerun' });
      }
    }
  }

  // "task": a whole engine task through the existing launch (bin/harness.js start).
  function runTask(id, prompt, timeoutMs) {
    const wd = path.join(S.work_dir, safe(id));
    fs.mkdirSync(wd, { recursive: true });
    return X.runProcess(process.execPath, [path.join(ROOT, 'bin', 'harness.js'), 'start', prompt, '--workdir', wd], { cwd: ROOT, env: X.cleanEnv([]), timeoutMs })
      .then(r => {
        const open = J.openTask(J.readAll().records);
        const timedOut = !!(r.result && r.result.timedOut);
        if (timedOut && open) J.append({ type: 'task_done', task_id: open.task_id, aborted: true, note: 'worker deadline' });
        return { ...r, result: { ...(r.result || {}), finished: r.ok && !timedOut, workdir: path.basename(wd) } };
      });
  }

  async function runJob(job) {
    const id = String(job.id);
    const known = st.jobs.get(id);
    if (known && (known.done || known.start)) { // the server handed it out again
      if (known.done) { say(`job ${id}: already finished here, re-posting stored result`); await postResult(id, known.done.result); return; }
      return refuse(id, 'this job was started here before and its outcome is unknown; not rerun', 'repeat');
    }
    const dl = parseDeadline(job.deadline);
    if (Number.isNaN(dl)) return refuse(id, 'bad deadline', 'deadline');
    if (dl !== null && dl <= Date.now()) return refuse(id, 'deadline already passed before the job started', 'deadline');
    if (job.kind !== 'tool' && job.kind !== 'task') return refuse(id, `unknown job kind ${JSON.stringify(job.kind)}`, 'payload');
    let planned = null;
    if (job.kind === 'tool') {
      let d;
      try { d = pol.check(job.payload); } catch (e) { d = { kind: 'policy', reason: `policy check failed (${String(e.message).split('\n')[0].slice(0, 100)})` }; }
      if (!d.ok) return refuse(id, d.reason, d.kind);
      planned = { ...d, tool: job.payload.tool };
    } else {
      const p = job.payload;
      if (!p || typeof p.prompt !== 'string' || !p.prompt.trim()) return refuse(id, 'task payload needs a prompt', 'payload');
    }
    const today = day();
    const used = st.runsByDay.get(today) || 0;
    if (used >= S.cap) return refuse(id, `daily cap reached (${used} of ${S.cap} runs today; worker.daily_cap). This worker shares the owner's subscription quota.`, 'daily_cap');

    const timeoutMs = Math.min(S.maxRun, dl === null ? S.maxRun : dl - Date.now());
    let ckpt = null;
    if (job.kind === 'tool' && planned.write) {
      try { ckpt = ckApi.checkpoint('wk-' + safe(id), pol.jail, planned.tool); } catch (e) {
        return refuse(id, `could not take a checkpoint (${String(e.message).split('\n')[0].slice(0, 100)})`, 'checkpoint');
      }
    }
    J.append({ type: 'worker_job', phase: 'start', job_id: id, kind: job.kind, day: today, task: job.task, checkpoint: ckpt && ckpt.n });
    st.jobs.set(id, { start: true });
    st.runsByDay.set(today, used + 1);
    const summary = job.kind === 'tool' ? `${planned.tool} ${redact(String(planned.ti.command || path.basename(planned.ti.file_path || ''))).slice(0, 120)}` : 'engine task';
    const callId = 'c-' + safe(id);
    say(`job ${id}: running ${job.kind} (${summary})`);
    await postProgress(id, [{ type: 'tool_call', task: job.task, callId, tool: job.kind === 'task' ? 'engine' : planned.tool, summary }]);
    const beat = setInterval(() => postProgress(id, []), S.heartbeat);
    let res;
    try {
      res = job.kind === 'tool'
        ? await X.runTool(pol, planned, { env: X.cleanEnv(S.strip), timeoutMs })
        : await runTask(id, job.payload.prompt, timeoutMs);
    } catch (e) { res = { ok: false, error: `${e.code || 'error'}: ${String(e.message).split('\n')[0].slice(0, 160)}`, result: null }; }
    clearInterval(beat);
    if (ckpt) res.result = { ...(res.result || {}), checkpoint: ckpt.n };
    await postProgress(id, [{ type: 'tool_result', task: job.task, callId, ok: !!res.ok, summary: res.ok ? 'ok' : String(res.error || 'failed').slice(0, 120) }]);
    await finish(id, { ok: !!res.ok, result: res.result, ...(res.error ? { error: res.error } : {}) });
  }

  await recover();
  say(`worker ${workerId} up; server ${S.url.origin}; work folder ${path.basename(S.work_dir)}; daily cap ${S.cap}`);
  await hello();
  while (reported < S.maxJobs) {
    const t0 = Date.now();
    let r;
    try { r = await call('POST', '/api/worker/claim', { workerId }, 35000); } catch (e) {
      say(`lost the server (${e.code || e.message}); retrying`);
      log('worker.jsonl', { event: 'unreachable', error: String(e.code || e.message) });
      await wait(); bump(); await hello(); continue;
    }
    if (r.status === 401 || r.status === 403) throw new Fatal(`the server refused the token (HTTP ${r.status}).`);
    if (r.status >= 500) { await wait(); bump(); continue; }
    backoff = S.bmin;
    if (r.status === 204) { const left = pollMs - (Date.now() - t0); if (left > 0) await sleep(left); continue; }
    if (r.status !== 200 || !r.json || !r.json.job || r.json.job.id === undefined) { log('worker.jsonl', { event: 'odd_claim', status: r.status }); await sleep(pollMs); continue; }
    await runJob(r.json.job);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(() => process.exit(0), e => {
    if (e instanceof Fatal) { process.stderr.write(`worker: ${e.message}\n`); process.exit(2); }
    process.stderr.write(`worker: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}
module.exports = { main, readToken, settings };
