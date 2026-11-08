#!/usr/bin/env node
'use strict';
// Engine: runs Claude Code (subscription login) headless on one task.
//   harness.js start "<request>" [--workdir <dir>]
//   harness.js resume            continue the open task from the journal
//   harness.js status
//   harness.js secret <module> <key>   set a module's secret setting (value on stdin)
//   harness.js uninstall <module>      run its uninstall hook, remove its state and secrets
//   harness.js <cmd> ...         a subcommand provided by an enabled module (e.g. checkpoint: restore)
// Seams left for later layers: dispatch (run on the Windows worker), approval
// cards (UNCERTAIN effects / guard blocks), voice entry (calls `start`).
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync, execSync } = require('child_process');
const J = require('../lib/journal');

const C = require('../lib/config');
const M = require('../lib/modules');
let CONFIG;
try { CONFIG = C.load(); } catch (e) { console.error(`harness: ${e.message}; fix or remove it (HARNESS_CONFIG / ~/.harness/config.json)`); process.exit(2); }
const EFFECT = path.join(J.ROOT, 'bin', 'effect.js');
let MODS = [];   // enabled modules, set by main() (loadModules)

function cleanEnv() {
  const pats = CONFIG.strip_env.map(p => new RegExp('^' + p.replace(/\*/g, '.*') + '$', 'i'));
  const env = { ...process.env };
  const stripped = [];
  for (const k of Object.keys(env)) if (pats.some(r => r.test(k))) { stripped.push(k); delete env[k]; }
  return { env, stripped };
}

function settingsFile() {
  // Generated so the hook command carries absolute paths.
  const node = process.execPath.replace(/\\/g, '/');
  const guard = path.join(J.ROOT, 'guards', 'guard.js').replace(/\\/g, '/');
  const hook = after => [{ matcher: '*', hooks: [{ type: 'command', command: `"${node}" "${guard}"${after ? ' --after' : ''}`, timeout: 60 }] }];
  const s = { hooks: { PreToolUse: hook(false), PostToolUse: hook(true) } };
  const f = path.join(J.STATE, 'claude-settings.json');
  fs.mkdirSync(J.STATE, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
  return f;
}

function protocolFile() {
  const text = fs.readFileSync(path.join(J.ROOT, 'config', 'protocol.md'), 'utf8').split('{{EFFECT}}').join(EFFECT.replace(/\\/g, '/'));
  const f = path.join(J.STATE, 'protocol.md');
  fs.writeFileSync(f, text);
  return f;
}

function ensureWorkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.git'))) execFileSync('git', ['init', '-q'], { cwd: dir });
}

// The engine command: binary, argv, stripped env. Exported so a long-lived
// process (e.g. modules/voice/ with --input-format stream-json) reuses the same
// settings, guard, tools and env instead of copying them.
// prompt === null -> bare -p (print mode, no prompt; caller streams input instead).
function engineSpec(prompt) {
  const { env, stripped } = cleanEnv();
  const args = [...(prompt === null ? ['-p'] : ['-p', prompt]),
    '--setting-sources', CONFIG.engine.setting_sources,
    '--settings', settingsFile(),
    '--append-system-prompt-file', protocolFile(),
    '--tools', CONFIG.engine.claude_tools,
    '--allowedTools', CONFIG.engine.claude_tools,
    '--strict-mcp-config', '--disable-slash-commands',
    '--output-format', 'stream-json', '--verbose'];
  // Test seam: HARNESS_ENGINE_SCRIPT runs a node script as a fake engine.
  const fake = process.env.HARNESS_ENGINE_SCRIPT;
  return { bin: fake ? process.execPath : (process.env.HARNESS_CLAUDE || 'claude'), args: fake ? [fake, ...args] : args, env, stripped };
}

// One executor per harness: state/executor.lock holds the harness pid and the
// engine pid. start/resume refuse while either is alive, so killing only the
// parent cannot lead to a second engine running the same task.
const EXEC_LOCK = path.join(J.STATE, 'executor.lock');

// Events (lib/modules.js emit): task.start after the engine_start record and
// before the prompt is built (a module may journal a note the prompt should
// show); then each module's prepareTurn may add context lines to the prompt;
// task.end after the engine_exit record.
// The engine's final answer (the last stream-json "result" line), so a chat UI can show it.
// Only bytes after "from" (the log is append-mode: an earlier turn's answer must not be re-journaled).
function lastReply(file, from = 0) {
  let lines; try { lines = fs.readFileSync(file).subarray(from).toString('utf8').split('\n'); } catch { return ''; }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"result"')) continue;
    try { const o = JSON.parse(lines[i]); if (o && o.type === 'result' && typeof o.result === 'string') return o.result; } catch {}
  }
  return '';
}

