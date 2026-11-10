# notifications

In-app notification log for the owner. Off by default: `"modules": { "notifications": true }`.

## What it records

| kind | event it listens to | text |
|---|---|---|
| `card_pending` | `card.created` | "Approval needed: <summary>" |
| `task_finished` | `task.end` with `code` 0 | "Task finished" |
| `task_failed` | `task.end` with any other code | "Task failed (exit N)" |
| `question_asked` | `question.asked {question_id, task_id, text}` | "Question: <text>" |
| `digest` | `digest.ready {text}` (from the digest module's `--push`) | the digest text, first 1000 characters |
| `room_mention` | `rooms.mention {room, target, text, msg_id}`, only when `target` is `owner` | "Mention in <room>: <text>" |

No module emits `question.asked` or `rooms.mention` yet, so those two kinds stay empty
until one does. Events reach this module only inside the process that emits them (the
contract has no cross-process transport yet).

Text is capped at 200 characters, control characters are removed and token-like strings
(`Bearer ...`, `token=...`, long hex or base64 runs) are replaced with `[hidden]`. The
journal gets only `notification_created {n_id, kind}`.

## Routes (all `owner`), under `/m/notifications`

- `GET /list?unread=1&offset=0&limit=50` newest first, `limit` 1..200 -> `{total, offset, limit, items}`
- `GET /unread-count` -> `{unread}`
- `POST /:id/read` -> the entry, or 404
- `POST /read-all` -> `{marked}`
- `GET /kinds` -> `{kinds: {kind: bool}}` (effective values)
- `PATCH /kinds` body `{kind: true|false|null}` (`null` clears the override)

Entry: `{id, kind, text, ref, task_id, ts, read}`. Invalid input answers 400.

## Settings (config section `notifications`)

- `max_entries` integer 10..5000, default 500. Over the cap, read entries are pruned first, oldest first, then unread ones.
- `kind_card_pending`, `kind_question_asked`, `kind_task_failed`, `kind_task_finished`, `kind_room_mention`, `kind_digest`: boolean, default true. A runtime override set with `PATCH /kinds` wins over the setting.

State: `state/m/notifications/notifications.json` and `prefs.json`.
Status line: `notifications: N unread`.

Test: `node modules/notifications/test/notifications.js`
