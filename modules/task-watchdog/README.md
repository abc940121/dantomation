# task-watchdog

Loop and stall guard for tasks. Off by default; enable with `"modules": { "task-watchdog": true }`.
Observe-only unless `cancel_enabled` is set.

## What it flags

| Reason | Trigger |
|---|---|
| `no_progress` | an active task had no successful `tool.done` for `stall_minutes` (checked by a 60 s job and on every list route) |
| `repeat_error` | the same failing tool call (tool + input) `repeat_error_limit` times in a row |
| `continuations` | the task was resumed `continuation_limit` times in a row with no successful tool call between |

A successful tool call counts as progress, clears a flag and resets the counters. A flag does the following:
a `task_stalled` journal record, a `task-watchdog.stalled {task_id, reason, detail, cancelled}` event
and, only if `cancel_enabled`, `ctx.tasks.cancel(task_id)` (a failure is recorded in the flag, never thrown).

## Routes (all `owner` access, under `/m/task-watchdog`)

- `GET /stalled` flagged, not dismissed tasks
- `GET /tasks?flagged=0|1&limit=1..200` watched tasks
- `GET /tasks/:id` one task
- `POST /tasks/:id/dismiss` acknowledge a flag
- `GET /settings` current values

## Command

`dantomation watchdog [stalled|list|dismiss <task_id>]` (`dismiss` refuses inside a task).

## Settings (`task_watchdog`)

`stall_minutes` (20), `repeat_error_limit` (3), `continuation_limit` (3), `cancel_enabled` (false), `max_tracked_tasks` (200).

## Storage

One small JSON file per task in `state/m/task-watchdog/tasks/`. Tool input and results are never stored; only a
16-hex hash of a failed call is kept for the repeat check.

Test: `node modules/task-watchdog/test/task-watchdog.js`
