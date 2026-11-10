#!/usr/bin/env node
'use strict';
// roles/engines/opencode.js: a Taskmote "turn engine" that runs one chat turn on the OpenCode CLI.
// The core gives the whole prompt on stdin and takes our trimmed plain stdout as the reply. Plain node, no packages.
//   - runs `opencode run "<short message>" --standalone --auto --format json -m <id> [-s <session>] -f <prompt file>` in the role's work
//     folder (stdin closed). The prompt is in the attached file, kept in <state>/m/roles/, never in the work folder.
//   - models: exactly two are allowed by default: the free opencode/deepseek-v4.1-flash-free (first) and the prepaid plan model
//     opencode-go/deepseek-v4.1-flash. Anything else could bill per use and is refused (bilingual) unless the owner lists it in the
//     roles setting opencode_extra_paid_models. "Free usage limit reached" -> one retry on the plan model, and "free exhausted" is
//     remembered for 120 minutes. Quota used up / expired key -> a bilingual reply. Never more retries than that.
//   - permissions: OpenCode has no OS sandbox and --auto approves whatever is not denied, so before each run the module writes
//     opencode.json in the work folder: external directories denied, .env reads denied, edits to config/instruction files denied,
//     bash/shell denied (unless the roles setting opencode_allow_bash is on). Network tools are ON by default; the roles setting
//     opencode_allow_web=false denies every one of them, including OpenCode's Code Mode `execute` tool whose `fetch` bypasses the
//     webfetch rule. The taskmote-tools MCP server is in the file too.
//   - keeps the conversation: the OpenCode session id is stored in <state>/m/roles/ and passed with -s; if that fails, one fresh start
//   - a per-role daily turn cap (engines/limits.js); a refused turn is answered with a short bilingual notice, exit 0
//   - stdout: only the final assistant text. stderr: diagnostics. Exit non-zero on failure, one short stderr line.
// Test seams: ROLES_OPENCODE_BIN names a node script that stands in for opencode; ROLES_OPENCODE_MODEL gives the model
// directly (manual runs and tests), else it is read from the role record in <state>/m/roles/roles.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const limits = require('./limits');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EXHAUSTED_MS = 120 * 60 * 1000;
const ID_RE = /^[0-9a-zA-Z][0-9a-zA-Z_-]{7,79}$/;
const FREE = 'opencode/deepseek-v4.1-flash-free';
const GO = 'opencode-go/deepseek-v4.1-flash';
const fwd = p => String(p).replace(/\\/g, '/');
const die = (code, msg) => { process.stderr.write(`opencode engine: ${String(msg).replace(/\s+/g, ' ').slice(0, 300)}\n`); process.exit(code); };

const MSG = {
  quota: 'The OpenCode quota is used up for now, so this role cannot answer. Try again later.\nOpenCode 的額度暫時用完了，這個角色現在無法回覆，請稍後再試。',
  timeout: 'This turn took too long and was stopped.\nOpenCode 這一輪花太久，已被中止。',
  key: 'The OpenCode API key has expired or is not accepted. The owner needs to renew it.\nOpenCode 的 API 金鑰已過期或不被接受，需要擁有者更新。',
};

function botId(cwd, env) {
  const m = /^bot-([\w-]+)$/.exec(path.basename(cwd));
  return (m && m[1]) || String((env && env.HARNESS_BOT) || 'main').replace(/[^\w-]/g, '_');
}
const stateDir = env => path.join(env.HARNESS_STATE_DIR || path.join(ROOT, 'state'), 'm', 'roles');
const sessionFile = (env, bot) => path.join(stateDir(env), `opencode-session-${bot.replace(/[^\w-]/g, '_')}.json`);
const exhaustedFile = env => path.join(stateDir(env), 'opencode-free-exhausted.json');

