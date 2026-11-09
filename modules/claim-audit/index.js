'use strict';
// claim-audit ("evidence"): when a task ends, check every "done" / "tested" claim in the
// agent's final message against the journal and the recorded command outputs. A warning
// layer: it journals a claim_audit record, `status` shows it, a flagged report emits
// claim-audit.flagged; it never blocks or fails the task. Optionally a reviewer from a
// different model family is asked 3 short evidence questions. See README.md.
const J = require('../../lib/journal');
const { auditReport, checkCitations } = require('./audit');
const { collect } = require('./evidence');
const { checkDifferent } = require('./family');
const I = require('./interrogate');

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 3) + '...' : s; };
const MAX_LISTED = 20;

// The reviewer engine call is the one thing core does not offer yet (see README, SEAM REQUEST).
// Until it does, another module or a test registers a client: async ({engine, task_id, questions}) -> [answer text].
let reviewerClient = null;
const setReviewerClient = fn => { reviewerClient = typeof fn === 'function' ? fn : null; };

// Store answers for the stored questions of a task and check their citations. Never throws on bad input.
function storeAnswers({ dir, append, taskId, answers, evidence }) {
  const rec = I.load(dir, taskId);
  if (!rec || !Array.isArray(rec.questions) || !rec.questions.length) return null;
  const list = Array.isArray(answers) ? answers : [];
  const done = rec.questions.map((q, i) => {
    const text = clip(list[i] == null ? '' : list[i], 600);
    const c = text ? checkCitations(text, evidence) : { cited: 0, ok: false, reasons: [] };
    return { n: q.n, answer: text, cited: c.cited, supported: c.ok, reasons: c.reasons.slice(0, 3) };
  });
  const answered = done.filter(a => a.answer).length;
  const next = { ...rec, answers: done, status: answered ? 'answered' : rec.status, answered_at: new Date().toISOString() };
  I.save(dir, next);
  append({ type: 'claim_interrogation', task_id: taskId, status: next.status, questions: rec.questions.length,
    answered, supported: done.filter(a => a.supported).length, reviewer_family: rec.reviewer_family });
  return next;
}

async function interrogate({ task_id, claims, evidence, settings, state }) {
  const engine = String(settings.reviewer_engine || '').trim();
  if (!engine) return null;
  const questions = I.makeQuestions(claims, settings.high_stakes_words);
  if (!questions.length) return null;
  const fam = checkDifferent(engine, settings.worker_model);
  const base = { task_id, ts: new Date().toISOString(), reviewer: engine, reviewer_family: fam.reviewer, worker_family: fam.worker, questions };
  if (!fam.ok) {
    // Same or unknown family: no questions leave this module. Kept only as a refusal line.
    I.save(state.dir, { ...base, questions: [], status: 'refused', reason: fam.reason });
    state.append({ type: 'claim_interrogation', task_id, status: 'refused', reason: fam.reason, questions: 0 });
    return I.load(state.dir, task_id);
  }
  I.save(state.dir, { ...base, status: 'pending_engine', answers: [] });
  state.append({ type: 'claim_interrogation', task_id, status: 'pending_engine', questions: questions.length, reviewer_family: fam.reviewer });
  if (!reviewerClient) return I.load(state.dir, task_id);
  let answers;
  try { answers = await reviewerClient({ engine, task_id, questions: questions.map(q => ({ n: q.n, q: q.q })) }); }
  catch (e) {
    I.save(state.dir, { ...base, status: 'engine_error', reason: clip(e && e.message, 160), answers: [] });
    state.append({ type: 'claim_interrogation', task_id, status: 'engine_error', questions: questions.length });
    return I.load(state.dir, task_id);
  }
  return storeAnswers({ dir: state.dir, append: state.append, taskId: task_id, answers, evidence });
}

// on task.end. The records go through ctx.state.append (module field set).
async function onTaskEnd({ task_id }, ctx) {
  const { state, emit, settings } = ctx;
  if (!task_id) return;
  const { report, evidence, hash } = collect(J, task_id);
  const base = { type: 'claim_audit', task_id, evidence: { records: evidence.records.length, outputs: evidence.outputs.length, sha256: hash } };
  if (!report) { state.append({ ...base, checked: 0, unverified: 0, note: 'no final message found' }); return; }
  const a = auditReport(report, evidence);
  state.append({ ...base, checked: a.claims.length, unverified: a.flagged,
    flagged: a.claims.filter(c => !c.verified).slice(0, MAX_LISTED).map(c => ({ text: clip(c.text, 200), reason: clip(c.reason, 160) })) });
  if (a.flagged && typeof emit === 'function') {
    try { await emit('claim-audit.flagged', { task_id, checked: a.claims.length, unverified: a.flagged }); } catch { /* an event never fails the audit */ }
  }
  try { await interrogate({ task_id, claims: a.claims, evidence, settings: settings || {}, state }); }
  catch (e) { process.stderr.write(`claim-audit: interrogation failed: ${clip(e && e.message, 120)}\n`); }
}

