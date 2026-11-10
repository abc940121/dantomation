'use strict';
// digest: a "while you were away" summary built from the journal. Off by default.
// Read-only on other modules' data; the only thing it writes is its own last-run file.
// See README.md.
const fs = require('fs');
const path = require('path');
const J = require('../../lib/journal');

const MAX_LINES = 10;
const UNIT_MS = { m: 60000, h: 3600000, d: 86400000 };
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '~' : s; };

// "12h", "2d", "30m" or an ISO date/time -> epoch ms, else null.
function parseSince(v, now) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const m = /^(\d{1,4})([mhd])$/.exec(s);
  if (m) { const n = Number(m[1]); return n > 0 ? now - n * UNIT_MS[m[2]] : null; }
  if (!/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

const lastRunFile = ctx => path.join(ctx.state.dir, 'last-run.json');
function readLastRun(ctx) {
  try { const t = Date.parse(JSON.parse(fs.readFileSync(lastRunFile(ctx), 'utf8')).at); return Number.isNaN(t) ? null : t; } catch { return null; }
}
function writeLastRun(ctx, now) {
  try { fs.mkdirSync(ctx.state.dir, { recursive: true }); fs.writeFileSync(lastRunFile(ctx), JSON.stringify({ at: new Date(now).toISOString() })); } catch { /* best effort */ }
}

// spend-count logs the running session spend (usd) per call to logs/spend.jsonl
// (HARNESS_LOG_DIR moves the folder). Window spend = per session, the highest value in
// the window minus the last value before it. Missing or unreadable file: null (skipped).
function readSpend(sinceMs, now) {
  const dir = process.env.HARNESS_LOG_DIR || path.join(path.resolve(__dirname, '..', '..'), 'logs');
  let raw;
  try { raw = fs.readFileSync(path.join(dir, 'spend.jsonl'), 'utf8'); } catch { return null; }
  const before = new Map(), top = new Map();
  for (const l of raw.split('\n')) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    const t = Date.parse(r && r.ts), usd = Number(r && r.usd);
    if (Number.isNaN(t) || !Number.isFinite(usd) || t > now) continue;
    const id = String(r.session_id || '');
    if (t < sinceMs) before.set(id, usd);
    else top.set(id, Math.max(top.get(id) || 0, usd));
  }
  let total = 0;
  for (const [id, v] of top) total += Math.max(0, v - (before.get(id) || 0));
  return Number(total.toFixed(2));
}

// Pure: records -> summary. Unknown or missing record kinds simply count as zero.
function summarize(records, sinceMs, now, spend) {
  const inWin = r => { const t = Date.parse(r && r.ts); return !Number.isNaN(t) && t >= sinceMs && t <= now; };
  const c = { tasks_started: 0, tasks_done: 0, tasks_failed: 0, tasks_stopped: 0, claims_flagged: 0, tripwires: 0, stalls: 0, overruns: 0, cards_answered: 0, cards_open: 0, questions_open: 0 };
  const fail = [], stall = [], over = [], claim = [], trip = [], open = [];

  // open cards and questions are "now" facts, so they fold the whole journal
  const cards = new Map(), qs = new Map();
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (r.type === 'card' && r.card_id && !cards.has(r.card_id)) cards.set(r.card_id, { ...r, open: true });
    else if (r.type === 'card_answer' && cards.has(r.card_id) && r.answer !== 'unclear') cards.get(r.card_id).open = false;
    else if (r.type === 'question' && r.question_id && !qs.has(r.question_id)) qs.set(r.question_id, { ...r, open: true });
    else if (['question_answer', 'question_expire', 'question_cancel'].includes(r.type) && qs.has(r.question_id)) qs.get(r.question_id).open = false;
  }
  const alive = x => x.open && !(x.expires_at && Date.parse(x.expires_at) <= now);
  for (const x of cards.values()) if (alive(x)) { c.cards_open++; open.push(`Approval waiting: ${clip(x.summary || x.tool || x.card_id, 80)} (card ${x.card_id})`); }
  for (const x of qs.values()) if (alive(x)) { c.questions_open++; open.push(`Question waiting: ${x.question_id}${x.task_id ? ' (task ' + x.task_id + ')' : ''}`); }

  for (const r of records) {
    if (!r || typeof r !== 'object' || !inWin(r)) continue;
    switch (r.type) {
      case 'task_start': c.tasks_started++; break;
      case 'task_done':
        c.tasks_done++;
        if (r.stopped) c.tasks_stopped++;
        else if (r.failed || r.aborted) { c.tasks_failed++; fail.push(`Task failed: ${r.task_id}${Number.isInteger(r.code) ? ' (exit ' + r.code + ')' : ''}${r.aborted ? ' (aborted)' : ''}`); }
        break;
      case 'queue_fail': c.tasks_failed++; fail.push(`Task never started: ${r.task_id}`); break;
      case 'claim_audit': if (r.unverified > 0) { c.claims_flagged++; claim.push(`Unverified claims: ${r.unverified} of ${r.checked} in task ${r.task_id}`); } break;
      case 'tripwire': c.tripwires++; trip.push(`Tripwire hit: ${clip(r.rule, 40)} in task ${r.task_id}`); break;
      case 'task_stalled': c.stalls++; stall.push(`Task stalled: ${r.task_id}${r.reason ? ' (' + clip(r.reason, 40) + ')' : ''}`); break;
      case 'trace_overrun': c.overruns++; over.push(`Overrun: ${r.task_id} took ${r.factor ? Number(r.factor).toFixed(1) + 'x' : 'longer than'} its estimate`); break;
      case 'card_answer': if (r.answer !== 'unclear') c.cards_answered++; break;
      default: break;
    }
  }
  const all = [...open, ...fail, ...stall, ...over, ...claim, ...trip];
  const notable = all.slice(0, MAX_LINES);
  if (all.length > MAX_LINES) notable.push(`...and ${all.length - MAX_LINES} more`);
  return { since: new Date(sinceMs).toISOString(), until: new Date(now).toISOString(), counts: c, spend_usd: typeof spend === 'number' ? spend : null, notable };
}

