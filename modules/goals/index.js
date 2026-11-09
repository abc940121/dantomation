'use strict';
// goals: (1) goal intake: the owner's verbatim goal, what done looks like and what is out of scope,
// confirmed once; prepareTurn puts the active card in front of the engine. (2) lessons: each owner
// correction is a row (what, which check missed it, fix) with weekly repeat counts; a lesson that
// does not drop in repeats is marked stale. Rows are entered explicitly, never from conversation text.
// See README.md and DECISIONS.md.
const S = require('./store');

const inTask = () => !!process.env.HARNESS_TASK_ID;
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 3) + '...' : s; };
const dirOf = ctx => ctx.state.dir;
const win = ctx => ctx.settings.stale_window_weeks;
const ret = ctx => ({ max_replaced_goals: ctx.settings.max_replaced_goals, max_lessons: ctx.settings.max_lessons, max_repeats_per_lesson: ctx.settings.max_repeats_per_lesson });

// An agent may read the card (goal show) but never set, edit, confirm or close goals, nor write lessons.
const OWNER_CMD = /(dantomation|harness)(\.(js|cmd))?["']?\s+(goal\s+["']?(set|edit|confirm|done|drop)|lesson\s+["']?(add|repeat))\b/i;
const API_CMD = /\/m\/goals(?![\w-])/i;
function beforeTool(ctx) {
  if (!inTask()) return null;
  const { tool, ti } = ctx;
  if (!/^(bash|shell|powershell|cmd)$/i.test(String(tool || ''))) return null;
  const cmd = String((ti && ti.command) || '');
  if (API_CMD.test(cmd)) return ['goals', 'the goals server API is for the owner only'];
  if (OWNER_CMD.test(cmd)) return ['goals', 'goals and lessons are entered by the owner, not by agents'];
  return null;
}

// ---- views
function goalView(g) { return g && { goal_id: g.goal_id, verbatim: g.verbatim, done: g.done, out_of_scope: g.out_of_scope, confirmed: g.confirmed, confirmed_at: g.confirmed_at, state: g.state, created_at: g.created_at, closed_at: g.closed_at }; }
function goalCard(g) {
  const lines = [`Goal (owner's words): ${g.verbatim}`, `Done looks like: ${g.done || '(not stated yet)'}`, `Out of scope: ${g.out_of_scope || '(not stated yet)'}`];
  lines.push(g.confirmed ? 'Status: confirmed by the owner. Check your work against this card before you say you are done.' : 'Status: NOT confirmed yet. Do not treat the done/out-of-scope lines as agreed; ask the owner to confirm (goal confirm).');
  return lines.join('\n');
}
const lessonLine = l => `- ${l.what} (missed by: ${l.missed_by}) Fix: ${l.fix}`;

// ---- prepareTurn: the goal card, then live lessons (stale ones are left out)
function prepareTurn(ctx) {
  const data = S.load(dirOf(ctx));
  const out = [];
  const g = S.activeGoal(data);
  if (g) out.push(goalCard(g));
  const t = S.now();
  const alive = data.lessons.filter(l => S.status(l, win(ctx), t) !== 'stale');
  const live = alive.slice(Math.max(0, alive.length - ctx.settings.max_lessons_in_prompt));
  if (live.length) out.push('Lessons from past owner corrections (do not repeat these):\n' + live.map(lessonLine).join('\n'));
  return out.length ? { context: [out.join('\n\n')] } : null;
}

// ---- routes (owner access)
const fail = r => ({ status: r.status || 400, json: { error: r.error } });
const body = ctx => (ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {});
function mutate(ctx, fn, type, pick) {
  const r = S.update(dirOf(ctx), fn);
  if (r.error) return r;
  ctx.state.append({ type, id: pick(r) }); // metadata only; texts stay in data.json
  return r;
}
const goalGet = ctx => { const data = S.load(dirOf(ctx)); const g = S.activeGoal(data); return { status: 200, json: { goal: goalView(g), questions: S.missing(g) } }; };
const goalPost = ctx => { const r = mutate(ctx, d => S.setGoal(d, body(ctx), ret(ctx)), 'goal_set', x => x.goal.goal_id); return r.error ? fail(r) : { status: 201, json: { goal: goalView(r.goal), questions: S.missing(r.goal) } }; };
const goalPatch = ctx => { const r = mutate(ctx, d => S.editGoal(d, body(ctx)), 'goal_edit', x => x.goal.goal_id); return r.error ? fail(r) : { status: 200, json: { goal: goalView(r.goal), questions: S.missing(r.goal) } }; };
const goalConfirm = ctx => { const r = mutate(ctx, d => S.confirmGoal(d), 'goal_confirm', x => x.goal.goal_id); return r.error ? fail(r) : { status: 200, json: { goal: goalView(r.goal) } }; };
const goalClose = ctx => { const how = body(ctx).how === 'dropped' ? 'dropped' : 'done'; const r = mutate(ctx, d => S.closeGoal(d, how), 'goal_close', x => x.goal.goal_id); return r.error ? fail(r) : { status: 200, json: { goal: goalView(r.goal) } }; };
const lessonList = ctx => { const data = S.load(dirOf(ctx)); const t = S.now(); return { status: 200, json: { lessons: data.lessons.map(l => S.lessonView(l, win(ctx), t)) } }; };
const lessonAdd = ctx => { const r = mutate(ctx, d => S.addLesson(d, body(ctx), ret(ctx), win(ctx)), 'lesson_add', x => x.lesson.lesson_id); return r.error ? fail(r) : { status: 201, json: { lesson: S.lessonView(r.lesson, win(ctx)) } }; };
const lessonRepeat = ctx => {
  if (!S.ID_RE.test(ctx.params.id)) return { status: 404, json: { error: 'no such lesson' } };
  const r = mutate(ctx, d => S.repeatLesson(d, ctx.params.id, ret(ctx)), 'lesson_repeat', x => x.lesson.lesson_id);
  return r.error ? fail(r) : { status: 200, json: { lesson: S.lessonView(r.lesson, win(ctx)) } };
};

