# checkpoint

Makes every agent edit undoable. Inside a harness task (`HARNESS_TASK_ID`, `HARNESS_TASK_DIR` set by `runEngine`), the module snapshots the task folder before every mutating tool call: Write, Edit, MultiEdit, NotebookEdit, and any Bash/PowerShell command that is not a plain read-only one (ls, cat, grep, git status/log/diff, ...).

- The snapshot goes into a private shadow repo `state/ckpt/repo.git` with a private index (`GIT_INDEX_FILE` = `state/ckpt/<task>.index`), then commit-tree, stored as `refs/harness/ckpt/<task>/<n>`. The folder's own `.git`, index, HEAD, branches and files are never written. Files are stored byte-for-byte (no eol conversion or filters). The code is in `checkpoint.js`.
- It honours `.gitignore` and `.git/info/exclude`, and skips files over 5 MB and nested repos. The journal line `{kind:"checkpoint", task_id, n, ref, sha, tool, files, skipped, ms}` lists what was skipped.
- If a checkpoint fails, the tool call is blocked (fail closed).
- `restore` is a command this module adds to `harness.js` (the core dispatches unknown subcommands to module `commands`):

      HARNESS_OWNER=1 node bin/harness.js restore <task> <n>
      # PowerShell: $env:HARNESS_OWNER='1'; node bin/harness.js restore <task> <n>

  It is owner-only (exit 6 without `HARNESS_OWNER=1`), refuses while an executor runs (exit 4), and first takes a fresh checkpoint so a restore can be undone. It rewrites the snapshot's files and deletes files added since; ignored and > 5 MB files are left alone. The rule that blocks agents from naming `HARNESS_OWNER` or `harness restore` is in guard-base. With checkpoint off, `harness.js restore` gives a usage error (exit 2).

- `undo` (via `dantomation undo`) rolls the latest task's folder back by one agent change, then one more on each repeat. It needs no HARNESS_OWNER: it refuses when `HARNESS_TASK_ID` is set (inside an engine) and guard-base blocks agents that name it. It uses the same snapshots. Before it changes anything it takes a fresh checkpoint and prints how to get back (`Undo this with: HARNESS_OWNER=1 node bin/harness.js restore <task> <n>`), so an undo is itself undoable.

## Turn it on

    "modules": { "checkpoint": true }

On in the shipped defaults and in `config/example.config.json`: it is what makes every agent edit undoable.

## Test

    node modules/checkpoint/test/checkpoint.js

## Known limits

- **Checkpoints do not cover everything.** Files outside the task folder (and outside git) are NOT recoverable. Neither are ignored files, files over 5 MB, nested repos, or the folder's own `.git` internals (branches, stash, index). Voice turns are checkpointed in the voice work dir only; files they touch elsewhere are not.
- Checkpoints live in `state/`, which an agent can reach with a bypass like any other file. Blocking `HARNESS_OWNER` is pattern matching, not a sandbox. Real separation needs the engine in a restricted account.
- A checkpoint costs about 0.3 s per mutating tool call (median on this repo, see the test); the hook timeout is 60 s.
- The checkpoint has `priority` 90, so it runs last in the guard whatever the config order. If any other module blocks the call or holds it for an approval card, no snapshot is taken (nothing ran).
- **Undo is protected by convention only.** `dantomation undo` refuses inside an engine (`HARNESS_TASK_ID`) and guard-base blocks agent spellings of it. An agent that bypasses the guard (guard-base off, or an obfuscated command) could still run undo; the pre-undo checkpoint keeps that recoverable with `restore`.
