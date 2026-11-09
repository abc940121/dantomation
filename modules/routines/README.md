# routines

Scheduled prompts. Off by default: set `"routines": true` under `modules` in the config.

A routine is `{id, bot, prompt, schedule, paused}`. When due, a job enqueues a task for `bot` with `prompt` through `ctx.tasks.enqueue`.

## Schedules
- `every 30s|15m|2h|1d` (10 s to 31 days), counted from creation, resume or the last fire.
- Five-field cron in UTC: `m h dom mon dow` with `*`, lists, ranges and `/step`. No names, no `L/W/#`. dom and dow both restricted = either matches (standard cron).

## Routes (owner only, under `/m/routines`)
`GET /routines`, `POST /routines`, `GET|PATCH|DELETE /routines/:id`, `POST /routines/:id/pause`, `/resume`, `/run`.
Run-now answers 202, 429 when the daily cap is reached, 502 when the task could not be enqueued.

## Behaviour
- Missed runs: on start the scheduler does one pass; a routine overdue (interval or any cron minute since it was last evaluated, scanning at most 31 days) fires once, then re-arms from now. Nothing is replayed.
- Resume and schedule change re-arm from now; no backlog.
- Daily cap `max_runs_per_day` (UTC day, all routines together). Run-now counts. A failed enqueue does not count and is not retried until the next due time.
- Journal records: `routine_created/updated/deleted/fired/skipped/error`. Prompt text is never journaled.

## Settings (`routines` section)
`max_runs_per_day` (24), `max_routines` (50), `max_prompt_chars` (4000), `tick_s` (30).

State: `state/m/routines/routines.json` (atomic write). Test: `node modules/routines/test/routines.js`.
