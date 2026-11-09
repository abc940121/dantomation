'use strict';
// ctx.engines.run(engine, input, {timeoutMs}) for modules (contract 6).
// Only engines listed in config "engines" ({"<name>": {"bin": "...", "args": [...]}}) can run;
// the prompt goes to the child on stdin, stdout comes back. The prompt is never journaled.
// Core caps the time: config "engines_max_timeout_ms" (default 120000) is both the default and the cap.
const { spawn } = require('child_process');
const J = require('./journal');

const DEFAULT_MAX_MS = 120000;
const MAX_OUTPUT = 1000000; // bytes of stdout kept
const MAX_INPUT = 200000;   // chars of input

const maxMs = cfg => (cfg && Number.isInteger(cfg.engines_max_timeout_ms) && cfg.engines_max_timeout_ms >= 1) ? cfg.engines_max_timeout_ms : DEFAULT_MAX_MS;
const listed = (cfg, name) => !!(cfg && cfg.engines && typeof cfg.engines === 'object' && !Array.isArray(cfg.engines) && Object.prototype.hasOwnProperty.call(cfg.engines, name) && cfg.engines[name] && typeof cfg.engines[name].bin === 'string');
const globRe = p => new RegExp('^' + p.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');

function childEnv(cfg) {
  const res = ((cfg && cfg.strip_env) || []).map(globRe);
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !res.some(r => r.test(k))));
}

// -> { output, code }. Rejects: engine not listed, bad input, timeout (child killed), spawn error.
function run(moduleName, cfg, engine, input, opts = {}) {
  if (typeof engine !== 'string' || !listed(cfg, engine)) return Promise.reject(new Error(`engine ${JSON.stringify(String(engine).slice(0, 60))} is not listed in config "engines"; module ${moduleName} may use only listed engines`));
  if (typeof input !== 'string' || input.length > MAX_INPUT) return Promise.reject(new Error(`engine input must be a string of at most ${MAX_INPUT} chars`));
  const cap = maxMs(cfg);
  let ms = cap;
  if (opts && opts.timeoutMs !== undefined) {
    if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1) return Promise.reject(new Error('timeoutMs must be a whole number of milliseconds >= 1'));
    ms = Math.min(opts.timeoutMs, cap);
  }
  const spec = cfg.engines[engine];
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    let done = false, out = Buffer.alloc(0), timer;
    const finish = (err, val) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { J.append({ type: 'engine_call', module: moduleName, engine, ms: Date.now() - t0 }); } catch { /* journal failure must not hide the result */ }
      err ? reject(err) : resolve(val);
    };
    let child;
    try { child = spawn(spec.bin, Array.isArray(spec.args) ? spec.args.map(String) : [], { env: childEnv(cfg), stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true }); }
    catch (e) { return finish(new Error(`engine ${engine} could not start (${e.code || 'error'})`)); }
    timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(Object.assign(new Error(`engine ${engine} took longer than ${ms} ms`), { timeout: true })); }, ms);
    child.on('error', e => finish(new Error(`engine ${engine} failed to run (${e.code || 'error'})`)));
    child.stdout.on('data', d => { if (out.length < MAX_OUTPUT) out = Buffer.concat([out, d]).subarray(0, MAX_OUTPUT); });
    child.on('close', code => finish(null, { output: out.toString('utf8'), code }));
    child.stdin.on('error', () => { /* child exited before reading */ });
    child.stdin.end(input);
  });
}

module.exports = { run, maxMs, DEFAULT_MAX_MS };
