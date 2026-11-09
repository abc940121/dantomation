'use strict';
// Run-time config. Everything specific to one owner lives outside the repo:
//   HARNESS_CONFIG=<file>   or   ~/.harness/config.json
// Missing -> public defaults (default modules only; warn() says so).
// Keys (all optional):
//   owner_name      shown in messages ("ask <owner_name>"); default "the owner"
//   private_rules   path to a rules file (relative to the config file), read by the
//                   guard-private-rules module; format: modules/guard-private-rules/example-private.json
//   preset          name of a profile in presets/ (e.g. "v1"): its modules are on unless "modules" says otherwise
//   modules         {"<name>": true|false}; see modules/<name>/README.md
//   modules_hook_timeout_ms  how long core waits for one module hook (default 5000)
//   spend_limit_usd_per_session, prices_usd_per_mtok, strip_env (appended), engine
// A config or rules file that exists but cannot be read is an error, never
// treated as missing (the guard then blocks: fail closed).
const fs = require('fs');
const os = require('os');
const path = require('path');
const preset = require('./preset');

const ROOT = path.resolve(__dirname, '..');
// Module tiers. Trunk (lib/, bin/) is not a module. A locked module is the safety floor: no config or preset can
// turn it off. load() throws, so serve refuses to start and the guard hook blocks every call (fail closed).
// A changeable module can be turned off, but turning off one the floor leans on is said out loud (warn()).
const LOCKED = Object.freeze({ 'guard-base': 'it is the safety floor that blocks red-line commands and writes to the journal and state folder' });
const WARN_OFF = Object.freeze({ 'approval-cards': 'red-line steps cannot be approved, so every one is refused' });

const DEFAULTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'harness.config.json'), 'utf8'));

function file() { return process.env.HARNESS_CONFIG || path.join(os.homedir(), '.harness', 'config.json'); }

function readJson(f, what) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { throw new Error(`${what} ${f} unreadable (${e.code || e.message})`); }
}

let cache = null;
function load() {
  if (cache) return cache;
  const f = file();
  const found = fs.existsSync(f);
  const user = found ? readJson(f, 'config') : {};
  const cfg = { ...DEFAULTS, ...user, strip_env: [...DEFAULTS.strip_env, ...(user.strip_env || [])] };
  cfg.owner_name = String(user.owner_name || 'the owner');
  cfg.file = f; cfg.found = found;
  // Modules: defaults, then the user's switches. A user config that names
  // private_rules but has no "modules" key keeps enforcing them: that is how
  // configs written before modules existed behave.
  cfg.modules = { ...DEFAULTS.modules };
  // A named preset is applied under the user's own switches. A bad name applies nothing (fail closed) and is reported by warn().
  cfg.preset_error = null; cfg.preset_modules = {};
  if (user.preset !== undefined) {
    try { cfg.preset_modules = { ...preset.read(user.preset).modules }; Object.assign(cfg.modules, cfg.preset_modules); } catch (e) { cfg.preset_error = `config ${f}: ${e.message}; no preset applied`; }
  }
  cfg.user_modules = user.modules && typeof user.modules === 'object' && !Array.isArray(user.modules) ? { ...user.modules } : {};
  if (user.modules !== undefined) {
    if (!user.modules || typeof user.modules !== 'object' || Array.isArray(user.modules)) throw new Error(`config ${f}: "modules" must be an object of name: true|false`);
    Object.assign(cfg.modules, user.modules);
  } else if (user.private_rules) cfg.modules['guard-private-rules'] = true;
  cfg.private_rules_file = user.private_rules ? path.resolve(path.dirname(f), user.private_rules) : null;
  for (const [n, why] of Object.entries(LOCKED)) {
    if (cfg.modules[n] !== true) throw new Error(`config ${f}: module "${n}" is locked on (${why}); it cannot be turned off. Remove "${n}": false from "modules"`);
  }
  // Said only when the owner's config or preset turned it off, not for a module that is simply off by default.
  cfg.tier_warnings = Object.entries(WARN_OFF).filter(([n]) => cfg.modules[n] === false && (cfg.user_modules[n] === false || cfg.preset_modules[n] === false))
    .map(([n, why]) => `module "${n}" is off: ${why}`);
  return (cache = cfg);
}

// Top-level keys nothing reads are named, so a typo or a nested section does not go unnoticed.
// Module settings are top-level keys named after the module ("chat-endpoint" -> "chat_endpoint"); "_" keys are comments.
const TRUNK_KEYS = ['owner_name', 'private_rules', 'preset', 'modules', 'modules_hook_timeout_ms', 'engine', 'engines', 'engines_max_timeout_ms',
  'spend_limit_usd_per_session', 'prices_usd_per_mtok', 'strip_env', 'bots', 'server'];
function unknownKeys(c) {
  if (!c.found) return [];
  let user, mods = [];
  try { user = JSON.parse(fs.readFileSync(c.file, 'utf8')); } catch { return []; }
  try { mods = fs.readdirSync(path.join(ROOT, 'modules')).map(n => n.replace(/-/g, '_')); } catch { /* none */ }
  const known = new Set([...TRUNK_KEYS, ...Object.keys(DEFAULTS), ...mods]);
  const out = [];
  for (const k of Object.keys(user)) {
    if (known.has(k) || k.startsWith('_')) continue;
    if (k === 'settings' && user[k] && typeof user[k] === 'object' && !Array.isArray(user[k])) {
      const inner = Object.keys(user[k]);
      out.push(`config ${c.file}: "settings" is not read; module settings are top-level keys. Move ${inner.length ? inner.map(n => '"' + n + '"').join(', ') : 'its keys'} out of "settings" to the top level`);
    } else out.push(`config ${c.file}: unknown key "${k}" is not read (a module's settings key is its name with "-" as "_", e.g. "chat_endpoint")`);
  }
  return out;
}

function warn() {
  const c = load();
  const out = [];
  if (c.preset_error) out.push(`taskmote: ${c.preset_error}`);
  else if (!c.found) out.push(`taskmote: no config at ${c.file}; running with the default modules (guard-base, checkpoint). Set HARNESS_CONFIG or copy config/example.config.json there.`);
  for (const w of c.tier_warnings) out.push(`taskmote: ${w}`);
  for (const w of unknownKeys(c)) out.push(`taskmote: ${w}`);
  return out.length ? out.join(String.fromCharCode(10)) : null;
}

// For messages only: never throws (a broken config still prints a usable line).
function owner() { try { return load().owner_name; } catch { return 'the owner'; } }

module.exports = { load, warn, owner, file, DEFAULTS, LOCKED, WARN_OFF };
