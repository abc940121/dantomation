'use strict';
// tripwires: output guardrails. When a task ends, the final reply (the journal `reply` record core
// writes just before task.end) and the exit code go through built-in rules. A trip is journaled as
// a `tripwire` record (rule id + redacted snippet only), emitted as tripwires.tripped, listed in
// status and kept (capped) in state for the owner routes. The v6 beforeReply hook can also mask or
// block the reply before delivery when mode is redact or block (default flag: report only).
const fs = require('fs');
const path = require('path');
const J = require('../../lib/journal');
const { RULES, scan, redact } = require('./rules');

const FILE = 'trips.json';
const ruleFlags = s => ({ secrets: s.rule_secrets, paths: s.rule_paths, private_ips: s.rule_private_ips, banned: s.rule_banned, oversize: s.rule_oversize, success_claim: s.rule_success_claim });
const opts = (s, code) => ({ rules: ruleFlags(s), bannedPhrases: s.banned_phrases || [], maxChars: s.max_reply_chars, code });

function load(dir) { try { const a = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function save(dir, list) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, FILE), tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list)); fs.renameSync(tmp, f);
}
// Turn scoping: a resumed task reuses its task id, so "a success_claim record exists" is not enough to
// say this turn's hook recorded it. core appends engine_exit after the reply hooks and before task.end,
// so at hook time the number of engine_exit records is this turn's index N, and at task.end it is N+1.
// The hook stamps its record with turn N; task.end skips only a hook record with turn >= count - 1.
const exitCount = (recs, taskId) => recs.filter(r => r.type === 'engine_exit' && r.task_id === taskId).length;
// The turn is identified by its latest engine_start record: only a claim journaled after it counts (a crash before
// engine_exit leaves the old turn's claim before the new engine_start). Without any engine_start, the exit count above is the fallback.
// This turn's window in the records: after its engine_start (core passes that record's id as turnStart in the task.end
// payload) and before the task's next engine_start. Without turnStart, the latest engine_start is the boundary.
// -> { recs, lo, hi } (lo = -1 with no engine_start: the whole journal)
function turnWindow(taskId, turnStart) {
  const recs = J.readAll().records;
  let lo = -1;
  if (turnStart) lo = recs.findIndex(r => r.id === turnStart && r.type === 'engine_start');
  if (lo < 0) for (let i = recs.length - 1; i >= 0; i--) if (recs[i].type === 'engine_start' && recs[i].task_id === taskId) { lo = i; break; }
  let hi = recs.length;
  for (let i = lo + 1; i < recs.length; i++) if (recs[i].type === 'engine_start' && recs[i].task_id === taskId) { hi = i; break; }
  return { recs, lo, hi };
}
const claimedAtHook = (taskId, turnStart) => {
  const { recs, lo, hi } = turnWindow(taskId, turnStart);
  if (lo >= 0) return recs.some((r, i) => i > lo && i < hi && r.type === 'tripwire' && r.task_id === taskId && r.rule === 'success_claim');
  const cur = Math.max(0, exitCount(recs, taskId) - 1);
  return recs.some(r => r.type === 'tripwire' && r.task_id === taskId && r.rule === 'success_claim' && typeof r.turn === 'number' && r.turn >= cur);
};
const lastReply = (taskId, turnStart) => {
  const { recs, lo, hi } = turnWindow(taskId, turnStart); // a turn without a reply has nothing to scan
  for (let i = hi - 1; i > lo; i--) if (recs[i].task_id === taskId && recs[i].type === 'reply') return recs[i].text;
  return '';
};

// Journal, list and emit trips. enforced: true when beforeReply masked or withheld them (task.end then
// sees only the cleaned reply, so those are recorded at the hook). Returns the emit promise.
function record(ctx, task_id, trips, enforced, turn) {
  const { state, emit, settings } = ctx;
  const list = load(state.dir);
  for (const t of trips) {
    const rec = state.append({ type: 'tripwire', task_id, rule: t.rule, snippet: t.snippet, mode: settings.mode, enforced, ...(turn === undefined ? {} : { turn }) });
    list.push({ id: rec.id, ts: rec.ts, task_id, rule: t.rule, snippet: t.snippet, mode: settings.mode, enforced });
  }
  save(state.dir, list.slice(-Math.max(1, settings.retention)));
  if (typeof emit !== 'function') return Promise.resolve();
  try { return Promise.resolve(emit('tripwires.tripped', { task_id, rules: trips.map(t => t.rule), mode: settings.mode, enforced })).catch(() => { /* events never fail the check */ }); }
  catch { return Promise.resolve(); }
}

async function onTaskEnd({ task_id, code, turn_start }, ctx) {
  try {
    if (!task_id) return;
    let trips = scan(lastReply(task_id, turn_start), opts(ctx.settings, typeof code === 'number' ? code : null));
    if (trips.some(t => t.rule === 'success_claim') && claimedAtHook(task_id, turn_start)) trips = trips.filter(t => t.rule !== 'success_claim');
    if (!trips.length) return;
    await record(ctx, task_id, trips, false);
  } catch (e) { try { process.stderr.write(`tripwires: check failed: ${String(e && e.message).slice(0, 120)}\n`); } catch { /* nothing more to do */ } }
}

