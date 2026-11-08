'use strict';
// Run-time config. Everything specific to one owner lives outside the repo:
//   HARNESS_CONFIG=<file>   or   ~/.harness/config.json
// Missing -> public defaults (default modules only; warn() says so).
// Keys (all optional):
//   owner_name      shown in messages ("ask <owner_name>"); default "the owner"
//   private_rules   path to a rules file (relative to the config file), read by the
//                   guard-private-rules module; format: modules/guard-private-rules/example-private.json
//   modules         {"<name>": true|false}; see modules/<name>/README.md
//   spend_limit_usd_per_session, prices_usd_per_mtok, strip_env (appended), engine
// A config or rules file that exists but cannot be read is an error, never
// treated as missing (the guard then blocks: fail closed).
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
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
  if (user.modules !== undefined) {
    if (!user.modules || typeof user.modules !== 'object' || Array.isArray(user.modules)) throw new Error(`config ${f}: "modules" must be an object of name: true|false`);
    Object.assign(cfg.modules, user.modules);
  } else if (user.private_rules) cfg.modules['guard-private-rules'] = true;
  cfg.private_rules_file = user.private_rules ? path.resolve(path.dirname(f), user.private_rules) : null;
  return (cache = cfg);
}

function warn() {
  const c = load();
  if (!c.found) return `harness: no config at ${c.file}; running with the default modules (guard-base, checkpoint). Set HARNESS_CONFIG or copy config/example.config.json there.`;
  return null;
}

// For messages only: never throws (a broken config still prints a usable line).
function owner() { try { return load().owner_name; } catch { return 'the owner'; } }

module.exports = { load, warn, owner, file, DEFAULTS };
