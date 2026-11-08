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

function onTaskEnd({ task }) {
  if (!task || !task.task_id) return;
  const { report, evidence, hash } = collect(J, task.task_id);
  const base = { type: 'claim_audit', task_id: task.task_id, evidence: { records: evidence.records.length, outputs: evidence.outputs.length, sha256: hash } };
  if (!report) { J.append({ ...base, checked: 0, unverified: 0, note: 'no final message found' }); return; }
  const a = auditReport(report, evidence);
  J.append({ ...base, checked: a.claims.length, unverified: a.flagged,
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

module.exports = { name: 'claim-audit', onTaskEnd, statusLines, auditReport };
