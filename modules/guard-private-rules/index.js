'use strict';
// guard-private-rules: the owner's red lines from the private rules file named in
// the config ("private_rules"), plus self-protection of the config file and the
// rules file. Match: shell -> the command; path -> the file a tool touches, or a
// path named in a shell command; content -> text being written. access: write
// (default) only blocks mutating calls; any also blocks reads.
const fs = require('fs');
const C = require('../../lib/config');
const { readOnlyShell, isShell, WRITE_TOOLS } = require('../../lib/shell');

// Read and compile the rules file. A file that exists but is broken throws: the
// module then fails to load and the guard blocks everything.
function loadRules(cfg) {
  if (!cfg.private_rules_file) return [];
  const rf = cfg.private_rules_file;
  let r;
  try { r = JSON.parse(fs.readFileSync(rf, 'utf8')); } catch (e) { throw new Error(`private rules ${rf} unreadable (${e.code || e.message})`); }
  if (!Array.isArray(r.rules)) throw new Error(`private rules ${rf}: no "rules" array`);
  return r.rules.map((x, i) => {
    if (!['shell', 'path', 'content'].includes(x.match) || !x.pattern) throw new Error(`private rules ${rf}: rule ${i} needs match shell|path|content and a pattern`);
    return { kind: String(x.kind || 'private'), match: x.match, re: new RegExp(x.pattern, typeof x.flags === 'string' ? x.flags : 'i'), access: x.access === 'any' ? 'any' : 'write', reason: String(x.reason || 'blocked by a private rule') };
  });
}

const CONFIG = C.load();
const RULES = loadRules(CONFIG);

function privateRules(tool, ti, rules = RULES) {
  const shell = isShell(tool);
  const cmd = String(ti.command || '');
  const p = String(ti.file_path || ti.notebook_path || ti.path || '').replace(/\\/g, '/');
  const content = [ti.content, ti.new_string, ti.new_source].filter(Boolean).join('\n');
  const writes = shell ? !readOnlyShell(cmd) : WRITE_TOOLS.test(tool);
  // The config and the rules file are the guard's own policy: agents never change them.
  const norm = x => String(x || '').replace(/\\/g, '/').toLowerCase();
  const own = [CONFIG.found && CONFIG.file, CONFIG.private_rules_file].filter(Boolean).map(norm);
  if (writes && own.some(f => (shell ? norm(cmd).includes(f) || (f.includes('/.harness/') && norm(cmd).includes('.harness')) : norm(p) === f)))
    return ['config', 'the harness config and private rules are the owner\'s; agents do not change them'];
  for (const r of rules) {
    if (r.access === 'write' && !writes) continue;
    const hit = r.match === 'shell' ? shell && r.re.test(cmd)
      : r.match === 'path' ? (shell ? r.re.test(cmd.replace(/\\/g, '/')) : !!p && r.re.test(p))
      : !!content && r.re.test(content);
    if (hit) return [r.kind, r.reason];
  }
  return null;
}

module.exports = {
  name: 'guard-private-rules',
  beforeTool: ({ tool, ti }) => privateRules(tool, ti),
  privateRules,
};
