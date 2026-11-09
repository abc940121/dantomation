# engine-router

Architect/editor split for engine choice. A strong **planner** engine plans; cheap
**editor** engines do mechanical edits. After `fail_limit` (default 2) failures in a
row on one step the router picks the next engine, but first checks the task journal
for half-done work and tells the new engine to inspect the tree before it starts.

Status: **policy only.** Core has no hook that lets a module choose the engine for a
turn, so today the module recommends (prompt line, journal record, route, command).
See "Seam request" below.

## What it does

- `classifyStep(text)`: planning words go to `planner`, mechanical words to `editor`, unknown to `planner`.
- `pickEngine(role, engines, failed)`: first engine of the role not yet failed; roles run out into the other role, then `exhausted`.
- Failure counter per task step, fed by `tool.done` (ok false) and a nonzero `task.end`.
- Half-done check: successful mutating tool calls since the last engine start, with no reply after.
- Output: a `router_switch` journal record, a "Context from modules" line, `GET /m/engine-router/decide?task_id=&step=`, and `harness engine-router <task_id> [step]` (owner only).

## Settings (config section `engine_router`)

| Key | Default | Meaning |
|---|---|---|
| `planner_engines` | `[]` | engine ids for planning, preferred first |
| `editor_engines` | `[]` | engine ids for mechanical edits, preferred first |
| `fail_limit` | 2 | consecutive failures before switching |
| `mutating_tools` | Edit, Write, MultiEdit, NotebookEdit, Bash | tools that count as changing the tree |

## Turn it on

    "modules": { "engine-router": true },
    "engine_router": { "planner_engines": ["big"], "editor_engines": ["cheap1", "cheap2"] }

Off by default. Tests: `node test/run-all.js module engine-router`.

## Seam request (for core)

Name: `chooseEngine` hook, a module manifest field.

    chooseEngine(ctx) -> null | { engine: string, reason?: string }
    ctx = module ctx + { task_id, request, workdir, resumed, bot, engines: [ids from provides.engines and cfg.bots], current }

Core calls it in `runEngine` (bin/harness.js) after `task.start` and before `engineSpec`, in load order, first non-null wins, with the hook timeout; a throw, timeout or unknown engine id is reported and ignored (keep the default). Core records `engine_choice {task_id, engine, module, reason}` in the journal. It must also run on `resume` and the server's per-bot start. Why existing seams fail: `prepareTurn` can only add prompt text, `provides.engines` only lists, and `engineSpec` reads one fixed `CONFIG.engine`. Smallest change: one optional manifest field plus a loop in `runEngine` that passes the chosen name to `engineSpec(prompt, engineName)`.
