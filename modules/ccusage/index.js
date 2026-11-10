'use strict';
// ccusage: per-day / per-session Claude Code token and cost reports. It runs the
// separate program ccusage (MIT, https://github.com/ryoppippi/ccusage) through npx,
// pinned by the `version` setting, and prints or serves its JSON. No ccusage code is
// copied. Off by default. Missing npx or ccusage gives a one-line hint, never a crash.
const { spawn } = require('child_process');

const KINDS = { daily: 'daily', monthly: 'monthly', session: 'session' };
const DATE = /^(\d{8}|\d{4}-\d{2}-\d{2})$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const HINT = 'ccusage: could not run it. Install Node/npx (https://nodejs.org) and check network access once to fetch ccusage.';

// Argument vector for npx. Only validated values reach it, so a shell on Windows
// (needed to run npx.cmd) cannot be given anything but digits, dashes and fixed words.
function buildArgs(kind, { since, until, version }) {
  if (!KINDS[kind]) throw new Error(`unknown report "${kind}" (daily, monthly, session)`);
  if (!VERSION.test(String(version))) throw new Error(`bad ccusage version "${version}"`);
  const a = ['-y', `ccusage@${version}`, 'claude', KINDS[kind], '--json', '--offline'];
  for (const [flag, v] of [['--since', since], ['--until', until]]) {
    if (v == null || v === '') continue;
    if (!DATE.test(String(v))) throw new Error(`${flag} must be YYYY-MM-DD or YYYYMMDD`);
    a.push(flag, String(v).replace(/-/g, ''));
  }
  return a;
}

// Default runner: spawn npx, collect stdout, stop it after timeoutMs.
// Resolves {code, stdout, stderr}; a missing npx resolves {code: null, error}.
function defaultRunner(args, { timeoutMs, signal }) {
  return new Promise(resolve => {
    let out = '', err = '', done = false, t = null;
    const fin = r => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    let p;
    try {
      p = spawn('npx', args, { shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    } catch (e) { return resolve({ code: null, error: e.message }); }
    t = setTimeout(() => { try { p.kill(); } catch {} fin({ code: null, error: `timed out after ${timeoutMs} ms` }); }, timeoutMs);
    p.stdout.on('data', d => { if (out.length < 32e6) out += d; });
    p.stderr.on('data', d => { if (err.length < 1e5) err += d; });
    p.on('error', e => fin({ code: null, error: e.message }));
    p.on('close', code => fin({ code, stdout: out, stderr: err }));
  });
}

let runner = defaultRunner; // replaced by tests through api.setRunner

// -> {ok: true, data} | {ok: false, error: one line}
async function report(kind, opts, settings, extra = {}) {
  let args;
  try { args = buildArgs(kind, { ...opts, version: settings.version }); } catch (e) { return { ok: false, error: `ccusage: ${e.message}` }; }
  let r;
  try { r = await runner(args, { timeoutMs: settings.timeout_ms, signal: extra.signal }); } catch (e) { r = { code: null, error: e.message }; }
  if (r && r.code === null && /^timed out/.test(String(r.error))) return { ok: false, error: `ccusage: ${r.error}. The first run downloads ccusage; try again, or raise "ccusage": { "timeout_ms" } in the config.` };
  if (!r || r.code !== 0) return { ok: false, error: r && r.code === null ? HINT : `ccusage exited ${r && r.code}: ${String((r && r.stderr) || '').trim().split('\n')[0].slice(0, 160)}` };
  try { return { ok: true, data: JSON.parse(r.stdout) }; } catch { return { ok: false, error: 'ccusage: its output was not JSON (try another version setting)' }; }
}

const rowsOf = data => (data && (data.daily || data.monthly || data.sessions)) || [];
const money = n => '$' + Number(n || 0).toFixed(2);
const kfmt = n => Number(n || 0).toLocaleString('en-US');

// Plain table: one row per day / month / session, then totals. Paths are not printed.
function table(data) {
  const rows = rowsOf(data);
  const lines = [['period', 'input', 'output', 'cache-w', 'cache-r', 'cost']];
  for (const r of rows) {
    const id = r.date || r.month || r.period || (r.sessionId ? String(r.sessionId).slice(0, 8) + (r.lastActivity ? ' ' + String(r.lastActivity).slice(0, 10) : '') : '?');
    lines.push([id, kfmt(r.inputTokens), kfmt(r.outputTokens), kfmt(r.cacheCreationTokens), kfmt(r.cacheReadTokens), money(r.totalCost)]);
  }
  const t = data && data.totals;
  if (t) lines.push(['TOTAL', kfmt(t.inputTokens), kfmt(t.outputTokens), kfmt(t.cacheCreationTokens), kfmt(t.cacheReadTokens), money(t.totalCost)]);
  const w = lines[0].map((_, i) => Math.max(...lines.map(l => String(l[i]).length)));
  return lines.map(l => l.map((c, i) => (i ? String(c).padStart(w[i]) : String(c).padEnd(w[i]))).join('  ')).join('\n');
}

function parseArgs(args) {
  const o = { kind: 'daily', json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') o.json = true;
    else if (a === '--since' || a === '--until') o[a.slice(2)] = args[++i];
    else if (a === 'sessions') o.kind = 'session';
    else if (!a.startsWith('-')) o.kind = a;
    else return { error: `unknown option ${a}` };
  }
  return o;
}

module.exports = {
  contract: 2,
  name: 'ccusage',
  description: 'Per-day / per-session Claude Code token and cost reports from local logs, by running the ccusage program.',
  runsOn: 'main',
  priority: 90,
  dependsOn: [],

  // `taskmote check usage [daily|monthly|session] [--since D] [--until D] [--json]`
  commands: {
    async usage(args, ctx) {
      if (process.env.HARNESS_TASK_ID) { console.error('check usage: owner only; not available inside a task'); return { handled: true, code: 2 }; }
      const o = parseArgs(args);
      if (o.error) { console.error(`usage: ${o.error}. Use: taskmote check usage [daily|monthly|session] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]`); return { handled: true, code: 2 }; }
      const r = await report(o.kind, o, ctx.settings);
      if (!r.ok) { console.error(r.error); return { handled: true, code: 1 }; }
      console.log(o.json ? JSON.stringify(r.data, null, 2) : table(r.data));
      return { handled: true, code: 0 };
    },
  },

  // GET /m/ccusage/usage?report=daily&since=2026-11-01&until=2026-11-10 -> ccusage's JSON
  routes: [{
    method: 'GET', path: '/usage', description: 'ccusage JSON report (report=daily|monthly|session, since, until)', access: 'owner',
    async handler({ query, settings, signal }) {
      const q = query || {};
      const r = await report(q.report || 'daily', { since: q.since, until: q.until }, settings, { signal });
      if (r.ok) return { status: 200, json: r.data };
      return { status: /could not run/.test(r.error) ? 503 : 400, json: { error: r.error } };
    },
  }],

  settings: {
    version: { type: 'string', default: '20.0.48', description: 'ccusage version npx runs (pinned; change it on purpose)' },
    timeout_ms: { type: 'integer', default: 120000, min: 1000, max: 600000, description: 'give up on ccusage after this long (the first run downloads it)' },
  },

  api: { buildArgs, report, table, setRunner: fn => { runner = fn || defaultRunner; } },
};
