#!/usr/bin/env node
'use strict';
// The guard: Claude Code PreToolUse hook, and the dispatcher for the modules.
// Reads the hook JSON on stdin, then awaits each enabled module's beforeTool in
// load order (lib/modules.js), each within modules_hook_timeout_ms; a timeout
// blocks with kind module_timeout. The first hit blocks: exit 2, reason on stderr,
// one line in logs/guard.jsonl. An "ask:" kind: exit 0 with permissionDecision "ask"
// on stdout (the owner decides). No hit: exit 0. What is checked is up to the
// modules (guard-base, guard-private-rules, spend-count, voice, checkpoint).
// Fails closed: unreadable input, unreadable config, or an enabled module that
// cannot load blocks every call.
// `guard.js --after` is the PostToolUse entry: emits the tool.done event, never blocks.
// Installed before any require: a throw while loading must exit 2 (block), because the
// host reads exit 1 as allow. The --after (PostToolUse) entry never blocks, so it gets none.
var CONFIG, CONFIG_ERR = null; // var: block() can run before the config is loaded
// PreToolUse speaks two exit codes only: 0 allow, 2 block (the host reads anything else as allow).
// Any other code (a core module's own exit, such as the journal's exit 5 on an unreadable journal) becomes 2.
if (require.main === module && !process.argv.includes('--after')) { const realExit = process.exit.bind(process); process.exit = c => realExit(c === 0 ? 0 : 2); }
// Total on purpose: a thrown object with no toString must still end in a block, never a pass.
const safe = e => { try { return String(e && e.message !== undefined ? e.message : e).split('\n')[0].slice(0, 160); } catch { return 'unprintable error'; } };
// die: a fixed reason, never exception text (a module's error may carry its secret).
const AFTER = process.argv.includes('--after');
const DIE_REASON = 'guard failed (uncaught error in a module or the guard; details withheld)';
const die = () => {
  if (AFTER) { try { process.stderr.write('[guard] --after failed (details withheld)\n'); } catch { /* ignore */ } process.exit(0); }
  try { process.stderr.write(`[guard] BLOCKED (module): ${DIE_REASON}. Do not retry another way.\n`); } catch { /* still block */ }
  try { block('module', DIE_REASON, null, true); } catch { /* fall through */ }
  process.exit(2);
};
if (require.main === module) { process.on('unhandledRejection', die); process.on('uncaughtException', die); } // both modes: die prints a fixed text, exits 2 (0 for --after)

const fs = require('fs');
const path = require('path');
const J = require('../lib/journal');
const C = require('../lib/config');
const M = require('../lib/modules');
const { log } = require('../lib/log');
const { redact } = require('../lib/redact');

try { CONFIG = C.load(); } catch (e) { CONFIG = { ...C.DEFAULTS, owner_name: 'the owner', modules: {} }; CONFIG_ERR = safe(e) || 'unknown error'; }

// The whole record is scrubbed against every loaded module's secrets (then secret patterns) before it is clipped or logged.
const clean = (s, n) => { try { return M.scrubAll(typeof s === 'string' ? s : s == null ? '' : JSON.stringify(s)).slice(0, n); } catch { return ''; } };
function block(kind, reason, input, quiet) {
  const ti = input && input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : null;
  const detail = ti ? (ti.command || ti.file_path || '') : '';
  kind = clean(kind, 80); reason = clean(reason, 1000);
  log('guard.jsonl', { session_id: clean(input && input.session_id, 120), tool: clean(input && input.tool_name, 120), kind, reason, detail: clean(detail, 300) });
  if (!quiet) process.stderr.write(`[guard] BLOCKED (${kind}): ${reason}. Do not retry another way; ask ${(CONFIG && CONFIG.owner_name) || 'the owner'}.\n`);
  process.exit(2);
}

// A red line the owner decides: answer the host with permissionDecision "ask", so it
// prompts (then an approval card) even when the owner's allow list would pass the call.
function ask(kind, reason, input) {
  const ti = input && input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : null;
  kind = clean(kind, 80); reason = clean(reason, 1000);
  log('guard.jsonl', { session_id: clean(input && input.session_id, 120), tool: clean(input && input.tool_name, 120), kind, reason, decision: 'ask', detail: clean(ti ? (ti.command || ti.file_path || ti.url || '') : '', 300) });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `red line (${kind}): ${reason}; ${(CONFIG && CONFIG.owner_name) || 'the owner'} decides` } }) + '\n');
}

// tool.done's durationMs: the allowed pre-call stamps state/tool-start/<tool_use_id>,
// --after reads and removes it. Stamps older than an hour are swept. Best effort.
const STAMPS = path.join(J.STATE, 'tool-start');
function stampStart(id) {
  try { fs.mkdirSync(STAMPS, { recursive: true }); fs.writeFileSync(path.join(STAMPS, id), String(Date.now())); } catch { /* no duration then */ }
}
function sinceStart(id) {
  let ms = null;
  try { const f = path.join(STAMPS, id); const t = Number(fs.readFileSync(f, 'utf8')); fs.rmSync(f, { force: true }); if (Number.isFinite(t)) ms = Math.max(0, Date.now() - t); } catch { /* none */ }
  try { for (const n of fs.readdirSync(STAMPS)) { const f = path.join(STAMPS, n); if (Date.now() - fs.statSync(f).mtimeMs > 3600e3) fs.rmSync(f, { force: true }); } } catch { /* none */ }
  return ms;
}