function writeJson(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj) + '\n', { mode: 0o600 });
  try { fs.renameSync(tmp, f); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
}
function readSession(env, bot) {
  try {
    const j = JSON.parse(fs.readFileSync(sessionFile(env, bot), 'utf8'));
    return j && typeof j.id === 'string' && ID_RE.test(j.id) ? j.id : null;
  } catch { return null; }
}
const writeSession = (env, bot, id) => writeJson(sessionFile(env, bot), { id, updated_at: new Date().toISOString() });
function clearSession(env, bot) { try { fs.unlinkSync(sessionFile(env, bot)); } catch { /* none */ } }

// "free exhausted" memory: until <ms epoch>. Later turns go straight to the plan model.
function freeExhausted(env, now) {
  try { const j = JSON.parse(fs.readFileSync(exhaustedFile(env), 'utf8')); return !!j && Number.isFinite(j.until) && j.until > (now || Date.now()); } catch { return false; }
}
function markExhausted(env, now) { try { writeJson(exhaustedFile(env), { until: (now || Date.now()) + EXHAUSTED_MS }); } catch { /* best effort */ } }

const isFree = m => String(m).split('#')[0] === FREE;

// Money gate. Allowed: the two ids above (variant suffix "#x" ignored) and the owner's extra paid list. -> null or the reason (bilingual).
function modelProblem(model, extra) {
  const m = String(model || '').trim();
  if (!m) return 'no model given / 沒有指定模型';
  const base = m.split('#')[0];
  if (base === FREE || base === GO || (extra || []).some(a => a === m || a === base)) return null;
  return `model ${m} could cost money (only ${FREE} and ${GO} are allowed) and is refused unless the owner lists it in the roles setting opencode_extra_paid_models.\n模型 ${m} 可能產生費用（預設只允許 ${FREE} 與 ${GO}），除非擁有者列在 roles 設定的 opencode_extra_paid_models，否則拒絕使用。`;
}

// Every network route OpenCode has, denied when the roles setting opencode_allow_web is false. `execute` (Code Mode) is the one that
// matters most: its `fetch` is not governed by the webfetch rule, and with it denied the MCP tools (reached through Code Mode) go too.
const WEB_TOOLS = ['execute', 'codemode', 'webfetch', 'websearch', 'codesearch', 'fetch', 'browser', 'browser*', 'web*', 'http*', 'context7_*'];

// The per-run opencode.json for the work folder: permissions + the Taskmote tools server.
function configFor(env, wd, node, allowBash, allowWeb) {
  const w = fwd(wd), both = n => ({ [n]: 'deny', [`**/${n}`]: 'deny' });
  const e = { HARNESS_STATE_DIR: fwd(env.HARNESS_STATE_DIR || path.join(ROOT, 'state')) };
  if (env.HARNESS_CONFIG) e.HARNESS_CONFIG = fwd(env.HARNESS_CONFIG);
  if (env.HARNESS_TASK_ID) e.HARNESS_TASK_ID = env.HARNESS_TASK_ID;
  return {
    mcp: { 'taskmote-tools': { type: 'local', command: [fwd(node), fwd(path.join(ROOT, 'bin', 'taskmote-mcp.js'))], environment: e } },
    permission: {
      external_directory: { '*': 'deny', [w]: 'allow', [`${w}/**`]: 'allow' },
      read: { '*': 'allow', '*.env': 'deny', '**/*.env': 'deny', '*.env.*': 'deny', '**/*.env.*': 'deny' },
      edit: { '*': 'allow', ...both('opencode.json'), ...both('AGENTS.md'), ...both('CLAUDE.md'), '.opencode/**': 'deny', '.claude/**': 'deny', '.codex/**': 'deny' },
      bash: allowBash ? 'allow' : 'deny',
      shell: allowBash ? 'allow' : 'deny',
      ...(allowWeb === false ? Object.fromEntries(WEB_TOOLS.map(k => [k, 'deny'])) : { webfetch: 'allow', websearch: 'allow' }),
    },
  };
}

