'use strict';
// arena core: two git worktrees, two runs, a judge, tests, keep. Every outside effect
// (run a task, call the judge, run tests, ask the owner) is a function in `deps`, so
// tests inject stubs. Written from scratch.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const VARIANTS = {
  A: { label: 'smallest', note: 'Make the smallest change that fully satisfies the request: touch as few files and lines as possible, add nothing extra.' },
  B: { label: 'cleanest', note: 'Make the cleanest design that satisfies the request: clear structure and names, small focused functions, tidy up what you touch.' },
};
const OPTIONS = ['Keep A', 'Keep B', 'Keep neither'];
const ID_RE = /^a[0-9a-f]{10}$/;

const git = (cwd, args, o = {}) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...o }).toString();
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 3) + '...' : s; };
const cut = (s, n) => (s.length > n ? s.slice(0, n) + '\n[... truncated ...]' : s);

// ---- run records: one JSON file per run in <stateDir>/runs/
const runsDir = dir => path.join(dir, 'runs');
const runFile = (dir, id) => path.join(runsDir(dir), `${id}.json`);
function save(dir, run) {
  fs.mkdirSync(runsDir(dir), { recursive: true });
  const f = runFile(dir, run.id), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(run, null, 1)); fs.renameSync(tmp, f);
  return run;
}
function load(dir, id) {
  if (!ID_RE.test(String(id))) return null;
  try { return JSON.parse(fs.readFileSync(runFile(dir, id), 'utf8')); } catch { return null; }
}
function list(dir) {
  let names = [];
  try { names = fs.readdirSync(runsDir(dir)).filter(n => /^a[0-9a-f]{10}\.json$/.test(n)); } catch { /* none yet */ }
  return names.map(n => load(dir, n.slice(0, -5))).filter(Boolean).sort((a, b) => String(a.created).localeCompare(String(b.created)));
}
const view = r => ({ id: r.id, request: clip(r.request, 200), engines: r.engines, winner: r.winner, tests: r.tests, kept: r.kept, state: r.state, reasons: r.reasons, question_id: r.question_id || null, created: r.created });

