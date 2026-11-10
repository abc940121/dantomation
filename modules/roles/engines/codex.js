#!/usr/bin/env node
'use strict';
// roles/engines/codex.js: a Taskmote "turn engine" that runs one chat turn on the OpenAI Codex CLI.
// The core gives the whole prompt on stdin and takes our trimmed plain stdout as the reply. Plain node, no packages.
//   - runs `codex exec` in the current folder (the role's work folder), workspace-write sandbox, no approval prompts
//   - attaches the taskmote-tools MCP server (bin/taskmote-mcp.js) with the same env a Claude session gets
//   - keeps the conversation: the Codex session id of the role is stored in <state>/m/roles/ (never in the work folder)
//     and the next turn uses `codex exec resume <id>`; if resume fails, one fresh start
//   - stdout: only the final assistant message. stderr: diagnostics. Exit non-zero on failure, one short stderr line.
// Test seam: ROLES_CODEX_BIN names a node script that stands in for codex.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TIMEOUT_MS = 10 * 60 * 1000;
const ID_RE = /^[0-9a-zA-Z][0-9a-zA-Z-]{7,63}$/;
const toml = v => JSON.stringify(String(v)); // a TOML basic string (JSON escapes are valid TOML)
const fwd = p => String(p).replace(/\\/g, '/');
const die = (code, msg) => { process.stderr.write(`codex engine: ${String(msg).replace(/\s+/g, ' ').slice(0, 300)}\n`); process.exit(code); };

// The bot (role) id: the work folder is named bot-<id>; else HARNESS_BOT; else "main".
function botId(cwd, env) {
  const m = /^bot-([\w-]+)$/.exec(path.basename(cwd));
  return (m && m[1]) || String((env && env.HARNESS_BOT) || 'main').replace(/[^\w-]/g, '_');
}
const stateDir = env => path.join(env.HARNESS_STATE_DIR || path.join(ROOT, 'state'), 'm', 'roles');
const sessionFile = (env, bot) => path.join(stateDir(env), `codex-session-${bot.replace(/[^\w-]/g, '_')}.json`);

function readSession(env, bot) {
  try {
    const j = JSON.parse(fs.readFileSync(sessionFile(env, bot), 'utf8'));
    return j && typeof j.id === 'string' && ID_RE.test(j.id) ? j.id : null;
  } catch { return null; }
}
function writeSession(env, bot, id) {
  const f = sessionFile(env, bot);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ id, updated_at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  try { fs.renameSync(tmp, f); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
}
function clearSession(env, bot) { try { fs.unlinkSync(sessionFile(env, bot)); } catch { /* none */ } }

// -c overrides that attach the same tools server the Claude path gets (see approveMcpFile in bin/harness.js).
function mcpOverrides(env, node) {
  const e = { HARNESS_STATE_DIR: env.HARNESS_STATE_DIR || path.join(ROOT, 'state') };
  if (env.HARNESS_CONFIG) e.HARNESS_CONFIG = env.HARNESS_CONFIG;
  if (env.HARNESS_TASK_ID) e.HARNESS_TASK_ID = env.HARNESS_TASK_ID;
  const tbl = '{' + Object.entries(e).map(([k, v]) => `${k}=${toml(fwd(v))}`).join(',') + '}';
  const p = 'mcp_servers.taskmote-tools';
  return ['-c', `${p}.command=${toml(fwd(node))}`, '-c', `${p}.args=[${toml(fwd(path.join(ROOT, 'bin', 'taskmote-mcp.js')))}]`, '-c', `${p}.env=${tbl}`];
}

// argv after the codex executable. The prompt comes on stdin ("-"). resume has no -s / -C, so the sandbox and the
// approval policy are config overrides on both forms.
function buildArgs({ env, cwd, outFile, resumeId }) {
  const common = ['--json', '--skip-git-repo-check',
    '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"',
    ...mcpOverrides(env, process.execPath), '-o', outFile];
  return resumeId ? ['exec', 'resume', ...common, resumeId, '-'] : ['exec', '-C', cwd, ...common, '-'];
}

// The real codex executable. Windows: the npm shim is codex.cmd (a shell script): use the native exe next to it, else node + its
// codex.js, so nothing needs a shell and no console window opens.
function resolveCodex(env) {
  if (env.ROLES_CODEX_BIN) return { bin: process.execPath, pre: [env.ROLES_CODEX_BIN] };
  if (process.platform !== 'win32') return { bin: 'codex', pre: [] };
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    if (!fs.existsSync(path.join(d, 'codex.cmd'))) continue;
    const pkg = path.join(d, 'node_modules', '@openai', 'codex');
    try {
      const sub = path.join(pkg, 'node_modules', '@openai');
      for (const n of fs.readdirSync(sub)) {
        const vend = path.join(sub, n, 'vendor');
        for (const t of fs.readdirSync(vend)) { const exe = path.join(vend, t, 'bin', 'codex.exe'); if (fs.existsSync(exe)) return { bin: exe, pre: [] }; }
      }
    } catch { /* fall through to the js entry */ }
    const js = path.join(pkg, 'bin', 'codex.js');
    if (fs.existsSync(js)) return { bin: process.execPath, pre: [js] };
  }
  return { bin: 'codex.exe', pre: [] };
}

