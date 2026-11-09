'use strict';
// taskmote server: one Node process, node:http and plain files only.
//   taskmote serve            listen (config server.host/server.port, default 127.0.0.1:7420)
//   taskmote token new        write a fresh owner-only token file
// The journal stays the only source of truth. Tasks, cards, jobs and the SSE event
// stream are all folds over it, so a killed server loses nothing: restart, and the
// same state and the same event seq numbers come back. The server starts engines by
// running bin/harness.js (the existing executor lock, journal and effect code), and
// answers cards/undo through the module registry (lib/modules.js). API: see the "server API v0" spec.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const J = require('./journal');
const C = require('./config');
const M = require('../lib/modules'); // the loader, not a module
const R = require('./redact');

const ROOT = J.ROOT;
const HARNESS = path.join(ROOT, 'bin', 'harness.js');
const TASKMOTE = path.join(ROOT, 'bin', 'taskmote.js');
const TOKEN_FILE = () => path.join(J.STATE, 'server.token');
const WORKER_TOKEN_FILE = () => path.join(J.STATE, 'worker.token'); // optional: a token that may only call worker routes
const INFO_FILE = () => path.join(J.STATE, 'server.json');
const EXEC_LOCK = () => path.join(J.STATE, 'executor.lock');
const SEQ_STRIDE = 64; // seq = (journal index + 1) * 64 + k: one record may carry up to 63 events
const WORKER_EVENT_TYPES = new Set(['message', 'tool_call', 'tool_result', 'claims']);

const SECRET_G = new RegExp(R.SECRET_LITERAL.source, 'g');
// Total: never throws. Hides the owner/worker token values and every loaded module's secrets, then secret patterns; clips last.
function scrub(s, n = 2000) {
  try {
    s = typeof s === 'string' ? s : s == null ? '' : String(s);
    for (const t of [readToken(), readWorkerToken()]) if (t && t.length >= 4) s = s.split(t).join('[REDACTED]');
    s = M.hideAll(s).replace(SECRET_G, '[REDACTED]');
    return s.length > n ? s.slice(0, n - 3) + '...' : s;
  } catch { return ''; }
}
const isLoopback = a => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';

// ---- settings --------------------------------------------------------------
function settings(cfg) {
  const s = (cfg && cfg.server) || {};
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== null ? Number(v) : d);
  const host = String(s.host || '127.0.0.1');
  const bots = Array.isArray(cfg.bots) && cfg.bots.length ? cfg.bots : [{ id: 'main', name: 'main', engine: (cfg.engine && cfg.engine.name) || 'claude', runsOn: 'main' }];
  return {
    host, port: num(s.port, 7420),
    loopbackBind: isLoopback(host) || host === 'localhost',
    localNoAuth: s.local_no_auth !== false,
    tickMs: Math.max(20, num(s.tick_ms, 150)),
    jobTimeoutMs: Math.max(100, num(s.job_timeout_ms, 600000)),
    claimWaitMs: Math.max(0, num(s.claim_wait_ms, 25000)),
    bots: bots.map(b => ({ id: String(b.id), name: String(b.name || b.id), engine: String(b.engine || 'claude'), runsOn: b.runsOn === 'worker' ? 'worker' : 'main' })),
  };
}

// ---- token -----------------------------------------------------------------
// Restrict the token file to the owner. Returns true when the restriction is in place.
function restrictToken(f) {
  if (process.platform === 'win32') { // POSIX mode bits do nothing on NTFS: drop inherited access, grant the current user only
    const r = spawnSync('icacls', [f, '/inheritance:r', '/grant:r', `${process.env.USERNAME || ''}:F`], { stdio: 'ignore' });
    return r.status === 0;
  }
  try { fs.chmodSync(f, 0o600); return (fs.statSync(f).mode & 0o077) === 0; } catch { return false; }
}
function tokenNew(kind) {
  fs.mkdirSync(J.STATE, { recursive: true });
  const f = kind === 'worker' ? WORKER_TOKEN_FILE() : TOKEN_FILE();
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, crypto.randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
  if (!restrictToken(tmp)) console.error('warning: could not restrict the token file permissions; restrict it to your own account yourself (Windows: icacls <file> /inheritance:r /grant:r %USERNAME%:F)');
  fs.renameSync(tmp, f);
  return f;
}
function readTokenFile(f) { try { return fs.readFileSync(f, 'utf8').trim() || null; } catch { return null; } }
function readToken() { return readTokenFile(TOKEN_FILE()); }
function readWorkerToken() { return readTokenFile(WORKER_TOKEN_FILE()); }
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

// ---- module panels: /m/<module>/ui/... (GET/HEAD) -------------------------------
// The registry decides what is servable (uiFile: a real file under the module's ui/ folder,
// symlinks resolved). These files are public static assets: a browser navigation cannot send
// a bearer token, and the files hold no data (the page asks the API, which needs the token).
const UI_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.mjs': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8' };
function serveModuleUi(reg, req, res, name, rest, json) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'GET only' });
  let rel = null;
  try { rel = decodeURIComponent(rest); } catch { /* bad escape */ }
  const file = rel !== null && !rel.includes('\0') && !rel.split(/[\\/]/).includes('..') ? reg.uiFile(name, 'ui/' + (rel === '' ? 'index.html' : rel)) : null;
  if (!file) return json(res, 404, { error: 'not found' });
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'content-type': UI_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store', 'content-length': body.length });
  return res.end(req.method === 'HEAD' ? undefined : body);
}

