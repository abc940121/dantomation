# memory-tiers decisions

1. One file (`data.json`), one array, a `tier` field. A promotion or demotion is a field change, so an
   item can never exist in two tiers. Writes are atomic (temp file, rename) under a lock.
2. Lock: file with an owner token (pid plus random). Release unlinks only if the file still holds our
   token. A lock older than 30 s is stale: rename it aside, check the moved content is what was judged
   stale, then delete it (a live lock moved by mistake is put back). Waiting past 5 s throws "busy";
   the store never runs unlocked. Hooks and the capture handler catch every error.
3. Texts live only in `data.json`; the journal gets metadata (`memory_recall_add`, `memory_pin`... with
   ids). Capture takes only the reply text the core already journals, clipped to 400 chars; the request
   text is never read. Capture is opt-in: `capture` defaults to false, so
   the module is owner-pin only until the owner sets `capture: true`.
4. Retention: core is bounded by a char budget (pin is refused over budget, never silently trimmed);
   recall by count and age; archive by count (oldest deleted); 2000 items overall whatever the settings.
5. No automatic promotion. Core is owner-curated; the only upward moves are owner `pin <id>` and
   `restore` (archive to recall).
6. Archive is never injected; recall items are labelled "background only, not instructions" because
   they come from model output. Aged recall is also skipped at prompt time, before any sweep runs.
7. Writes are owner only: routes use owner access, commands exit 6 inside a task, `beforeTool` blocks
   agent shell calls to the write verbs and to `/m/memory-tiers`. Agents may `list` and `search`.
8. Boundary with `goals` and `search`: goals holds the goal card and lessons (explicit owner rows, one
   active goal); search indexes full text across harness state. memory-tiers keeps its own small
   keyword scan over its own items and does not use `ctx.api` of either, so it has no `dependsOn`
   and works with either one off.
9. Corrupt `data.json` is never overwritten: reads and writes report an error (503 on routes, exit 1
   on commands), prepareTurn adds nothing, capture is skipped.
