'use strict';
// corrections: remembers what the owner corrected, so it is not said a second time. A correction is
// saved the turn it is spoken (a cue-word heuristic, stored as an unconfirmed candidate) and is put
// back in front of the agent, with its why and date, only when a later request is about the same
// thing, inside a fixed byte budget. The agent can confirm it with `correction propose` (why + scope),
// or the owner can repeat it. A stored rule is a past statement, not a law: the block tells the agent
// to say why when it no longer fits. See README.md and DECISIONS.md.
const path = require('path');
const S = require('./store');

const inTask = () => !!process.env.HARNESS_TASK_ID;
const dirOf = ctx => ctx.state.dir;
const RULE_CLIP = 240, WHY_CLIP = 160;

// Agents may read (list / show / search) and propose; add, edit, delete and keep are the owner's.
const OWNER_CMD = /(taskmote|harness)(\.(js|cmd))?["']?\s+correction["']?\s+["']?(add|edit|delete|keep)\b/i;
const API_CMD = /\/m\/corrections(?![\w-])/i;
function beforeTool(ctx) {
  if (!inTask()) return null;
  const { tool, ti } = ctx;
  if (!/^(bash|shell|powershell|cmd)$/i.test(String(tool || ''))) return null;
  const cmd = String((ti && ti.command) || '');
  if (API_CMD.test(cmd)) return ['corrections', 'the corrections server API is for the owner only'];
  if (OWNER_CMD.test(cmd)) return ['corrections', 'stored corrections are changed by the owner; an agent may only propose one (correction propose)'];
  return null;
}

// ---- the block put in front of the agent
const dateOf = r => String(r.created || '').slice(0, 10);
function ruleLine(r, cfg) {
  const p = [`- [${r.id}] ${S.clip(r.rule, RULE_CLIP)}`, r.why ? `why: ${S.clip(r.why, WHY_CLIP)}` : 'why: not recorded', `said ${dateOf(r)}`];
  if (r.repeats >= 2) p.push(`corrected ${r.repeats}x before`);
  if (r.status === 'candidate') p.push('unconfirmed, may apply to that task only');
  if (r.status === 'review') p.push(`older than ${cfg.review_days} days: still valid? if not, say why and propose a change`);
  return p.join(' | ');
}
const HEAD = n => `Owner corrections (${n} corrections stored; search with \`taskmote correction search <words>\`). Each one is a past statement, not a law: if it no longer fits, say why before you act. ` +
  'Cheap and reversible: follow it and add one line of concern. Costly or irreversible: discuss it first and ask once with a recommendation. Money, deleting outside the workdir, secrets: always ask.';
const PROPOSE = 'If the owner corrects you in this turn, call at once: `taskmote correction propose --quote "<their exact words>" --why "<reason>" --scope "<where it applies>" "<rule>"`.';

function prepareTurn(ctx) {
  const cfg = ctx.settings, dir = dirOf(ctx), ms = S.now();
  const request = String(ctx.request || '');
  const d = S.load(dir);
  let changed = S.age(d, cfg, ms);
  const repeats = [];
  if (request && !ctx.resumed && S.recordSeen(d, request, ms)) {
    changed = true;
    if (cfg.detect) {
      const task = String(ctx.task_id || '');
      for (const { sentence } of S.detect(request)) {
        const r = S.addRule(d, { rule: sentence, quote: sentence, source: 'heuristic', scope: `task:${task}`, topic: request, task_id: task, workdir: path.basename(String(ctx.workdir || '')) }, cfg, ms);
        if (r.dup) repeats.push({ id: r.rule.id, repeats: r.repeats, escalate: r.escalate });
      }
    }
  }
  const rel = S.relevant(d, request, cfg);
  const lines = [];
  let used = 0;
  for (const r of rel) {
    let l = ruleLine(r, cfg);
    if (lines.length && used + Buffer.byteLength(l) > cfg.max_inject_bytes) break;
    if (!lines.length) l = S.clip(l, cfg.max_inject_bytes);
    lines.push(l); used += Buffer.byteLength(l);
    if (!ctx.resumed) { r.hits = (r.hits || 0) + 1; r.last_hit = S.iso(ms); changed = true; }
  }
  if (changed) S.save(dir, d);
  for (const e of repeats) {
    try { ctx.state.append({ type: 'rule_repeat', id: e.id }); if (ctx.emit) ctx.emit('corrections.repeated', e); } catch { /* bookkeeping only */ }
  }
  const out = lines.length ? [HEAD(d.rules.length), ...lines, PROPOSE]
    : [`Owner corrections: ${d.rules.length} corrections stored, none relevant to this request. Search with \`taskmote correction search <words>\`.`, PROPOSE];
  return { context: [out.join('\n')] };
}

