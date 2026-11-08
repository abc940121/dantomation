#!/usr/bin/env node
'use strict';
// The guard: Claude Code PreToolUse hook, and the dispatcher for the modules.
// Reads the hook JSON on stdin, then calls each enabled module's beforeTool in
// config order (lib/modules.js). The first hit blocks: exit 2, reason on stderr,
// one line in logs/guard.jsonl. No hit: exit 0. What is checked is up to the
// modules (guard-base, guard-private-rules, spend-count, voice, checkpoint).
// Fails closed: unreadable input, unreadable config, or an enabled module that
// cannot load blocks every call.
// `guard.js --after` is the PostToolUse entry: afterTool of each module, never blocks.
const fs = require('fs');
const C = require('../lib/config');
const M = require('../lib/modules');
const { log } = require('../lib/log');
const { redact } = require('../lib/redact');

let CONFIG, CONFIG_ERR = null;
try { CONFIG = C.load(); } catch (e) { CONFIG = { ...C.DEFAULTS, owner_name: 'the owner', modules: {} }; CONFIG_ERR = e.message; }

function block(kind, reason, input) {
  const detail = input && input.tool_input ? (input.tool_input.command || input.tool_input.file_path || '') : '';
  log('guard.jsonl', { session_id: input && input.session_id, tool: input && input.tool_name, kind, reason, detail: redact(detail) });
  process.stderr.write(`[guard] BLOCKED (${kind}): ${reason}. Do not retry another way; ask ${CONFIG.owner_name}.\n`);
  process.exit(2);
}

function main() {
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return block('parse', 'hook input unreadable (fail closed)', null); }
  if (!input || typeof input !== 'object') return block('parse', 'hook input is not an object (fail closed)', null);
  if (CONFIG_ERR) return block('config', `run-time config unreadable (${CONFIG_ERR.slice(0, 160)})`, input);
  const { mods, errors } = M.load(CONFIG);
  const ctx = { input, tool: input.tool_name || '', ti: input.tool_input || {}, cwd: input.cwd || process.cwd(), config: CONFIG };
  if (process.argv.includes('--after')) { M.notify(mods, 'afterTool', ctx); process.exit(0); }
  if (errors.length) return block('module', `module load error: ${errors.join('; ').slice(0, 300)}`, input);
  const hit = M.beforeTool(mods, ctx);
  if (hit) block(hit[0], hit[1], input);
  process.exit(0);
}

if (require.main === module) main();