function render(s) {
  const c = s.counts;
  const lines = [`Digest since ${s.since.slice(0, 16).replace('T', ' ')} UTC`,
    `tasks: ${c.tasks_started} started, ${c.tasks_done} ended, ${c.tasks_failed} failed, ${c.tasks_stopped} stopped`,
    `cards: ${c.cards_answered} answered, ${c.cards_open} open; questions open: ${c.questions_open}`,
    `flags: ${c.claims_flagged} claim audits, ${c.tripwires} tripwires, ${c.stalls} stalls, ${c.overruns} overruns`];
  if (typeof s.spend_usd === 'number') lines.push(`spend: $${s.spend_usd.toFixed(2)}`);
  if (s.notable.length) lines.push('',...s.notable.map(l => '- ' + l));
  else lines.push('', 'Nothing needs you.');
  return lines.join('\n');
}

function build(ctx, sinceArg, now) {
  let sinceMs;
  if (sinceArg === undefined || sinceArg === null || sinceArg === '') {
    const hours = (ctx.settings && ctx.settings.default_hours) || 24;
    sinceMs = readLastRun(ctx) || now - hours * 3600000;
  } else {
    sinceMs = parseSince(sinceArg, now);
    if (sinceMs === null) return null;
  }
  let records = [];
  try { records = J.readAll().records; } catch { /* no journal: empty digest */ }
  return summarize(records, sinceMs, now, readSpend(sinceMs, now));
}

// Push goes out as the event digest.ready {text}. A notifier module (notifications, ntfy)
// that handles that event delivers it; this module opens no network connection itself.
async function push(ctx, text) {
  const mods = (ctx.config && ctx.config.modules) || {};
  if (!mods.notifications && !mods.ntfy) return 'push skipped: notifications and ntfy are both off';
  try { await ctx.emit('digest.ready', { text }); return 'push: sent to the notify path'; } catch { return 'push failed: the notify path raised an error'; }
}

async function digest(args, ctx) {
  const flags = { since: undefined, json: false, push: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') flags.json = true;
    else if (a === '--push') flags.push = true;
    else if (a === '--since' && i + 1 < args.length) flags.since = args[++i];
    else if (a.startsWith('--since=')) flags.since = a.slice(8);
    else { console.error(`digest: unknown option "${clip(a, 40)}"; usage: taskmote digest [--since <ISO|12h|2d>] [--json] [--push]`); return { handled: true, code: 2 }; }
  }
  const inTask = !!process.env.HARNESS_TASK_ID; // an agent peeks: it must not push or move the owner's "since last run" mark
  if (inTask && flags.push) { console.error('digest: --push is for the owner, not from inside a task'); return { handled: true, code: 2 }; }
  const now = Date.now();
  const s = build(ctx, flags.since, now);
  if (!s) { console.error('digest: bad --since; use an ISO date/time (2026-01-31T08:00:00Z) or a span like 30m, 12h, 2d'); return { handled: true, code: 2 }; }
  const text = render(s);
  console.log(flags.json ? JSON.stringify(s) : text);
  if (flags.push) { const note = await push(ctx, text); if (flags.json) console.error(note); else console.log(note); }
  if (!inTask) writeLastRun(ctx, now);
  return { handled: true, code: 0 };
}

module.exports = {
  contract: 2,
  name: 'digest',
  description: 'While-you-were-away summary of the journal; optional push through the notify path.',
  runsOn: 'main',
  priority: 90,
  emits: [],
  settings: { default_hours: { type: 'integer', default: 24, min: 1, max: 720, description: 'look-back when there is no last run and no --since' } },
  commands: { digest },
  routes: [{
    method: 'GET', path: '/digest', access: 'owner', description: 'summary as JSON (?since=<ISO|12h|2d>)',
    handler: ctx => {
      const q = (ctx.query && ctx.query.since) || undefined;
      const s = build(ctx, q, Date.now());
      return s ? { status: 200, json: s } : { status: 400, json: { error: 'bad since; use an ISO date/time or a span like 12h, 2d' } };
    },
  }],
  api: { parseSince, summarize, render },
};
