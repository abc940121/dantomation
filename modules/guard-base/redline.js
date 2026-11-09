'use strict';
// Red lines that hold even when the owner's allow list would pass a tool call.
// A hit is [kind, reason]; a kind that starts with "ask:" makes the guard answer the
// host with permissionDecision "ask" (a prompt, then an approval card), any other
// kind blocks. Regex matching is best effort: indirection (a script that does
// the write or install, an alias, an encoded command) gets past it.
const path = require('path');
const os = require('os');
const J = require('../../lib/journal');
const C = require('../../lib/config');

// ---- self-modification ---------------------------------------------------
const norm = p => String(p || '').replace(/\\/g, '/');
const low = p => (process.platform === 'win32' ? p.toLowerCase() : p);
const under = (p, dir) => { const a = low(norm(p)).replace(/\/+$/, ''), d = low(norm(dir)).replace(/\/+$/, ''); return a === d || a.startsWith(d + '/'); };

// Never written by a bot, anywhere: the --settings layer and Claude settings files (permissions live there).
const SETTINGS_NAME = /(^|\/)(claude-settings\.json|\.claude\/settings(\.local)?\.json|managed-settings\.json)$/i;
// Never written by a bot, inside the Taskmote tree: the guard, the guard modules, the card path, the approve tool.
const GUARD_NAME = /^\/(guards\/.*|lib\/(config|modules|preset)\.js|presets\/[^/]+\.json|modules\/(guard-[^/]+|approval-cards)\/.*|[^/]+\/approve[\w.-]*\.js|approve[\w.-]*\.js)$/i;
// Taskmote's own config inside its tree: allowed with a card.
const CONFIG_NAME = /^\/config\/[^/]+$/i;

// The real path: symlinks resolved on the longest existing prefix (the file itself may not exist yet).
const fs = require('fs');
function realOf(abs) {
  let head = abs, tail = '';
  for (;;) {
    try { return norm(path.join(fs.realpathSync.native(head), tail)); } catch { /* walk up */ }
    const up = path.dirname(head);
    if (up === head) return abs;
    tail = path.join(path.basename(head), tail); head = up;
  }
}

// A path is checked as written and as its real path (a symlink into a protected dir), the stricter wins.
function selfPath(p, cwd) {
  if (!p) return null;
  const lit = path.resolve(cwd || process.cwd(), String(p));
  const a = selfPathAt(norm(lit)), real = realOf(lit);
  if (a && a[0] === 'self_modify') return a;
  const b = real !== norm(lit) ? selfPathAt(real) : null;
  return (b && b[0] === 'self_modify') ? b : a || b;
}
function selfPathAt(abs) {
  if (SETTINGS_NAME.test(abs)) return ['self_modify', 'writing Claude settings (permissions) or the guard settings layer'];
  const root = [J.ROOT, realOf(J.ROOT)].find(r => under(abs, r));
  const inRoot = !!root, rel = inRoot ? abs.slice(norm(root).replace(/\/+$/, '').length) : null;
  if (inRoot && GUARD_NAME.test(rel)) return ['self_modify', 'writing the guard, a guard module, the module loader, config loader or a preset, the approval path or the approve tool'];
  if ((inRoot && CONFIG_NAME.test(rel)) || [J.STATE, C.file(), path.join(os.homedir(), '.harness')].some(d => under(abs, d) || under(abs, realOf(d))))
    return ['ask:self_config', 'changing Taskmote\'s own config'];
  return null;
}

const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
function fileRedline(tool, ti, cwd) {
  if (!WRITE_TOOLS.test(tool)) return null;
  return selfPath(ti.file_path || ti.notebook_path || ti.path, cwd);
}

