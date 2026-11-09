# Decisions: checkpoint

Module-owned log. Append only, one line per decision with the reason. Trunk decisions are in the root DECISIONS.md.

- M1: `undo` is a command of the checkpoint module (`commands.undo`), not core code, so core keeps no reference to `modules/`. With checkpoint off, `taskmote undo` says how to turn it on and exits 1.
- M1: undo steps through agent checkpoints as a stack: each undo restores the state before the latest remaining agent change, then removes it from the stack. The restore's own safety checkpoint is not an undo point.
- M1: undo works without HARNESS_OWNER. Two protections keep agents out: the verb refuses when HARNESS_TASK_ID is set (the engine always sets it), and guard-base blocks agent commands that name `taskmote`/`harness` followed by `restore` or `undo`. A user typing in their own shell then needs no env ritual. `harness.js restore <task> <n>` keeps HARNESS_OWNER because it can jump to any checkpoint of any task.
- M1: `undo` takes a fresh checkpoint before it changes anything (the restore code already does) and prints the restore line to get back, so a wrong undo is one command to reverse; test/entry.js runs undo then that restore and compares content.
- M1: undo's protection is documented as convention only (refusal in an engine plus the guard-base pattern), because a bypassed guard could still run it; the pre-undo checkpoint is the recovery.
- M2: fork from step N copies the snapshot with checkout-index into a new dir (not a git worktree): the shadow repo has no real work tree and a worktree would write metadata into it. The fork has no .git; the original folder is only read.
- M2: fork is a command that refuses inside an engine (HARNESS_TASK_ID), like undo; routes are owner access. Fork ids are generated here; user input is only a task id (`[\w.-]`, no separators) and a step number, and the dest is always `<base>/<generated id>` with base from settings (never inside the original folder).
- M2: fork records are capped (`max_forks`, default 20, oldest dropped). Their folders are kept unless `prune_fork_dirs` is on, so a cap never deletes work by surprise.
- M2: re-running the engine from a fork needs core support (SEAM REQUEST in the commit report); prepareTurn only adds the "continuing from step N of task X" note for a task whose workdir is a fork.