async function runEngine(task, nonce) {
  J.append({ type: 'engine_start', task_id: task.task_id, stripped_env: cleanEnv().stripped, resumed: !!task.resumed });
  await M.emit(MODS, 'task.start', { task_id: task.task_id, request: task.request, workdir: task.workdir, resumed: !!task.resumed }, { task, config: CONFIG });
  const extra = await M.prepareTurn(MODS, { task_id: task.task_id, request: task.request, workdir: task.workdir, resumed: !!task.resumed });
  const notes = extra.context.map(c => `[${c.module}] ${c.text}`).join('\n');
  const spec = engineSpec(J.buildPrompt(J.readAll().records, task) + (notes ? `\n\n## Context from modules\n${notes}` : ''));
  const logFile = path.join(J.STATE, `engine-${task.task_id}.jsonl`);
  let logFrom = 0; try { logFrom = fs.statSync(logFile).size; } catch { /* no log yet */ }
  const out = fs.openSync(logFile, 'a');
  // The guard snapshots this folder before every mutating tool call.
  Object.assign(spec.env, { HARNESS_TASK_ID: task.task_id, HARNESS_TASK_DIR: task.workdir, HARNESS_STATE_DIR: J.STATE });
  const child = spawn(spec.bin, spec.args, { cwd: task.workdir, env: spec.env, stdio: ['ignore', out, out], shell: false, windowsHide: true });
  J.relock(EXEC_LOCK, { pids: [process.pid, child.pid], task_id: task.task_id }, nonce);
  const code = await new Promise(res => child.on('exit', res));
  J.unlock(EXEC_LOCK, nonce);
  const reply = M.scrubAll(lastReply(logFile, logFrom)).trim().slice(0, 4000); // hide every loaded module's secrets and secret patterns in the full text, then clip
  if (reply) J.append({ type: 'reply', task_id: task.task_id, text: reply });
  J.append({ type: 'engine_exit', task_id: task.task_id, code });
  await M.emit(MODS, 'task.end', { task_id: task.task_id, code, workdir: task.workdir }, { task, code, config: CONFIG });
  const open = J.openTask(J.readAll().records);
  const finished = !open || open.task_id !== task.task_id;
  console.log(finished ? `task ${task.task_id} done` : `task ${task.task_id} not finished (exit ${code}); run: harness resume`);
  process.exitCode = finished ? 0 : 1;
}

function resolveClaude() {
  if (process.env.HARNESS_CLAUDE) return;
  if (process.platform !== 'win32') return;
  // spawn without a shell needs the real exe on Windows
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const exe = path.join(npmRoot, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(exe)) process.env.HARNESS_CLAUDE = exe;
  } catch { /* fall back to PATH */ }
}

const nap = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Enabled modules (config "modules"). Any problem exits 2 naming the module:
// the harness never runs silently without a module the config turned on.
// Pending state migrations (stateVersion) run here, once; a failed one exits 2 too.
async function loadModules() {
  const { mods, errors } = M.load(CONFIG);
  if (errors.length) { console.error(`harness: module load error: ${errors.join('; ')}. Fix config "modules" (or the module), or turn it off.`); process.exit(2); }
  const mig = await M.migrate(mods);
  if (mig.errors.length) { console.error(`harness: module ${mig.errors.join('; ')}. Fix the module or its state, or turn it off.`); process.exit(2); }
  return (MODS = mods);
}

// `harness uninstall <module>`: the module's uninstall hook, then its state/m/<name>/
// and secrets are removed. The config line and modules/<name>/ stay the owner's to remove.
async function uninstallVerb([name]) {
  if (process.env.HARNESS_TASK_ID) { console.error('harness: modules are uninstalled by the owner, not from inside a task'); process.exit(2); }
  if (!name) { console.error('usage: harness uninstall <module>'); process.exit(2); }
  let r;
  try { r = await M.uninstall(CONFIG, name); } catch (e) { console.error(`harness: ${e.message}`); process.exit(2); }
  for (const e of r.errors) console.error(`harness: ${name}: ${e}`);
  console.log(`${name}: removed ${r.removed.length} state path(s). Now remove "${name}" from config "modules" and delete modules/${name}/ if you no longer want it.`);
  if (r.errors.length) process.exitCode = 1;
}

