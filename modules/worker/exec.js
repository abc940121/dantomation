'use strict';
// Runs one already-approved tool action, or one engine task. No policy here (policy.js).
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { redact } = require('../../lib/redact');

const OUT_MAX = 64 * 1024;
const READ_MAX = 256 * 1024;

function killTree(child) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

function shellFor(tool) {
  if (tool === 'PowerShell') return { bin: process.platform === 'win32' ? 'powershell.exe' : 'pwsh', pre: ['-NoProfile', '-NonInteractive', '-Command'] };
  let bin = process.env.HARNESS_BASH || 'bash';
  if (!process.env.HARNESS_BASH && process.platform === 'win32') {
    // plain "bash" on Windows can be the WSL launcher; prefer Git's bash
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      const f = path.join(root, 'Git', 'bin', 'bash.exe');
      if (fs.existsSync(f)) { bin = f; break; }
    }
  }
  return { bin, pre: ['-c'] };
}

// Child environment: the engine's strip list (keys and tokens), never the owner switch.
function cleanEnv(stripPatterns) {
  const pats = stripPatterns.map(p => new RegExp('^' + p.replace(/\*/g, '.*') + '$', 'i'));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'HARNESS_OWNER' || pats.some(r => r.test(k))) delete env[k];
  return env;
}

// -> Promise<{ok, result, error?}>
function runProcess(bin, args, { cwd, env, timeoutMs, onSpawn }) {
  return new Promise(resolve => {
    let out = '', err = '', cut = false, timedOut = false;
    const child = spawn(bin, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    if (onSpawn) onSpawn(child);
    const add = (cur, d) => { const s = cur + d.toString('utf8'); if (s.length > OUT_MAX) { cut = true; return s.slice(0, OUT_MAX); } return s; };
    child.stdout.on('data', d => { out = add(out, d); });
    child.stderr.on('data', d => { err = add(err, d); });
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs) : null;
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: `could not start ${path.basename(bin)}: ${e.code || e.message}`, result: null }); });
    child.on('close', code => {
      clearTimeout(timer);
      const result = { exit: code, stdout: redact2(out), stderr: redact2(err), truncated: cut };
      if (timedOut) resolve({ ok: false, error: 'deadline exceeded; the process was stopped', result: { ...result, timedOut: true } });
      else resolve({ ok: code === 0, error: code === 0 ? undefined : `exit ${code}`, result });
    });
  });
}
// redact() clips to 300 chars (log use); keep the shape, apply per line, no clip.
const redact2 = s => s.split('\n').map(l => (l.length > 2000 ? l : redact(l))).join('\n');

async function runTool(pol, planned, { env, timeoutMs }) {
  const { tool } = planned;
  const ti = planned.ti;
  if (tool === 'Read') {
    const st = fs.statSync(ti.file_path);
    if (!st.isFile()) return { ok: false, error: 'not a file', result: null };
    const fd = fs.openSync(ti.file_path, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, READ_MAX));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return { ok: true, result: { content: redact2(buf.toString('utf8')), bytes: st.size, truncated: st.size > READ_MAX } };
    } finally { fs.closeSync(fd); }
  }
  if (tool === 'Write') {
    fs.mkdirSync(path.dirname(ti.file_path), { recursive: true });
    fs.writeFileSync(ti.file_path, ti.content);
    return { ok: true, result: { bytes: Buffer.byteLength(ti.content) } };
  }
  if (tool === 'Edit') {
    const cur = fs.readFileSync(ti.file_path, 'utf8');
    const n = ti.old_string ? cur.split(ti.old_string).length - 1 : 0;
    if (!ti.old_string || n === 0) return { ok: false, error: 'old_string not found', result: null };
    if (n > 1 && !ti.replace_all) return { ok: false, error: `old_string matches ${n} places; set replace_all or give more context`, result: null };
    fs.writeFileSync(ti.file_path, ti.replace_all ? cur.split(ti.old_string).join(ti.new_string) : cur.replace(ti.old_string, () => ti.new_string));
    return { ok: true, result: { replaced: ti.replace_all ? n : 1 } };
  }
  const sh = shellFor(tool);
  return runProcess(sh.bin, [...sh.pre, ti.command], { cwd: planned.cwd, env, timeoutMs });
}

module.exports = { runTool, runProcess, killTree, cleanEnv };
