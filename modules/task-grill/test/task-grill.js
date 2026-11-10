#!/usr/bin/env node
'use strict';
// task-grill: off by default, needs question-cards, the vague check, the hold state machine with a
// fake clock and fake question store, bypasses, modes, the journal line, and one real round trip
// through question-cards' CLI. Temp state dir; no network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-grill-'));
const STATE = path.join(tmp, 'state');
const CONFIG = path.join(tmp, 'config.json');
process.env.HARNESS_STATE_DIR = STATE; // before the journal is required
process.env.HARNESS_CONFIG = CONFIG;
for (const k of ['HARNESS_TASK_ID', 'HARNESS_TASK_DIR']) delete process.env[k];
const T0 = Date.parse('2030-01-01T00:00:00Z');
process.env.HARNESS_NOW = String(T0);
const ROOT = path.resolve(__dirname, '..', '..', '..');
const M = require(path.join(ROOT, 'lib', 'modules'));
const J = require(path.join(ROOT, 'lib', 'journal'));
const G = require('../grill');
const mod = require('../index');

const results = [];
const check = (label, ok, info) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${info ? ': ' + info : ''}`); };
const OWNER = { kind: 'owner', id: '' };
const VAGUE = 'make the app better';
const CLEAR = 'Add a --json flag to lib/report.js so that the output should parse; test it with node test/report.js';

// fake question store + fake clock + fake task start
function fake(settings = { wait_minutes: 30 }) {
  let t = T0, n = 0;
  const qs = new Map(), started = [], journal = [], holds = new Map();
  const io = {
    now: () => t,
    ask: async (text, options) => { const id = 'q' + (++n); qs.set(id, { text, options, state: 'pending', answer: null }); return id; },
    get: async id => qs.get(id) || null,
    cancel: async id => { qs.get(id).state = 'cancelled'; },
    start: async prompt => { started.push(prompt); return 't-' + started.length; },
    journal: r => journal.push(r),
    save: h => holds.set(h.id, h), drop: h => holds.delete(h.id),
  };
  const answer = (id, option, free_text) => { const q = qs.get(id); q.state = 'answered'; q.answer = { option: option || null, free_text: free_text || null }; };
  return { io, qs, started, journal, holds, settings, answer, advance: ms => { t += ms; } };
}
const hold = (raw, o) => G.newHold('g-0123456789ab', raw, { now: T0, ...o });

(async () => {
  // ---- off by default, and what a missing question-cards says
  const off = M.registry({ modules: {} });
  check('off by default: nothing registered', off.errors.length === 0 && !off.listRoutes().some(r => r.module === 'task-grill') && !off.listCommands().includes('grill'));
  const lone = M.registry({ modules: { 'task-grill': true } });
  check('missing question-cards: clear message', lone.errors.length === 1 && /question-cards/.test(lone.errors[0]), lone.errors.join(' | '));
  const cfg = { modules: { 'question-cards': true, 'task-grill': true }, task_grill: { wait_minutes: 10 } };
  const reg = M.registry(cfg, { tasks: { start: async () => ({ id: 't-fake' }) } });
  check('on with question-cards: loads clean', reg.errors.length === 0, reg.errors.join(' | '));
  check('settings merge', JSON.stringify(reg.settingsFor('task-grill')) === '{"mode":"vague","wait_minutes":10}', JSON.stringify(reg.settingsFor('task-grill')));
  const bad = M.registry({ modules: { 'question-cards': true, 'task-grill': true }, task_grill: { mode: 'sometimes' } });
  check('bad mode is a load error', bad.errors.length === 1, bad.errors.join('|'));
  check('route, command and job listed', reg.listRoutes().filter(r => r.module === 'task-grill').length === 2 && reg.listCommands().includes('grill') && reg.listJobs().some(j => j.module === 'task-grill'));

  // ---- heuristic
  check('clear request is not vague', !G.looksVague(CLEAR));
  check('short request is vague', G.looksVague(VAGUE));
  check('a path makes it not vague', !G.looksVague('improve lib/server.js'));
  check('acceptance words make it not vague', !G.looksVague('improve the login, it should reject empty passwords'));
  const sg = [0, 1, 2].map(i => G.suggestions(i, VAGUE));
  check('2 to 4 suggestions plus Skip', sg.every(s => s.length >= 3 && s.length <= 5 && s[s.length - 1] === 'Skip'), JSON.stringify(sg[0]));

  // ---- clear request is not grilled
  {
    const f = fake(); const h = hold(CLEAR);
    const r = await G.step(h, f.io, f.settings);
    check('clear request runs at once, no card', r === 'started' && f.qs.size === 0 && f.started[0] === CLEAR && f.journal.length === 0, String(r));
  }
  // ---- vague request is grilled: one card at a time
  {
    const f = fake(); const h = hold(VAGUE);
    check('vague request is held', h.grill === true);
    let r = await G.step(h, f.io, f.settings);
    check('vague: first card asked, task held', r === 'waiting' && f.qs.size === 1 && f.started.length === 0 && /What does done look like\?/.test(f.qs.get('q1').text), f.qs.get('q1') && f.qs.get('q1').text);
    r = await G.step(h, f.io, f.settings);
    check('still waiting: no second card yet', r === 'waiting' && f.qs.size === 1);
    f.answer('q1', null, 'the settings page saves');
    r = await G.step(h, f.io, f.settings);
    check('second card only after the first is answered', r === 'waiting' && f.qs.size === 2 && /What is out of scope\?/.test(f.qs.get('q2').text));
    f.answer('q2', f.qs.get('q2').options[0]);
    await G.step(h, f.io, f.settings);
    check('third card', f.qs.size === 3 && /Anything it must not touch\?/.test(f.qs.get('q3').text));
    f.answer('q3', 'Skip');
    r = await G.step(h, f.io, f.settings);
    const p = f.started[0] || '';
    check('answers appended as an Owner answers block', r === 'started' && p.startsWith(VAGUE + '\n\nOwner answers:\n') && p.includes('- Done looks like: the settings page saves') && p.includes('- Out of scope: ' + f.qs.get('q2').options[0]) && !p.includes('Must not touch'), JSON.stringify(p));
    check('journal line has counts only', JSON.stringify(f.journal) === JSON.stringify([{ type: 'task_grill', kind: 'task-grill', task_id: 't-1', asked: 3, answered: 2, skipped: 1, timed_out: false }]), JSON.stringify(f.journal));
    check('hold removed once started', f.holds.size === 0);
  }
  // ---- skip on the first card
  {
    const f = fake(); const h = hold(VAGUE);
    await G.step(h, f.io, f.settings);
    f.answer('q1', 'Skip');
    const r = await G.step(h, f.io, f.settings);
    check('skip on first card runs as is', r === 'started' && f.started[0] === VAGUE && f.qs.size === 1);
    check('skip journal', f.journal[0].asked === 1 && f.journal[0].skipped === 1 && f.journal[0].answered === 0 && f.journal[0].timed_out === false, JSON.stringify(f.journal[0]));
  }
  // ---- timeout runs as is, never denied
  {
    const f = fake(); const h = hold(VAGUE);
    await G.step(h, f.io, f.settings);
    f.advance(29 * 60000);
    check('before wait_minutes: still held', (await G.step(h, f.io, f.settings)) === 'waiting' && f.started.length === 0);
    f.advance(2 * 60000);
    const r = await G.step(h, f.io, f.settings);
    check('after wait_minutes: runs as is, not denied', r === 'started' && f.started[0] === VAGUE && f.qs.get('q1').state === 'cancelled', String(r));
    check('timeout journal note', f.journal[0].timed_out === true && f.journal[0].asked === 1 && f.journal[0].answered === 0, JSON.stringify(f.journal[0]));
  }
  {
    const f = fake(); const h = hold(VAGUE);
    await G.step(h, f.io, f.settings); f.answer('q1', null, 'it works');
    await G.step(h, f.io, f.settings); f.advance(31 * 60000);
    await G.step(h, f.io, f.settings);
    check('timeout on a later card keeps earlier answers', f.started[0] === VAGUE + '\n\nOwner answers:\n- Done looks like: it works' && f.journal[0].timed_out === true && f.journal[0].answered === 1, JSON.stringify(f.started[0]));
  }
  {
    const f = fake(); const h = hold(VAGUE);
    await G.step(h, f.io, f.settings); f.qs.get('q1').state = 'expired';
    const r = await G.step(h, f.io, f.settings);
    check('an expired card also runs as is', r === 'started' && f.started[0] === VAGUE && f.journal[0].timed_out === true);
  }
  // ---- bypass and modes
  check('! bypasses and is stripped', (() => { const h = hold('!' + VAGUE); return h.grill === false && h.request === VAGUE; })());
  check('--no-grill bypasses', hold(VAGUE, { noGrill: true }).grill === false);
  {
    const f = fake(); const h = hold('! ' + VAGUE);
    const r = await G.step(h, f.io, f.settings);
    check('bypassed request runs at once, no journal line', r === 'started' && f.qs.size === 0 && f.started[0] === VAGUE && f.journal.length === 0, JSON.stringify(f.started));
  }
  check('mode always grills a clear request', hold(CLEAR, { mode: 'always' }).grill === true);
  check('mode off never grills', hold(VAGUE, { mode: 'off' }).grill === false);
  check('mode vague (default) grills only vague', hold(VAGUE).grill === true && hold(CLEAR).grill === false);
  check('"!" beats mode always', hold('!' + CLEAR, { mode: 'always' }).grill === false);

  // ---- real round trip: route -> question-cards (real CLI) -> answer -> job tick -> task start
  fs.writeFileSync(CONFIG, JSON.stringify({ modules: { 'question-cards': true, 'task-grill': true } }));
  const startedReal = [];
  const ctx = {
    settings: { mode: 'vague', wait_minutes: 30 },
    state: {
      get dir() { const d = path.join(STATE, 'm', 'task-grill'); fs.mkdirSync(d, { recursive: true }); return d; },
      append: r => J.append({ ...r, module: 'task-grill' }),
    },
    tasks: { start: async (bot, prompt) => { startedReal.push(prompt); return { id: 't-real' }; } },
  };
  const taskmote = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'taskmote.js'), ...a], { env: process.env, encoding: 'utf8' });
  const route = mod.routes.find(r => r.path === '/submit');
  const holdsRoute = mod.routes.find(r => r.path === '/holds');
  const job = mod.jobs[0];
  const byp = await route.handler({ ...ctx, body: { request: '!' + VAGUE }, actor: OWNER });
  check('route: bypass starts at once', byp.json && byp.json.held === false && startedReal[0] === VAGUE, JSON.stringify(byp));
  const sub = await route.handler({ ...ctx, body: { request: VAGUE }, actor: OWNER });
  check('route: vague request is held', sub.json && sub.json.held === true && startedReal.length === 1, JSON.stringify(sub));
  const qid = () => (/(q-[0-9a-f]+)/.exec(taskmote('ask', 'list').stdout) || [])[1];
  const q1 = qid();
  check('a real question card is pending', !!q1 && /What does done look like\?/.test(taskmote('ask', 'list').stdout), taskmote('ask', 'list').stdout.slice(0, 200));
  const reply = taskmote('ask', 'answer', q1, '1');
  check('owner answers the card', reply.status === 0, reply.stderr || reply.stdout);
  await job.run(ctx);
  const q2 = qid();
  check('job tick asks the next card', !!q2 && q2 !== q1 && /What is out of scope\?/.test(taskmote('ask', 'list').stdout));
  taskmote('ask', 'answer', q2, '2');
  await job.run(ctx);
  const q3 = qid();
  taskmote('ask', 'answer', q3, '1', 'leave the build files alone');
  await job.run(ctx);
  const rp = startedReal[1] || '';
  check('real: task started with the Owner answers block', rp.startsWith(VAGUE + '\n\nOwner answers:\n- Done looks like: ') && rp.includes('- Out of scope: '), JSON.stringify(rp));
  const rec = J.readAll().records.filter(r => r.kind === 'task-grill');
  check('real: journal line written', rec.length === 1 && rec[0].task_id === 't-real' && rec[0].asked === 3 && rec[0].timed_out === false, JSON.stringify(rec));
  const left = await holdsRoute.handler(ctx);
  check('real: no holds left', left.json && left.json.holds.length === 0, JSON.stringify(left));

  // ---- agent surface: grill check "<request>" --json (pure, no cards, no hold)
  {
    const cap = async args => { const o = [], e = []; const l = console.log, er = console.error; console.log = s => o.push(String(s)); console.error = s => e.push(String(s)); let r; try { r = await mod.commands.grill(args, {}); } finally { console.log = l; console.error = er; } return { out: o.join('\n'), err: e.join('\n'), code: r && r.code }; };
    const cardsBefore = fs.existsSync(path.join(STATE, 'm', 'question-cards')) ? fs.readdirSync(path.join(STATE, 'm', 'question-cards')).length : 0;
    const cv = G.check(VAGUE);
    check('check: vague request -> vague true, reasons, 3 questions', cv.vague === true && cv.reasons.length >= 1 && cv.questions.length === 3, JSON.stringify(cv));
    const cc = G.check(CLEAR);
    check('check: clear request -> not vague, no questions', cc.vague === false && cc.questions.length === 0);
    check('check: leading ! bypasses', G.check('!' + VAGUE).vague === false && G.check('   ').vague === false);
    process.env.HARNESS_TASK_ID = 't-agent';
    try {
      const rv = await cap(['check', VAGUE, '--json']);
      const jv = JSON.parse(rv.out);
      check('cli check --json (in a task): {vague, reasons, questions}', rv.code === 0 && jv.vague === true && Array.isArray(jv.reasons) && jv.questions.length === 3, rv.out.slice(0, 100));
      const rc = await cap(['check', CLEAR, '--json']);
      check('cli check --json: clear request is not vague', JSON.parse(rc.out).vague === false);
      const rt = await cap(['check', VAGUE]);
      check('cli check text mode prints a readable line', rt.code === 0 && /vague/i.test(rt.out));
    } finally { delete process.env.HARNESS_TASK_ID; }
    const cardsAfter = fs.existsSync(path.join(STATE, 'm', 'question-cards')) ? fs.readdirSync(path.join(STATE, 'm', 'question-cards')).length : 0;
    check('check made no cards and no hold', cardsAfter === cardsBefore && !fs.existsSync(path.join(STATE, 'm', 'task-grill', 'holds.json')));
  }

  const ok = results.filter(Boolean).length;
  console.log(`result: ${ok}/${results.length}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp */ }
  process.exit(ok === results.length ? 0 : 1);
})().catch(e => { console.log('FAIL crashed: ' + ((e && e.stack) || e)); process.exit(1); });
