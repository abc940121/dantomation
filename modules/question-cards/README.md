# question-cards

A bot or task asks the owner a plain question with 2 to 6 choices (and optional
free text), then reads the answer. Approval-cards covers risky actions; this is
for everything else ("which colour?", "ship today?"). Off by default:

```json
{ "modules": { "question-cards": true }, "question_cards": { "timeout_minutes": 60, "max_pending": 50 } }
```

## Flow

1. Asker: `dantomation question ask "Which colour?" Red Green Blue --free` prints
   `{"question_id":"q-1a2b3c",...}`. Inside a task the question is tied to
   `HARNESS_TASK_ID`.
2. Owner: sees it in the `Questions` chat panel, `status`, or
   `dantomation question list`, and answers with a button, the route, or
   `dantomation question answer q-1a2b3c 2 [free text]`.
3. Asker polls `dantomation question get q-1a2b3c` (state `pending | answered |
   cancelled | expired`, plus `answer`). The answer also lands in the task's
   history as a note, so a resumed task sees it.

## Commands (`question`)

`ask "<text>" <opt> <opt> ... [--free]`, `get <id>` (a task reads only its own),
`list`, `answer <id> <number|option> [text]`, `cancel <id>`. `list`, `answer`
and `cancel` refuse inside a task (exit 6) and the guard blocks agents from
typing them.

## Routes (`/m/question-cards`, owner access)

| Route | Purpose |
|---|---|
| `GET /questions` | pending |
| `GET /questions/recent` | last 20 answered, cancelled or expired |
| `GET /questions/:id` | one question and its answer |
| `POST /questions` | ask `{text, options, allow_free?, task_id?}` -> 201 |
| `POST /questions/:id/answer` | `{choice?: 1-based number or option text, text?}` |
| `POST /questions/:id/cancel` | withdraw |

Errors: 400 bad input, 403 not owner, 404 unknown, 409 already decided or
expired, 429 too many pending.

## Events

`question.asked`, `question.answered {question_id, task_id, choice, option,
free_text, who, where}`, `question.cancelled`, `question.expired`, each after
its journal record. Declared as `emits: ['question']`.

## Limits

Text 500 chars, option 100 chars (one line, unique ignoring case), free text 500,
no control characters. Settings: `timeout_minutes` (default 60), `max_pending`
(default 50).

## Tests

`node modules/question-cards/test/question-cards.js` prints `result: N/N`.
