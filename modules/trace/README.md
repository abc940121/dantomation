# trace

One timeline per task, built from core events, and predict-then-do with an overrun alert.

- Timeline: start, every tool call (name, ok, duration), end, wall-clock duration, tokens and cost when known. A resumed task continues the same timeline.
- Cost: only when `tool.done` carries an optional `usage` (core does not send it yet). Tokens times the `prices_usd_per_mtok` table in the config, the same table and cache factors as spend-count. Without usage the cost shows as unknown, never as zero.
- Predict-then-do: before the work, record a predicted duration and result. When elapsed time goes over `overrun_factor` x the prediction, the module journals `trace_overrun`, emits `trace.overrun {task_id, line_owner, predicted_ms, elapsed_ms, factor}` and adds a status line `trace: [<line owner>] task <id> is at ...`. It is aimed at the line owner (a name given with the prediction, default the predicting actor). It sends no notification and never cancels anything.

## Turn it on

    "modules": { "trace": true }

Off by default.

## Settings (section `trace`)

| Key | Default | Meaning |
|---|---|---|
| `overrun_factor` | 2 | multiple of the prediction that raises the overrun |
| `max_events_per_task` | 500 | timeline events stored per task; extras are counted |
| `max_tracked_tasks` | 200 | ended tasks kept, oldest forgotten first |

## Use

    dantomation trace predict <task_id> <minutes> [expected result]   (line owner from env HARNESS_LINE_OWNER, else owner)
    dantomation trace list
    dantomation trace show <task_id>

Routes under `/m/trace/`: `GET /tasks`, `GET /tasks/:id` (timeline), `GET /overruns?line_owner=x`, `POST /tasks/:id/predict` `{minutes|duration_ms, result?, line_owner?}` and `POST /tasks/:id/result` `{result}` (both open to a worker). Panel "Task trace" lists tasks and shows a timeline on click.

## Test

    node modules/trace/test/run.js

## Known limits

- Timeline events are timestamped when the module sees them, not when the tool ran; tool duration is core's `durationMs`.
- A running task that goes quiet is caught by the 30 s job (server only) or by the next list route; otherwise at its next event or at `task.end`.
- The predicted and the actual result are stored side by side; the module does not judge whether they match.