// ---- the server ------------------------------------------------------------
function create(opts = {}) {
  const CONFIG = C.load();
  const SET = settings(CONFIG);
  const tasksSvc = {}; // ctx.tasks for modules; filled in below, once createTask and friends exist
  const REG = M.registry(CONFIG, { role: 'main', tasks: tasksSvc });
  if (REG.errors.length) throw new Error(`module load error: ${REG.errors.join('; ')}`);
  const ckApi = REG.api('checkpoint'), K = REG.api('approval-cards'); // K: fold, pending, isExpired (pure journal helpers)
  const ck = ckApi && typeof ckApi.undoStack === 'function' && typeof ckApi.undoInfo === 'function' ? ckApi : null;
  const OWNER = { kind: 'owner' };
  const pairing = REG.api('device-pairing'); // null when that module is off
  const botById = new Map(SET.bots.map(b => [b.id, b]));
  const defaultBot = SET.bots[0].id;

  let jobsP = null, closing = null; // jobsP: the startJobs promise (resolves to a handle or null); closing: the memoised close() promise
  let S = { records: [], size: -1, mtime: -1, tasks: new Map(), jobs: new Map() };
  const EV = [];                 // every event so far: {seq, type, data}
  let emitted = 0;
  const botOf = new Map(), announced = new Set();
  const clients = new Set();     // SSE responses
  const waiters = [];            // long-poll claims
  const procs = new Map();       // task id -> child process we started
  const workers = new Map();     // worker id -> last seen ms
  let dispatching = false;

  // -- journal view ----
  const stat = () => { try { const s = fs.statSync(J.JOURNAL); return { size: s.size, mtime: s.mtimeMs }; } catch { return { size: 0, mtime: 0 }; } };
  function refresh(force) {
    const st = stat();
    if (!force && st.size === S.size && st.mtime === S.mtime) return false;
    const { records } = J.readAll();
    S = { ...S, records, size: st.size, mtime: st.mtime };
    derive();
    emitNew();
    return true;
  }
  const append = rec => { const r = J.append(rec); refresh(true); return r; };

  function derive() {
    const tasks = new Map(), jobs = new Map();
    const mk = (id, o) => { const t = { id, bot: defaultBot, prompt: '', steps: new Set(), queued: false, open: false, end: null, exitCode: null, claims: null, job: null, ...o }; tasks.set(id, t); return t; };
    for (const r of S.records) {
      const t = r.task_id && tasks.get(r.task_id);
      switch (r.type) {
        case 'queue_add': mk(r.task_id, { bot: r.bot, prompt: r.prompt, queued: true, created: r.ts, ...(r.workdir ? { workdir: r.workdir } : {}), ...(r.forked_from ? { forked_from: r.forked_from } : {}) }); break;
        case 'queue_fail': if (t) { t.end = 'failed'; t.queued = false; } break;
        case 'queue_cancel': if (t) { t.end = 'stopped'; t.queued = false; } break;
        case 'task_start': { const x = t || mk(r.task_id, {}); x.queued = false; x.open = true; x.prompt = r.request; x.bot = r.bot || x.bot; x.workdir = r.workdir; x.created = x.created || r.ts; break; }
        case 'task_done': if (t) { t.open = false; t.end = r.stopped ? 'stopped' : 'done'; } break;
        case 'step': if (t && r.status === 'done') t.steps.add(r.step); break;
        case 'engine_start': if (t) t.exitCode = null; break;
        case 'engine_exit': if (t) t.exitCode = r.code; break;
        case 'claim_audit': if (t) t.claims = { checked: r.checked, unverified: r.unverified }; break;
        case 'job_queued': {
          jobs.set(r.job_id, { id: r.job_id, task: r.task_id, bot: r.bot, kind: r.kind, payload: r.payload, timeoutMs: r.timeout_ms, state: 'queued', worker: null, deadline: null });
          if (r.kind === 'task') mk(r.task_id, { bot: r.bot, prompt: r.payload && r.payload.prompt, job: r.job_id, created: r.ts });
          break;
        }
        case 'job_claimed': { const j = jobs.get(r.job_id); if (j && j.state === 'queued') { j.state = 'claimed'; j.worker = r.worker_id; j.deadline = r.deadline; } break; }
        case 'job_progress': { const j = jobs.get(r.job_id); if (j && j.state === 'claimed') j.deadline = r.deadline; break; }
        case 'job_result': { const j = jobs.get(r.job_id); if (j && (j.state === 'claimed' || j.state === 'queued')) { j.state = r.ok ? 'done' : 'failed'; j.result = r.result; j.error = r.error; } break; }
        case 'job_uncertain': { const j = jobs.get(r.job_id); if (j && j.state === 'claimed') j.state = 'uncertain'; break; }
        case 'job_cancel': { const j = jobs.get(r.job_id); if (j && (j.state === 'claimed' || j.state === 'queued')) j.state = 'cancelled'; break; }
        default:
      }
    }
    S.tasks = tasks; S.jobs = jobs;
  }

  // -- tasks ----
  const lockLive = openId => {
    const h = J.readLock(EXEC_LOCK());
    return !!(h && !h.restore && (h.pids || []).some(J.alive) && (h.task_id === openId || (h.task_id == null && openId)));
  };
  const pendingCards = () => (K ? K.pending(S.records) : []);
  const openLocal = () => J.openTask(S.records);
  function stateOf(t) {
    if (t.job) {
      const j = S.jobs.get(t.job);
      return { queued: 'queued', claimed: 'running', done: 'done', failed: 'failed', uncertain: 'failed', cancelled: 'stopped' }[j.state];
    }
    if (t.end) return t.end;
    if (pendingCards().some(c => c.task_id === t.id)) return 'waiting_card';
    if (t.queued) return procs.has(t.id) ? 'running' : 'queued';
    const o = openLocal();
    if (procs.has(t.id) || (o && o.task_id === t.id && lockLive(t.id))) return 'running';
    return t.exitCode != null && t.exitCode !== 0 ? 'failed' : 'stopped';
  }
  function taskView(t) {
    const v = { id: t.id, bot: t.bot, prompt: scrub(t.prompt), state: stateOf(t), steps: t.steps.size,
      undoPoints: ck && !t.job ? ck.undoStack(S.records, t.id).length : 0, open: t.open || (t.queued && !t.end) };
    if (t.claims) v.claims = t.claims;
    if (t.job && S.jobs.get(t.job).state === 'uncertain') v.uncertain = true;
    return v;
  }
  const taskList = limit => [...S.tasks.values()].reverse().slice(0, limit).map(taskView);

  // opts.workdir (absolute path) and opts.forkedFrom ({task, step}) come only from ctx.tasks.start (modules), never from HTTP.
  function createTask(botId, prompt, opts = {}) {
    const bot = botById.get(botId);
    if (!bot) return { status: 404, body: { error: `unknown bot ${scrub(botId, 60)}` } };
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000) return { status: 400, body: { error: 'prompt must be a non-empty string (max 20000 chars)' } };
    const id = 't' + J.newId();
    if (opts.workdir && bot.runsOn === 'worker') return { status: 400, body: { error: 'a workdir is not supported for worker bots' } };
    if (bot.runsOn === 'worker') append({ type: 'job_queued', job_id: 'j' + J.newId(), task_id: id, bot: bot.id, kind: 'task', payload: { prompt }, timeout_ms: SET.jobTimeoutMs });
    else append({ type: 'queue_add', task_id: id, bot: bot.id, prompt, ...(opts.workdir ? { workdir: opts.workdir } : {}), ...(opts.forkedFrom ? { forked_from: opts.forkedFrom } : {}) });
    pump(); serveWaiters();
    return { status: 201, body: { id, bot: bot.id, state: stateOf(S.tasks.get(id)) } };
  }

  // -- engine start/resume: always the existing bin/harness.js ----
  function spawnHarness(taskId, args, extraEnv) {
    const out = fs.openSync(path.join(J.STATE, 'server-spawn.log'), 'a');
    const env = { ...process.env, HARNESS_NO_SERVER: '1', ...extraEnv };
    const child = spawn(process.execPath, [HARNESS, ...args], { env, stdio: ['ignore', out, out], windowsHide: true });
    fs.closeSync(out);
    procs.set(taskId, child);
    child.on('error', () => procs.delete(taskId));
    child.on('exit', code => {
      procs.delete(taskId);
      refresh(true);
      const t = S.tasks.get(taskId);
      if (t && t.queued && !t.open && code !== 4) append({ type: 'queue_fail', task_id: taskId, code }); // start never reached the journal
      pump();
    });
    return child;
  }
  function pump() {
    if (dispatching) return;
    refresh();
    const head = [...S.tasks.values()].find(t => t.queued && !t.end && !t.job);
    if (!head || procs.size || openLocal() || lockLive(null) || lockLive(true)) return;
    dispatching = true;
    try { spawnHarness(head.id, ['start', head.prompt, ...(head.workdir ? ['--workdir', head.workdir] : [])], { HARNESS_NEW_TASK_ID: head.id, HARNESS_BOT: head.bot, ...(head.forked_from ? { HARNESS_FORKED_FROM: JSON.stringify(head.forked_from) } : {}) }); } finally { dispatching = false; }
  }
  function resumeTask(id) {
    refresh();
    const o = openLocal(), t = S.tasks.get(id);
    if (!t) return { status: 404, body: { error: 'no such task' } };
    if (!o || o.task_id !== id) return { status: 409, body: { error: 'only the open task can be resumed' } };
    const st = stateOf(t);
    if (st === 'running') return { status: 200, body: { id, state: st } };
    if (st === 'waiting_card') return { status: 409, body: { error: 'waiting for a card answer' } };
    if (procs.size || lockLive(true)) return { status: 409, body: { error: 'an executor is still running' } };
    spawnHarness(id, ['resume'], {});
    return { status: 200, body: { id, state: 'running' } };
  }
  function killTree(pid) {
    if (!Number.isInteger(pid) || pid === process.pid) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  function stopTask(id) {
    refresh();
    const t = S.tasks.get(id);
    if (!t) return { status: 404, body: { error: 'no such task' } };
    const st = stateOf(t);
    if (t.job) { const j = S.jobs.get(t.job); if (j.state === 'queued' || j.state === 'claimed') append({ type: 'job_cancel', job_id: j.id, task_id: id }); return { status: 200, body: { id, state: 'stopped' } }; }
    if (t.end) return { status: 200, body: { id, state: st } }; // already over: idempotent
    if (t.queued && !t.open && !procs.has(id)) { append({ type: 'queue_cancel', task_id: id }); return { status: 200, body: { id, state: 'stopped' } }; }
    const h = J.readLock(EXEC_LOCK());
    const child = procs.get(id);
    if (child) killTree(child.pid);
    if (h && !h.restore && h.task_id === id) for (const p of h.pids || []) killTree(p);
    append({ type: 'task_done', task_id: id, stopped: true });
    return { status: 200, body: { id, state: 'stopped' } };
  }
  function undoTask(id) {
    refresh();
    const t = S.tasks.get(id);
    if (!t || t.job) return { status: 404, body: { error: 'no such task' } };
    if (!ck) return { status: 409, body: { error: 'undo needs the checkpoint module, which is off' } };
    const latest = ck.undoInfo(J).task;
    if (latest !== id) return { status: 409, body: { error: 'undo only applies to the latest task' } };
    const env = { ...process.env, HARNESS_NO_SERVER: '1' }; delete env.HARNESS_TASK_ID;
    const r = spawnSync(process.execPath, [TASKMOTE, 'undo'], { env, encoding: 'utf8', timeout: 120000 });
    const out = (r.stdout || '').trim();
    if (r.status === 4) return { status: 409, body: { error: 'a task is still running; stop it before undoing' } };
    if (r.status !== 0) return { status: 500, body: { error: scrub((r.stderr || out).split('\n')[0], 300) } };
    const n = /before agent change (\d+)/.exec(out), hint = /Undo this with: (.*?)(\s{2,}\(PowerShell.*)?$/m.exec(out);
    refresh(true);
    return { status: 200, body: { restoredTo: n ? Number(n[1]) : null, redoHint: hint ? hint[1].trim() : null, message: scrub(out, 1000) } };
  }

  // -- cards ----
  function cardView(c) {
    const t = S.tasks.get(c.task_id);
    return { id: c.card_id, task: c.task_id, bot: t ? t.bot : defaultBot, tool: c.tool, summary: scrub(c.summary, 300), expiresAt: c.expires_at, state: K.isExpired(c) ? 'expired' : c.state, decision: c.decision || null };
  }
  function listCards(state) {
    if (!K) return [];
    const all = [...K.fold(S.records).values()];
    const want = state || 'pending';
    return all.filter(c => (want === 'all' ? true : want === 'pending' ? c.state === 'pending' && !K.isExpired(c) : c.state === want)).map(cardView);
  }
  let sweeping = false;
  async function sweepCards() { // the card module's own GET /cards sweeps expired cards (and journals them)
    const f = K && REG.findRoute('GET', '/m/approval-cards/cards');
    if (!f) return;
    await REG.callRoute(f, { actor: OWNER });
    refresh(true);
  }
  async function answerCard(id, body, actor) { // actor: the authenticated caller; the module records who/where from it, never from the body
    if (!K) return { status: 404, body: { error: 'approval cards are off' } };
    await sweepCards();
    const card = [...K.fold(S.records).values()].find(c => c.card_id === id);
    if (!card) return { status: 404, body: { error: 'no such card' } };
    if (card.state !== 'pending' || K.isExpired(card)) return { status: 409, body: { error: `card is not pending (${K.isExpired(card) ? 'expired' : card.state})` } };
    const text = body && body.answer;
    if (typeof text !== 'string') return { status: 400, body: { error: 'answer must be a string' } };
    const r = await REG.callRoute(REG.findRoute('POST', `/m/approval-cards/cards/${id}/answer`), { actor: actor || OWNER, params: { id }, body: { text } });
    refresh(true);
    if (r.status !== 200) return { status: r.status, body: r.json };
    const a = r.json.answer;
    if (a === 'unclear') return { status: 409, body: { error: 'answer unclear; nothing approved, card still pending', answer: 'unclear' } };
    let resumed = false;
    const o = openLocal();
    if (o && o.task_id === card.task_id && !pendingCards().some(c => c.task_id === card.task_id)) resumed = resumeTask(card.task_id).status === 200;
    return { status: 200, body: { id, answer: a, resumed } };
  }

  // ctx.tasks for modules (S1 owns it): the same code the HTTP API uses.
  const okOr = r => { if (r.status >= 300) throw new Error(r.body.error || 'failed'); return r.body; };
  Object.assign(tasksSvc, {
    enqueue: async (bot, prompt) => okOr(createTask(bot === undefined ? defaultBot : bot, prompt)),
    // start(bot, prompt, { workdir, forkedFrom: { task, step } }): like enqueue, in a given folder; the new task records forked_from.
    start: async (bot, prompt, o = {}) => {
      const { workdir, forkedFrom } = o || {};
      if (workdir !== undefined && (typeof workdir !== 'string' || !path.isAbsolute(workdir) || workdir.length > 500 || workdir.includes('\0'))) throw new Error('workdir must be an absolute path');
      if (forkedFrom !== undefined && !(forkedFrom && /^t[\w-]+$/.test(String(forkedFrom.task)) && (typeof forkedFrom.step === 'number' || /^[\w.:-]{1,80}$/.test(String(forkedFrom.step))))) throw new Error('forkedFrom must be {task: "<task id>", step: <number or short id>}');
      return okOr(createTask(bot === undefined ? defaultBot : bot, prompt, { workdir, forkedFrom: forkedFrom && { task: forkedFrom.task, step: forkedFrom.step } }));
    },
    get: async id => { refresh(); const t = S.tasks.get(id); return t ? taskView(t) : null; },
    cancel: async id => okOr(stopTask(id)),
  });

  // -- events ----
  function toEvents(r) {
    const task = r.task_id, bot = () => botOf.get(task) || defaultBot;
    const out = [];
    const start = () => { if (task && !announced.has(task)) { announced.add(task); out.push(['task_start', { task, bot: bot(), prompt: scrub(botPrompt.get(task)) }], ['bot_status', { bot: bot(), status: 'busy' }]); } };
    switch (r.type) {
      case 'queue_add': botOf.set(task, r.bot); botPrompt.set(task, r.prompt); start(); break;
      case 'job_queued': if (r.kind === 'task') { botOf.set(task, r.bot); botPrompt.set(task, r.payload && r.payload.prompt); start(); } break;
      case 'task_start': if (r.bot) botOf.set(task, r.bot); botPrompt.set(task, r.request); start(); break;
      case 'task_done': out.push(['task_end', { task, state: r.stopped ? 'stopped' : 'done' }], ['bot_status', { bot: bot(), status: 'idle' }]); break;
      case 'queue_fail': out.push(['task_end', { task, state: 'failed' }], ['bot_status', { bot: bot(), status: 'idle' }]); break;
      case 'queue_cancel': out.push(['task_end', { task, state: 'stopped' }], ['bot_status', { bot: bot(), status: 'idle' }]); break;
      case 'reply': out.push(['message', { task, bot: bot(), text: typeof r.text === 'string' ? scrub(r.text, 4000) : '', final: true }]); break;
      case 'step': out.push(['message', { task, bot: bot(), text: scrub(`step ${r.step} ${r.status}${r.note ? ': ' + r.note : ''}`, 300), final: false }]); break;
      case 'effect_intent': out.push(['tool_call', { task, bot: bot(), callId: r.effect_id, tool: r.kind, summary: R.redact(`${r.kind} ${r.target || ''}`.trim()) }]); break;
      case 'effect_done': out.push(['tool_result', { task, callId: r.effect_id, ok: true, summary: R.redact(r.mode || 'done') }]); break;
      case 'effect_uncertain': out.push(['tool_result', { task, callId: r.effect_id, ok: false, summary: R.redact('UNCERTAIN: ' + (r.reason || '')) }]); break;
      case 'checkpoint': if (r.tool !== 'restore') out.push(['undo_point', { task, n: r.n, label: R.redact(`before ${r.tool}`) }]); break;
      case 'card': out.push(['card_pending', { card: { id: r.card_id, task, bot: bot(), tool: r.tool, summary: scrub(r.summary, 300), expiresAt: r.expires_at } }]); break;
      case 'card_answer': if (r.answer !== 'unclear') out.push(['card_resolved', { cardId: r.card_id, answer: r.answer }]); break;
      case 'claim_audit': out.push(['claims', { task, checked: r.checked, unverified: r.unverified }]); break;
      case 'job_progress': for (const e of (r.events || []).slice(0, SEQ_STRIDE - 1)) out.push([e.type, e.data]); break;
      case 'job_result': {
        const j = S.jobs.get(r.job_id);
        if (j && j.kind === 'task') {
          const rr = r.result, rep = rr && typeof rr === 'object' && typeof rr.reply === 'string' && rr.reply; // a worker task's engine answer, as a local reply
          out.push(['message', { task, bot: bot(), text: rep ? scrub(rep, 4000) : scrub(typeof rr === 'string' ? rr : (rr && rr.text) || (r.ok ? 'done' : r.error || 'failed'), 2000), final: true }],
            ['task_end', { task, state: r.ok ? 'done' : 'failed' }], ['bot_status', { bot: bot(), status: 'idle' }]);
        }
        break;
      }
      case 'job_uncertain': { const j = S.jobs.get(r.job_id); if (j && j.kind === 'task') out.push(['task_end', { task, state: 'failed' }], ['bot_status', { bot: bot(), status: 'idle' }]); break; }
      case 'job_cancel': { const j = S.jobs.get(r.job_id); if (j && j.kind === 'task') out.push(['task_end', { task, state: 'stopped' }], ['bot_status', { bot: bot(), status: 'idle' }]); break; }
      default:
    }
    return out;
  }
  const botPrompt = new Map();
  function emitNew() {
    if (S.records.length < emitted) { EV.length = 0; emitted = 0; botOf.clear(); announced.clear(); botPrompt.clear(); }
    for (; emitted < S.records.length; emitted++) {
      let evs = [];
      try { evs = toEvents(S.records[emitted]).slice(0, SEQ_STRIDE - 1); } catch { /* one bad record is skipped, never wedges the view */ }
      evs.forEach(([type, data], k) => {
        const ev = { seq: (emitted + 1) * SEQ_STRIDE + k + 1, type, data: { ...data } };
        EV.push(ev);
        for (const c of clients) send(c, ev);
      });
    }
  }
  const send = (res, ev) => { try { res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify({ ...ev.data, seq: ev.seq })}\n\n`); } catch { /* closed */ } };

  // -- worker queue ----
  function bumpWorker(id) { if (typeof id === 'string' && id.length <= 80) workers.set(id, Date.now()); }
  const jobView = j => ({ id: j.id, task: j.task, kind: j.kind, payload: j.payload, deadline: j.deadline });
  function tryClaim(workerId) {
    refresh();
    const mine = [...S.jobs.values()].find(j => j.state === 'claimed' && j.worker === workerId);
    if (mine) return jobView(mine); // a retried claim after a dropped response gets the same job
    const j = [...S.jobs.values()].find(x => x.state === 'queued');
    if (!j) return null;
    const deadline = new Date(Date.now() + (j.timeoutMs || SET.jobTimeoutMs)).toISOString();
    append({ type: 'job_claimed', job_id: j.id, task_id: j.task, worker_id: workerId, deadline });
    return jobView(S.jobs.get(j.id));
  }
  function serveWaiters() {
    for (let i = 0; i < waiters.length;) {
      const w = waiters[i];
      const job = tryClaim(w.workerId);
      if (job) { waiters.splice(i, 1); clearTimeout(w.timer); w.done(200, { job }); } else i++;
    }
  }
  function sweepJobs() {
    refresh();
    for (const j of S.jobs.values()) {
      if (j.state === 'claimed' && Date.parse(j.deadline) <= Date.now()) append({ type: 'job_uncertain', job_id: j.id, task_id: j.task, reason: 'deadline passed without progress or result' });
    }
  }
  function validEvents(events, job) {
    if (!Array.isArray(events) || events.length > SEQ_STRIDE - 2) return null;
    const out = [];
    for (const e of events) {
      if (!e || typeof e !== 'object' || !WORKER_EVENT_TYPES.has(e.type)) return null;
      const d = { ...(e.data && typeof e.data === 'object' ? e.data : e) }; delete d.type; delete d.data; delete d.seq;
      for (const k of Object.keys(d)) if (typeof d[k] === 'string') d[k] = scrub(d[k], 1000);
      out.push({ type: e.type, data: { ...d, task: job.task, bot: job.bot } });
    }
    return out;
  }
  function workerRoute(method, p, body, res) {
    const reply = (status, b) => json(res, status, b);
    if (method !== 'POST') return reply(405, { error: 'POST only' });
    if (p === '/api/worker/hello') {
      if (!body || typeof body.workerId !== 'string' || !body.workerId) return reply(400, { error: 'workerId required' });
      bumpWorker(body.workerId);
      return reply(200, { ok: true, pollMs: 1000 });
    }
    if (p === '/api/worker/claim') {
      if (!body || typeof body.workerId !== 'string' || !body.workerId) return reply(400, { error: 'workerId required' });
      bumpWorker(body.workerId);
      const job = tryClaim(body.workerId);
      if (job) return reply(200, { job });
      const w = { workerId: body.workerId };
      w.done = (status, b) => (status === 204 ? (res.writeHead(204).end()) : reply(status, b));
      w.timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); w.done(204); }, SET.claimWaitMs);
      res.on('close', () => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); clearTimeout(w.timer); } });
      waiters.push(w);
      return undefined;
    }
    const m = /^\/api\/worker\/jobs\/([\w-]+)\/(progress|result)$/.exec(p);
    if (!m) return reply(404, { error: 'not found' });
    refresh();
    const job = S.jobs.get(m[1]);
    if (!job) return reply(404, { error: 'no such job' });
    if (body && typeof body.workerId === 'string') bumpWorker(body.workerId);
    if (m[2] === 'progress') {
      const evs = validEvents(body && body.events, job);
      if (!evs) return reply(400, { error: 'events must be an array of message|tool_call|tool_result|claims objects' });
      if (job.state !== 'claimed') return reply(200, { ok: true, applied: false, state: job.state });
      append({ type: 'job_progress', job_id: job.id, task_id: job.task, events: evs, deadline: new Date(Date.now() + (job.timeoutMs || SET.jobTimeoutMs)).toISOString() });
      return reply(200, { ok: true, applied: true });
    }
    // result: applied once per job id; later posts are acknowledged only
    if (!body || typeof body.ok !== 'boolean') return reply(400, { error: 'ok (boolean) required' });
    let result = null;
    if (body.result !== undefined) {
      const raw = JSON.stringify(body.result);
      if (raw.length > 20000) return reply(413, { error: 'result too large (max 20000 chars)' });
      result = JSON.parse(raw.replace(SECRET_G, '[REDACTED]'));
    }
    const rec = { job_id: job.id, task_id: job.task, ok: body.ok, result, error: body.error ? scrub(body.error, 500) : undefined };
    if (job.state === 'done' || job.state === 'failed') return reply(200, { ok: true, duplicate: true, applied: false });
    if (job.state === 'uncertain') { append({ type: 'job_late_result', ...rec }); return reply(200, { ok: true, applied: false, state: 'uncertain' }); }
    if (job.state === 'cancelled') return reply(200, { ok: true, applied: false, state: 'cancelled' });
    if (job.state !== 'claimed') return reply(409, { error: 'job was not claimed' });
    append({ type: 'job_result', ...rec });
    return reply(200, { ok: true, applied: true });
  }

  // -- http ----
  function json(res, status, body) {
    if (res.headersSent || res.writableEnded) return;
    const s = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  }
  const readBody = req => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > 262144) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!n) return resolve({});
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { return reject(Object.assign(new Error('body is not valid UTF-8 JSON'), { status: 400 })); }
      try { resolve(JSON.parse(text)); } catch { reject(Object.assign(new Error('body is not valid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
  const hostOk = req => { const h = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, ''); return h === 'localhost' || h === '127.0.0.1' || h === '::1'; };
  const originOk = req => { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch { return false; } };
  // Who is calling: the owner token (server.token) is the owner; the optional worker token
  // (worker.token) is a worker; a loopback GET without a token (local_no_auth) is anonymous
  // but may read; everything else is refused. Every state-changing call needs a token,
  // loopback or not: a bot on this machine must not be able to answer its own cards.
  function actorOf(req, p) {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    if (m) {
      const tok = readToken(), wtok = readWorkerToken();
      if (tok && safeEq(m[1], tok)) return OWNER;
      if (wtok && safeEq(m[1], wtok)) return { kind: 'worker' };
      const dev = pairing && pairing.authenticate(m[1]); // device-pairing module: a per-device token, or null
      if (dev) return { kind: 'device', id: dev.id, label: dev.label };
    }
    if (req.method === 'POST' && originOk(req)) { // the one tokenless POST: a route its module marks public-post (pairing redeem)
      const f = p.startsWith('/m/') ? REG.findRoute('POST', p) : null;
      if (f && f.route.access === 'public-post') return { kind: 'anonymous' };
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return null;
    if (p.startsWith('/api/worker/')) return null;
    return SET.localNoAuth && SET.loopbackBind && isLoopback(req.socket.remoteAddress) && hostOk(req) && originOk(req) ? { kind: 'anonymous' } : null;
  }

  // GET/PATCH /api/settings/<module>: schema + current values, and the owner's changes.
  // The config file is written atomically; secrets go to the module's secrets file instead.
  function saveSection(key, section) {
    const f = C.file();
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`config file ${f} is unreadable; not changed`); }
    cur[key] = section;
    const tmp = `${f}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n');
    fs.renameSync(tmp, f);
  }
  async function settingsRoute(method, name, body, res) {
    const schema = REG.settingsSchema(name);
    if (!schema) return json(res, 404, { error: 'no such module' });
    if (method === 'GET') return json(res, 200, { ...schema, values: REG.settingsFor(name) });
    if (method !== 'PATCH' && method !== 'POST') return json(res, 405, { error: 'GET or PATCH only' });
    try { return json(res, 200, { values: await REG.updateSettings(name, body, { save: saveSection }) }); }
    catch (e) { return json(res, 400, { error: scrub(e.message, 500) }); }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname, method = req.method;
    const isApi = p.startsWith('/api/') || p.startsWith('/m/');
    if (!isApi) return json(res, 404, { error: 'not found' });
    const uiM = /^\/m\/([a-z0-9-]+)\/ui(\/.*)?$/.exec(p);
    if (uiM && REG.modules().some(m => m.name === uiM[1])) return serveModuleUi(REG, req, res, uiM[1], uiM[2] ? uiM[2].slice(1) : '', json);
    let actor = actorOf(req, p);
    if (!actor) return json(res, 401, { error: 'unauthorized: this call needs Authorization: Bearer <token> (the token file is server.token in the state dir; taskmote token new makes one)' });
    if (actor.kind === 'device') { // deny by default: only the module's allowlist gets through, and every change is journaled with the device
      if (!pairing.allows(method, p)) return json(res, 403, { error: 'forbidden: this device may not call this route' });
      if (method !== 'GET' && method !== 'HEAD') pairing.audit(actor, method, p);
      actor = { kind: 'owner', id: 'device:' + actor.id }; // allowed routes behave as for the owner; the id keeps the device visible
    }
    refresh();
    let body = {};
    if (method === 'POST' || method === 'PATCH') body = await readBody(req);

    if (p.startsWith('/m/')) { // module routes: the registry matches, checks access, runs the handler
      const found = REG.findRoute(method, p);
      if (!found) return json(res, 404, { error: 'no such module route' });
      const r = await REG.callRoute(found, { actor, body, query: Object.fromEntries(url.searchParams), params: found.params });
      return json(res, r.status, r.json);
    }
    if (p.startsWith('/api/worker/')) return actor.kind === 'owner' || actor.kind === 'worker' ? workerRoute(method, p, body, res) : json(res, 403, { error: 'forbidden' });
    const sm = /^\/api\/settings\/([a-z0-9-]+)$/.exec(p);
    if (sm) return actor.kind === 'owner' ? settingsRoute(method, sm[1], body, res) : json(res, 403, { error: 'forbidden' });
    if (method === 'GET' && p === '/api/bots') {
      return json(res, 200, SET.bots.map(b => {
        const busy = [...S.tasks.values()].some(t => t.bot === b.id && ['running', 'waiting_card', 'queued'].includes(stateOf(t)));
        const offline = b.runsOn === 'worker' && !(workers.size && [...workers.values()].some(ts => Date.now() - ts < 90000));
        return { id: b.id, name: b.name, engine: b.engine, status: offline ? 'offline' : busy ? 'busy' : 'idle', runsOn: b.runsOn };
      }));
    }
    if (method === 'GET' && p === '/api/status') {
      const env = { ...process.env, HARNESS_NO_SERVER: '1' };
      const r = spawnSync(process.execPath, [TASKMOTE, 'status'], { env, encoding: 'utf8', timeout: 60000 });
      return json(res, 200, { text: scrub(r.stdout, 20000).trim() });
    }
    if (p === '/api/tasks') {
      if (method === 'GET') return json(res, 200, taskList(Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50))));
      if (method === 'POST') { if (actor.kind !== 'owner') return json(res, 403, { error: 'forbidden' }); const r = createTask(body.bot === undefined ? defaultBot : body.bot, body.prompt); return json(res, r.status, r.body); }
    }
    const tm = /^\/api\/tasks\/([\w-]+)(?:\/(stop|undo|resume))?$/.exec(p);
    if (tm) {
      const t = S.tasks.get(tm[1]);
      if (method === 'GET' && !tm[2]) return t ? json(res, 200, taskView(t)) : json(res, 404, { error: 'no such task' });
      if (method === 'POST' && tm[2]) {
        if (actor.kind !== 'owner') return json(res, 403, { error: 'forbidden' });
        const r = tm[2] === 'stop' ? stopTask(tm[1]) : tm[2] === 'undo' ? undoTask(tm[1]) : resumeTask(tm[1]);
        return json(res, r.status, r.body);
      }
    }
    if (method === 'GET' && p === '/api/cards') return json(res, 200, listCards(url.searchParams.get('state')));
    const cm = /^\/api\/cards\/(card-[0-9a-f]+)$/i.exec(p);
    if (cm && method === 'POST') { if (actor.kind !== 'owner') return json(res, 403, { error: 'forbidden' }); const r = await answerCard(cm[1].toLowerCase(), body, actor); return json(res, r.status, r.body); }
    if (method === 'POST' && p === '/api/chat') {
      if (actor.kind !== 'owner') return json(res, 403, { error: 'forbidden' });
      const want = body.bots === 'all' ? SET.bots.map(b => b.id) : body.bots;
      if (!Array.isArray(want) || !want.length || want.some(b => !botById.has(b))) return json(res, 400, { error: 'bots must be "all" or a list of known bot ids' });
      if (typeof body.text !== 'string' || !body.text.trim()) return json(res, 400, { error: 'text required' });
      return json(res, 200, [...new Set(want)].map(b => ({ bot: b, taskId: createTask(b, body.text).body.id })));
    }
    if (method === 'GET' && p === '/api/events') {
      const since = Math.max(0, Number(url.searchParams.get('since') || req.headers['last-event-id']) || 0);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': taskmote events\n\n');
      for (const ev of EV) if (ev.seq > since) send(res, ev);
      clients.add(res);
      res.on('close', () => clients.delete(res));
      return undefined;
    }
    return json(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => json(res, e.status || 500, { error: e.status ? e.message : 'internal error' }));
  });
  let timer = null, beat = null, tickN = 0;

  function listen() {
    return new Promise((resolve, reject) => {
      if (!SET.loopbackBind && !readToken()) return reject(new Error('refusing to listen on a non-local address without a token: run `taskmote token new` first'));
      if (!SET.loopbackBind && !restrictToken(TOKEN_FILE())) return reject(new Error(`refusing to listen on a non-local address: the token file ${TOKEN_FILE()} is not owner-only and could not be fixed. Restrict it to your own account (Windows: icacls "<file>" /inheritance:r /grant:r %USERNAME%:F), or run \`taskmote token new\` again`));
      if (!readToken()) tokenNew(); // the CLI and every state-changing call need one
      const info = readInfo();
      if (info && info.pid !== process.pid && J.alive(info.pid)) return reject(new Error(`a server is already running for this state dir (pid ${info.pid})`));
      server.once('error', reject);
      server.listen(SET.port, SET.host, () => {
        const a = server.address();
        fs.mkdirSync(J.STATE, { recursive: true });
        fs.writeFileSync(INFO_FILE(), JSON.stringify({ pid: process.pid, host: SET.host, port: a.port, started: new Date().toISOString() }));
        refresh(true);
        timer = setInterval(() => {
          try {
            refresh();
            if (K && ++tickN % Math.max(1, Math.round(1000 / SET.tickMs)) === 0 && !sweeping) { sweeping = true; sweepCards().catch(() => {}).finally(() => { sweeping = false; }); }
            sweepJobs(); serveWaiters(); pump();
          } catch (e) { process.stderr.write(`server tick: ${e.message}\n`); }
        }, SET.tickMs);
        beat = setInterval(() => { for (const c of clients) { try { c.write(': ping\n\n'); } catch { /* closed */ } } }, 15000);
        // module jobs (interval and service) start once the server is up; an error is reported, never fatal
        if (!closing) jobsP = REG.startJobs({}, (job, e) => process.stderr.write(`module job ${job.module}/${job.id}: ${e && e.message}\n`))
          .catch(e => { process.stderr.write(`module jobs: ${e && e.message}\n`); return null; });
        Promise.resolve(jobsP).then(() => resolve({ host: SET.host, port: a.port }));
      });
    });
  }
  // Memoised: every call returns the same promise. It resolves once module jobs have started (if still starting) and stopped
  // (each bounded by the hook timeout); a caller that exits right after must await it.
  function close() {
    if (closing) return closing;
    clearInterval(timer); clearInterval(beat);
    try { const i = readInfo(); if (i && i.pid === process.pid) fs.unlinkSync(INFO_FILE()); } catch { /* ignore */ }
    for (const c of clients) { try { c.end(); } catch { /* ignore */ } }
    server.close();
    return (closing = (async () => {
      const h = await jobsP;
      if (h) { try { await h.stop(); } catch (e) { process.stderr.write(`module jobs stop: ${e && e.message}\n`); } }
    })());
  }
  return { listen, close, server, enqueueJob: (task, bot, kind, payload) => { append({ type: 'job_queued', job_id: 'j' + J.newId(), task_id: task, bot, kind, payload, timeout_ms: SET.jobTimeoutMs }); serveWaiters(); } };
}

function readInfo() { try { return JSON.parse(fs.readFileSync(INFO_FILE(), 'utf8')); } catch { return null; } }

async function serve() {
  let s;
  try { s = create(); } catch (e) { console.error(`taskmote: ${e.message}`); process.exit(2); }
  const stop = () => { s.close().finally(() => process.exit(0)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop); // before listen: a signal while jobs start still cleans up
  try {
    const a = await s.listen();
    console.log(`taskmote server listening on http://${a.host}:${a.port}  (state ${J.STATE})`);
  } catch (e) { console.error(`taskmote: ${e.message}`); process.exit(e.code === 'EADDRINUSE' ? 1 : 2); }
}

module.exports = { create, serve, tokenNew, readToken, readWorkerToken, readInfo, settings, TOKEN_FILE, WORKER_TOKEN_FILE, INFO_FILE };
