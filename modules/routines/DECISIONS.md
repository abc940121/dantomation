# routines: decisions

1. Time is UTC for cron: no timezone database, results are the same on every machine.
2. One cursor per routine (cron) or next_at (interval) instead of a run log: fire at most once per pass, so a restart after downtime fires once and never floods.
3. Missed-run catch-up is scanned minute by minute over at most 31 days; cheap and bounded.
4. Delivery is fire-and-forget through ctx.tasks.enqueue(bot, prompt); reply handling stays with the task service. Failures are recorded on the routine and journaled, not retried.
5. Daily cap is global and counts run-now, so a runaway definition or a script hammering run-now cannot spend without bound.
6. Strict input validation: unknown fields refused, id and bot shapes fixed, prompt length capped, routine count capped.
7. One in-process write lock around the state file; routes and the scheduler share it.
8. Journal never carries prompt text.
9. Scheduler is a start-style job (immediate pass, then setInterval inside the job) so startup catch-up happens at once, not after the first interval.

Missing seam: none blocking. ctx.tasks was used as in rooms; there is no seam to receive a reply or tag a task as scheduled.
