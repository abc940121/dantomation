'use strict';
// change-card: when a task ends having changed files, raise one Keep / Undo card.
// Undo rolls the folder back to the state before the task's first change, through the
// checkpoint module's restore. Needs checkpoint and question-cards (dependsOn). See README.md.
const fs = require('fs');
const path = require('path');
const J = require('../../lib/journal');

const MAX_LIST = 8;
const MINUS = '−';
const KEEP = 'Keep', UNDO = 'Undo';
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x1f\x7f]/g;

const pendingFile = ctx => path.join(ctx.state.dir, 'pending.json');
function loadPending(ctx) {
  try { const v = JSON.parse(fs.readFileSync(pendingFile(ctx), 'utf8')); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* none yet */ }
  return {};
}
function savePending(ctx, v) {
  fs.mkdirSync(ctx.state.dir, { recursive: true });
  const f = pendingFile(ctx), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v));
  fs.renameSync(tmp, f);
}

function cardText(task, stats) {
  const added = stats.reduce((a, s) => a + s.added, 0), removed = stats.reduce((a, s) => a + s.removed, 0);
  const names = stats.map(s => s.path.replace(CTRL, '?'));
  const shown = names.slice(0, MAX_LIST).join(', ');
  const more = names.length > MAX_LIST ? `, +${names.length - MAX_LIST} more` : '';
  const n = stats.length;
  let text = `Task ${task} changed ${n} ${n === 1 ? 'file' : 'files'} (+${added} ${MINUS}${removed}): ${shown}${more}`;
  if (text.length > 500) text = text.slice(0, 497) + '...';
  return { text, added, removed };
}

const rec = (ctx, o) => ctx.state.append({ type: 'change_card', kind: 'change-card', ...o });

// task.end: work out what changed since the task's first snapshot and ask once.
async function onTaskEnd(p, ctx) {
  const task = p && p.task_id, dir = p && p.workdir;
  if (!task || !dir) return;
  const ck = ctx.api('checkpoint');
  const first = ck.steps(task).filter(s => !s.safety).map(s => s.step).sort((a, b) => a - b)[0];
  if (!first) return; // the task never changed anything
  const stats = ck.diffstat(task, dir, first);
  const min = Math.max(1, Number(ctx.settings.min_files) || 1);
  if (stats.length < min || stats.length === 0) return;
  const { text, added, removed } = cardText(task, stats);
  const r = await ctx.api('question-cards').ask({ text, options: [KEEP, UNDO], allow_free: false, task_id: task });
  if (!r || r.error || !r.question) { rec(ctx, { task_id: task, files: stats.length, added, removed, answer: 'card_failed' }); return; }
  const pending = loadPending(ctx);
  pending[r.question.question_id] = { task_id: task, dir, n: first, files: stats.length, added, removed };
  savePending(ctx, pending);
  rec(ctx, { task_id: task, files: stats.length, added, removed, answer: 'pending', question_id: r.question.question_id });
}

function takeEntry(ctx, qid) {
  const pending = loadPending(ctx);
  const e = pending[qid];
  if (!e) return null;
  delete pending[qid];
  savePending(ctx, pending);
  return e;
}

// question.answered: Keep closes the card; Undo restores snapshot n (the state before the first change).
async function onAnswered(p, ctx) {
  const e = p && takeEntry(ctx, p.question_id);
  if (!e) return; // not our card
  const base = { task_id: e.task_id, files: e.files, added: e.added, removed: e.removed, question_id: p.question_id };
  if (p.option !== UNDO) { rec(ctx, { ...base, answer: 'keep' }); return; }
  const lock = path.join(J.STATE, 'executor.lock');
  const l = J.lock(lock, { pids: [process.pid], task_id: e.task_id, restore: true });
  if (!l.held) { rec(ctx, { ...base, answer: 'undo_blocked', error: 'a task is still running' }); return; }
  try {
    const r = ctx.api('checkpoint').restore(e.task_id, e.n, { user: true });
    rec(ctx, { ...base, answer: 'undo', removed_files: r.removed.length, undo_ref: r.undo.ref });
  } catch (err) {
    rec(ctx, { ...base, answer: 'undo_failed', error: String((err && err.message) || err).split('\n')[0].slice(0, 200) });
  } finally { if (!J.unlock(lock, l.nonce)) J.unlockLater(lock, l.nonce, undefined, 'change-card'); }
}

// A card that expired or was withdrawn changes nothing; just forget it.
function onClosed(p, ctx) {
  const e = p && takeEntry(ctx, p.question_id);
  if (e) rec(ctx, { task_id: e.task_id, files: e.files, added: e.added, removed: e.removed, answer: 'none', question_id: p.question_id });
}

// taskmote changes [status] [--json]: read-only, safe for an agent inside a task.
function pendingList(ctx) {
  return Object.entries(loadPending(ctx)).map(([question_id, e]) => ({ question_id, task_id: e.task_id, files: e.files, added: e.added, removed: e.removed }));
}
function changes(args, ctx) {
  const a = (Array.isArray(args) ? args : []).map(String);
  const json = a.includes('--json');
  const sub = a.find(x => x !== '--json') || 'status';
  if (sub !== 'status') { console.error('usage: taskmote changes [status] [--json]'); return { handled: true, code: 2 }; }
  const pending = pendingList(ctx);
  console.log(json ? JSON.stringify({ pending }) : (pending.length ? pending.map(p => `${p.question_id}: task ${p.task_id} changed ${p.files} file${p.files === 1 ? '' : 's'} (+${p.added} -${p.removed}), waiting for Keep / Undo`).join('\n') : 'no change cards waiting'));
  return { handled: true, code: 0 };
}

module.exports = {
  contract: 2,
  name: 'change-card',
  commands: { changes },
  description: 'After a task changed files: one Keep / Undo card; Undo rolls the folder back through checkpoint.',
  runsOn: 'main',
  priority: 60,
  dependsOn: ['checkpoint', 'question-cards'], // either one off = load error naming it
  on: {
    'task.end': onTaskEnd,
    'question.answered': onAnswered,
    'question.expired': onClosed,
    'question.cancelled': onClosed,
  },
  settings: {
    min_files: { type: 'integer', default: 1, min: 1, max: 100000, description: 'ask only when the task changed at least this many files' },
  },
  api: { cardText },
};
