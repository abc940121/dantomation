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
const lastReply = taskId => {
  const recs = J.readAll().records;
  for (let i = recs.length - 1; i >= 0; i--) if (recs[i].type === 'reply' && recs[i].task_id === taskId) return recs[i].text;
  return '';
};

// Journal, list and emit trips. enforced: true when beforeReply masked or withheld them (task.end then
// sees only the cleaned reply, so those are recorded at the hook). Returns the emit promise.
function record(ctx, task_id, trips, enforced) {
  const { state, emit, settings } = ctx;
  const list = load(state.dir);
  for (const t of trips) {
    const rec = state.append({ type: 'tripwire', task_id, rule: t.rule, snippet: t.snippet, mode: settings.mode, enforced });
    list.push({ id: rec.id, ts: rec.ts, task_id, rule: t.rule, snippet: t.snippet, mode: settings.mode, enforced });
  }
  save(state.dir, list.slice(-Math.max(1, settings.retention)));
  if (typeof emit !== 'function') return Promise.resolve();
  try { return Promise.resolve(emit('tripwires.tripped', { task_id, rules: trips.map(t => t.rule), mode: settings.mode, enforced })).catch(() => { /* events never fail the check */ }); }
  catch { return Promise.resolve(); }
}

async function onTaskEnd({ task_id, code }, ctx) {
  try {
    if (!task_id) return;
    const trips = scan(lastReply(task_id), opts(ctx.settings, typeof code === 'number' ? code : null));
    if (!trips.length) return;
    await record(ctx, task_id, trips, false);
  } catch (e) { try { process.stderr.write(`tripwires: check failed: ${String(e && e.message).slice(0, 120)}\n`); } catch { /* nothing more to do */ } }
}

// v6 hook: beforeReply(reply, ctx). flag (default) leaves the reply alone, redact masks secrets,
// home paths and private IPs, block withholds the reply when a text rule trips. The reason names
// rule ids only, never the matched text. Errors propagate: manifest failMode "closed" blocks them.
// What is masked or withheld is recorded here (enforced: true), since task.end only sees the result.
// success_claim needs the exit code, which core does not pass to beforeReply: it stays a task.end
// (flag) check in every mode until a v7 seam hands the code over.
const MASKED = new Set(['secrets', 'paths', 'private_ips']);
function beforeReply(reply, ctx) {
  const s = (ctx && ctx.settings) || {};
  if (s.mode !== 'redact' && s.mode !== 'block') return undefined;
  if (typeof reply !== 'string' || !reply) return undefined;
  const taskId = ctx && ctx.task_id ? String(ctx.task_id) : '';
  const note = trips => { if (trips.length && ctx.state) { try { record(ctx, taskId, trips, true); } catch { /* the reply decision stands */ } } };
  if (s.mode === 'redact') {
    const out = redact(reply, ruleFlags(s));
    if (out !== reply) note(scan(reply, opts(s, null)).filter(t => MASKED.has(t.rule)));
    return out;
  }
  const trips = scan(reply, opts(s, null));
  if (!trips.length) return undefined;
  note(trips);
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
