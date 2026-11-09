# ntfy

Optional push pings to your phone through [ntfy](https://ntfy.sh) (Apache-2.0). It only pings; approving stays in `approval-cards`. Off by default: `"modules": { "ntfy": true }`. It stays silent until a topic is set.

No ntfy code is used. Each ping is one HTTP POST to `<server>/<topic>` with a plain-text body.

## Events

| ping | event | message |
|---|---|---|
| task finished | `task.end` with `code` 0 | `Task finished: <task id>` |
| task blocked | `task-watchdog.stalled`, or `task.end` with a non-zero `code` | `Task blocked: <task id>` (with `(exit N)` for an exit) |
| approval waiting | `card.created` | `Approval waiting: <task id>` |

The message holds only the kind, the task id and, if `include_title` is on, the first line of the task request (ASCII, 60 characters). Card summaries, watchdog details, commands and file contents are never sent. If `app_url` is set it is sent as the tap-to-open link.

## Setup

1. Install the ntfy app on your phone (or use the web app at your server).
2. Pick a hard-to-guess topic name (4 to 64 letters, digits, `_` or `-`) and subscribe to it in the app. On the public server anyone who knows the topic can read it.
3. Store it: `echo my-long-random-topic | node bin/harness.js secret ntfy topic`
4. Turn the module on in the config. For a self-hosted server set `ntfy.server`.

## Settings (config section `ntfy`)

- `server` string, default `https://ntfy.sh` (http or https, no credentials in the URL)
- `topic` secret, write-only, never logged; the journal gets `ntfy_sent {kind, task_id, ok, status, why?}` only; with a topic set, dropped pings (bad topic, bad server, rate cap, timeout, network) are journaled too
- `app_url` string, default empty
- `include_title` boolean, default false
- `kind_task_finished`, `kind_task_blocked`, `kind_approval_waiting` booleans, default true
- `max_per_minute` integer 1..600, default 20; extra pings are dropped
- `timeout_ms` integer 500..4500, default 4000

A failed send never stops a task. `taskmote status` shows one ntfy line: no topic (silent), the last ping sent, or the last failure and which setting to fix. Events reach this module only inside the process that emits them (no cross-process transport yet), so a card created in another process does not ping.

Test: `node test/run-all.js module ntfy`
