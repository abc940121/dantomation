# Decisions: claim-audit

Module-owned log. Append only, one line per decision with the reason. Trunk decisions are in the root DECISIONS.md.

M5: claim-audit is a module, off by default: it adds a line to the final-report convention and a journal record per task, so the owner opts in.
M5: it is a warning layer only. onTaskEnd journals a claim_audit record and status lists the unverified sentences; the task is never blocked or failed, because a false alarm must cost one glance, not a stuck task.
M5: output evidence comes from the engine stream log (state/engine-<task>.jsonl, tool results only) read at task end, not from a new PostToolUse hook. The log already holds full outputs; a hook would need a core change and a second copy of every output in the journal.
M5: the journal gets only counts and a 16-hex sha256 of the outputs plus the unverified sentences (max 20, clipped), so it stays small and the audit is traceable without storing outputs twice.
M5: two citation forms, [j:<effect_id | journal id | stepN>] and [t:"<exact output line>"]; two short lines in protocol.md. A journal citation must name a done effect or step; a quote must be a whitespace-normalised substring of a tool result, so a changed number (38/39 for 39/39) is not found.
M5: the agent own text is never evidence for itself: only tool results and journal records count.
M5: a claim is a sentence with a completion word (English or Chinese) and none of: negation, future/modal, failure word, question. Missing a claim is cheaper than flagging a plan as a lie, so the non-claim filter wins ties.
M5: contradiction is checked on the cited line itself: FAIL, a non-zero failure count, a partial pass such as 37/39, a non-zero exit of the cited output, an UNCERTAIN cited effect, or a fraction in the claim that the quote does not show.
M5: a claim that names a file must find that file in an effect target, a command or an output; this catches a real citation pasted onto a claim about a file never written.
M5: the pure function auditReport(text, evidence) is exported and tested on its own; the fake engine gained opt-in HARNESS_FAKE_STREAM so an end-to-end test can supply a stream-json log.
E1: the folder and module name stay claim-audit; "evidence" is the capability name. Renaming would break the config key, the journal record type and the status line users already have.
E2: a flagged report emits claim-audit.flagged {task_id, checked, unverified} after the claim_audit record, as a seam for notifications; the event never fails the audit.
E3: prepareTurn adds one cite-your-evidence line (setting ask_to_cite, default true) and, on a resume after a flagged report, a count of the flagged claims. Context only: it never blocks the turn.
E4: interrogation is off unless reviewer_engine is set. When on it asks at most 3 questions, flagged claims first, then verified high-stakes claims; fewer claims are padded with follow-ups on the same claims so the reviewer always gets short, distinct questions.
E5: high-stakes means the claim sentence contains a word from high_stakes_words (a configurable substring list: deploy, production, migrat, delete, security, payment, release, push, merge and Chinese equivalents). A word list is crude but predictable and cheap; the owner can tune it.
E6: the reviewer must be from a different model family than worker_model (default claude). Same or unknown family on either side is refused: zero questions leave the module and the refusal is journaled. A wrong guess would defeat the point of a second opinion, so unknown fails closed.
E7: the engine call is a seam, not implemented: core offers no way for a module to run another engine. Questions and answers are stored (state/m/claim-audit/interrogations.jsonl) and a client can be registered with api.setReviewerClient(fn); without one the status is pending_engine. See the SEAM REQUEST in the commit report.
E8: reviewer answers go through the same citation check as the report ([j:...], [t:"..."] must exist in the task evidence, no failing line). Answers are stored with supported true/false; an uncited answer is recorded as unsupported, never dropped.
E9: the journal gets only a claim_interrogation record with status and counts; question and answer text stays in the module state file, so the journal stays small.
E10: commands claim-questions and claim-answer (via harness.js) let an outside reviewer run be recorded today; claim-answer refuses to run inside a task.

E8 (contract 6): E7 is superseded. With engine_name set the reviewer call goes through ctx.engines.run (owner-listed engines only, core caps time, prompt never journaled); empty engine_name keeps the old behaviour (pending_engine, setReviewerClient still works). No spawning code existed in the module, so none was removed. No hooks, so no hookTimeoutMs.
