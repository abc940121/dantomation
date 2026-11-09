# trace decisions

1. **New module, not an extension of spend-count.** spend-count is a `beforeTool` guard that reads a transcript; trace is event-driven and has state, routes and a panel. It needs no `ctx.api('spend-count')` (that api takes a transcript path, which task events do not carry), so there is no `dependsOn` and trace works with spend-count off. The price table in the config is the shared piece.
2. **Cost only from real usage.** Today `tool.done` has no `usage`; the module accepts it when core adds it and shows "cost unknown" (null) otherwise. No estimate from tool counts.
3. **File-per-task state with a lock**, as task-watchdog does: `tool.done` fires in the guard process, `task.start` in the harness process.
4. **Timeline events are capped** (`max_events_per_task`); extras are counted in `dropped_events`. Tool input is never stored.
5. **A resume continues the timeline**; elapsed time is wall clock from the first start, so time between a stop and a resume counts.
6. **A prediction is write-once** (409 on a second). The point is to commit before the work; rewriting afterwards would defeat it. It may be recorded before `task.start` (state "predicted"); the clock starts at the start.
7. **Overrun is checked on events, at task.end, by a 30 s job and by the list routes**, flagged once per task under the task lock.
8. **The alert goes to the line owner, not to a human.** `line_owner` is part of the event payload and the status line; no push notification is sent and nothing is cancelled. Other modules decide what to do with `trace.overrun`.
9. **Predict and result routes use `access: worker`** so a task can record its own prediction; reads are owner-only.
