'use strict';
// What `taskmote preset <name>` prints: the modules a profile from presets/ turns on, the
// user's own overrides and the one config line to add. Nothing here writes a file.
const path = require('path');
const P = require('../../lib/preset');

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

function cli(args, modulesDir = path.join(__dirname, '..')) {
  const name = args.find(a => !a.startsWith('--')); // --dry-run is accepted and means nothing: this verb never writes
  if (!name) { console.log(`usage: taskmote preset <name>   (presets: ${P.list().join(', ')})`); return 2; }
  const preset = P.read(name);
  const C = require('../../lib/config');
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

module.exports = { cli, plan };