// argv after the opencode executable. The prompt is the attached file; stdin is closed.
function buildArgs({ model, resumeId, promptFile }) {
  return ['run', 'Answer the request in the attached file.', '--standalone', '--auto', '--format', 'json', '-m', model, ...(resumeId ? ['-s', resumeId] : []), '-f', promptFile];
}

// The real opencode executable. Windows: the npm shim is opencode.cmd (a shell script): use the native exe it points at, so nothing needs a shell.
function resolveOpencode(env) {
  if (env.ROLES_OPENCODE_BIN) return { bin: process.execPath, pre: [env.ROLES_OPENCODE_BIN] };
  if (process.platform !== 'win32') return { bin: 'opencode', pre: [] };
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    if (!fs.existsSync(path.join(d, 'opencode.cmd'))) continue;
    const exe = path.join(d, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
    if (fs.existsSync(exe)) return { bin: exe, pre: [] };
  }
  return { bin: 'opencode.exe', pre: [] };
}

function killTree(child) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* already gone */ }
}

// Run opencode once, stdin closed. -> { code, stdout, stderr, timedOut }
function runOpencode(exe, args, cwd, env, ms) {
  return new Promise(resolve => {
    let out = '', err = '', timedOut = false, done = false;
    const child = spawn(exe.bin, [...exe.pre, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32' });
    const finish = r => { if (done) return; done = true; clearTimeout(timer); resolve({ stdout: out, stderr: err, timedOut, ...r }); };
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, ms);
    child.stdout.on('data', c => { out += c; if (out.length > 8e6) out = out.slice(-4e6); });
    child.stderr.on('data', c => { err += c; if (err.length > 2e5) err = err.slice(-1e5); });
    child.stdin.on('error', () => { /* closed */ });
    child.on('error', e => finish({ code: -1, stderr: err + String((e && e.code) || e) }));
    child.on('close', code => { if (timedOut) killTree(child); finish({ code: code === null ? -1 : code }); });
    child.stdin.end();
  });
}

// From the --format json event lines: the session id and the reply = the text parts of the last assistant message that has text.
function parseEvents(text) {
  let id = null, msg = null, last = '';
  for (const line of String(text).split(/\r?\n/)) {
    if (line[0] !== '{') continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (typeof e.sessionID === 'string') id = e.sessionID;
    if (e.type === 'text' && e.part && typeof e.part.text === 'string') {
      if (e.part.messageID !== msg) { msg = e.part.messageID; last = ''; }
      last += e.part.text;
    }
  }
  return { id, last };
}

// What a failed run says. -> 'free' | 'quota' | 'key' | null
function classify(text) {
  const t = String(text);
  if (/Free usage limit reached/i.test(t)) return 'free';
  if (/rate limit|usage limit reached/i.test(t)) return 'quota';
  if (/API key has expired|unauthorized/i.test(t)) return 'key';
  return null;
}

// One chat turn. -> { ok: true, reply } | { ok: false, notice } (a reply to show, exit 0) | { ok: false, error }
async function turn({ prompt, cwd, env, exe, model, allowBash, allowWeb, timeoutMs, goCap: goCapN }) {
  const bot = botId(cwd, env), deadline = Date.now() + (timeoutMs || limits.DEFAULT_TIMEOUT_S * 1000), goCap = goCapN || 0;
  const sdir = stateDir(env), promptFile = path.join(sdir, `opencode-prompt-${bot.replace(/[^\w-]/g, '_')}.txt`);
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
  try {
    writeJson(path.join(cwd, 'opencode.json'), configFor(env, cwd, process.execPath, allowBash, allowWeb)); // module-owned, rewritten every run
    let cur = model && !(isFree(model) && freeExhausted(env)) ? model : (freeExhausted(env) ? GO : FREE);
    let resumeId = readSession(env, bot), fell = false, fresh = false;
    for (;;) {
      if (cur.startsWith('opencode-go/')) { // count plan turns across all roles; refuse at the owner's cap
        const g = limits.goTake(sdir, goCap); if (!g.ok) return { ok: false, notice: g.message };
      }
      const r = await runOpencode(exe, buildArgs({ model: cur, resumeId, promptFile }), cwd, env, Math.max(1000, deadline - Date.now()));
      const ev = parseEvents(r.stdout), reply = ev.last.trim();
      if (r.timedOut) return { ok: false, notice: MSG.timeout };
      if (r.code === 0 && reply) {
        const sid = ev.id || resumeId;
        if (sid) { try { writeSession(env, bot, sid); } catch (e) { process.stderr.write(`opencode engine: could not save the session id (${e.code || 'error'})\n`); } }
        return { ok: true, reply, model: cur, resumed: !!resumeId, sessionId: sid };
      }
      const kind = classify(r.stdout + '\n' + r.stderr);
      if (kind === 'free' && isFree(cur) && !fell) { // the free tier is used up: once on the plan model, and remember it
        markExhausted(env); cur = GO; fell = true;
        process.stderr.write(`opencode engine: free usage limit reached, using ${GO}\n`);
        continue;
      }
      if (kind === 'free' || kind === 'quota') return { ok: false, notice: MSG.quota };
      if (kind === 'key') return { ok: false, notice: MSG.key };
      if (resumeId && !fresh && Date.now() < deadline) { // resume failed: forget the id, start fresh once
        process.stderr.write(`opencode engine: resume failed (exit ${r.code}), starting a new session\n`);
        clearSession(env, bot); resumeId = null; fresh = true; continue;
      }
      const why = (r.stderr.trim().split(/\r?\n/).filter(Boolean).pop() || '').slice(0, 200);
      return { ok: false, error: r.code === 0 ? 'opencode returned no reply' : `opencode exit ${r.code}${why ? ': ' + why : ''}` };
    }
  } finally { try { fs.unlinkSync(promptFile); } catch { /* gone */ } }
}

// The role's model: ROLES_OPENCODE_MODEL (tests, manual runs), else the role record in <state>/m/roles/roles.json.
function modelOf(env, bot) {
  if (env.ROLES_OPENCODE_MODEL !== undefined) return env.ROLES_OPENCODE_MODEL;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(stateDir(env), 'roles.json'), 'utf8'));
    const r = (Array.isArray(j && j.roles) ? j.roles : []).find(x => x && x.id === bot && !x.archived_at);
    return r && typeof r.model === 'string' ? r.model : '';
  } catch { return ''; }
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const prompt = Buffer.concat(chunks).toString('utf8');
  if (!prompt.trim()) die(2, 'empty prompt on stdin');
  const env = process.env, cwd = process.cwd(), bot = botId(cwd, env), st = limits.settings(env);
  const model = String(modelOf(env, bot) || '').trim();
  const bad = model ? modelProblem(model, st.paid) : null; // no model = the defaults (free first, then the plan model)
  if (bad) die(1, bad);
  const gate = limits.takeTurn(env, ROOT, bot); // per-role daily cap (settings daily_turn_cap, 0 = off)
  if (!gate.ok) { process.stdout.write(gate.message + '\n'); return; }
  const r = await turn({ prompt, cwd, env, exe: resolveOpencode(env), model, allowBash: st.bash, allowWeb: st.web, goCap: st.goCap, timeoutMs: st.timeoutS * 1000 });
  if (r.notice) { process.stdout.write(r.notice + '\n'); return; }
  if (!r.ok) die(1, r.error);
  process.stdout.write(r.reply + '\n');
}

if (require.main === module) main().catch(e => die(1, (e && e.message) || e));
module.exports = { botId, sessionFile, readSession, writeSession, clearSession, buildArgs, configFor, parseEvents, classify, resolveOpencode, modelProblem, modelOf, freeExhausted, exhaustedFile, turn, FREE, GO, MSG };
