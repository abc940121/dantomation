#!/usr/bin/env node
'use strict';
// digest: off by default, since parsing, counts, open cards, route, --json, last-run, push.
// Private temp state dir, no network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'));
const STATE = path.join(tmp, 'state');
process.env.HARNESS_STATE_DIR = STATE; // before the journal is required
process.env.HARNESS_LOG_DIR = path.join(tmp, 'logs');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };

const iso = ago => new Date(Date.now() - ago).toISOString();
const H = 3600000;
const seed = recs => {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, 'journal.jsonl'), recs.map((r, i) => JSON.stringify({ id: 'x' + i, ...r })).join('\n') + '\n');
};

async function run(reg, args, cfgExtra) {
  const out = [], err = [];
  const log = console.log, elog = console.error;
  console.log = s => out.push(String(s)); console.error = s => err.push(String(s));
  let res;
  try { res = await M.commands(reg.mods).digest(args, cfgExtra || {}); } finally { console.log = log; console.error = elog; }
  return { out: out.join('\n'), err: err.join('\n'), code: res && res.code };
}

(async () => {
  try {
    const off = M.registry({ modules: { digest: false } });
    check('off: nothing registered', !off.listRoutes().length && !off.listCommands().includes('digest'));
    const def = M.registry({ modules: {} });
    check('off by default (not in an empty modules map)', !def.listCommands().includes('digest'));

    const reg = M.registry({ modules: { digest: true } });
    check('on: loads with no errors', reg.errors.length === 0, reg.errors.join(' | '));
    check('command and route listed', reg.listCommands().includes('digest') && reg.listRoutes().map(r => `${r.method} ${r.path}`).join() === 'GET /m/digest/digest');

    // empty state: no journal file at all
    let r = await run(reg, ['--since', '24h']);
    check('empty state: exits 0 and says nothing needs you', r.code === 0 && /Nothing needs you/.test(r.out) && /tasks: 0 started/.test(r.out), r.out);

    // since parsing
    const mod = require(path.join(ROOT, 'modules', 'digest', 'index.js'));
    const now = Date.now();
    const p = mod.api.parseSince;
    check('since: 12h', p('12h', now) === now - 12 * H);
    check('since: 2d', p('2d', now) === now - 48 * H);
    check('since: ISO', p('2026-01-31T08:00:00Z', now) === Date.parse('2026-01-31T08:00:00Z'));
    check('since: date only', p('2026-01-31', now) === Date.parse('2026-01-31'));
    check('since: junk rejected', ['', 'abc', '0h', '-2h', '12x', '2026-13-45', 'yesterday'].every(v => p(v, now) === null));
    r = await run(reg, ['--since', 'yesterday']);
    check('bad --since exits 2', r.code === 2 && /bad --since/.test(r.err));
    r = await run(reg, ['--nope']);
    check('unknown option exits 2', r.code === 2);
    r = await run(reg, ['--since']);
    check('--since with no value exits 2', r.code === 2);

    // counts and open cards
    seed([
      { ts: iso(30 * H), type: 'task_start', task_id: 'old' },
      { ts: iso(5 * H), type: 'task_start', task_id: 'a1' },
      { ts: iso(4 * H), type: 'task_done', task_id: 'a1', auto: true },
      { ts: iso(4 * H), type: 'task_start', task_id: 'a2' },
      { ts: iso(3 * H), type: 'task_done', task_id: 'a2', auto: true, failed: true, code: 3 },
      { ts: iso(3 * H), type: 'task_done', task_id: 'a3', stopped: true },
      { ts: iso(2 * H), type: 'card', card_id: 'c1', task_id: 'a2', tool: 'Bash', summary: 'rm -rf build', expires_at: iso(-H) },
      { ts: iso(2 * H), type: 'card', card_id: 'c2', task_id: 'a2', tool: 'Bash', summary: 'ls' },
      { ts: iso(H), type: 'card_answer', card_id: 'c2', task_id: 'a2', answer: 'yes' },
      { ts: iso(2 * H), type: 'question', question_id: 'q1', task_id: 'a2', expires_at: iso(-H) },
      { ts: iso(H), type: 'claim_audit', task_id: 'a1', checked: 4, unverified: 2 },
      { ts: iso(H), type: 'tripwire', task_id: 'a2', rule: 'secret-path' },
      { ts: iso(H), type: 'task_stalled', task_id: 'a2', reason: 'no output' },
      { ts: iso(H), type: 'trace_overrun', task_id: 'a1', factor: 2.5 },
      { ts: iso(H), type: 'unknown_future_kind' },
    ]);
    r = await run(reg, ['--since', '24h', '--json']);
    const j = JSON.parse(r.out);
    const c = j.counts;
    check('counts', c.tasks_started === 2 && c.tasks_done === 3 && c.tasks_failed === 1 && c.tasks_stopped === 1 && c.cards_answered === 1 && c.claims_flagged === 1 && c.tripwires === 1 && c.stalls === 1 && c.overruns === 1, JSON.stringify(c));
    check('window excludes records older than since', c.tasks_started === 2);
    check('open card counted and answered card not', c.cards_open === 1 && c.questions_open === 1, JSON.stringify(c));
    check('open-card line present', j.notable.some(l => /Approval waiting: rm -rf build \(card c1\)/.test(l)), j.notable.join(' | '));
    check('failure line present', j.notable.some(l => /Task failed: a2 \(exit 3\)/.test(l)));
    check('--json shape', r.code === 0 && typeof j.since === 'string' && typeof j.until === 'string' && Array.isArray(j.notable) && typeof c === 'object');
    r = await run(reg, ['--since', '24h']);
    check('text output: counts before notable lines', r.out.indexOf('tasks:') < r.out.indexOf('- '), r.out);

    // spend: missing file skipped, then per-session growth inside the window
    check('spend: missing file is skipped', j.spend_usd === null && !/spend:/.test(r.out));
    fs.mkdirSync(process.env.HARNESS_LOG_DIR, { recursive: true });
    const sp = (ago, id, usd) => JSON.stringify({ ts: iso(ago), session_id: id, usd });
    const spFile = path.join(process.env.HARNESS_LOG_DIR, 'spend.jsonl');
    fs.writeFileSync(spFile, [sp(30 * H, 's1', 1.0), sp(5 * H, 's1', 1.5), sp(2 * H, 's1', 2.25), sp(3 * H, 's2', 0.5), 'junk'].join('\n') + '\n');
    r = await run(reg, ['--since', '24h', '--json']);
    check('spend: window total is per-session growth', JSON.parse(r.out).spend_usd === 1.75, String(JSON.parse(r.out).spend_usd));
    r = await run(reg, ['--since', '24h']);
    check('spend: shown in text', /spend: \$1\.75/.test(r.out), r.out);
    fs.unlinkSync(spFile);

    // notable list is capped
    seed(Array.from({ length: 15 }, (_, i) => ({ ts: iso(H), type: 'task_done', task_id: 't' + i, failed: true, code: 1 })));
    r = await run(reg, ['--since', '24h', '--json']);
    const capped = JSON.parse(r.out);
    check('notable capped at 10 plus a more-line', capped.notable.length === 11 && /and 5 more/.test(capped.notable[10]), String(capped.notable.length));

    // last-run memory
    seed([{ ts: iso(2 * H), type: 'task_start', task_id: 'z1' }]);
    const lastFile = path.join(STATE, 'm', 'digest', 'last-run.json');
    r = await run(reg, ['--since', '24h', '--json']);
    check('first run sees the task', JSON.parse(r.out).counts.tasks_started === 1);
    check('last-run file written', fs.existsSync(lastFile) && !Number.isNaN(Date.parse(JSON.parse(fs.readFileSync(lastFile, 'utf8')).at)));
    r = await run(reg, ['--json']);
    check('next run without --since starts at the last run', JSON.parse(r.out).counts.tasks_started === 0);
    fs.writeFileSync(lastFile, JSON.stringify({ at: iso(3 * H) }));
    r = await run(reg, ['--json']);
    check('last-run time is the default since', JSON.parse(r.out).counts.tasks_started === 1);
    fs.writeFileSync(lastFile, '{not json');
    r = await run(reg, ['--json']);
    check('corrupt last-run file falls back to 24h', r.code === 0 && JSON.parse(r.out).counts.tasks_started === 1);

    // route
    fs.rmSync(lastFile, { force: true });
    const owner = { kind: 'owner', id: 'test' };
    const rt = reg.findRoute('GET', '/m/digest/digest');
    let rr = await reg.callRoute(rt, { query: { since: '24h' }, actor: owner });
    check('route 200 with the JSON shape', rr.status === 200 && rr.json.counts && rr.json.counts.tasks_started === 1, JSON.stringify(rr).slice(0, 120));
    rr = await reg.callRoute(rt, { query: { since: 'nonsense' }, actor: owner });
    check('route 400 on bad since', rr.status === 400);
    rr = await reg.callRoute(rt, { query: { since: '24h' }, actor: { kind: 'anonymous', id: 'anon' } });
    check('route 403 for anonymous', rr.status === 403, String(rr.status));
    check('route does not write last-run', !fs.existsSync(lastFile));

    // push, with a stubbed notifier that catches the emitted event
    const sent = [];
    const mkCtx = modules => ({ state: { dir: path.join(tmp, 'push-state'), append() {} }, settings: {}, config: { modules }, emit: async (ev, pl) => { sent.push([ev, pl]); } });
    const run2 = async (args, ctx) => {
      const out = []; const log = console.log; console.log = s => out.push(String(s));
      try { return { res: await mod.commands.digest(args, ctx), out: out.join('\n') }; } finally { console.log = log; }
    };
    let x = await run2(['--since', '24h', '--push'], mkCtx({ digest: true, ntfy: true }));
    check('push: emits digest.ready with the text', x.res.code === 0 && sent.length === 1 && sent[0][0] === 'digest.ready' && /^Digest since/.test(sent[0][1].text), JSON.stringify(sent[0]).slice(0, 80));
    sent.length = 0;
    x = await run2(['--since', '24h', '--push'], mkCtx({ digest: true, notifications: true }));
    check('push: notifications alone also counts', sent.length === 1);
    sent.length = 0;
    x = await run2(['--since', '24h', '--push'], mkCtx({ digest: true }));
    check('push: skipped when both notifiers are off', sent.length === 0 && /push skipped/.test(x.out) && x.res.code === 0);
    const bad = mkCtx({ ntfy: true }); bad.emit = async () => { throw new Error('boom'); };
    x = await run2(['--since', '24h', '--push'], bad);
    check('push: a failing notifier does not crash the digest', x.res.code === 0 && /push failed/.test(x.out));
    sent.length = 0;
    await run2(['--since', '24h'], mkCtx({ digest: true, ntfy: true }));
    check('no --push, no event', sent.length === 0);
    // ---- inside a running task (agent surface): --json works, read-only
    {
      const lastF = path.join(STATE, 'm', 'digest', 'last-run.json');
      fs.rmSync(lastF, { force: true });
      seed([{ ts: iso(2 * H), type: 'task_start', task_id: 'in1' }]);
      process.env.HARNESS_TASK_ID = 't-agent';
      try {
        const ra = await run(reg, ['--since', '24h', '--json']);
        check('in a task: --json prints the digest', ra.code === 0 && JSON.parse(ra.out).counts.tasks_started === 1, ra.out.slice(0, 80));
        check('in a task: last-run mark not moved', !fs.existsSync(lastF));
        const rp = await run(reg, ['--push']);
        check('in a task: --push refused with exit 2', rp.code === 2 || /task/.test(rp.err), rp.err + ' ' + rp.code);
      } finally { delete process.env.HARNESS_TASK_ID; }
    }
  } catch (e) { check('no exception', false, e.stack); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const n = results.filter(Boolean).length;
  console.log(`\nresult: ${n}/${results.length}`);
  process.exit(n === results.length ? 0 : 1);
})();
