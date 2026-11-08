'use strict';
// The one module loader and hook dispatcher. Core never requires a module by a
// fixed path: enabled names come from the config and are resolved here at run time.
// A module is modules/<name>/index.js exporting
//   { name, beforeTool(ctx) -> null | [kind, reason], afterTool(ctx), onTaskStart(ctx),
//     onTaskEnd(ctx), commands?: { <subcommand>: fn(args, core) } }
// (every hook optional). Any load problem is an error that names the module;
// callers fail closed (guard blocks every call, start/resume exit 2).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'modules');
const HOOKS = ['beforeTool', 'afterTool', 'onTaskStart', 'onTaskEnd'];

// -> { mods: [module...] in config order, errors: ['<name>: why'...] }
function load(cfg) {
  const mods = [], errors = [];
  const conf = (cfg && cfg.modules) || {};
  for (const name of Object.keys(conf)) {
    const val = conf[name];
    if (typeof val !== 'boolean') { errors.push(`${name}: config value must be true or false`); continue; }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !fs.existsSync(path.join(DIR, name))) { errors.push(`${name}: unknown module (no folder modules/${name})`); continue; }
    if (!val) continue;
    try {
      const m = require(path.join(DIR, name, 'index.js'));
      if (!m || typeof m !== 'object') throw new Error('index.js does not export an object');
      if (m.name !== name) throw new Error(`exports name ${JSON.stringify(m.name)}, expected ${JSON.stringify(name)}`);
      for (const h of HOOKS) if (m[h] !== undefined && typeof m[h] !== 'function') throw new Error(`${h} is not a function`);
      if (m.commands !== undefined && (!m.commands || typeof m.commands !== 'object' || Object.values(m.commands).some(f => typeof f !== 'function'))) throw new Error('commands must map names to functions');
      mods.push(m);
    } catch (e) { errors.push(`${name}: ${String(e.message).split('\n')[0].slice(0, 200)}`); }
  }
  return { mods, errors };
}

// First beforeTool hit wins: [kind, reason] or null. A throwing module is a hit
// (fail closed), never a pass.
function beforeTool(mods, ctx) {
  for (const m of mods) {
    if (!m.beforeTool) continue;
    let hit;
    try { hit = m.beforeTool(ctx); } catch (e) { return ['module', `module ${m.name} failed (${String(e.message).split('\n')[0].slice(0, 120)})`]; }
    if (hit) return hit;
  }
  return null;
}

// Notification hooks: errors are reported, never silenced, but do not stop the others.
function notify(mods, hook, ctx) {
  for (const m of mods) {
    if (!m[hook]) continue;
    try { m[hook](ctx); } catch (e) { process.stderr.write(`harness: module ${m.name} ${hook} failed: ${String(e.message).split('\n')[0]}\n`); }
  }
}

function commands(mods) {
  const out = {};
  for (const m of mods) for (const [k, f] of Object.entries(m.commands || {})) if (!(k in out)) out[k] = f;
  return out;
}

module.exports = { load, beforeTool, notify, commands, DIR };
