'use strict';
// engine-router policy: pure functions, no IO. The module (index.js) feeds them
// state and journal records and applies the result.

const ROLES = ['planner', 'editor'];
const DEFAULT_MUTATING = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'];

const PLAN_RE = /\b(plan|design|architect|investigate|diagnose|why|decide|compare|strategy|approach|review|analy[sz]e|research|break (it )?down|outline|propose)\b/i;
const EDIT_RE = /\b(rename|replace|typo|format|reformat|lint|bump|add (a )?(comment|import|test)|move|delete|remove|apply|refactor|edit|change)\b/i;

// classifyStep(text) -> 'planner' | 'editor'. Planning words win: a step that
// mixes planning and editing needs the strong engine. Unknown text goes to the
// planner (fail toward the stronger engine, never silently to the cheap one).
function classifyStep(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return 'planner';
  if (PLAN_RE.test(s)) return 'planner';
  if (EDIT_RE.test(s)) return 'editor';
  return 'planner';
}

// engineList(engines, role) -> ordered unique non-empty string ids for the role.
function engineList(engines, role) {
  const raw = engines && Array.isArray(engines[role]) ? engines[role] : [];
  return [...new Set(raw.map(String).filter(Boolean))];
}

// pickEngine(role, engines, failed) -> { engine, role, exhausted }.
// First engine of the role not in `failed`. When every engine of the role has
// failed, fall back to the other role's untried engines (an editor stuck twice
// escalates to the planner engines); when nothing is left, exhausted is true
// and the first engine of the role is returned so the caller still has a value.
function pickEngine(role, engines, failed = []) {
  const r = ROLES.includes(role) ? role : 'planner';
  const o = r === 'planner' ? 'editor' : 'planner';
  const bad = new Set((failed || []).map(String));
  const own = engineList(engines, r), other = engineList(engines, o);
  const pick = own.find(e => !bad.has(e));
  if (pick) return { engine: pick, role: r, exhausted: false };
  const alt = other.find(e => !bad.has(e));
  if (alt) return { engine: alt, role: o, exhausted: false };
  return { engine: own[0] || other[0] || null, role: r, exhausted: true };
}

// newState(step, engine) -> fresh per-step counter.
function newState(step, engine) { return { step: String(step || ''), engine: engine || null, fails: 0, failed_engines: [], switch: false }; }

// recordOutcome(state, ok, limit) -> new state. A success resets the streak. A
// failure adds one. `limit` consecutive failures mark the engine failed and set
// switch: true.
function recordOutcome(state, ok, limit = 2) {
  const s = { ...state, failed_engines: [...(state.failed_engines || [])] };
  if (ok) { s.fails = 0; s.switch = false; return s; }
  s.fails = (s.fails || 0) + 1;
  s.switch = s.fails >= limit;
  if (s.switch && s.engine && !s.failed_engines.includes(s.engine)) s.failed_engines.push(s.engine);
  return s;
}

// startStep(state, step, engine) -> state for a step. Same step keeps its counters
// and failed engines; a different step resets them.
function startStep(state, step, engine) {
  if (state && state.step === String(step || '')) return { ...state, engine: engine || state.engine };
  return newState(step, engine);
}

// halfDone(records, taskId, mutating) -> { halfDone, since, mutations[] }.
// Looks at the journal for work the failing engine may have left in place: the
// successful mutating tool calls (tool_done ok:true) of this task after the last
// engine_start or router_switch record. Failed calls do not count. A reply or
// task_done after them means the step finished.
function halfDone(records, taskId, mutating = DEFAULT_MUTATING) {
  const mut = new Set(mutating);
  const mine = (records || []).filter(r => r && r.task_id === taskId);
  let from = -1;
  mine.forEach((r, i) => { if (r.type === 'engine_start' || (r.type === 'router_switch' && r.module === 'engine-router')) from = i; });
  const tail = mine.slice(from + 1);
  const mutations = tail.filter(r => r.type === 'tool_done' && r.ok === true && mut.has(r.tool)).map(r => ({ tool: r.tool, id: r.id }));
  const finished = tail.some(r => r.type === 'reply' || r.type === 'task_done');
  return { halfDone: mutations.length > 0 && !finished, since: from, mutations };
}

// decide({state, records, taskId, engines, role, mutating}) -> decision.
// action: 'stay' (keep the engine), 'switch' (change engine, nothing half done),
// 'switch_with_handoff' (change engine; the new one must first inspect the
// workdir and finish or undo the listed half-done work), 'exhausted' (no engine left).
function decide({ state, records, taskId, engines, role, mutating = DEFAULT_MUTATING }) {
  const st = state || newState('', null);
  const want = ROLES.includes(role) ? role : 'planner';
  const failed = st.failed_engines || [];
  if (!st.switch) {
    const cur = st.engine && !failed.includes(st.engine) ? st.engine : null;
    if (cur) return { action: 'stay', engine: cur, role: want, halfDone: false, mutations: [] };
    const p = pickEngine(want, engines, failed);
    return { action: p.exhausted ? 'exhausted' : 'stay', engine: p.engine, role: p.role, halfDone: false, mutations: [] };
  }
  const p = pickEngine(want, engines, failed);
  const h = halfDone(records, taskId, mutating);
  if (p.exhausted) return { action: 'exhausted', engine: null, role: p.role, halfDone: h.halfDone, mutations: h.mutations };
  return { action: h.halfDone ? 'switch_with_handoff' : 'switch', engine: p.engine, role: p.role, halfDone: h.halfDone, mutations: h.mutations };
}

// handoffNote(decision) -> one line for the new engine's prompt, or ''.
function handoffNote(d) {
  if (!d || (d.action !== 'switch' && d.action !== 'switch_with_handoff')) return '';
  if (d.action === 'switch') return `engine switched to ${d.engine} (${d.role}) after repeated failures; no earlier edits found in the journal.`;
  const tools = [...new Set(d.mutations.map(m => m.tool))].join(', ');
  return `engine switched to ${d.engine} (${d.role}) after repeated failures. The earlier engine left ${d.mutations.length} successful change(s) (${tools}). Inspect the working tree (git status / diff) first; finish or undo that work before starting the step again.`;
}

module.exports = { ROLES, DEFAULT_MUTATING, classifyStep, engineList, pickEngine, newState, recordOutcome, startStep, halfDone, decide, handoffNote };
