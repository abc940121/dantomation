# Decisions: change-card

Module-owned. Append only.

- Dependencies use `dependsOn` (checkpoint, question-cards). If either is off the loader reports a load error naming it; the module does not run.
- The answer arrives later than `task.end`, so the card is remembered in `state/m/change-card/pending.json` and settled on the `question.answered` event. No answer (expired or withdrawn) changes nothing: there is no auto-undo.
- Diff stats are `git diff-tree --numstat` between the task's first snapshot and the folder now, in checkpoint's shadow repo (`diffstat` in checkpoint). Binary files count 0 lines.
- Journal: one record when the card is raised (`answer: "pending"`) and one when it is settled (`keep`, `undo`, `undo_blocked`, `undo_failed`, `none`).
- Two small api additions in other modules were needed because the card cannot be raised or undone through their old api: `question-cards` api `ask`, `checkpoint` api `restore` and `diffstat`.