// Ask the agent to cite, and on a resume remind it of what was flagged last time.
function prepareTurn({ task_id, resumed, settings }) {
  if (!settings || !settings.ask_to_cite) return null;
  const ctx = ['When you say something is done, fixed or tested, add [j:<effect_id or stepN>] or [t:"<exact output line>"] in the same sentence. Unsupported claims are flagged.'];
  if (resumed && task_id) {
    const recs = J.readAll().records.filter(r => r.type === 'claim_audit' && r.task_id === task_id);
    const r = recs[recs.length - 1];
    if (r && r.unverified) ctx.push(`Your last report had ${r.unverified} claim(s) without matching evidence; cite them or say they are unverified.`);
  }
  return { context: ctx };
}

// status: the latest audit with the unverified sentences, and the latest interrogation.
function statusLines(Jn) {
  const all = Jn.readAll().records;
  const recs = all.filter(r => r.type === 'claim_audit');
  const r = recs[recs.length - 1];
  if (!r) return ['claims: not audited yet'];
  const lines = [`claims: ${r.checked} checked, ${r.unverified} unverified${r.note ? ` (${r.note})` : ''}`];
  for (const f of r.flagged || []) lines.push(`  unverified: "${f.text}" - ${f.reason}`);
  const qs = all.filter(x => x.type === 'claim_interrogation' && x.task_id === r.task_id);
  const q = qs[qs.length - 1];
  if (q) lines.push(`interrogation: ${q.status}${q.status === 'refused' ? ` (${q.reason})` : ` (${q.questions} questions${q.answered ? `, ${q.answered} answered, ${q.supported} supported` : ''})`}`);
  return lines;
}

const commands = {
  // claim-questions <task_id>: print the stored evidence questions.
  'claim-questions'(args, ctx) {
    const rec = I.load(ctx.state.dir, args[0]);
    if (!rec) { console.log('no interrogation stored for that task'); return; }
    console.log(JSON.stringify({ status: rec.status, reviewer_family: rec.reviewer_family, questions: rec.questions }, null, 2));
  },
  // claim-answer <task_id> <answer 1> [<answer 2> ...]: record answers from an outside reviewer run.
  'claim-answer'(args, ctx) {
    if (process.env.HARNESS_TASK_ID) { console.log('claim-answer is for the owner, not for a task'); process.exitCode = 1; return; }
    const [taskId, ...answers] = args;
    const { evidence } = collect(ctx.J || J, taskId);
    const r = storeAnswers({ dir: ctx.state.dir, append: ctx.state.append, taskId, answers, evidence });
    console.log(r ? `recorded ${r.answers.filter(a => a.answer).length} answers (${r.answers.filter(a => a.supported).length} supported)` : 'no interrogation stored for that task');
  },
};

module.exports = {
  contract: 2,
  name: 'claim-audit',
  description: 'Evidence: checks "done" / "tested" claims of the final message against the journal; optional cross-family reviewer asks 3 evidence questions. Warns, never blocks.',
  on: { 'task.end': onTaskEnd },
  prepareTurn,
  statusLines,
  commands,
  settings: {
    ask_to_cite: { type: 'boolean', default: true, description: 'add a short "cite your evidence" line to the engine prompt (and a reminder on resume after a flagged report)' },
    reviewer_engine: { type: 'string', default: '', description: 'engine/model name of a reviewer from a DIFFERENT model family; empty turns interrogation off' },
    worker_model: { type: 'string', default: 'claude', description: 'model name of the engine that does the work; the reviewer family must differ from it' },
    high_stakes_words: { type: 'array', items: 'string', default: I.DEFAULT_STAKES, description: 'words that make a verified claim high-stakes, so it is also questioned' },
  },
  api: { auditReport, checkCitations, makeQuestions: I.makeQuestions, setReviewerClient },
};
