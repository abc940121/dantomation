# Decisions: engine-router

Module-owned log. Append only, one line per decision with the reason. Trunk decisions are in the root DECISIONS.md.

- Policy lives in `lib/policy.js` as pure functions (classify, pick, counter, half-done, decide); `index.js` only does IO. Pure code is testable without an engine and survives the real seam landing unchanged.
- Core has no per-turn engine hook, so the module only recommends: it journals `router_switch`, adds a prepareTurn line and serves `GET /m/engine-router/decide`. It never spawns or kills an engine.
- Unknown or mixed step text classifies as planner: the failure mode of a wrong guess is a dearer engine, never a weak engine on a hard step.
- Failures count consecutively per step (a success resets). The default limit is 2, setting `fail_limit`, because two identical failures rarely fix themselves.
- A step is the task request text; a resumed task keeps its counters, a new request resets them. Core has no finer step event.
- Counter state is one JSON file per task (atomic rename) because `tool.done` fires in the guard process and `task.start` in the harness process.
- A failed engine is excluded for the rest of the step. When a role runs out, the router escalates to the other role (cheap editors that fail go to the planner), then reports `exhausted`, which tells the model to stop and ask the owner.
- Half-done check reads the journal: successful `tool_done` records of a mutating tool after the last `engine_start` or router switch, with no `reply`/`task_done` after them. `tool_done` carries no tool input, so the tool name is all we know; this over-reports (a harmless Bash counts), which only adds a "inspect first" note.
- A half-done tree never blocks the switch; it changes the action to `switch_with_handoff` and the note tells the new engine to inspect git status/diff and finish or undo first. Blocking could strand a task.
- A nonzero `task.end` code counts as a failure; a zero code does not reset the counter (the step may continue on resume).
- Engine ids are opaque strings from settings (`planner_engines`, `editor_engines`); the module knows no vendor or model names.
- `runsOn: main` and `priority: 60`: it only advises, so it runs after the blocking and asking modules.
- Contract 6: `chooseEngine(turn)` is pure (classify the request, first configured engine of the role, no failure state) because it has a 200 ms bound and must do no I/O. Failure-driven switching stays in prepareTurn and the route. `hookTimeoutMs: 1000` declared; hooks are cheap.
- prepareTurn recommendation line kept: it is the only effect for owners who have not added a `turn: true` engines entry, so existing behaviour is unchanged.
- Dropped the "Seam request" README section: the seam landed.

- Manifest stays `contract: 2` for now: trunk test/module-events.js asserts every in-repo module sets contract 2, and the loader does not gate chooseEngine or hookTimeoutMs on the field. Raise to 6 once that assertion allows it.
