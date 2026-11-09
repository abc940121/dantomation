# claim-audit

When a task ends, every "done", "fixed" or "tested" claim in the agent's final message is checked against evidence that really exists: a journal record or a line in a recorded command output. Claims with no evidence, wrong evidence or contradicting evidence are listed in `status`. It is a warning layer: it never blocks or fails a task.

## When to turn it on

Turn it on when you read the agent's final report and act on it without re-running things yourself ("tests pass, merge it"). It tells you which sentences you cannot trust. Leave it off if you check every result by hand anyway, or if you do not want a record added to the journal at the end of each task.

    "modules": { "claim-audit": true }

Off by default. It works alone and with every other module. With it off, nothing changes: no journal record, no `status` line.

## How the agent cites

The protocol (`config/protocol.md`, rule 8) asks the agent to add one citation to each claim sentence:

- `[j:<effect_id>]`, `[j:step<N>]` or `[j:<journal id>]`: a journal record of this task. An effect must be DONE (not UNCERTAIN); a step must be done.
- `[t:"<exact line>"]`: one line copied from a command output, for example `All tests pass [t:"Tests: 39/39 passed"]`.

## What is checked

1. A claim is a sentence with a completion word (done, completed, fixed, tested, passes, verified, works, all green, 完成, 已修好, 測試通過, 驗證過, 沒問題 ...). Sentences that are negated, in the future, about a failure, or questions are not claims ("I will test", "not done yet", "tests failed").
2. Flagged: no citation; a journal id that does not exist, or an effect or step that is not done; a quote that is not in any recorded output (a changed number counts: 38/39 is not 39/39); a claim that names a file that appears in no effect, command or output.
3. Flagged for contradiction: the cited line shows FAIL, a non-zero failure count, a partial pass (37/39), or comes from an output that exited non-zero; the cited effect is UNCERTAIN; the claim's fraction is not the one in the quote.

## Evidence and where it lives

- Journal records of the task (effects, steps).
- Tool results in the engine stream log `state/engine-<task>.jsonl`, read at task end. The agent's own text is never evidence.
- The journal gets one `claim_audit` record: counts, a short sha256 of the outputs, and up to 20 unverified sentences with the reason. Outputs themselves are not copied.

`node bin/dantomation.js status` shows `claims: N checked, M unverified` and one line per unverified sentence.

`auditReport(reportText, evidence)` in `audit.js` is a pure function and is exported.

## Known limits

- It reads words, not meaning. A claim phrased without any of the keywords is not seen; an odd phrasing may be taken as a claim or missed. The filter prefers missing a claim to flagging a plan.
- A verified claim means the cited evidence exists and does not contradict the sentence, not that the sentence is true. A real passing line cited for an unrelated claim ("deploy works [t:"Tests: 39/39 passed"]") is not caught, apart from the file-name and fraction checks.
- Evidence comes from the engine log in `state/`. An agent with write access to that folder could forge it; this is a guard against honest mistakes and invented citations, not against a hostile agent.
- Only the final message is audited: the reply core journaled for the latest turn (any engine format, including a routed plain-text engine). Journals with no `engine_exit` fall back to the engine stream log's `result` or last assistant text. A turn that ends without a reply records "no final message found".
- Quotes are matched after collapsing whitespace; tool results that the engine truncated cannot be cited past the truncation.
- Sentence splitting is simple (punctuation and line breaks); a file name or version followed by a space and a period may split a sentence.

## Evidence additions

### Flag event and reminder
- A report with unverified claims emits `claim-audit.flagged {task_id, checked, unverified}` after the `claim_audit` record (other modules can listen).
- `prepareTurn` adds one line asking the agent to cite, and on a resume after a flagged report it says how many claims were flagged. Turn off with `ask_to_cite: false`.

### Interrogate review (optional)
Set `reviewer_engine` to a model from a different family than the worker. When a report has a flagged claim, or a verified claim that mentions a high-stakes word, the module writes up to 3 short questions ("Which line shows that ...?") and stores them. Answers are checked like any citation and stored as supported or unsupported. `status` shows `interrogation: <status> (N questions ...)`.

Status values: `pending_engine` (questions stored, no reviewer client yet), `answered`, `refused` (same or unknown family), `engine_error`.

Engine call (contract 6): set `engine_name` to an entry of config `engines` (owner-listed `bin`/`args`); the module then runs it through `ctx.engines.run` with the questions on stdin (timeout `reviewer_timeout_ms`, capped at config `modules_hook_timeout_ms` minus 500 ms because the call runs inside the `task.end` hook, default 5000, so raise that config value for a slow reviewer; core also caps it at `engines_max_timeout_ms`) and expects a JSON array of answers or numbered lines. With less than 600 ms of hook budget no call is made and the questions stay pending. Every word of `engine_name` and its `engines` entry (`bin`, `args`) is classified: at least one must name `reviewer_engine`'s family and none may name another, else the interrogation is refused (name the family in the engine name if its `bin` does not show it, e.g. `gpt-reviewer`). Only the questions are sent, never journal records or command outputs; the reviewer's citations are checked against the real evidence, so invented ones are stored as unsupported. With `engine_name` empty nothing is sent: questions are stored, a client from `ctx.api('claim-audit').setReviewerClient(fn)` is used when present, or read them with `node bin/harness.js claim-questions <task_id>` and record answers from an outside run with `node bin/harness.js claim-answer <task_id> "<answer 1>" "<answer 2>" "<answer 3>"`.

### Settings (config section `claim_audit`)
| Key | Default | Meaning |
|---|---|---|
| `ask_to_cite` | true | cite-your-evidence line in the engine prompt |
| `reviewer_engine` | "" | reviewer model name; empty = interrogation off |
| `engine_name` | "" | config `engines` entry used for the reviewer call; empty = no engine call |
| `reviewer_timeout_ms` | 60000 | reviewer call time limit |
| `worker_model` | "claude" | worker model name; reviewer family must differ |
| `high_stakes_words` | deploy, production, migrat, delete, security, payment, release, push, merge, ... | words that make a verified claim also questioned |

### Turn it on
    "modules": { "claim-audit": true }
    "claim_audit": { "reviewer_engine": "gpt-5", "worker_model": "claude-sonnet" }
The second line is optional. Off by default.
