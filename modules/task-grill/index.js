'use strict';
// task-grill: "grill me before you start". A vague request is held and the owner is asked up to
// 3 question-cards (what done looks like, what is out of scope, what not to touch). The answers
// are appended to the prompt as an "Owner answers" block, then the task runs. Off by default.
// See README.md and DECISIONS.md.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const G = require('./grill');

const BIN = path.join(__dirname, '..', '..', 'bin', 'taskmote.js');
const now = () => {
  const v = process.env.HARNESS_NOW;
  if (v) { const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v); if (Number.isFinite(n)) return n; }
  return Date.now();
};

// ---- holds: one small JSON file each under state/m/task-grill/holds/
const holdsDir = ctx => { const d = path.join(ctx.state.dir, 'holds'); fs.mkdirSync(d, { recursive: true }); return d; };
const holdFile = (ctx, id) => path.join(holdsDir(ctx), id + '.json');
function saveHold(ctx, h) {
  const f = holdFile(ctx, h.id), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(h), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
function loadHolds(ctx) {
  const out = [];
  for (const n of fs.readdirSync(holdsDir(ctx))) {
    if (!/^g-[0-9a-f]{12}\.json$/.test(n)) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(holdsDir(ctx), n), 'utf8'))); } catch { /* half-written: next tick */ }
  }
  return out.sort((a, b) => a.created_at - b.created_at);
}

// ---- talking to question-cards through its public CLI verb (`taskmote ask ...`)
function cli(args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.HARNESS_TASK_ID;
    execFile(process.execPath, [BIN, 'ask', ...args], { env, timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().split('\n')[0]));
      resolve(String(stdout).trim());
    });
  });
}
const realIo = ctx => ({
  now,
  ask: async (text, options) => JSON.parse(await cli([text, ...options, '--free'])).question_id,
  get: async qid => { try { return JSON.parse(await cli(['get', qid])); } catch { return null; } },
  cancel: qid => cli(['cancel', qid]),
  start: async (prompt, hold) => (await ctx.tasks.start(hold.bot, prompt, hold.workdir ? { workdir: hold.workdir } : {})).id,
  journal: rec => ctx.state.append(rec),
  save: h => saveHold(ctx, h),
  drop: h => { try { fs.unlinkSync(holdFile(ctx, h.id)); } catch { /* already gone */ } },
});

const busy = new Set(); // hold ids being stepped in this process: no double step, no double card
async function drive(ctx, hold, io = realIo(ctx)) {
  if (busy.has(hold.id)) return 'waiting';
  busy.add(hold.id);
  try { return await G.step(hold, io, ctx.settings); } finally { busy.delete(hold.id); }
}

function intake(ctx, request, o = {}) {
  const hold = G.newHold('g-' + crypto.randomBytes(6).toString('hex'), request, { mode: ctx.settings.mode, now: now(), ...o });
  if (!hold.request) return { error: 'request is empty' };
  saveHold(ctx, hold);
  return { hold };
}

// ---- the pending-hold tick: a job in the server, so a held task starts even with no phone open
async function tick(ctx) {
  for (const h of loadHolds(ctx)) {
    try { await drive(ctx, h); } catch (e) { process.stderr.write(`task-grill: hold ${h.id}: ${e.message}\n`); }
  }
}

// ---- routes / command
async function postSubmit(ctx) {
  const b = ctx.body || {};
  if (typeof b.request !== 'string' || !b.request.trim() || b.request.length > 20000) return { status: 400, json: { error: 'request must be a non-empty string (max 20000 chars)' } };
  const r = intake(ctx, b.request, { bot: typeof b.bot === 'string' ? b.bot : undefined, workdir: typeof b.workdir === 'string' ? b.workdir : undefined, noGrill: b.no_grill === true });
  if (r.error) return { status: 400, json: { error: r.error } };
  let state;
  try { state = await drive(ctx, r.hold); } catch (e) { return { status: 502, json: { error: 'could not ask the owner: ' + e.message, grill_id: r.hold.id } }; }
  return { status: 201, json: { grill_id: r.hold.id, held: state === 'waiting' } };
}
const listHolds = ctx => ({ status: 200, json: { holds: loadHolds(ctx).map(h => ({ grill_id: h.id, stage: h.stage + 1, asked: h.asked, answered: h.answered })) } });

const USAGE = 'usage: taskmote grill "<request>" [--no-grill] | grill list | grill check "<request>" [--json]   (a request starting with ! is not grilled)';
async function command(args, ctx) {
  const a = (Array.isArray(args) ? args : []).map(String);
  if (a[0] === 'list') {
    for (const h of loadHolds(ctx)) console.log(`${h.id}: question ${h.stage + 1} of 3 (${h.answered} answered)`);
    return { handled: true, code: 0 };
  }
  if (a[0] === 'check') {
    const json = a.includes('--json');
    const req = a.slice(1).filter(x => x !== '--json').join(' ').trim();
    if (!req) { console.error('usage: taskmote grill check "<request>" [--json]'); return { handled: true, code: 2 }; }
    const r = G.check(req); // read only: no hold, no card, no server needed
    console.log(json ? JSON.stringify(r) : (r.vague ? `vague: ${r.reasons.join('; ')}\nif unsure, ask the owner: ${r.questions.join(' | ')}` : 'clear enough'));
    return { handled: true, code: 0 };
  }
  const noGrill = a.includes('--no-grill');
  const request = a.filter(x => x !== '--no-grill').join(' ').trim();
  if (!request) { console.error(USAGE); return { handled: true, code: 2 }; }
  const info = require('../../lib/server').readInfo();
  if (!info || !require('../../lib/journal').alive(info.pid)) { console.error('task-grill needs the server running (taskmote serve): it asks the cards and starts the task.'); return { handled: true, code: 2 }; }
  const r = intake(ctx, request, { noGrill });
  if (r.error) { console.error(r.error); return { handled: true, code: 2 }; }
  console.log(r.hold.grill ? `held ${r.hold.id}: the owner will be asked up to 3 questions, then the task starts` : `queued ${r.hold.id}: not grilled, the task starts in a few seconds`);
  return { handled: true, code: 0 };
}

module.exports = {
  contract: 2,
  name: 'task-grill',
  description: 'Asks the owner up to 3 question-cards before a vague task starts. Off by default.',
  runsOn: 'main',
  priority: 60,
  dependsOn: ['question-cards'],
  commands: { grill: command },
  routes: [
    { method: 'POST', path: '/submit', handler: postSubmit, description: 'submit a task: body {request, bot?, workdir?, no_grill?}; a vague one is held for questions' },
    { method: 'GET', path: '/holds', handler: listHolds, description: 'tasks waiting for answers' },
  ],
  jobs: [{ id: 'holds', every: 5, run: tick, description: 'ask the next card, start held tasks' }],
  statusLines: (J, ctx) => { try { const n = loadHolds(ctx).length; return n ? [`task-grill: ${n} task${n === 1 ? '' : 's'} waiting for answers`] : []; } catch { return []; } },
  settings: {
    mode: { type: 'string', default: 'vague', enum: ['vague', 'always', 'off'], description: 'vague = ask only for underspecified requests, always, or off' },
    wait_minutes: { type: 'number', default: 30, min: 1, max: 1440, description: 'minutes to wait for an answer before the task runs as is' },
  },
  api: { check: G.check, shouldGrill: G.shouldGrill, looksVague: G.looksVague, parse: G.parse, suggestions: G.suggestions, finalPrompt: G.finalPrompt },
};
