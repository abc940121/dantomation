# Decisions: task-board

1. **One JSON file plus a lock file.** The server, harness and workers are separate processes, so memory cannot hold the board. `board.json` is written by unique tmp + rename; every read-modify-write holds `board.lock` (exclusive create, stale after 10 s, EPERM/EACCES/EBUSY retried for Windows), copied in shape from the notifications store. A multi-process race test backs the "atomic claim" promise.
2. **Lease expiry is lazy, inside the lock.** Every locked operation first reopens claims whose lease ended, so no clock job is needed for correctness; the 30 s job only makes the `task-board.expired` event timely. Expiry is kept even when the operation itself fails.
3. **Failed tasks block dependants.** Only `done` satisfies a dependency. A failed task must be retried (owner only) so a broken step is never silently skipped.
4. **Dependencies are fixed at creation and must already exist.** That makes cycles impossible without a graph check.
5. **Workers act as themselves.** On a route the owner name is the worker's actor id, ignoring a body `owner`, so a worker cannot claim or finish as another. The owner may force a release or finish. Owner-only: add, retry, delete.
6. **Claim returns `{task: null}`, not an error, when nothing is ready.** Polling agents treat it as normal.
7. **Workspace is a git worktree, created on claim, reused on re-claim.** The folder is always `<workspace_dir>/task-<id>` (id is limited to letters, digits, `_`, `-`) and is checked to be a direct child of `workspace_dir`. If it cannot be made the claim is rolled back and the route answers 500.
8. **Cleanup removes the worktree, never the branch.** Committed work survives. Default policy `done`: a failed task keeps its workspace for inspection; `finished` also cleans failures; `never` keeps all.
9. **Coordination by events, not files.** `task-watchdog.stalled` and core `task.end` release claims tied (`task_ref`) to that harness task. No `dependsOn` on task-watchdog, so either works alone. The command sets `task_ref` from `HARNESS_TASK_ID`; routes and the api take it as a field.
10. **The api uses the last hook context.** Module api functions get no ctx, so the api uses the ctx of the most recent hook, route or command (settings, journal, emit), and before any ran uses defaults with no events. See the SEAM REQUEST in the build report.
11. **Journal records carry ids and owners, never titles or notes.** Task text is agent-written and may hold anything.
12. **Board is bounded.** `max_tasks` drops the oldest done tasks nobody waits on; if none can go, add answers 409.

## Review fixes
- Lock ownership: the lock file holds an owner token (pid plus random). Only the holder removes it.
  A stale lock is renamed aside and deleted only when the renamed file is still the stale content
  that was seen; otherwise it is restored and the waiter retries. No lock, no work: after the wait
  limit the call throws `busy`.
- A failed workspace creation releases the claim only if the task is still held by the same owner
  with the same `claimed_at`; a claim made later by someone else is left alone.
- Pruning at the cap never removes a done task that any remaining task, or the task being added,
  lists in `deps`. If nothing can be pruned the add is refused with `full`.