async function main() {
  const after = AFTER; // in after mode every failure exits 0
  const skip = why => { try { process.stderr.write(`[guard] --after skipped (${why})\n`); } catch { /* ignore */ } process.exit(0); };
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return after ? skip('hook input unreadable') : block('parse', 'hook input unreadable (fail closed)', null); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return after ? skip('hook input is not an object') : block('parse', 'hook input is not an object (fail closed)', null);
  const isO = v => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!after && !(typeof input.tool_name === 'string' && input.tool_name && isO(input.tool_input))) return block('parse', 'hook input has no tool_name / tool_input (fail closed)', null);
  // Overall deadline (just under the engine's hook limit): a hang is a block, never the host's fail-open timeout.
  if (!after) setTimeout(() => die(), M.ENGINE_HOOK_LIMIT_MS - 2000).unref(); // unref: it must not hold a finished guard open; if it fires, exit 2
  if (CONFIG_ERR && after) return skip('config unreadable');
  if (CONFIG_ERR) return block('config', `run-time config unreadable (${CONFIG_ERR.slice(0, 160)})`, input);
  const { mods, errors, meta } = M.load(CONFIG);
  const ctx = { input, tool: input.tool_name || '', ti: input.tool_input || {}, cwd: input.cwd || process.cwd(), config: CONFIG };
  const id = typeof input.tool_use_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(input.tool_use_id) ? input.tool_use_id : null;
  if (after) {
    const r = input.tool_response;
    const ok = !(r && typeof r === 'object' && (r.is_error || r.isError || r.interrupted || r.error));
    const ev = { tool: ctx.tool, input: ctx.ti, cwd: ctx.cwd, session_id: input.session_id || null, task_id: process.env.HARNESS_TASK_ID || null,
      tool_use_id: id, ok, durationMs: id ? sinceStart(id) : null };
    try { J.append({ type: 'tool_done', task_id: ev.task_id, tool: ev.tool, tool_use_id: id, ok, durationMs: ev.durationMs, session_id: ev.session_id }); } catch { /* the journal is best effort here; the event still goes out */ }
    await M.emit(mods, 'tool.done', ev, ctx);
    process.exit(0);
  }
  if (errors.length) return block('module', `module load error: ${errors.join('; ').slice(0, 1000)}`, input);
  let hit = await M.beforeTool(mods, ctx);
  // Locked profile (no permission-prompt tool): nobody can answer the engine's own ask in -p mode, so a red-line
  // ask becomes an approval card the owner answers (approval-cards api); its yes lets this exact call pass once.
  // With approval-cards off the ask stays, and the engine refuses it.
  if (hit && /^ask:/.test(hit[0]) && process.env.HARNESS_PROMPT_TOOL !== '1' && process.env.HARNESS_TASK_ID) {
    const A = M.apiOf(mods, 'approval-cards'), mt = meta && meta.get('approval-cards');
    if (A && typeof A.raise === 'function' && mt && mt.state) {
      const r = await A.raise({ J, state: mt.state, settings: mt.settings, emit: (ev, p) => M.emit(mods, ev, p).catch(() => {}) },
        { task_id: process.env.HARNESS_TASK_ID, tool: ctx.tool, ti: ctx.ti, kind: hit[0].slice(4), reason: hit[1], cwd: ctx.cwd });
      hit = r && /^allow:/.test(r[0]) ? null : (r || hit);
    }
  }
  // Full profile: the prompt tool (bin/approve-mcp.js) never sees the hook's cwd, so the hook writes down the
  // ask for this tool_use_id; the prompt tool keeps it as an ask and checks in that directory. No record, no ask.
  if (hit && /^ask:/.test(hit[0]) && process.env.HARNESS_PROMPT_TOOL === '1' && id) {
    try { J.append({ type: 'hook_ask', tool_use_id: id, task_id: process.env.HARNESS_TASK_ID || null, tool: ctx.tool, cwd: ctx.cwd, kind: hit[0].slice(4), reason: hit[1] }); }
    catch (e) { hit = ['journal', `could not record the red-line ask (${e.message}); fail closed`]; }
  }
  if (hit && /^ask:/.test(hit[0])) ask(hit[0].slice(4), hit[1], input);
  else if (hit) block(hit[0], hit[1], input);
  if (id) stampStart(id);
  // Allow: no forced exit. The loop drains naturally, so any later throw / rejection of a hook still reaches the fail-closed handlers (exit 2);
  // a module that leaves a live timer open runs into the deadline above, which blocks.
  process.exitCode = 0;
}

// --after: the startup handlers are skipped (a crash there stays non-blocking as before);
// main().catch(die) is unchanged from the old code.
if (require.main === module) main().catch(die); // die exits 0 in --after mode, 2 otherwise
