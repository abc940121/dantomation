'use strict';
// task-grill logic: the vague-request check, the three questions and their suggested answers,
// the "Owner answers" block, and the hold state machine. Pure apart from the io it is given,
// so tests drive it with a fake question store and a fake clock.

const STAGES = [
  { key: 'done', label: 'Done looks like', text: 'What does done look like?' },
  { key: 'out', label: 'Out of scope', text: 'What is out of scope?' },
  { key: 'avoid', label: 'Must not touch', text: 'Anything it must not touch?' },
];
const SKIP = 'Skip';
const MAX_ANSWER = 500;

const VAGUE_VERBS = /\b(improve|make (it|this|that) (better|nicer|cleaner)|fix (it|this|that|things|stuff)|clean ?up|tidy|polish|optimi[sz]e|refactor( it)?|update (it|this)|enhance|tweak|sort out|look into|deal with)\b/i;
const ACCEPTANCE = /\b(should|must|so that|ensure|test|tests|passes?|passing|expect(ed)?|acceptance|done when)\b/i;
const PATHISH = /([\w.-]+[\/][\w.\/-]+|\b[\w-]+\.(js|ts|tsx|jsx|json|md|py|css|html|yml|yaml|sh|go|rs|java|cs|txt)\b)/i;
const SHORT_WORDS = 14;

const words = s => String(s || '').trim().split(/\s+/).filter(Boolean);

// A leading "!" bypasses the grill. Returns {request, bypass}.
function parse(raw) {
  let s = String(raw == null ? '' : raw).trim();
  let bypass = false;
  if (s.startsWith('!')) { bypass = true; s = s.slice(1).trim(); }
  return { request: s, bypass };
}

// Cheap local heuristic. Vague = no acceptance words, no file or path, and either short or built on a vague verb.
function looksVague(request) {
  const s = String(request || '');
  if (ACCEPTANCE.test(s) || PATHISH.test(s)) return false;
  return words(s).length <= SHORT_WORDS || VAGUE_VERBS.test(s);
}

// A pure read for an agent: {vague, reasons, questions}. No hold, no card. A leading "!" is never vague.
function check(raw) {
  const { request, bypass } = parse(raw);
  if (!request) return { vague: false, reasons: ["request is empty"], questions: [] };
  if (bypass) return { vague: false, reasons: ["starts with !: not grilled"], questions: [] };
  const vague = looksVague(request);
  const reasons = [];
  if (vague) {
    if (words(request).length <= SHORT_WORDS) reasons.push(`short (${words(request).length} words)`);
    if (VAGUE_VERBS.test(request)) reasons.push("built on a vague verb (improve, clean up, fix it ...)");
    reasons.push("no acceptance words (should, must, test, passes ...) and no file or path");
  }
  return { vague, reasons, questions: vague ? STAGES.map(s => s.text) : [] };
}

// mode: "vague" (default) | "always" | "off". Returns true when the owner should be asked.
function shouldGrill(request, mode) {
  if (mode === 'off') return false;
  if (!String(request || '').trim()) return false;
  return mode === 'always' ? true : looksVague(request);
}

const clip = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 3) + '...' : s; };

// What the request is about, in a few words (for suggested answers). Never invents facts.
function subject(request) {
  const w = words(request).slice(0, 8).join(' ').replace(/[.!?,;:]+$/, '');
  return clip(w || 'the request', 40);
}

// 2 to 4 suggested answers for a stage, derived from the request, plus Skip (3 to 5 options in all).
function suggestions(stageIndex, request) {
  const sub = subject(request);
  const sets = [
    [`"${sub}" works and I can check it`, 'A test covers it and passes', 'A short summary of what changed'],
    ['Anything not about this request', 'No new features or refactors', 'Do not change the public behaviour'],
    ['Config and secrets', 'Tests and build files', 'Files unrelated to this request'],
  ];
  const out = (sets[stageIndex] || sets[0]).map(x => clip(x, 100));
  return [...new Set(out), SKIP];
}

function cardText(stageIndex, request) {
  return clip(`(${stageIndex + 1}/${STAGES.length}) ${STAGES[stageIndex].text} Task: ${clip(request, 160)}`, 480);
}

function answersBlock(answers) {
  const rows = answers.filter(a => a && a.text).map(a => `- ${STAGES[a.stage].label}: ${clip(a.text, MAX_ANSWER)}`);
  return rows.length ? `\n\nOwner answers:\n${rows.join('\n')}` : '';
}

const finalPrompt = (request, answers) => request + answersBlock(answers);

// ---- hold state machine
// hold: {id, request, bot?, workdir?, grill: bool, stage, answers[], asked, answered, skipped, timed_out,
//        qid, asked_at (ms), created_at}
function newHold(id, raw, o = {}) {
  const p = parse(raw);
  const bypass = p.bypass || o.noGrill === true;
  const grill = !bypass && shouldGrill(p.request, o.mode || 'vague');
  return { id, request: p.request, ...(o.bot ? { bot: o.bot } : {}), ...(o.workdir ? { workdir: o.workdir } : {}),
    grill, stage: 0, answers: [], asked: 0, answered: 0, skipped: 0, timed_out: false, qid: null, asked_at: null, created_at: o.now };
}

// One step. io: {now(), ask(text, options) -> qid, get(qid) -> {state, answer:{option,free_text}}|null,
// cancel(qid), start(prompt, hold) -> task_id, journal(rec), save(hold), drop(hold)}.
// Returns 'started' (hold finished, task started) or 'waiting'.
async function step(hold, io, settings) {
  const waitMs = (Number(settings && settings.wait_minutes) || 30) * 60000;
  const finish = async () => {
    const task_id = await io.start(finalPrompt(hold.request, hold.answers), hold);
    if (hold.grill) io.journal({ type: 'task_grill', kind: 'task-grill', task_id, asked: hold.asked, answered: hold.answered, skipped: hold.skipped, timed_out: hold.timed_out });
    io.drop(hold);
    return 'started';
  };
  if (!hold.grill) return finish();

  if (!hold.qid) {
    hold.qid = await io.ask(cardText(hold.stage, hold.request), suggestions(hold.stage, hold.request));
    hold.asked++; hold.asked_at = io.now();
    io.save(hold);
    return 'waiting';
  }
  const q = await io.get(hold.qid);
  const stale = !q || q.state === 'expired' || q.state === 'cancelled' || (q.state === 'pending' && io.now() - hold.asked_at >= waitMs);
  if (stale) {
    // Never deny: run as is (with whatever was answered so far) and say why in the journal.
    if (q && q.state === 'pending') { try { await io.cancel(hold.qid); } catch { /* best effort */ } }
    hold.timed_out = true;
    return finish();
  }
  if (q.state === 'pending') return 'waiting';

  const a = q.answer || {};
  const text = a.free_text || (a.option && a.option !== SKIP ? a.option : '');
  if (text) { hold.answers.push({ stage: hold.stage, text }); hold.answered++; } else hold.skipped++;
  if (!text && hold.stage === 0) return finish(); // Skip on the first card: run as is
  hold.stage++; hold.qid = null; hold.asked_at = null;
  if (hold.stage >= STAGES.length) return finish();
  io.save(hold);
  return step(hold, io, settings);
}

module.exports = { STAGES, SKIP, parse, check, looksVague, shouldGrill, suggestions, cardText, answersBlock, finalPrompt, newHold, step };