// ---- commands: dantomation goal ..., dantomation lesson ...
const GOAL_USAGE = 'usage: goal [show] | goal interview | goal set "<your words>" [--done "<text>"] [--out "<text>"] | goal edit [--done "<text>"] [--out "<text>"] | goal confirm | goal done | goal drop';
const LESSON_USAGE = 'usage: lesson list | lesson add "<what went wrong>" --missed "<which check missed it>" --fix "<fix>" | lesson repeat <id>';
function bad(msg, code) { console.error(msg); process.exitCode = code || 2; return { ok: false }; }
function flags(args) {
  const pos = [], f = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--done' || a === '--out' || a === '--missed' || a === '--fix') { if (i + 1 >= args.length) return { error: `${a} needs a value` }; f[a.slice(2)] = args[++i]; } else pos.push(a);
  }
  return { pos, f };
}
function refuseInTask() { console.error('goals and lessons are entered by the person at the keyboard, not by agents (HARNESS_TASK_ID is set). Stopping.'); process.exit(6); }
function printGoal(g) { console.log(goalCard(g)); }

async function goalCmd(args, ctx) {
  const [verb0, ...rest] = Array.isArray(args) ? args.map(String) : [];
  const verb = verb0 || 'show';
  const dir = dirOf(ctx);
  const rec = (type, id) => ctx.state.append({ type, id });
  if (verb === 'show') {
    const g = S.activeGoal(S.load(dir));
    if (!g) { console.log('no active goal. Set one with: goal set "<your words>"'); return { ok: true }; }
    printGoal(g); return { ok: true };
  }
  if (verb === 'interview') {
    const g = S.activeGoal(S.load(dir));
    const q = S.missing(g);
    if (!q.length) console.log('the goal card is complete and confirmed'); else q.forEach((x, i) => console.log(`${i + 1}. ${x}`));
    return { ok: true };
  }
  if (inTask()) refuseInTask();
  const p = flags(rest);
  if (p.error) return bad(p.error + '\n' + GOAL_USAGE);
  let r;
  if (verb === 'set') {
    if (p.pos.length !== 1) return bad('goal set takes your goal as one quoted text\n' + GOAL_USAGE);
    r = S.update(dir, d => S.setGoal(d, { verbatim: p.pos[0], done: p.f.done, out_of_scope: p.f.out }, ret(ctx)));
    if (!r.error) rec('goal_set', r.goal.goal_id);
  } else if (verb === 'edit') {
    if (p.pos.length) return bad(GOAL_USAGE);
    r = S.update(dir, d => S.editGoal(d, { done: p.f.done, out_of_scope: p.f.out }));
    if (!r.error) rec('goal_edit', r.goal.goal_id);
  } else if (verb === 'confirm') {
    r = S.update(dir, d => S.confirmGoal(d));
    if (!r.error) rec('goal_confirm', r.goal.goal_id);
  } else if (verb === 'done' || verb === 'drop') {
    r = S.update(dir, d => S.closeGoal(d, verb === 'drop' ? 'dropped' : 'done'));
    if (!r.error) rec('goal_close', r.goal.goal_id);
  } else return bad(GOAL_USAGE);
  if (r.error) return bad(r.error, 3);
  printGoal(r.goal);
  if (verb === 'set' || verb === 'edit') S.missing(r.goal).forEach(x => console.log('? ' + x));
  return r;
}