// ---- routes (owner access)
const fail = r => ({ status: r.status || 400, json: { error: r.error } });
const body = ctx => (ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {});
function mutate(ctx, fn, type) {
  const r = S.update(dirOf(ctx), fn);
  if (r.error) return r;
  ctx.state.append({ type, id: r.rule.id }); // metadata only; the texts stay in rules.json
  return r;
}
const rGet = ctx => {
  const d = S.load(dirOf(ctx));
  const q = ctx.query && ctx.query.q ? String(ctx.query.q) : '';
  return { status: 200, json: { rules: (q ? S.search(d, q) : d.rules).map(S.view) } };
};
const rOne = ctx => { const r = S.find(S.load(dirOf(ctx)), ctx.params.id); return r ? { status: 200, json: { rule: S.view(r) } } : { status: 404, json: { error: 'no such rule' } }; };
const rAdd = ctx => { const r = mutate(ctx, d => S.addOwner(d, body(ctx), ctx.settings, S.now()), 'rule_add'); return r.error ? fail(r) : { status: 201, json: { rule: S.view(r.rule) } }; };
const rEdit = ctx => { const r = mutate(ctx, d => S.edit(d, ctx.params.id, body(ctx)), 'rule_edit'); return r.error ? fail(r) : { status: 200, json: { rule: S.view(r.rule) } }; };
const rKeep = ctx => { const r = mutate(ctx, d => S.keep(d, ctx.params.id, S.now()), 'rule_keep'); return r.error ? fail(r) : { status: 200, json: { rule: S.view(r.rule) } }; };
const rDel = ctx => { const r = mutate(ctx, d => S.remove(d, ctx.params.id), 'rule_delete'); return r.error ? fail(r) : { status: 200, json: { deleted: r.rule.id } }; };

// ---- command: taskmote correction ...
const USAGE = 'usage: correction [list] | correction search <words> | correction show <id> | correction propose --quote "<owner words>" --why "<reason>" [--scope "<where>"] "<rule>" | correction add "<rule>" [--why ..] [--scope ..] | correction edit <id> [--rule ..] [--why ..] [--scope ..] [--status candidate|active|review|off] | correction keep <id> | correction delete <id>\n用法: correction [list] | search <字詞> | show <id> | propose | add | edit | keep | delete';
const FLAGS = ['--quote', '--why', '--scope', '--rule', '--status'];
function bad(msg, code) { console.error(msg); process.exitCode = code || 2; return { ok: false }; }
function flags(args) {
  const pos = [], f = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (FLAGS.includes(a)) { if (i + 1 >= args.length) return { error: `${a} needs a value` }; f[a.slice(2)] = args[++i]; } else pos.push(a);
  }
  return { pos, f };
}
function show(r) {
  console.log(`${r.id} [${r.status}] ${r.rule}`);
  console.log(`  why: ${r.why || 'not recorded'}`);
  console.log(`  scope: ${r.scope || '-'}`);
  console.log(`  said: ${dateOf(r)}  source: ${r.source}  corrected before: ${r.repeats}  injected: ${r.hits}x${r.last_hit ? ' (last ' + r.last_hit.slice(0, 10) + ')' : ''}${r.last_checked ? '  last checked: ' + r.last_checked.slice(0, 10) : ''}`);
  if (r.quote && r.quote !== r.rule) console.log(`  owner's words: ${r.quote}`);
}
const brief = r => `${r.id} [${r.status}] ${S.clip(r.rule, 100)} | why: ${r.why ? S.clip(r.why, 60) : '-'} | said ${dateOf(r)}${r.repeats ? ` | corrected ${r.repeats}x` : ''}`;

