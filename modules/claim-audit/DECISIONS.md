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
