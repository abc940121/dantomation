# task-watchdog decisions

1. **Observe-only by default.** Cancelling a task is destructive, so `cancel_enabled` is false until the owner opts in.
2. **File-per-task state, not memory.** `tool.done` fires in the guard process and `task.start` in the harness process,
   so in-memory counters would never meet. Each task has its own JSON file (atomic write by rename), which also limits
   write races to events of the same task.
3. **Progress = a successful tool call.** The contract has no other progress event. Failed calls are not progress.
4. **Repeat error = consecutive identical failures.** Signature is a hash of tool name and normalized input (plus result
   text if core adds `result` later). Any success or a different failure resets the streak. Input is hashed, never stored.
5. **Continuations.** A resumed `task.start` with no successful tool call since the previous start adds one; progress resets it.
6. **Time stall is polled.** No event fires when nothing happens, so a 60 s job and the list routes sweep active tasks.
   Jobs only run where the server runs; routes also sweep, so the owner view is always fresh.
7. **One flag per reason.** Re-triggering the same reason is a no-op (no repeated cancels or events). Progress or a new
   `task.start` clears the flag. `dismiss` hides it without clearing the task.
8. **Owner-only routes**, strict id validation (`[A-Za-z0-9_.-]{1,64}`), list caps (200), journal text clipped.
9. **Cancel failure is data.** If `ctx.tasks.cancel` rejects (today: "tasks service not available until S1"), the error
   text is stored in the flag and the task stays flagged.

## Missing seams

- Settings can only be read over HTTP: no module route can persist config (`registry.updateSettings` is server-owned).
- `tool.done` has no error text yet, so "same error" means same tool call failing, not identical message.
- Events reach only handlers in the emitting process; `task-watchdog.stalled` from the guard process does not reach the server.
- `ctx.tasks.cancel` is a stub until S1.