// Shell: a write verb plus a protected name anywhere in the command.
const SHELL_WRITE = /(>|\btee\b|\bdd\b[^;&|]*\bof=|\b(appendFileSync|appendFile|writeFile|createWriteStream|write_text|write_bytes)\b|\bsed\b[^;&|]*\s-i|\b(cp|mv|copy|move|install|ln|truncate|rm|del|erase|chmod|attrib)\b|\b(Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Remove-Item|Rename-Item|sc|ac|ni|cpi|mi|ri)\b|\bWriteAllText\b|\bwriteFileSync\b|\bopen\([^)]*['"][wa])/i;
const SHELL_NEVER = /(guards[\\/]|modules[\\/](guard-[\w-]+|approval-cards)[\\/]|claude-settings\.json|\.claude[\\/]+settings(\.local)?\.json|managed-settings\.json)/i;
const SHELL_CONFIG = /(\.harness[\\/]|HARNESS_CONFIG|taskmote[\w.-]*\.json)/i;

// ---- shell red lines -------------------------------------------------------
const W = '[^;&|]*';
const SHELL_ASK = [
  // installing software
  ['ask:install', 'installs software globally', new RegExp(`\\b(npm|pnpm|yarn|bun)\\b${W}\\s(-g\\b|--global\\b)|\\byarn\\s+global\\s+add\\b|\\bnpx\\b${W}--global`, 'i')],
  ['ask:install', 'installs Python packages outside a project venv', new RegExp(`\\b(pip3?|python3?\\s+-m\\s+pip|py\\s+-m\\s+pip|uv\\s+pip|pipx)\\b${W}\\binstall\\b`, 'i')],
  ['ask:install', 'runs a system package manager or installer', /\b(winget|choco|scoop|brew|apt(-get)?|dnf|yum|pacman|zypper|snap|flatpak|port)\s+(install|upgrade|add|reinstall)\b|\bmsiexec\b|\bAdd-AppxPackage\b|\bInstall-(Module|Package|Script)\b|\b(dpkg\s+-i|rpm\s+-i)\b|\b[\w-]*(setup|installer)\w*\.(exe|msi)\b/i],
  ['ask:install', 'pipes a downloaded script into a shell', /\b(curl|wget|iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\b[^;&]*\|\s*(sudo\s+)?(ba|z)?sh\b|\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^;&]*\|\s*(iex|Invoke-Expression)\b/i],
  // persistent config
  ['ask:persistent', 'creates a scheduled or startup job', /\bcrontab\b(?!\s+-l\b)|\bschtasks\b[^;&|]*\/(create|change)\b|\b(Register|Set)-ScheduledTask\b|\bNew-ScheduledTask\w*\b|\blaunc[h]ctl\s+(load|bootstrap|enable|submit)\b|LaunchAgents|LaunchDaemons|\bsystemctl\b[^;&|]*\b(enable|link)\b|Start Menu[\\/]Programs[\\/]Startup|shell:startup|\breg(\.exe)?\s+(add|import)\b[^;&|]*\\Run\b|CurrentVersion\\Run|\bNew-Service\b|\bsc(\.exe)?\s+create\b/i],
  ['ask:persistent', 'creates a webhook or mail rule', /\bgh\s+api\b[^;&|]*\/hooks\b|\bgh\s+(webhook|secret\s+set|variable\s+set)\b|\bNew-InboxRule\b|\bSet-Mailbox\b[^;&|]*Forward/i],
  // accounts and sign-ins
  ['ask:account', 'signs in, creates an account or grants access', /\b(gh|glab)\s+auth\s+(login|refresh|token)\b|\b(npm|pnpm|yarn)\s+(login|adduser)\b|\baz\s+login\b|\bgcloud\s+auth\b|\baws\s+(configure|sso\s+login)\b|\bdocker\s+login\b|\b(firebase|vercel|netlify|heroku|wrangler|fly|flyctl|railway|supabase)\s+login\b|\bgit\s+credential\b[^;&|]*\b(approve|store)\b|\boauth\b[^;&|]*device|\bdevice[_-]code\b|\bConnect-(AzAccount|MgGraph|ExchangeOnline)\b/i],
  // git history rewrite (force push and remote delete are hard blocks in rules.js)
  ['ask:history', 'rewrites git history', /\bgit\b[^;&|]*\b(filter-branch|filter-repo|replace)\b|\bgit\b[^;&|]*\brebase\b[^;&|]*\s(--root|-i|--interactive)\b|\bgit\b[^;&|]*\bupdate-ref\s+-d\b|\bgit\s+push\b[^;&|]*\s--prune\b|\bgit\s+branch\s+-[dD]\b[^;&|]*\s-r\b|\bbfg\b/i],
  // paid compute
  ['ask:paid_compute', 'starts paid cloud compute', /\bgcloud\s+(compute\s+instances|container\s+clusters|run|ai|ml)\b[^;&|]*\b(create|deploy|submit)\b|\baws\s+(ec2\s+run-instances|sagemaker\s+create|batch\s+submit|eks\s+create|lambda\s+create)\b|\baz\s+(vm|aks|ml|container)\b[^;&|]*\bcreate\b|(^|[;&|(]\s*)(runpodctl|runpod|modal|lambda-cloud|lambdalabs|vastai|sky|skypilot|paperspace|replicate|doctl)\b[^;&|]*\b(create|run|deploy|launch|up|start)\b/i],
];

// Paid APIs and SDKs (the approval-cards module has the same ids; this keeps them as a floor when that module is off).
const MONEY = [
  ['ask:spend_money', 'calls a paid API, which may spend money', /(https?:\/\/|\b)(api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.cohere\.(ai|com)|api\.x\.ai|api\.groq\.com|api\.deepseek\.com|openrouter\.ai|api\.stripe\.com|api\.twilio\.com|api\.elevenlabs\.io)/i],
  ['ask:spend_money_sdk', 'uses a paid AI SDK or CLI, which may spend money', /\bopenai\s+(api|chat|responses|completions|images|audio)\b|\banthropic\s+(messages|api|completions)\b|\bimport\s+(anthropic|openai)\b|\bfrom\s+(anthropic|openai)\s+import\b|require\(\s*['"](openai|@anthropic-ai\/sdk)['"]|\bfrom\s+['"](openai|@anthropic-ai\/sdk)['"]/],
];

// The journal and the state dir hold cards and answers; a bot writing there could forge the owner's yes.
const SHELL_JOURNAL = /\bjournal\.jsonl\b|\btool-start[\\/]|[\\/]used[\\/]card-/i;
function namesState(c) {
  if (SHELL_JOURNAL.test(c)) return true;
  const s = low(norm(c));
  // C:/x/state, and the Git Bash spelling /c/x/state
  const forms = [J.STATE, realOf(J.STATE)].flatMap(d => { const x = low(norm(d)).replace(/\/+$/, ''); return [x, x.replace(/^([a-z]):/i, (m, l) => '/' + l.toLowerCase())]; });
  return forms.some(x => x && s.includes(x));
}

function shellRedline(c) {
  // Any shell command that names the journal or the state dir, read or write: no list of write verbs is complete
  // (dd, a one-line script, tee under another name), and bots read the journal through taskmote, not the shell.
  if (namesState(c)) return ['self_modify', 'shell command on Taskmote\'s journal or state (cards and answers live there; use taskmote to read them)'];
  if (SHELL_WRITE.test(c)) {
    if (SHELL_NEVER.test(c)) return ['self_modify', 'shell write to the guard, a guard module, the approval path or Claude settings'];
    if (SHELL_CONFIG.test(c)) return ['ask:self_config', 'shell write to Taskmote\'s own config'];
  }
  for (const [kind, why, re] of [...SHELL_ASK, ...MONEY]) if (re.test(c)) return [kind, why];
  return null;
}

function urlRedline(tool, ti) {
  if (tool !== 'WebFetch') return null;
  const u = String(ti.url || '');
  for (const [kind, why, re] of MONEY.slice(0, 1)) if (re.test(u)) return [kind, why];
  return null;
}

module.exports = { fileRedline, shellRedline, urlRedline, selfPath };
