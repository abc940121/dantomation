# quiet-hours

Do-not-disturb for phone pings. Off by default.

At night the ntfy module's pings are held instead of sent. When quiet hours end,
they go out as one ping: "While quiet: N updates" plus up to 5 titles.

Turn it on (it needs the `ntfy` module on too):

    "modules": { "ntfy": true, "quiet-hours": true },
    "quiet_hours": { "start": "23:00", "end": "07:30", "urgent_kinds": ["approval_waiting", "question_waiting"] }

| Setting | Default | Meaning |
|---|---|---|
| `start` | `"23:00"` | quiet window starts (24-hour local time) |
| `end` | `"07:30"` | quiet window ends; a start later than the end crosses midnight |
| `urgent_kinds` | approval and question waiting | ping kinds that always go through |

Urgent pings are never held, because a task is waiting on you. This module never
denies or answers a card or question.

## Commands

    taskmote quiet            same as status
    taskmote quiet status     window, quiet now yes/no, held count
    taskmote quiet flush      send the held pings now as one ping
    taskmote quiet on         force quiet until the next window edge
    taskmote quiet off        force not quiet until the next window edge

`flush` can be run by a routine, for example at the end of the window. Without it,
held pings are released on the next ping attempt after the window ends.

## Route

`GET /m/quiet-hours/status` (owner only) returns the window, `quiet_now`, any manual
override, the held count and up to 5 held titles.

## Notes

- Only ntfy sends to the phone. The `notifications` module is an in-app log and sends
  nothing, so there is nothing for this module to hold there.
- A bad time (for example `"25:00"`) is reported with a clear message when the server
  starts the module's job, by `taskmote quiet`, and in `taskmote status`. The module
  loader has no hook to check a setting value earlier, so until then pings are not held.
- Equal `start` and `end` means no quiet window.
- Held pings live in this module's state folder (`quiet.json`), at most 500.
- The ntfy kinds today are `task_finished`, `task_blocked` and `approval_waiting`.
  `question_waiting` is in the default list for when ntfy pings questions.

## How it hooks into ntfy

ntfy has a small generic hook: `api.setSendGate(fn)`. Before each ping, `fn({kind, task_id, text})`
may return `true` to hold it. Any other answer, or an error, sends as usual. ntfy also
has `api.sendText(text, title)` to send one plain message. Both are documented in the
ntfy module and need no core change.

Test: `node modules/quiet-hours/test/quiet-hours.js`

## For task agents

`taskmote quiet status --json` (also `taskmote quiet --json`) prints the status as one JSON object. Inside a task, `quiet on`, `quiet off` and `quiet flush` are refused with exit 2; they are for the owner.
