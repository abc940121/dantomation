# corrections: decisions

**Why a candidate, not a rule.** The cue-word check cannot tell a lasting preference from a one-off remark.
So a hit is stored as `candidate`, scoped to that task, and injected only with the label "unconfirmed, may
apply to that task only". It becomes `active` when the agent confirms it (`correction propose` with why and
scope) or the owner repeats it. The owner is never asked to confirm a candidate. A candidate never relevant
again within `candidate_days` goes `off`, not deleted.

**Why the agent proposes.** The agent knows the why and the scope; a regex does not. The injected block asks it
to call `correction propose` at once when corrected in the turn. `propose` must quote words the owner really
said this session (case and whitespace-insensitive substring of the last 20 requests seen), and needs a why,
so an agent cannot invent an instruction and attribute it to the owner.

**Injection budget is bytes.** `max_inject_bytes` (default 1500), at most `max_inject` (3) lines, rule and why
clipped. Stored count only changes the count in the header, so 500 rules inject the same size as 5.

**Relevance.** Words shared with the request: a Latin word (lowercased, crude plural strip) scores 1, a CJK
two-character bigram scores 2; eligible at `min_overlap` (2). The workdir path is not counted, or every rule
in a project would match every request. Order: repeated-2x first, then score, then newest.

**Repeat detection.** Containment `shared / min(len a, len b)` with at least 3 shared tokens and threshold
`repeat_similarity` (0.6). Containment lets a short restatement match a long rule, at the cost of sometimes
merging two near-identical rules; the owner can delete a wrong merge. A repeat sets the rule `active` and
counts `repeats`; the third repeat emits `corrections.repeated` (metadata only).

**Not blind obedience.** A rule is injected as a past statement with its why and date. The block tells the
agent: cheap and reversible, follow it and add one line of concern; costly or irreversible, discuss and ask
once with a recommendation; money, deleting outside the workdir, secrets: always ask. An active rule not
re-checked for `review_days` is flagged "still valid?".

**Owner-only edits.** `add`, `edit`, `keep`, `delete` refuse when `HARNESS_TASK_ID` is set (exit 6), and
`beforeTool` blocks an agent shell call to them or to `/m/corrections`. Routes default to owner access.

**Storage.** One `rules.json` per state dir, written by atomic rename, mode 0600, no lock (one writer per turn;
a lost update is a lost hint, not corruption). Over `max_rules`, `off` rules go first, then candidates, then the
oldest. The state log gets `{type, id}` only; texts stay in `rules.json`.

**Limits.**
- The cue-word check misses corrections phrased without a cue and can catch a non-correction. The agent's
  `propose` is the main path; the heuristic is the safety net.
- Overlap with `goals` lessons: lessons are entered by hand for the owner's weekly review; corrections are
  captured automatically and injected by relevance. They do not read each other.
- `prepareTurn` runs at turn start. A correction made mid-turn after an in-turn compaction, or in a voice turn,
  is not re-injected until the next turn; closing that needs a core hook (proposed separately).