async function lessonCmd(args, ctx) {
  const [verb, ...rest] = Array.isArray(args) ? args.map(String) : [];
  const dir = dirOf(ctx);
  if (verb === 'list') {
    const t = S.now();
    const rows = S.load(dir).lessons.map(l => S.lessonView(l, win(ctx), t));
    if (!rows.length) console.log('no lessons yet');
    for (const v of rows) {
      const wk = Object.keys(v.weekly).sort().map(k => `${k}:${v.weekly[k]}`).join(' ') || 'no repeats';
      console.log(`${v.lesson_id} [${v.status}] ${clip(v.what, 100)} | missed by: ${clip(v.missed_by, 60)} | fix: ${clip(v.fix, 80)} | repeats ${v.repeat_count} (${wk})`);
    }
    return { ok: true };
  }
  if (verb !== 'add' && verb !== 'repeat') return bad(LESSON_USAGE);
  if (inTask()) refuseInTask();
  const p = flags(rest);
  if (p.error) return bad(p.error + '\n' + LESSON_USAGE);
  let r;
  if (verb === 'add') {
    if (p.pos.length !== 1) return bad('lesson add takes the problem as one quoted text\n' + LESSON_USAGE);
    r = S.update(dir, d => S.addLesson(d, { what: p.pos[0], missed_by: p.f.missed, fix: p.f.fix }, ret(ctx), win(ctx)));
    if (!r.error) ctx.state.append({ type: 'lesson_add', id: r.lesson.lesson_id });
  } else {
    if (p.pos.length !== 1 || !S.ID_RE.test(p.pos[0])) return bad(LESSON_USAGE);
    r = S.update(dir, d => S.repeatLesson(d, p.pos[0], ret(ctx)));
    if (!r.error) ctx.state.append({ type: 'lesson_repeat', id: r.lesson.lesson_id });
  }
  if (r.error) return bad(r.error + (verb === 'add' ? '\n' + LESSON_USAGE : ''), 3);
  console.log(`${verb === 'add' ? 'added' : 'counted a repeat of'} ${r.lesson.lesson_id}`);
  return r;
}

function statusLines(J, ctx) {
  const data = S.load(dirOf(ctx));
  const lines = [];
  const g = S.activeGoal(data);
  if (g) lines.push(`goal: ${clip(g.verbatim, 80)} (${g.confirmed ? 'confirmed' : 'NOT confirmed: dantomation goal confirm'})`);
  const t = S.now();
  const stale = data.lessons.filter(l => S.status(l, win(ctx), t) === 'stale').length;
  if (data.lessons.length) lines.push(`lessons: ${data.lessons.length}${stale ? `, ${stale} stale (repeats did not drop)` : ''}`);
  return lines;
}

module.exports = {
  contract: 2,
  name: 'goals',
  description: 'Owner goal card (verbatim goal, done, out of scope, confirmed once) and a lessons list from owner corrections.',
  runsOn: 'main',
  priority: 50,
  beforeTool,
  prepareTurn,
  statusLines,
  commands: { goal: goalCmd, lesson: lessonCmd },
  routes: [
    { method: 'GET', path: '/goal', handler: goalGet, description: 'the active goal card and the interview questions still open' },
    { method: 'POST', path: '/goal', handler: goalPost, description: 'set a goal: body {verbatim, done?, out_of_scope?}; replaces the active goal' },
    { method: 'PATCH', path: '/goal', handler: goalPatch, description: 'edit done and/or out_of_scope; clears the confirmation' },
    { method: 'POST', path: '/goal/confirm', handler: goalConfirm, description: 'confirm the active goal card (needs done and out_of_scope)' },
    { method: 'POST', path: '/goal/close', handler: goalClose, description: 'close the active goal: body {how?: done|dropped}' },
    { method: 'GET', path: '/lessons', handler: lessonList, description: 'lessons with weekly repeat counts and status (new|kept|stale)' },
    { method: 'POST', path: '/lessons', handler: lessonAdd, description: 'add a lesson: body {what, missed_by, fix}' },
    { method: 'POST', path: '/lessons/:id/repeat', handler: lessonRepeat, description: 'count one more repeat of a lesson' },
  ],
  settings: {
    stale_window_weeks: { type: 'integer', default: 2, min: 1, max: 26, description: 'weeks per window; a lesson older than two windows is stale if its repeats did not drop between them' },
    max_lessons_in_prompt: { type: 'integer', default: 10, min: 0, max: 50, description: 'most recent non-stale lessons put in each turn prompt' },
    max_replaced_goals: { type: 'integer', default: 50, min: 1, max: 10000, description: 'closed goals kept (replaced, done or dropped); the oldest beyond this are deleted when a goal is set' },
    max_lessons: { type: 'integer', default: 200, min: 1, max: 10000, description: 'lessons kept; over the cap the oldest stale lessons are deleted first, then the oldest others, when a lesson is added' },
    max_repeats_per_lesson: { type: 'integer', default: 100, min: 1, max: 10000, description: 'repeat timestamps kept per lesson (newest); the repeat count shown is of kept ones' },
  },
};
