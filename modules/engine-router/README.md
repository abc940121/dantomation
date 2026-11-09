# engine-router

Architect/editor split for engine choice. A strong **planner** engine plans; cheap
**editor** engines do mechanical edits. After `fail_limit` (default 2) failures in a
row on one step the router picks the next engine, but first checks the task journal
for half-done work and tells the new engine to inspect the tree before it starts.

Status: implements the contract v6 `chooseEngine(turn)` hook. It returns the first
configured engine for the step's role (planner or editor, from the request text), or
`null` when none is configured. The hook is pure and synchronous (no I/O), so it does not
know about failure counts; the failure-aware switch stays advisory (prompt line, route,
command, `router_switch` journal record).

**Owner opt-in:** the choice only takes effect if the config `engines` table has an entry
with the same name, a string `bin` and `turn: true`. Otherwise core keeps the default
engine and journals `engine_choice_ignored`. Chosen engines run without the harness guard
hooks unless the entry has `format: "claude"` (see docs/module-contract.md). The router itself only
counts listed engines that pass this check: an id it cannot run is skipped, so its turns are
never charged as that engine's failures. Core takes the first module answer, so turn on only one
module that chooses engines; with two, the router's failure counts can name an engine that did
not run.

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

Add matching `engines` entries, e.g. `"engines": { "big": { "bin": "...", "turn": true } }`, for each engine id.

Off by default. Tests: `node test/run-all.js module engine-router`.
