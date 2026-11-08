'use strict';
// Local checks a worker runs BEFORE it runs anything. All pure functions of
// (job payload, config); a hit is a reason string and the job is refused.
//   1. guard-base       (modules/guard-base, always, whatever the modules switch says)
//   2. private rules    (modules/guard-private-rules, rules file named by the config)
//   3. deny list        worker.deny.any (no access at all), worker.deny.read_only (no writes)
//   4. work-dir jail    writes only inside worker.work_dir
// Not a sandbox: shell commands are checked by reading the command text (README, known limits).
const fs = require('fs');
const path = require('path');
const { readOnlyShell, isShell } = require('../../lib/shell');

const WIN = process.platform === 'win32';
const norm = p => (WIN ? p.toLowerCase() : p);
const TOOLS = ['Bash', 'PowerShell', 'Read', 'Write', 'Edit'];

// Real path of the deepest existing ancestor + the not-yet-existing rest, so a
// symlink or junction inside the jail cannot lead a write outside it.
function real(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest.reverse()); } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = up;
    }
  }
}
function inside(child, parent) {
  const c = norm(child), p = norm(parent).replace(/[\/]+$/, '');
  return c === p || c.startsWith(p + path.sep);
}

// Deny list entry: an absolute path (itself and everything under it) or "re:<regex>"
// (tested, case-insensitive, on the path with forward slashes).
function compileDeny(list, what) {
  return (list || []).map(e => {
    if (typeof e !== 'string' || !e) throw new Error(`worker.deny.${what}: entries must be non-empty strings`);
    if (e.startsWith('re:')) { const re = new RegExp(e.slice(3), 'i'); return p => re.test(p.split('\\').join('/')); }
    if (!path.isAbsolute(e)) throw new Error(`worker.deny.${what}: "${e}" must be an absolute path or re:<regex>`);
    const abs = real(e);
    return p => inside(p, abs);
  });
}

function makePolicy(cfg, deps) { // deps: { guardBase, priv, checkpoint } = the apis of the modules this one dependsOn
  if (!cfg.work_dir || !path.isAbsolute(cfg.work_dir)) throw new Error('worker.work_dir must be set to an absolute folder path');
  fs.mkdirSync(cfg.work_dir, { recursive: true });
  const jail = real(cfg.work_dir);
  const denyAny = compileDeny(cfg.deny && cfg.deny.any, 'any');
  const denyRO = compileDeny(cfg.deny && cfg.deny.read_only, 'read_only');
  const { guardBase, priv } = deps;

  const resolve = (p, cwd) => real(path.resolve(cwd, p));
  const denied = (abs, write) => denyAny.some(f => f(abs)) ? 'deny list (no access)' : write && denyRO.some(f => f(abs)) ? 'deny list (read-only)' : null;

  // One path the job touches -> reason or null.
  function pathHit(raw, cwd, write) {
    if (/[\0\r\n]/.test(raw)) return `path has control characters`;
    if (/^[A-Za-z]:/.test(raw) ? raw.indexOf(':', 2) >= 0 : raw.includes(':')) return `path "${raw.slice(0, 80)}" uses ':' (stream or device syntax)`;
    const abs = resolve(raw, cwd);
    const d = denied(abs, write);
    if (d) return `path ${path.basename(abs)} is on the ${d}`;
    if (write && !inside(abs, jail)) return `write outside the work folder (jail): ${path.basename(abs)}`;
    return null;
  }

  // Shell command: read the text. Every path-like word is checked against the deny list;
  // for a command that changes something, each must also be inside the jail.
  function shellHit(cmd, cwd) {
    const write = !readOnlyShell(cmd);
    const cd = denied(real(cwd), write);
    if (cd) return `working folder is on the ${cd}`;
    if (write && !inside(real(cwd), jail)) return 'a command that changes something must run inside the work folder (jail)';
    if (write && /`|\$\(|<\(/.test(cmd)) return 'a command that changes something may not use command substitution (cannot verify its paths)';
    const re = /"([^"]*)"|'([^']*)'|([^\s<>|&;()]+)/g;
    let m;
    while ((m = re.exec(cmd))) {
      const tok = m[1] ?? m[2] ?? m[3];
      for (const t of [tok, ...tok.split('=').slice(1)]) {
        if (!t || /^-/.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) continue;
        if (/^(\/dev\/null|nul)$/i.test(t)) continue;
        const pathish = /[\/]/.test(t) || /^\.\.?$/.test(t) || /^[A-Za-z]:/.test(t) || t.startsWith('~');
        if (pathish && (/[$%`]/.test(t) || t.startsWith('~'))) return `cannot verify path "${t.slice(0, 60)}" (variable or ~ expansion)`;
        if (/[$%`*?]/.test(t) && !pathish) continue; // not a path
        const h = pathish ? pathHit(t, cwd, write) : (() => { const d = denied(resolve(t, cwd), write); return d ? `path ${path.basename(t)} is on the ${d}` : null; })();
        if (h) return h;
      }
    }
    return null;
  }

  // -> { ok:true, write, cwd, ti } (allowed) | { kind, reason, write? } (refused).  `p` is the job payload {tool, input, cwd?}.
  function check(p) {
    if (!p || typeof p !== 'object' || !TOOLS.includes(p.tool)) return { kind: 'payload', reason: `unsupported tool ${JSON.stringify(p && p.tool)} (supported: ${TOOLS.join(', ')})` };
    const input = p.input && typeof p.input === 'object' ? p.input : null;
    if (!input) return { kind: 'payload', reason: 'payload.input is missing' };
    if (p.cwd !== undefined && typeof p.cwd !== 'string') return { kind: 'payload', reason: 'payload.cwd must be a string' };
    const cwd = p.cwd ? path.resolve(p.cwd) : jail;
    const ti = { ...input };
    let write;
    let hit = null;
    if (isShell(p.tool)) {
      if (typeof input.command !== 'string' || !input.command.trim()) return { kind: 'payload', reason: 'input.command is required' };
      write = !readOnlyShell(input.command);
      hit = shellHit(input.command, cwd);
    } else {
      if (typeof input.file_path !== 'string' || !input.file_path) return { kind: 'payload', reason: 'input.file_path is required' };
      write = p.tool !== 'Read';
      if (write && typeof (p.tool === 'Write' ? input.content : input.new_string) !== 'string') return { kind: 'payload', reason: 'input content is required' };
      ti.file_path = resolve(input.file_path, cwd);
      hit = pathHit(input.file_path, cwd, write);
    }
    if (hit) return { kind: 'jail_or_deny', reason: hit, write };
    const g = guardBase.beforeTool({ tool: p.tool, ti, cwd });
    if (g) return { kind: g[0], reason: `guard-base: ${g[1]}`, write };
    const r = priv.privateRules(p.tool, ti);
    if (r) return { kind: r[0], reason: `private rule: ${r[1]}`, write };
    return { ok: true, write, cwd, ti };
  }

  return { check, jail, inside, real };
}

module.exports = { makePolicy, TOOLS, inside, real };
