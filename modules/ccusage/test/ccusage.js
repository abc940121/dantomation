#!/usr/bin/env node
'use strict';
// ccusage: args are pinned and validated, the child process is stubbed (no network,
// no npx), the command prints a table / JSON / a one-line hint, the route answers.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccusage-'));
process.env.HARNESS_STATE_DIR = path.join(tmp, 'state');
delete process.env.HARNESS_TASK_ID;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const DAILY = { daily: [{ date: '2026-01-02', inputTokens: 10, outputTokens: 20, cacheCreationTokens: 30, cacheReadTokens: 40, totalCost: 1.5 }], totals: { inputTokens: 10, outputTokens: 20, cacheCreationTokens: 30, cacheReadTokens: 40, totalCost: 1.5 } };
const SESS = { sessions: [{ sessionId: 'abcdef123456', lastActivity: '2026-01-02T01:00:00Z', projectPath: 'SECRET/PATH', inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4, totalCost: 0.25 }], totals: { totalCost: 0.25 } };

(async () => {
  try {
    const reg = M.registry({ modules: { ccusage: true } });
    check('loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    check('off by default', M.registry({ modules: { ccusage: false } }).listCommands().indexOf('usage') < 0);
    check('command and route listed', reg.listCommands().includes('usage') && reg.listRoutes().map(r => r.path).join() === '/m/ccusage/usage');
    const api = reg.api('ccusage');
    const settings = reg.settingsFor('ccusage');
    check('version is pinned by default', /^\d+\.\d+\.\d+$/.test(settings.version), settings.version);

    check('args: pinned version, claude, json, offline, dates normalised',
      JSON.stringify(api.buildArgs('daily', { since: '2026-01-02', until: '20260110', version: '1.2.3' })) ===
      JSON.stringify(['-y', 'ccusage@1.2.3', 'claude', 'daily', '--json', '--offline', '--since', '20260102', '--until', '20260110']));
    for (const [label, fn] of [['bad date', () => api.buildArgs('daily', { since: '1; echo hi', version: '1.2.3' })], ['bad report', () => api.buildArgs('x y', { version: '1.2.3' })], ['bad version', () => api.buildArgs('daily', { version: 'latest & calc' })]]) {
      let threw = false; try { fn(); } catch { threw = true; }
      check(`args: ${label} is refused`, threw);
    }

    const seen = [];
    api.setRunner(async (args) => { seen.push(args); return { code: 0, stdout: JSON.stringify(args.includes('session') ? SESS : DAILY), stderr: '' }; });
    const out = [], err = [];
    const log = console.log, elog = console.error;
    console.log = s => out.push(String(s)); console.error = s => err.push(String(s));
    let r1, r2, r3, r4, r5;
    try {
      const cmds = M.commands(reg.mods);
      const ctx = { settings };
      r1 = await cmds.usage(['--since', '2026-01-01'], ctx);
      r2 = await cmds.usage(['session'], ctx);
      r3 = await cmds.usage(['daily', '--json'], ctx);
      r4 = await cmds.usage(['--bogus'], ctx);
      api.setRunner(async () => ({ code: null, error: 'spawn npx ENOENT' }));
      r5 = await cmds.usage([], ctx);
    } finally { console.log = log; console.error = elog; }
    check('command prints a table with totals', r1.code === 0 && /2026-01-02/.test(out[0]) && /TOTAL/.test(out[0]) && /\$1\.50/.test(out[0]), out[0] && out[0].split('\n')[1]);
    check('command passes since to the child', seen[0].includes('--since') && seen[0].includes('20260101'));
    check('session table shows id, no path', r2.code === 0 && /abcdef12/.test(out[1]) && !/SECRET/.test(out[1]));
    check('--json prints the raw JSON', r3.code === 0 && JSON.parse(out[2]).totals.totalCost === 1.5);
    check('unknown option exits 2 with usage', r4.code === 2 && /unknown option/.test(err[0]));
    check('missing npx: one-line hint, nonzero, no throw', r5.code === 1 && err.length === 2 && !/\n/.test(err[1]) && /could not run/.test(err[1]), err[1]);

    api.setRunner(async () => ({ code: 0, stdout: JSON.stringify(DAILY), stderr: '' }));
    const found = reg.findRoute('GET', '/m/ccusage/usage?report=daily');
    const ok = await reg.callRoute(found, { query: { report: 'daily' }, actor: { kind: 'owner', id: 't' } });
    check('route returns the JSON', ok.status === 200 && ok.json.totals.totalCost === 1.5);
    const bad = await reg.callRoute(found, { query: { since: 'nope' }, actor: { kind: 'owner', id: 't' } });
    check('route: bad input is 400', bad.status === 400 && /YYYY/.test(bad.json.error));
    api.setRunner(async () => ({ code: null, error: 'x' }));
    const down = await reg.callRoute(found, { query: {}, actor: { kind: 'owner', id: 't' } });
    check('route: missing ccusage is 503 with the hint', down.status === 503 && /could not run/.test(down.json.error));
    const anon = await reg.callRoute(found, { query: {}, actor: { kind: 'anonymous' } });
    check('route: anonymous is refused', anon.status === 403);
    api.setRunner(async () => ({ code: 0, stdout: 'not json', stderr: '' }));
    const junk = await api.report('daily', {}, settings);
    check('non-JSON output is a clean error', !junk.ok && /not JSON/.test(junk.error));
    api.setRunner(async () => ({ code: 3, stdout: '', stderr: 'boom\nmore' }));
    const fail = await api.report('daily', {}, settings);
    check('nonzero exit is a one-line error', !fail.ok && /exited 3: boom$/.test(fail.error));
    api.setRunner(async () => ({ code: null, error: 'timed out after 5 ms' }));
    const slow = await api.report('daily', {}, settings);
    check('timeout says it timed out and names timeout_ms, not the install hint', !slow.ok && /timed out after 5 ms/.test(slow.error) && /timeout_ms/.test(slow.error) && !/could not run/.test(slow.error), slow.error);
  } catch (e) { check('no exception', false, e.stack); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  process.exit(n === results.length ? 0 : 1);
})();
