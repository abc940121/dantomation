'use strict';
// gitleaks: thin wrapper around the separate `gitleaks` program (MIT, not bundled, no code copied).
// beforeTool: a `git commit` / `git push` shell call in a repo runs a scan first and blocks with
// "rule id, file, line" when findings exist (never the secret: --redact, and we print three fields).
// Verb: `scan [path] [--dir]` (via bin/harness.js). Off by default.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { isShell } = require('../../lib/shell');

// git [-C dir | -c k=v | --flag]* commit|push
const GIT_RE = /\bgit((?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--[\w-]+(?:=\S+)?))*)\s+(commit|push)\b/;
function classify(cmd) {
  const m = GIT_RE.exec(String(cmd || ''));
  if (!m) return null;
  const c = /-C\s+(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(m[1] || '');
  return { op: m[2], dir: c ? (c[1] || c[2] || c[3]) : null };
}

// Find the binary on PATH ourselves, so a missing one is a clean "missing" and not a spawn error.
function resolveBin(name) {
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  const dirs = path.isAbsolute(name) ? [''] : (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) for (const e of exts) {
    const f = d ? path.join(d, name + e) : name + e;
    try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

// -> { status: 'clean'|'findings'|'missing'|'error', findings: [{rule,file,line}], detail }
function runGitleaks(args, { cwd, bin, timeoutMs, signal }) {
  return new Promise(resolve => {
    const exe = resolveBin(bin);
    if (!exe) return resolve({ status: 'missing', findings: [], detail: `${bin} not found on PATH` });
    let tmp, done = false;
    const finish = r => { if (done) return; done = true; try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } resolve(r); };
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-gitleaks-'));
    const report = path.join(tmp, 'report.json');
    const full = [...args, '--report-format', 'json', '--report-path', report, '--redact', '--no-banner', '--no-color', '--exit-code', '1'];
    const shell = /\.(cmd|bat)$/i.test(exe);
    let child;
    try { child = shell ? spawn([`"${exe}"`, ...full.map(a => (/\s/.test(a) ? `"${a}"` : a))].join(' '), { cwd, shell: true, stdio: 'ignore', windowsHide: true }) : spawn(exe, full, { cwd, stdio: 'ignore', windowsHide: true }); } catch (e) { return finish({ status: 'error', findings: [], detail: `cannot run gitleaks (${e.code || 'spawn'})` }); }
    const kill = () => { try { child.kill(); } catch { /* gone */ } };
    const timer = setTimeout(() => { kill(); finish({ status: 'error', findings: [], detail: `scan timed out after ${timeoutMs} ms` }); }, timeoutMs);
    if (signal) signal.addEventListener('abort', () => { kill(); finish({ status: 'error', findings: [], detail: 'scan aborted' }); }, { once: true });
    child.on('error', e => { clearTimeout(timer); finish({ status: 'error', findings: [], detail: `cannot run gitleaks (${e.code || 'spawn'})` }); });
    child.on('close', code => {
      clearTimeout(timer);
      let list = null;
      try { const t = fs.readFileSync(report, 'utf8').trim(); list = t ? JSON.parse(t) : []; } catch { /* no report */ }
      if (code === 0 && (list === null || !list.length)) return finish({ status: 'clean', findings: [] });
      if (Array.isArray(list) && list.length) {
        // Only three fields ever leave this function; Secret/Match text is dropped.
        const findings = list.map(f => ({ rule: String(f.RuleID || 'unknown').slice(0, 80), file: String(f.File || '?').replace(/[\r\n]/g, ' ').slice(0, 200), line: Number.isInteger(f.StartLine) ? f.StartLine : 0 }));
        return finish({ status: 'findings', findings });
      }
      finish({ status: 'error', findings: [], detail: `gitleaks exited with code ${code}` });
    });
  });
}

const fmt = (list, n = 5) => list.slice(0, n).map(f => `${f.rule} ${f.file}:${f.line}`).join('; ') + (list.length > n ? ` (+${list.length - n} more)` : '');

const argsFor = op => (op === 'commit' ? ['git', '--staged'] : ['git', '--log-opts=HEAD --not --remotes']);

// Every unscanned commit/push says so: a one-time line scrolls away, and a push is public.
function warnMissing(op) {
  process.stderr.write(`gitleaks module: this git ${op} was NOT scanned: the gitleaks program is not installed (on_missing=allow). Install it, or set gitleaks.on_missing to block.\n`);
}

async function beforeTool({ tool, ti, cwd, settings, state, signal }) {
  if (!isShell(tool)) return null;
  const c = classify(ti && ti.command);
  if (!c || (c.op === 'commit' && !settings.scan_commit) || (c.op === 'push' && !settings.scan_push)) return null;
  const dir = c.dir ? path.resolve(cwd || process.cwd(), c.dir) : (cwd || process.cwd());
  const r = await runGitleaks(argsFor(c.op), { cwd: dir, bin: settings.binary, timeoutMs: settings.scan_timeout_ms, signal });
  if (r.status === 'clean') return null;
  if (r.status === 'findings') return ['secret_scan', `gitleaks found ${r.findings.length} possible secret(s) before git ${c.op}: ${fmt(r.findings)}. Remove them, then retry.`];
  if (r.status === 'missing' && settings.on_missing === 'allow') { warnMissing(c.op); return null; }
  return ['secret_scan', `git ${c.op} not scanned: ${r.detail}. ${r.status === 'missing' ? 'Ask the owner to install gitleaks (do not install it yourself), or to set gitleaks.on_missing to "allow".' : 'Fix the scan and retry.'}`];
}

// harness.js scan [path] [--dir] (taskmote forwards only its fixed verbs, so this needs trunk help to be `taskmote scan`): no path = staged changes of the repo in the current folder;
// a path or --dir scans files (gitleaks dir). Exit 0 clean, 1 findings, 2 could not scan.
async function scan(args, ctx) {
  const s = ctx.settings;
  const rest = args.filter(a => a !== '--dir');
  const dirMode = args.includes('--dir') || rest.length > 0;
  const target = rest[0] ? path.resolve(rest[0]) : process.cwd();
  const r = await runGitleaks(dirMode ? ['dir', target] : ['git', '--staged'], { cwd: process.cwd(), bin: s.binary, timeoutMs: Math.max(s.scan_timeout_ms, 60000) });
  if (r.status === 'clean') { console.log('scan: no secrets found'); process.exitCode = 0; return { handled: true, code: 0 }; }
  if (r.status === 'findings') { for (const f of r.findings) console.log(`${f.rule}\t${f.file}:${f.line}`); console.error(`scan: ${r.findings.length} possible secret(s) (values hidden)`); process.exitCode = 1; return { handled: true, code: 1 }; }
  console.error(`scan: could not scan: ${r.detail}`);
  process.exitCode = 2; return { handled: true, code: 2 };
}

module.exports = {
  contract: 2,
  name: 'gitleaks',
  description: 'Runs the gitleaks program before git commit / git push and blocks on findings.',
  runsOn: ['main', 'worker'],
  priority: 10,
  hookTimeoutMs: 5000,
  beforeTool,
  commands: { scan },
  settings: {
    binary: { type: 'string', default: 'gitleaks', description: 'gitleaks program name or absolute path' },
    scan_commit: { type: 'boolean', default: true, description: 'scan staged changes before git commit' },
    scan_push: { type: 'boolean', default: true, description: 'scan commits not on any remote before git push' },
    scan_timeout_ms: { type: 'integer', default: 4000, min: 500, max: 600000, description: 'scan time limit in the guard (a timeout blocks)' },
    on_missing: { type: 'string', enum: ['allow', 'block'], default: 'allow', description: 'gitleaks not installed: allow commit/push with a warning on each one, or block them' },
  },
  api: { classify },
};
