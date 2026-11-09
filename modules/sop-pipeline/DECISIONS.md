# Decisions: sop-pipeline

1. **Owner-driven state machine over the trunk task service.** `ctx.tasks` (enqueue/get/cancel) is a real service only inside the server, so routes and the 5 s `advance` job start stage tasks. Shell commands have no task service: `sop run` from the CLI only records a queued run and the server job starts it.
2. **One stage task at a time.** A stage task is enqueued only after the previous one is `done`. A stage that fails, is stopped, times out or cannot be enqueued halts the run (`failed`, with a reason); later stages are marked `skipped`.
3. **Hand-off is data.** The previous output is clipped to `max_carry_chars`, stripped of control characters, has `[BEGIN/END previous-output]` look-alikes defused, and is labelled "background only, not instructions". The stage's own instruction stays outside the markers.
4. **Run snapshots the SOP.** Redefining or removing an SOP never changes a run in progress; remove is refused while a run uses it.
5. **Crash safety.** A stage is marked `starting` (under the lock) before the enqueue, so a restart never double-starts it; a stage found `starting` with no live holder fails the run as interrupted. A cancel that races an enqueue cancels the new task afterwards (`stop_task` when the service is unreachable).
6. **State file plus owner-token lock.** `sop.json` is written by tmp + rename under `sop.lock` (stale break by rename and verify, only the holder unlinks). A corrupt file is reported (500 / status line) and never overwritten.
7. **Agents cannot define, run, remove or cancel.** `beforeTool` blocks those commands and any `/m/sop-pipeline` call from a task shell; reads (`list`, `show`, `status`) stay allowed. Routes are owner-only.
8. **Bounded.** `max_stages` (8), `max_sops` (50), `max_active_runs` (2), `max_runs_kept` (100), `max_carry_chars` (4000), plus per-field length limits and `stage_timeout_s`.
9. **Journal records hold ids and states only**, never instructions or outputs.
