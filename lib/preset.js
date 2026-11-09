'use strict';
// Presets: presets/<name>.json holds {"modules": {name: true|false}}. A config
// selects one with the key "preset": "<name>"; lib/config.js then turns those modules
// on at load, and the config's own "modules" entries always win. Nothing here writes
// a file: `taskmote preset <name>` only prints what the preset does and the one
// line to add to the config.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'presets');
const NAME_RE = /^[a-z0-9-]+$/;

function list() {
  try { return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort(); } catch { return []; }
}
// Throws a clear Error for an invalid or unknown name or a malformed preset.
function read(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error(`preset name ${JSON.stringify(name)} is not valid (use letters a-z, digits and "-")`);
  if (!list().includes(name)) throw new Error(`unknown preset "${name}" (presets: ${list().join(', ') || 'none'})`);
  const p = JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8'));
  if (!p || typeof p.modules !== 'object' || Array.isArray(p.modules) || Object.values(p.modules).some(v => typeof v !== 'boolean')) throw new Error(`preset ${name}: "modules" must be an object of name: true|false`);
  return p;
}

// Pure: -> { on: [names the preset turns on], overridden: [{module, user}] , unmet: [string] }
// userModules is the config's own "modules" object.
function plan(preset, userModules, modulesDir) {
  const user = userModules || {};
  const on = [], overridden = [];
  for (const [m, v] of Object.entries(preset.modules)) {
    if (m in user) { if (user[m] !== v) overridden.push({ module: m, user: user[m] }); else if (v) on.push(m); } else if (v) on.push(m);
  }
  const eff = { ...preset.modules, ...user };
  const unmet = [];
  for (const m of on) {
    let deps = [];
    try { deps = require(path.join(modulesDir, m, 'index.js')).dependsOn || []; } catch { /* the loader reports a broken module */ }
    for (const d of deps) if (!eff[d]) unmet.push(`${m} dependsOn ${d}, which is off`);
  }
  return { on, overridden, unmet };
}

function cli(args, modulesDir = path.join(__dirname, '..', 'modules')) {
  const name = args.find(a => !a.startsWith('--')); // --dry-run is accepted and means nothing: this verb never writes
  if (!name) { console.log(`usage: taskmote preset <name>   (presets: ${list().join(', ')})`); return 2; }
  const preset = read(name);
  const C = require('./config');
  let user = {}, where = C.file();
  try { user = C.load().user_modules || {}; } catch (e) { throw new Error(e.message + '; fix it first'); }
  const { on, overridden, unmet } = plan(preset, user, modulesDir);
  console.log(`preset ${name}: turns on ${on.length} module(s) when the config says "preset": "${name}"`);
  for (const m of on) console.log(`  on: ${m}`);
  for (const o of overridden) console.log(`  kept as you set it: ${o.module} = ${o.user} (the preset says ${preset.modules[o.module]})`);
  for (const u of unmet) console.log(`  WARNING: ${u}`);
  console.log(`\nNothing was written. To use it, add this line to the top level of ${where}:\n\n  "preset": "${name}"\n\nThen run: node bin/taskmote.js status`);
  return unmet.length ? 1 : 0;
}

module.exports = { cli, plan, read, list, DIR, NAME_RE };
