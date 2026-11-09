# task-board

A shared task board for parallel agents. Off by default; enable with `"modules": { "task-board": true }`
(settings in the config section `task_board`).

A task has an `id`, a `title`, `deps` (ids that must be `done` first), a `status`
(`open`, `claimed`, `done`, `failed`), an `owner` and a lease (`lease_until`).

- **Claim** is atomic: it runs under a lock file, so two agents (even in two processes) never get the same task.
- **Lease**: a claim lasts `lease_seconds`; the owner renews it with a heartbeat. A claim that is not renewed goes
  back to `open` (checked on every board operation and by a 30 s job), so a dead agent's task is picked up by another.
- **Done** unblocks dependants whose deps are now all done. A **failed** task keeps its dependants blocked until the
  owner retries it.
- **Workspace** (optional): with `workspace_dir` and `workspace_repo` set, a claim creates a git worktree
  `<workspace_dir>/task-<id>` on branch `task-board/<id>`. It is removed by `workspace_cleanup` (the branch stays).

## Routes (under `/m/task-board`)

Workers (and the owner) call: `GET /tasks` (`?status=`, `?owner=`, `?ready=1`), `GET /tasks/:id`,
`POST /claim {id?, lease_seconds?, task_ref?}` (returns `{task: null}` when nothing is ready),
`POST /tasks/:id/heartbeat`, `/done {note?}`, `/fail {note?}`, `/release`.
Owner only: `POST /tasks {id?, title, deps?, task_ref?}`, `POST /tasks/:id/retry`, `DELETE /tasks/:id`.
A worker always acts as its own actor id; the owner may force a finish or release.

## Command

`dantomation taskboard [list [status]|add <title> [--id ID] [--dep ID]...|claim [id]|heartbeat <id>|done <id> [note]|fail <id> [note]|release <id>|retry <id>|remove <id>]`.
Inside a harness task the owner name is `task:<HARNESS_TASK_ID>` and `add`/`retry`/`remove` refuse.

## Events and coordination

Emits `task-board.added`, `.claimed`, `.done`, `.failed`, `.released`, `.expired`, `.unblocked`.
Listens to `task-watchdog.stalled` and core `task.end`: claims whose `task_ref` is that harness task are released
(`release_on_stall`, `release_on_task_end`). No file is shared with task-watchdog.

## API for other modules

List `dependsOn: ['task-board']`, then `ctx.api('task-board')`: `add`, `list`, `get`, `claim(owner, {id?, lease_seconds?, task_ref?})`,
`heartbeat`, `done`, `fail`, `release`, `releaseByTask(taskId)`. Errors carry `.code`
(`not_found`, `not_open`, `blocked`, `not_owner`, `not_claimed`, `limit`, `bad_input`, ...).

## Settings (`task_board`)

`lease_seconds` (300), `max_claims_per_owner` (0 = unlimited), `max_tasks` (1000), `release_on_stall` (true),
`release_on_task_end` (true), `workspace_dir` / `workspace_repo` ('' = no workspaces),
`workspace_cleanup` (`done` | `finished` | `never`, default `done`).
