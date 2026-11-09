'use strict';
// Presets: presets/<name>.json holds {"modules": {name: true|false}}. A config
// selects one with the key "preset": "<name>"; lib/config.js then turns those modules
// on at load, and the config's own "modules" entries always win. Nothing here writes
// a file. Reading is all the trunk does; the `taskmote preset <name>` printing verb
// is the presets module (modules/presets/).
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

module.exports = { read, list, DIR, NAME_RE };