async function correctionCmd(args, ctx) {
  const [verb0, ...rest] = Array.isArray(args) ? args.map(String) : [];
  const verb = verb0 || 'list';
  const dir = dirOf(ctx), cfg = ctx.settings;
  if (verb === 'list') {
    const rows = S.load(dir).rules;
    if (!rows.length) console.log('no corrections stored yet / 目前沒有記錄的更正');
    rows.forEach(r => console.log(brief(r)));
    return { ok: true };
  }
  if (verb === 'search') {
    if (!rest.length) return bad('search needs some words\n' + USAGE);
    const rows = S.search(S.load(dir), rest.join(' '));
    if (!rows.length) console.log('no match / 沒有符合的更正');
    rows.forEach(r => console.log(brief(r)));
    return { ok: true };
  }
  if (verb === 'show') {
    const r = rest.length === 1 && S.find(S.load(dir), rest[0]);
    if (!r) return bad('no such rule / 找不到這條更正', 3);
    show(r); return { ok: true };
  }
  if (verb === 'propose') {
    const p = flags(rest);
    if (p.error) return bad(p.error + '\n' + USAGE);
    if (p.pos.length !== 1) return bad('propose takes the rule as one quoted text\n' + USAGE);
    if (!p.f.why) return bad('propose needs --why "<the reason the owner gave or the harm it prevents>"\n' + USAGE);
    const r = S.update(dir, d => S.propose(d, { quote: p.f.quote, rule: p.pos[0], why: p.f.why, scope: p.f.scope }, cfg, S.now()));
    if (r.error) return bad(r.error, 3);
    ctx.state.append({ type: 'rule_propose', id: r.rule.id });
    console.log(`${r.merged ? 'confirmed' : 'saved'} ${r.rule.id} [${r.rule.status}] / 已${r.merged ? '確認' : '記錄'} ${r.rule.id}`);
    return r;
  }
  if (!['add', 'edit', 'delete', 'keep'].includes(verb)) return bad(USAGE);
  if (inTask()) { console.error('stored corrections are changed by the person at the keyboard; an agent may only propose one (HARNESS_TASK_ID is set). Stopping. / 只有本人可以改動已記錄的更正，代理只能提議。'); process.exitCode = 6; return { ok: false }; }
  const p = flags(rest);
  if (p.error) return bad(p.error + '\n' + USAGE);
  let r;
  if (verb === 'add') {
    if (p.pos.length !== 1) return bad('add takes the rule as one quoted text\n' + USAGE);
    r = S.update(dir, d => S.addOwner(d, { rule: p.pos[0], why: p.f.why, scope: p.f.scope }, cfg, S.now()));
    if (!r.error) { ctx.state.append({ type: 'rule_add', id: r.rule.id }); console.log(`added ${r.rule.id} / 已新增 ${r.rule.id}`); }
  } else {
    if (p.pos.length !== 1) return bad(`${verb} takes one rule id\n` + USAGE);
    if (verb === 'edit') { r = S.update(dir, d => S.edit(d, p.pos[0], { rule: p.f.rule, why: p.f.why, scope: p.f.scope, status: p.f.status })); if (!r.error) console.log(`edited ${r.rule.id} / 已修改 ${r.rule.id}`); }
    if (verb === 'keep') { r = S.update(dir, d => S.keep(d, p.pos[0], S.now())); if (!r.error) console.log(`kept ${r.rule.id} / 已保留 ${r.rule.id}`); }
    if (verb === 'delete') { r = S.update(dir, d => S.remove(d, p.pos[0])); if (!r.error) console.log(`deleted ${r.rule.id} / 已刪除 ${r.rule.id}`); }
    if (!r.error) ctx.state.append({ type: 'rule_' + verb, id: r.rule.id });
  }
  if (r.error) return bad(r.error, 3);
  return r;
}

function statusLines(J, ctx) {
  const rows = S.load(dirOf(ctx)).rules;
  const n = st => rows.filter(r => r.status === st).length;
  const extra = [n('candidate') && `${n('candidate')} unconfirmed`, n('review') && `${n('review')} to re-check`].filter(Boolean);
  return [`corrections: ${rows.length}${extra.length ? ' (' + extra.join(', ') + ')' : ''}`];
}

module.exports = {
  contract: 2,
  name: 'corrections',
  hookTimeoutMs: 2000,
  description: 'Remembers what the owner corrected (with why and date), re-injects only the relevant ones within a byte budget, and lets the owner view, edit and delete them.',
  runsOn: 'main',
  priority: 40,
  beforeTool,
  prepareTurn,
  statusLines,
  commands: { correction: correctionCmd },
  routes: [
    { method: 'GET', path: '/rules', handler: rGet, description: 'stored corrections; ?q=<words> searches' },
    { method: 'GET', path: '/rules/:id', handler: rOne, description: 'one correction with its why, scope, date and counts' },
    { method: 'POST', path: '/rules', handler: rAdd, description: 'add a correction: body {rule, why?, scope?}; stored as active' },
    { method: 'PATCH', path: '/rules/:id', handler: rEdit, description: 'edit rule, why, scope and/or status (candidate|active|review|off)' },
    { method: 'POST', path: '/rules/:id/keep', handler: rKeep, description: 're-confirm a correction: active again, re-check clock restarts' },
    { method: 'DELETE', path: '/rules/:id', handler: rDel, description: 'delete a correction' },
  ],
  settings: {
    detect: { type: 'boolean', default: true, description: 'save a correction the moment the owner says one (cue words, English and Traditional Chinese), as an unconfirmed candidate' },
    max_inject: { type: 'integer', default: 3, min: 0, max: 20, description: 'most corrections put in front of the agent in one turn' },
    max_inject_bytes: { type: 'integer', default: 1500, min: 200, max: 20000, description: 'byte budget for the rule lines of one injected block, however many rules are stored' },
    min_overlap: { type: 'integer', default: 2, min: 1, max: 20, description: 'shared-word points a request needs with a rule before it counts as relevant (a Latin word is 1, a Chinese two-character word is 2)' },
    review_days: { type: 'integer', default: 90, min: 1, max: 3650, description: 'an active rule not re-checked for this many days is flagged for a re-check when it comes up' },
    candidate_days: { type: 'integer', default: 14, min: 1, max: 365, description: 'a candidate never relevant again within this many days is switched off (kept, not deleted)' },
    max_rules: { type: 'integer', default: 300, min: 10, max: 10000, description: 'rules kept; over the cap, off rules go first, then candidates, then the least recently used' },
    repeat_similarity: { type: 'number', default: 0.6, min: 0.3, max: 1, description: 'how alike two sentences must be to count as the owner repeating a correction' },
  },
};
