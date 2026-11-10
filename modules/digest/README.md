# digest

A short summary of what happened while you were away. Off by default.

Enable: `"modules": {"digest": true}`.

## Use

    taskmote digest [--since <ISO|12h|2d>] [--json] [--push]

- `--since` takes an ISO date/time (`2026-01-31T08:00:00Z`) or a span (`30m`, `12h`, `2d`). Bad input exits 2.
- Without `--since` it uses the time of the last digest run, or the last 24 hours (setting `default_hours`).
- The output has counts first, then up to 10 lines: waiting approval cards and questions, failed tasks, stalls, overruns, unverified claims, tripwire hits.
- The last-run time is kept in this module's state folder. Only the command updates it.

Route: `GET /m/digest/digest?since=` returns the same data as JSON (owner only).

## Data it reads

The journal record types `task_start`, `task_done`, `queue_fail`, `card`, `card_answer`, `question*`, `claim_audit`, `tripwire`, `task_stalled` and `trace_overrun`. A source with no records counts as zero. Spend comes from `logs/spend.jsonl` (written by spend-count; `HARNESS_LOG_DIR` moves the folder): each session's growth inside the window, summed. No file means no spend line.

## Push

`--push` emits the event `digest.ready` with `{text}`, only when `notifications` or `ntfy` is on. This module opens no network connection. `ntfy` pings it and `notifications` records it.

## For task agents

`taskmote digest --json` works inside a task. There it is read only: `--push` is refused (exit 2) and the "since last run" mark is not moved.