// ---- git helpers
const isRepo = d => { try { return git(d, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'; } catch { return false; } };
const dirty = d => git(d, ['status', '--porcelain']).trim() !== '';
function addWorktree(target, p) { fs.mkdirSync(path.dirname(p), { recursive: true }); git(target, ['worktree', 'add', '--detach', p]); }
function removeWorktree(target, p) {
  try { git(target, ['worktree', 'remove', '--force', p]); } catch { /* fall through */ }
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* gone */ }
  try { git(target, ['worktree', 'prune']); } catch { /* best effort */ }
}
// the whole change of a worktree (new files included) against its starting commit
function diffOf(wt) {
  git(wt, ['add', '-A']);
  return { stat: git(wt, ['diff', '--cached', '--stat', 'HEAD']), patch: git(wt, ['diff', '--cached', '--binary', 'HEAD']) };
}

// ---- judge
function judgePrompt(request, A, B, cap) {
  return [
    'You are judging two attempts at the same coding request. Reply with JSON only, no other text:',
    '{"winner":"A"|"B"|"tie","reasons":["short reason", "..."]}',
    'A is the "smallest change" attempt, B is the "cleanest design" attempt. Prefer the one that satisfies the request correctly and is easier to review.',
    '', `Request: ${clip(request, 1000)}`,
    '', '=== A: diff stat ===', A.stat.trim() || '(no changes)', '=== A: diff ===', cut(A.patch, cap) || '(no changes)',
    '', '=== B: diff stat ===', B.stat.trim() || '(no changes)', '=== B: diff ===', cut(B.patch, cap) || '(no changes)',
  ].join('\n');
}
// -> {winner, reasons, judged}. Anything unusable is a tie with judged:false, never a throw.
function parseJudge(text) {
  const bad = why => ({ winner: 'tie', reasons: [why], judged: false });
  const m = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!m) return bad('judge output was not JSON');
  let j; try { j = JSON.parse(m[0]); } catch { return bad('judge output was not valid JSON'); }
  if (!j || typeof j !== 'object' || !['A', 'B', 'tie'].includes(j.winner)) return bad('judge output had no valid winner');
  const reasons = (Array.isArray(j.reasons) ? j.reasons : []).filter(x => typeof x === 'string' && x.trim()).slice(0, 5).map(x => clip(x, 200));
  return { winner: j.winner, reasons, judged: true };
}
// Tests outrank the judge: exactly one side passing decides it.
function decide(judge, tests) {
  const a = tests.A, b = tests.B;
  if (a === 'pass' && b === 'fail') return { winner: 'A', reasons: ['tests pass in A and fail in B', ...judge.reasons] };
  if (b === 'pass' && a === 'fail') return { winner: 'B', reasons: ['tests pass in B and fail in A', ...judge.reasons] };
  return { winner: judge.winner, reasons: judge.reasons };
}

function questionText(run) {
  const why = run.reasons.length ? run.reasons.join('; ') : 'no reason given';
  const t = run.tests.A === 'none' ? '' : ` Tests: A ${run.tests.A}, B ${run.tests.B}.`;
  const pick = run.winner === 'tie' ? 'judge sees a tie' : `judge picks ${run.winner}`;
  return clip(`Arena: A (smallest) vs B (cleanest) - ${pick} because ${why}.${t}`, 500);
}

// ---- the flow
// ctx: { dir (state dir), settings, log(rec) }. deps: runTask, judge, runTests, ask (ask optional).
async function start(ctx, deps, request, o = {}) {
  const s = ctx.settings || {};
  const target = path.resolve(o.dir || process.cwd());
  if (!request || !String(request).trim()) throw new Error('arena needs a request');
  if (!isRepo(target)) throw new Error(`${target} is not a git repository`);
  const engines = (o.engines && o.engines.length ? o.engines : String(s.engines || '').split(',').map(x => x.trim()).filter(Boolean));
  const pair = [engines[0] || 'default', engines[1] || engines[0] || 'default'];
  const id = 'a' + crypto.randomBytes(5).toString('hex');
  const wt = { A: path.join(ctx.dir, 'wt', id, 'A'), B: path.join(ctx.dir, 'wt', id, 'B') };
  const run = { id, request: String(request), target, engines: pair, worktrees: wt, state: 'running', winner: null, reasons: [], tests: { A: 'none', B: 'none' }, kept: null, question_id: null, created: new Date().toISOString(), errors: [] };
  save(ctx.dir, run);
  try { addWorktree(target, wt.A); addWorktree(target, wt.B); }
  catch (e) { for (const k of ['A', 'B']) removeWorktree(target, wt[k]); run.state = 'failed'; run.errors.push('worktree: ' + clip(e.message, 200)); save(ctx.dir, run); throw new Error('could not create worktrees: ' + clip(e.message, 200)); }
  // Sequential on purpose: the engine runner holds the executor lock, one run at a time.
  const diffs = {};
  for (const k of ['A', 'B']) {
    try { await deps.runTask(`${run.request}\n\n${VARIANTS[k].note}`, { dir: wt[k], engine: pair[k === 'A' ? 0 : 1], variant: k, label: VARIANTS[k].label }); }
    catch (e) { run.errors.push(`run ${k}: ${clip(e && e.message, 200)}`); }
    try { diffs[k] = diffOf(wt[k]); } catch (e) { diffs[k] = { stat: '', patch: '' }; run.errors.push(`diff ${k}: ${clip(e.message, 200)}`); }
  }
  if (s.test_cmd) for (const k of ['A', 'B']) {
    try { run.tests[k] = (await deps.runTests(wt[k], s.test_cmd)) ? 'pass' : 'fail'; } catch { run.tests[k] = 'fail'; }
  }
  let judge;
  try { judge = parseJudge(await deps.judge(judgePrompt(run.request, diffs.A, diffs.B, s.diff_cap || 12000), { engine: s.judge_engine || pair[0] })); }
  catch (e) { judge = { winner: 'tie', reasons: ['judge failed: ' + clip(e && e.message, 120)], judged: false }; }
  Object.assign(run, decide(judge, run.tests), { state: 'decided' });
  save(ctx.dir, run);
  ctx.log({ type: 'arena', kind: 'arena', id, engines: pair, winner: run.winner, tests: run.tests, kept: null });
  if (typeof deps.ask === 'function') {
    try { const q = await deps.ask(questionText(run), OPTIONS); run.question_id = q || null; run.state = 'asked'; save(ctx.dir, run); }
    catch (e) { run.errors.push('ask: ' + clip(e && e.message, 120)); save(ctx.dir, run); }
  }
  return run;
}

// choice: 'A' | 'B' | 'none'. Never throws on a user error: returns {ok:false, error}; the run then stays as it was.
function keep(ctx, id, choice) {
  const run = load(ctx.dir, id);
  if (!run) return { ok: false, error: 'no such arena run' };
  if (run.kept) return { ok: false, error: `run already settled (kept ${run.kept})` };
  if (!['A', 'B', 'none'].includes(choice)) return { ok: false, error: 'choice must be A, B or none' };
  try {
    if (choice !== 'none') {
      if (dirty(run.target)) return { ok: false, error: 'the target folder has uncommitted changes; commit or stash them, then keep again. Nothing was changed.' };
      const { patch } = diffOf(run.worktrees[choice]);
      if (patch.trim()) {
        const pf = path.join(ctx.dir, `${run.id}-${choice}.patch`);
        fs.writeFileSync(pf, patch);
        try { git(run.target, ['apply', '--binary', pf]); }
        catch (e) { return { ok: false, error: 'the patch does not apply to the target: ' + clip(e.stderr || e.message, 200) }; }
        finally { try { fs.unlinkSync(pf); } catch { /* gone */ } }
      }
    }
  } catch (e) { return { ok: false, error: clip(e.message, 200) }; }
  for (const k of ['A', 'B']) removeWorktree(run.target, run.worktrees[k]);
  try { fs.rmSync(path.join(ctx.dir, 'wt', run.id), { recursive: true, force: true }); } catch { /* gone */ }
  run.kept = choice; run.state = 'kept'; save(ctx.dir, run);
  ctx.log({ type: 'arena', kind: 'arena', id: run.id, engines: run.engines, winner: run.winner, tests: run.tests, kept: choice });
  return { ok: true, run };
}

// ---- queue: requests an agent made from inside a running task. One JSON file, written atomically.
// They start only after the executor lock is free (see index.js drain); nothing here runs a task.
const queueFile = dir => path.join(dir, "queue.json");
function readQueue(dir) {
  try { const v = JSON.parse(fs.readFileSync(queueFile(dir), "utf8")); return Array.isArray(v) ? v.filter(x => x && typeof x.request === "string") : []; } catch { return []; }
}
function writeQueue(dir, q) {
  fs.mkdirSync(dir, { recursive: true });
  const f = queueFile(dir), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(q));
  fs.renameSync(tmp, f);
}
function enqueue(dir, item, max = 20) {
  const q = readQueue(dir);
  if (q.length >= max) return { ok: false, error: `the arena queue is full (${max})` };
  const entry = { qid: "q" + crypto.randomBytes(4).toString("hex"), request: String(item.request).slice(0, 20000), dir: item.dir ? path.resolve(item.dir) : null, engines: item.engines || null, task_id: item.task_id || null, queued_at: new Date().toISOString() };
  q.push(entry);
  writeQueue(dir, q);
  return { ok: true, entry, position: q.length };
}
// Remove and return the oldest entry (null when empty).
function dequeue(dir) {
  const q = readQueue(dir);
  const e = q.shift() || null;
  if (e) writeQueue(dir, q);
  return e;
}

module.exports = { enqueue, dequeue, readQueue, start, keep, list, load, view, parseJudge, decide, judgePrompt, questionText, VARIANTS, OPTIONS, ID_RE };
