#!/usr/bin/env node
'use strict';
// Cost: tokens the model sees at session start (input + cache write + cache read
// on the first request) for the harness engine vs plain `claude -p` here.
// Engine: which API-key-like env vars exist (names only), what the child gets,
// and what Claude Code reports as its auth source.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('../bin/harness');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-'));
H.resolveClaude();
const claude = process.env.HARNESS_CLAUDE || 'claude';
const { env, stripped } = H.cleanEnv();

function first(args, e) {
  const r = spawnSync(claude, ['-p', 'Reply with just: ok', ...args, '--output-format', 'stream-json', '--verbose'], { cwd: dir, env: e, encoding: 'utf8', timeout: 300000 });
  let init, msg;
  for (const l of r.stdout.split('\n')) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.type === 'system' && j.subtype === 'init') init = j;
    if (j.type === 'assistant' && !msg) msg = j.message;
  }
  const u = (msg && msg.usage) || {};
  return { tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), apiKeySource: init && init.apiKeySource, tools: init && init.tools.length, plugins: init && init.plugins.map(p => p.name), skills: init && (init.skills || []).length };
}

const keyLike = Object.keys(process.env).filter(k => /API_KEY|AUTH_TOKEN|^ANTHROPIC_|^OPENAI_/i.test(k));
const childKeyLike = Object.keys(env).filter(k => /API_KEY|AUTH_TOKEN|^ANTHROPIC_|^OPENAI_/i.test(k));
const harnessArgs = ['--setting-sources', H.CONFIG.engine.setting_sources, '--settings', H.settingsFile(), '--append-system-prompt-file', H.protocolFile(),
  '--tools', H.CONFIG.engine.claude_tools, '--strict-mcp-config', '--disable-slash-commands'];
const bare = ['--setting-sources', H.CONFIG.engine.setting_sources, '--tools', H.CONFIG.engine.claude_tools, '--strict-mcp-config', '--disable-slash-commands'];

const harness = first(harnessArgs, env);
const floor = first(bare, env);
const baseline = first([], process.env);
const protoChars = fs.readFileSync(H.protocolFile(), 'utf8').length;

console.log(`env vars in this shell with key-like names: ${keyLike.join(', ') || 'none'}`);
console.log(`stripped for the engine child: ${stripped.join(', ') || 'none'}`);
console.log(`key-like names left in child env: ${childKeyLike.join(', ') || 'none'}`);
console.log(`harness session: ${harness.tokens} tokens at start; apiKeySource=${harness.apiKeySource}; tools=${harness.tools}; plugins=${JSON.stringify(harness.plugins)}; skills=${harness.skills}`);
console.log(`same flags without harness protocol/guard: ${floor.tokens} tokens -> harness's own always-on = ${harness.tokens - floor.tokens} tokens (protocol.md ${protoChars} chars)`);
console.log(`baseline plain claude -p (the owner's full setup): ${baseline.tokens} tokens; apiKeySource=${baseline.apiKeySource}; plugins=${(baseline.plugins || []).length}; skills=${baseline.skills}`);
fs.rmSync(dir, { recursive: true, force: true });
