'use strict';
// claim-audit: when a task ends, check every "done" / "tested" claim in the agent's
// final message against the journal and the recorded command outputs. A warning
// layer: it journals a claim_audit record and `status` shows it; it never blocks
// or fails the task. See README.md.
const J = require('../../lib/journal');
const { auditReport } = require('./audit');
const { collect } = require('./evidence');

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 3) + '...' : s; };
const MAX_LISTED = 20;

// on task.end. The claim_audit record goes through ctx.state.append (module field set).
function onTaskEnd({ task_id }, { state }) {
  if (!task_id) return;
  const { report, evidence, hash } = collect(J, task_id);
  const base = { type: 'claim_audit', task_id, evidence: { records: evidence.records.length, outputs: evidence.outputs.length, sha256: hash } };
  if (!report) { state.append({ ...base, checked: 0, unverified: 0, note: 'no final message found' }); return; }
  const a = auditReport(report, evidence);
  state.append({ ...base, checked: a.claims.length, unverified: a.flagged,
    flagged: a.claims.filter(c => !c.verified).slice(0, MAX_LISTED).map(c => ({ text: clip(c.text, 200), reason: clip(c.reason, 160) })) });
}

// status: the latest audit, with the unverified sentences.
function statusLines(Jn) {
  const recs = Jn.readAll().records.filter(r => r.type === 'claim_audit');
  const r = recs[recs.length - 1];
  if (!r) return ['claims: not audited yet'];
  const lines = [`claims: ${r.checked} checked, ${r.unverified} unverified${r.note ? ` (${r.note})` : ''}`];
  for (const f of r.flagged || []) lines.push(`  unverified: "${f.text}" - ${f.reason}`);
  return lines;
}

module.exports = {
  contract: 2,
  name: 'claim-audit',
  description: 'When a task ends, checks every "done" / "tested" claim of the final message against the journal; warns, never blocks.',
  on: { 'task.end': onTaskEnd },
  statusLines,
  api: { auditReport },
};