// v6 hook: beforeReply(reply, ctx). flag (default) leaves the reply alone, redact masks secrets,
// home paths and private IPs, block withholds the reply when a text rule trips. The reason names
// rule ids only, never the matched text. Errors propagate: manifest failMode "closed" blocks them.
// What is masked or withheld is recorded here (enforced: true), since task.end only sees the result.
// success_claim needs the engine exit code (ctx.code, a number): when it is nonzero the rule runs here in
// every mode (flag records it, block withholds the reply) and task.end then skips the rule for that task;
// with no numeric code it stays a task.end check.
const MASKED = new Set(['secrets', 'paths', 'private_ips']);
function beforeReply(reply, ctx) {
  const s = (ctx && ctx.settings) || {};
  if (typeof reply !== 'string' || !reply) return undefined;
  const taskId = ctx && ctx.task_id ? String(ctx.task_id) : '';
  const code = ctx && typeof ctx.code === 'number' ? ctx.code : null;
  // Hook-time records never hold reply text: a later module may still block the reply or fail closed,
  // and the withheld text must not sit in the journal or the stored list. Markers only.
  const MARK = { secrets: '[secret]', paths: '[home-path]', private_ips: '[private-ip]' };
  const textFree = t => ({ rule: t.rule, snippet: t.rule === 'success_claim' ? `success claim at reply hook (exit ${code})` : (MARK[t.rule] || `${t.rule} at reply hook`) });
  const note = (trips, enforced = true) => {
    if (trips.length && ctx.state) {
      try { record(ctx, taskId, trips.map(textFree), enforced, exitCount(J.readAll().records, taskId)); } catch { /* the reply decision stands */ }
    }
  };
  const claims = () => (code !== null && code !== 0 ? scan(reply, opts(s, code)).filter(t => t.rule === 'success_claim') : []);
  if (s.mode !== 'redact' && s.mode !== 'block') { note(claims(), false); return undefined; } // flag: report only
  if (s.mode === 'redact') {
    const out = redact(reply, ruleFlags(s));
    if (out !== reply) note(scan(reply, opts(s, null)).filter(t => MASKED.has(t.rule)));
    note(claims(), false); // a claim is not masked, so it is a flag
    return out;
  }
  const trips = scan(reply, opts(s, code));
  if (!trips.length) return undefined;
  note(trips); // a withheld reply leaves no text behind
  return { block: true, reason: 'tripwire rule(s): ' + [...new Set(trips.map(t => t.rule))].join(', ') };
}

// Older shape kept on the api: beforeReply(ctx, reply) -> reply (redacts in redact mode).
function apiBeforeReply(ctx, reply) {
  const s = (ctx && ctx.settings) || {};
  if (s.mode !== 'redact') return reply;
  return redact(reply, ruleFlags(s));
}

function statusLines(Jn) {
  try {
    const recs = Jn.readAll().records.filter(r => r.type === 'tripwire');
    if (!recs.length) return ['tripwires: none tripped'];
    const last = recs[recs.length - 1];
    return [`tripwires: ${recs.length} tripped, last ${last.rule} (${last.task_id || 'no task'}): ${last.snippet}`];
  } catch { return ['tripwires: status unavailable']; }
}

const routes = [
  { method: 'GET', path: '/trips', access: 'owner', description: 'recent tripwire trips, newest first (?limit=N, ?rule=id)',
    handler: ({ query, state }) => {
      const q = query || {};
      const limit = Math.max(1, Math.min(500, parseInt(q.limit, 10) || 50));
      let list = load(state.dir).slice().reverse();
      if (q.rule) list = list.filter(t => t.rule === q.rule);
      return { status: 200, json: { trips: list.slice(0, limit), total: list.length, rules: RULES } };
    } },
  { method: 'DELETE', path: '/trips', access: 'owner', description: 'clear the stored trip list (journal records stay)',
    handler: ({ state }) => { const n = load(state.dir).length; save(state.dir, []); return { status: 200, json: { cleared: n } }; } },
];

module.exports = {
  contract: 2, // uses v6 beforeReply + failMode; core does not gate them by contract number
  failMode: 'closed',
  hookTimeoutMs: 1000,
  name: 'tripwires',
  description: 'Output guardrails: flags secrets, home paths, private IPs, banned phrases, oversized replies and success claims on a failed exit. Flags by default; can mask or block the reply before delivery (mode redact or block).',
  beforeReply,
  on: { 'task.end': onTaskEnd },
  statusLines,
  routes,
  settings: {
    mode: { type: 'string', enum: ['flag', 'redact', 'block'], default: 'flag', description: 'flag: report only. redact: mask secrets, paths and private IPs in the delivered reply. block: withhold a reply that trips a text rule' },
    rule_secrets: { type: 'boolean', default: true, description: 'API key shapes, private key headers, bearer tokens' },
    rule_paths: { type: 'boolean', default: true, description: 'absolute home paths (/home, /Users, drive Users folders)' },
    rule_private_ips: { type: 'boolean', default: true, description: 'private, link-local and CGNAT IPv4 addresses' },
    rule_banned: { type: 'boolean', default: true, description: 'phrases from banned_phrases' },
    rule_oversize: { type: 'boolean', default: true, description: 'reply longer than max_reply_chars' },
    rule_success_claim: { type: 'boolean', default: true, description: 'reply claims success while the task exit code is nonzero' },
    banned_phrases: { type: 'array', items: 'string', default: [], description: 'case-insensitive phrases that must not appear in a reply' },
    max_reply_chars: { type: 'integer', default: 3000, min: 100, max: 100000, description: 'oversize limit in characters (core clips replies at 4000)' },
    retention: { type: 'integer', default: 200, min: 1, max: 5000, description: 'most trips kept for the owner list (journal records are not capped)' },
  },
  api: { scan, redact, beforeReply: apiBeforeReply },
};