// `harness secret <module> <key>`: the value is read from stdin (empty removes it)
// and stored owner-only under the state dir, never in config.json. Not from a task.
function secretVerb([name, key]) {
  if (process.env.HARNESS_TASK_ID) { console.error('harness: secrets are set by the owner, not from inside a task'); process.exit(2); }
  if (!name || !key) { console.error('usage: harness secret <module> <key>   (value on stdin; empty removes it)'); process.exit(2); }
  let value;
  try { value = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, ''); } catch { value = ''; }
  try { const f = M.setSecret(name, key, value); console.log(`${name}.${key} ${value ? 'set' : 'removed'} (${path.relative(J.STATE, f)} in the state dir, owner-only)`); }
  catch (e) { console.error(`harness: ${e.message}`); process.exit(2); }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'secret') return secretVerb(rest);
  if (cmd === 'uninstall') return uninstallVerb(rest);
  let { records, torn } = J.readAll();
  let open = J.openTask(records);
  if ((cmd === 'start' || cmd === 'resume' || cmd === 'status') && C.warn()) console.error(C.warn());
  if (cmd === 'status') {
    if (torn) console.error(`journal: ${torn} torn line(s) skipped`);
    if (!open) return console.log('no open task');
    console.log(J.buildPrompt(records, open));
    return;
  }
  const isRun = cmd === 'start' || cmd === 'resume';
  if (!isRun) {
    const handler = cmd && M.commands(await loadModules())[cmd];
    if (handler) return await handler(rest, { J, EXEC_LOCK });
    console.error(`usage: harness start "<request>" | resume | status | secret <module> <key> | uninstall <module>${Object.keys(M.commands(MODS)).map(k => ' | ' + k + ' ...').join('')}`);
    process.exit(2);
  }
  await loadModules();
  resolveClaude();
  let nonce = null;
  {
    let l = J.lock(EXEC_LOCK, { pids: [process.pid], task_id: null });
    // A transient holder (a voice turn: lock record has transient:true) is short: wait up to 60 s for it.
    const until = Date.now() + Number(process.env.HARNESS_VOICE_WAIT_MS || 60000);
    while (!l.held && l.holder.transient && Date.now() < until) { nap(500); l = J.lock(EXEC_LOCK, { pids: [process.pid], task_id: null }); }
    if (!l.held) {
      const h = l.holder;
      console.error(`an executor is still running (${h.transient ? (h.label || 'short-lived holder') : 'task ' + (h.task_id || '?')}, pid ${(h.pids || []).filter(J.alive).join(',') || '?'}); not starting a second one. Wait for it to exit, or ask ${CONFIG.owner_name}.`);
      process.exit(4);
    }
    nonce = l.nonce;
    // released by runEngine on engine exit; if we exit before spawning, drop it.
    // unlock checks the nonce, so a lock that is no longer ours is left alone.
    process.on('exit', () => { const h = J.readLock(EXEC_LOCK); if (h && h.nonce === nonce && (h.pids || []).length === 1) J.unlock(EXEC_LOCK, nonce); });
    // Re-read under the lock: the journal may have moved while we waited.
    ({ records, torn } = J.readAll());
    open = J.openTask(records);
  }
  if (torn) console.error(`journal: ${torn} torn line(s) skipped`);
  if (cmd === 'start') {
    if (open) { console.error(`task ${open.task_id} is still open; run: harness resume`); process.exit(1); }
    const wi = rest.indexOf('--workdir');
    const request = rest.filter((_, i) => i !== wi && i !== wi + 1 || wi < 0).join(' ');
    if (!request) { console.error('usage: harness start "<request>"'); process.exit(2); }
    // HARNESS_NEW_TASK_ID / HARNESS_BOT: set by the server so the task id and bot are known before the engine starts.
    const task_id = /^t[\w-]+$/.test(process.env.HARNESS_NEW_TASK_ID || '') ? process.env.HARNESS_NEW_TASK_ID : 't' + J.newId();
    const workdir = path.resolve(wi >= 0 ? rest[wi + 1] : path.join(process.env.HARNESS_WORK_DIR || path.join(J.ROOT, 'work'), task_id));
    ensureWorkdir(workdir);
    const t = J.append({ type: 'task_start', task_id, request, workdir, ...(process.env.HARNESS_BOT ? { bot: process.env.HARNESS_BOT } : {}) });
    return runEngine(t, nonce);
  }
  if (cmd === 'resume') {
    if (!open) return console.log('nothing to resume');
    return runEngine({ ...open, resumed: true }, nonce);
  }
}

if (require.main === module) main().catch(e => { console.error(`harness: ${e && e.stack || e}`); process.exit(1); });
module.exports = { EXEC_LOCK, cleanEnv, settingsFile, protocolFile, resolveClaude, engineSpec, CONFIG };
