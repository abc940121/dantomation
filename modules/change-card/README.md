# change-card

When a task ends and it changed files, you get one card on your phone:

    Task t-12 changed 3 files (+20 −4): a.txt, b.txt, c.txt

Choices: **Keep** or **Undo**.

- Keep closes the card. Files stay as they are.
- Undo puts the task folder back to how it was before the task's first change. It uses the checkpoint module's restore, so the undo itself can be undone (`taskmote undo --to <n> <task>`). Files the task added are removed.
- No answer: nothing happens. The card expires with the question-cards timeout. It never undoes by itself.
- The list shows up to 8 files, then `+k more`.
- No card when the task changed fewer files than `min_files`, or none.

The counts come from the checkpoint shadow repo (first snapshot of the task against the folder now). The folder's own `.git` is never written.

## Turn it on

Off by default. It needs `checkpoint` and `question-cards` on too. If one is off, the loader reports a load error that names it.

    "modules": { "checkpoint": true, "question-cards": true, "change-card": true },
    "change_card": { "min_files": 1 }

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `min_files` | 1 | Ask only when the task changed at least this many files |

## Journal

One line when the card is raised and one when it is settled:
`{kind:"change-card", task_id, files, added, removed, answer}` where answer is `pending`, `keep`, `undo`, `undo_blocked`, `undo_failed` or `none`.

## Test

    node modules/change-card/test/change-card.js

## For task agents

`taskmote changes [status] [--json]` lists the Keep / Undo cards still waiting: `{"pending":[{question_id, task_id, files, added, removed}]}`. It is read only.
