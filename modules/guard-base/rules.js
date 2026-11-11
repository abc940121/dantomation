'use strict';
// Base guard rules: generic dangerous operations, the same for every owner.
// Owner-specific red lines are not here; they come from the guard-private-rules module.
// Each rule returns null or [kind, reason].
const { execFileSync } = require('child_process');

const { SECRET_LITERAL, redact } = require('../../lib/redact');

// ---- rules on shell commands -------------------------------------------
const KEY_NAME = /\b[A-Z0-9_]*(API_KEY|AUTH_TOKEN)\b/;
const SECRET_FILE = /(^|[\s"'\/\\=@<])(\.env(\.[\w.-]+)?|[\w.-]*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)|\.credentials\.json|server\.token|credentials(\.json)?|\.npmrc|\.netrc|\.pgpass)(["'\s]|$)/i;

const OWNER_ONLY = /HARNESS_OWNER|(harness|taskmote)(\.(js|cmd))?["']?\s+(restore|undo)\b/i;

function shellRules(cmd, cwd) {
  const c = cmd.replace(/\s+/g, ' ');
  // f) owner-only restore
  if (OWNER_ONLY.test(c)) return ['owner_only', 'restore, undo and HARNESS_OWNER are for the person at the keyboard only'];
  // a) paid API keys: any *_API_KEY / *_AUTH_TOKEN name, key literals, key flags/helpers
  if (KEY_NAME.test(c)) return ['api_key', 'command sets or uses an API key variable'];
  if (/sk-ant-/.test(c)) return ['api_key', 'command contains an Anthropic key literal'];
  if (/--api-key\b|apiKeyHelper|x-api-key/i.test(c)) return ['api_key', 'command passes an API key'];

  // c) skipping git hooks (checked before b so `push --no-verify -f` names the hook skip)
  if (/--no-verify\b/.test(c)) return ['hook_skip', '--no-verify skips git hooks'];
  if (/\bgit\b[^;&|]*\bcommit\b[^;&|]*\s-[a-zA-Z]*n[a-zA-Z]*\b/.test(c)) return ['hook_skip', 'git commit -n skips git hooks'];
  if (/core\.hooksPath/i.test(c)) return ['hook_skip', 'overriding core.hooksPath disables hooks'];
  if (/\bHUSKY\s*=\s*0\b|\bHUSKY_SKIP_HOOKS\b|\$env:HUSKY\b/.test(c)) return ['hook_skip', 'HUSKY=0 disables hooks'];

  // b) deleting data
  if (/\brm\b[^;&|]*\s(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/.test(c)) return ['delete', 'recursive rm'];
  if (/\b(Remove-Item|ri|rm|del|erase|rd|rmdir)\b[^;&|]*\s-Recurse\b/i.test(c)) return ['delete', 'Remove-Item -Recurse'];
  if (/\b(rd|rmdir|del|erase)\b[^;&|]*\s\/[sS]\b/.test(c)) return ['delete', 'rd/del /s'];
  if (/\bfind\b[^;&|]*\s-delete\b/.test(c)) return ['delete', 'find -delete'];
  if (/\bgit\b[^;&|]*\bclean\b/.test(c) && /\s-[a-zA-Z]*f|--force/.test(c)) return ['delete', 'git clean -f'];
  if (/\bgit\b[^;&|]*\bpush\b/.test(c) && /(\s--force\b|\s--force-with-lease\b|\s-[a-zA-Z]*f\b|\s--mirror\b|\s--delete\b|\s\+\S+|\s:\S+)/.test(c)) return ['delete', 'force push / remote ref delete'];
  if (/\bgit\b[^;&|]*\breset\b[^;&|]*--hard\b/.test(c)) {
    const why = hardResetRisk(cwd);
    if (why) return ['delete', `git reset --hard would lose work (${why})`];
  }

  // d) printing or sending secrets
  if (/(^|[;&|]\s*)(env|printenv|export -p|set)\s*($|[;&|>])/.test(c) || /\b(Get-ChildItem|gci|dir|ls)\s+env:/i.test(c))
    return ['secret', 'dumping the environment'];
  if (/\b(cat|type|more|less|head|tail|Get-Content|gc|bat|xxd|od|base64|strings|grep|rg|findstr|Select-String|cp|copy|scp|curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b/i.test(c) && SECRET_FILE.test(c))
    return ['secret', 'reading or sending a secret file'];
  if (/\$\{?(env:)?[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY)[A-Z0-9_]*/i.test(c)) return ['secret', 'echoing a secret variable'];
  if (SECRET_LITERAL.test(c)) return ['secret', 'command contains a secret literal'];
  return null;
}

function hardResetRisk(cwd) {
  const g = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  try {
    if (g(['status', '--porcelain'])) return 'uncommitted changes';
    try { g(['rev-parse', '--abbrev-ref', '@{u}']); } catch { return 'no upstream, commits not pushed'; }
    if (g(['rev-list', '--count', '@{u}..HEAD']) !== '0') return 'unpushed commits';
    return null;
  } catch { return 'cannot inspect repo'; } // fail closed
}

// ---- rules on file tools -----------------------------------------------
function fileRules(tool, ti) {
  const p = String(ti.file_path || ti.notebook_path || ti.path || '');
  if (/^(Read|Grep|Glob)$/.test(tool) && SECRET_FILE.test(' ' + p.replace(/\\/g, '/').split('/').pop() + ' ')) return ['secret', 'reading a secret file'];
  if (/^(Glob|Grep)$/.test(tool) && /server\.token/i.test(String(ti.pattern || '') + ' ' + String(ti.glob || ''))) return ['secret', 'searching for the server token'];
  if (tool === 'Grep' && SECRET_FILE.test(' ' + String(ti.glob || '') + ' ')) return ['secret', 'searching secret files'];
  const content = [ti.content, ti.new_string, ti.new_source].filter(Boolean).join('\n');
  if (content) {
    if (SECRET_LITERAL.test(content)) return ['secret', 'writing a secret literal into a file'];
    if (/\b(ANTHROPIC|OPENAI|GEMINI|GOOGLE|AZURE_OPENAI|MISTRAL|COHERE|GROQ|XAI|DEEPSEEK|OPENROUTER)_(API_KEY|AUTH_TOKEN)\s*[=:]|apiKeyHelper/.test(content)) return ['api_key', 'writing API key config'];
    if (/core\.hooksPath|--no-verify/.test(content)) return ['hook_skip', 'writing a hook bypass into a file'];
    if (OWNER_ONLY.test(content)) return ['owner_only', 'writing the owner-only restore/undo into a file'];
  }
  if (/^(Write|Edit|MultiEdit)$/.test(tool) && /(^|[\\/])\.env(\.|$)/i.test(p)) return ['api_key', 'writing an .env file'];
  if (/^(WebFetch)$/.test(tool) && SECRET_LITERAL.test(JSON.stringify(ti))) return ['secret', 'sending a secret in a request'];
  return null;
}

module.exports = { shellRules, fileRules, SECRET_LITERAL, SECRET_FILE, OWNER_ONLY, redact };
