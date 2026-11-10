# task-grill

Asks you up to 3 questions before a vague task starts. Off by default; needs `question-cards`.

Turn it on:

    "modules": { "question-cards": true, "task-grill": true }

If `question-cards` is off, the module does not load and the error names it.

## Use

    taskmote grill "make the app better"      the front door (the server must be running)
    taskmote grill "..." --no-grill           skip the questions
    taskmote grill list                       tasks waiting for answers

Or `POST /m/task-grill/submit` with `{ "request": "...", "no_grill": false }`.
A request that starts with `!` is not grilled. `taskmote do` itself is not changed.

## What happens

A request is "vague" when it is short (or uses words like improve, clean up, fix it), names no file
or path, and has no words like should, must, so that, test. A vague request is held and you get
one card at a time: "What does done look like?", "What is out of scope?", "Anything it must not
touch?". Each card has 2 to 4 suggested answers, "Skip", and free text. Your answers are added to
the prompt as an "Owner answers" block, then the task runs.

- Skip on the first card: the task runs as is.
- No answer in `wait_minutes`: the task runs as is. It is never denied.
- Journal: `{kind: "task-grill", task_id, asked, answered, skipped, timed_out}` (counts only).

## Settings (`task_grill`)

| Setting | Default | Meaning |
|---|---|---|
| `mode` | `vague` | `vague`, `always` or `off` |
| `wait_minutes` | 30 | wait per card before running as is |

## For task agents

`taskmote grill check "<request>" --json` prints `{vague, reasons, questions}`. It works inside a task, needs no server, and makes no card and no hold. A leading `!` or an empty request is not vague.