function killTree(child) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* already gone */ }
}

// Run codex once. -> { code, stdout, stderr, timedOut }
function runCodex(exe, args, input, cwd, env, ms) {
  return new Promise(resolve => {
    let out = '', err = '', timedOut = false, done = false;
    const child = spawn(exe.bin, [...exe.pre, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32' });
    const finish = r => { if (done) return; done = true; clearTimeout(timer); resolve({ stdout: out, stderr: err, timedOut, ...r }); };
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, ms);
    child.stdout.on('data', c => { out += c; if (out.length > 8e6) out = out.slice(-4e6); });
    child.stderr.on('data', c => { err += c; if (err.length > 2e5) err = err.slice(-1e5); });
    child.stdin.on('error', () => { /* codex exited before reading */ });
    child.on('error', e => finish({ code: -1, stderr: err + String((e && e.code) || e) }));
    child.on('close', code => { if (timedOut) killTree(child); finish({ code: code === null ? -1 : code }); });
    child.stdin.end(input);
  });
}

// From the --json event lines: the thread (session) id and the last agent message.
function parseEvents(text) {
  let id = null, last = '';
  for (const line of String(text).split(/\r?\n/)) {
    if (line[0] !== '{') continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'thread.started' && typeof e.thread_id === 'string') id = e.thread_id;
    if (e.type === 'item.completed' && e.item && e.item.type === 'agent_message' && typeof e.item.text === 'string') last = e.item.text;
  }
  return { id, last };
}

async function turn({ prompt, cwd, env, exe, timeoutMs }) {
  const bot = botId(cwd, env), deadline = Date.now() + (timeoutMs || TIMEOUT_MS);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-codex-'));
  const outFile = path.join(tmp, 'last.txt');
  try {
    let resumeId = readSession(env, bot);
    for (let attempt = 0; attempt < 2; attempt++) {
      try { fs.rmSync(outFile, { force: true }); } catch { /* none */ }
      const r = await runCodex(exe, buildArgs({ env, cwd, outFile, resumeId }), prompt, cwd, env, Math.max(1000, deadline - Date.now()));
      const ev = parseEvents(r.stdout);
      let reply = ''; try { reply = fs.readFileSync(outFile, 'utf8').trim(); } catch { /* fall back to the event */ }
      if (!reply) reply = ev.last.trim();
      if (r.timedOut) return { ok: false, error: 'timed out after 10 minutes' };
      if (r.code === 0 && reply) {
        const sid = ev.id || resumeId;
        if (sid) { try { writeSession(env, bot, sid); } catch (e) { process.stderr.write(`codex engine: could not save the session id (${e.code || 'error'})\n`); } }
        return { ok: true, reply, resumed: !!resumeId, sessionId: sid };
      }
      if (resumeId && Date.now() < deadline) { // resume failed: forget the id, start fresh once
        process.stderr.write(`codex engine: resume failed (exit ${r.code}), starting a new session\n`);
        clearSession(env, bot); resumeId = null; continue;
      }
      const why = (r.stderr.trim().split(/\r?\n/).filter(Boolean).pop() || '').slice(0, 200);
      return { ok: false, error: r.code === 0 ? 'codex returned no reply' : `codex exit ${r.code}${why ? ': ' + why : ''}` };
    }
    return { ok: false, error: 'codex failed' };
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } }
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const prompt = Buffer.concat(chunks).toString('utf8');
  if (!prompt.trim()) die(2, 'empty prompt on stdin');
  const env = process.env;
  const r = await turn({ prompt, cwd: process.cwd(), env, exe: resolveCodex(env) });
  if (!r.ok) die(1, r.error);
  process.stdout.write(r.reply + '\n');
}

if (require.main === module) main().catch(e => die(1, (e && e.message) || e));
module.exports = { botId, sessionFile, readSession, writeSession, clearSession, buildArgs, mcpOverrides, parseEvents, resolveCodex, turn };
