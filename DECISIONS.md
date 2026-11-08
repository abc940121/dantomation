# Decisions

One line per decision, with the reason.

- M1: one CLI, `dantomation`, with three verbs (`do`, `status`, `undo`). Fewer verbs means nothing to memorise; the agent picks its working method inside.
- M1: `do "<request>"` starts, `do` alone resumes, `do "<request>"` while a task is open refuses and says how to resume. One open task at a time matches the journal and the executor lock.
- M1: `dantomation do` runs `bin/harness.js start|resume` as a child process. The engine logic stays in one place; `harness.js` stays the low-level command.
- M1: `status` is its own summary (open task, last finished task, undo points, modules, warnings) and never prints the raw prompt, which `harness.js status` still does.
- M1: `undo` is a command of the checkpoint module (`commands.undo`), not core code, so core keeps no reference to `modules/`. With checkpoint off, `dantomation undo` says how to turn it on and exits 1.
- M1: undo steps through agent checkpoints as a stack: each undo restores the state before the latest remaining agent change, then removes it from the stack. The restore's own safety checkpoint is not an undo point.
- M1: undo works without HARNESS_OWNER. Two protections keep agents out: the verb refuses when HARNESS_TASK_ID is set (the engine always sets it), and guard-base blocks agent commands that name `dantomation`/`harness` followed by `restore` or `undo`. A user typing in their own shell then needs no env ritual. `harness.js restore <task> <n>` keeps HARNESS_OWNER because it can jump to any checkpoint of any task.
- M1: guard-base rule (f) is a name match, not a sandbox; an obfuscated command could still get past it, and the HARNESS_TASK_ID refusal is the second layer. Real isolation needs a restricted account.
- M1: task method list (bug, change, review, unclear) goes in `config/protocol.md` as four short lines, because that file is always-on context. Written from scratch; no text taken from another project.
- M1: `unclear` means list the questions and stop, so an ambiguous request costs one message, not a wrong big change.
- M1: the review method asks for evidence (file:line or command output) and a second-model check when one is available, so findings can be verified.
- M1: `HARNESS_WORK_DIR` sets the base folder for task work dirs (default `work/`), so tests and Quickstart runs stay out of the repo.
- M1: the fake engine can send its mutating calls through the real guard hook, opt-in with `HARNESS_FAKE_GUARD=1`, so checkpoints are made by the same code path as with the real engine and the undo test needs no hand-made snapshots.
- M1: the Quickstart commands in README are extracted and run literally by `test/entry.js`, so the docs cannot drift from the CLI.
- M1: `undo` takes a fresh checkpoint before it changes anything (the restore code already does) and prints the restore line to get back, so a wrong undo is one command to reverse; test/entry.js runs undo then that restore and compares content.
- M1: undo's protection is documented as convention only (refusal in an engine plus the guard-base pattern), because a bypassed guard could still run it; the pre-undo checkpoint is the recovery.
- M2: approval-cards is a module, off by default: the stop-and-ask behaviour changes what agents may do unattended, so the owner opts in.
- M2: cards are journal records (card, card_answer, card_used) and state/cards/<id>.json is only a mirror; one fsynced append is the commit point, so a crash leaves either one pending card or none, and a resume cannot make a duplicate.
- M2: a card approves one sha256 of tool plus canonical input, once; a changed input or a second identical call needs a new card, so a yes can never be stretched to a different action.
- M2: modules may export `priority` (lower runs first, default 0); approval-cards is 50 and checkpoint 90, so guard-base and private-rule hard blocks win over cards, and no snapshot is taken for a call that is only being held.
- M2: the owner answers through the existing `do` verb (`do yes`, `do no`, or `do "yes <id>"`) and `status` lists the card, so there is no fourth verb; only a pending card turns `do <text>` into an answer.
- M2: parseAnswer is a closed word list over the whole text, not a keyword search: any extra word, hedge, question mark, mixed yes/no or unknown token gives unclear, and unclear never approves, because a wrong yes is the costly error and asking again is cheap.
- M2: an expired card counts as no and is swept (answer written once) on resume, answer or the next risky call; the resumed agent is told "denied (timeout)" through a `history_note` journal record that `buildPrompt` prints.
- M2: `onTaskStart` now runs before the prompt is built (bin/harness.js), so a module can journal a note the resumed agent sees.
- M2: the answer verb refuses inside an engine and the module blocks agent spellings of it, the same convention-level protection as undo; the clock seam is HARNESS_NOW so expiry tests need no sleeping.
- M2: the risky list is data (modules/approval-cards/default-risky.json) plus config `approval_cards.risky` rules and `skip` ids, like the private rules; deleting outside the task folder only counts when a path argument resolves outside it, and unknown paths (variables, ~) count as outside.
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
