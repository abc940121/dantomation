# Provenance: task-board

Module-owned. Append only. Trunk provenance is in the root PROVENANCE.md.

## Ideas referenced (no code)

| Idea | Where it came from | License | How it was used |
|---|---|---|---|
| A shared task list for a team of agents: tasks with dependencies, claiming, and a task unblocking its dependants when done | agent-team task lists (idea only) | n/a | Ideas only, no code. Task, deps, claim and done-unblocks model in `store.js`; written from scratch. |
| Tasks as first-class units with a description, dependencies and an assigned agent | CrewAI tasks (idea only) | MIT | Ideas only, no code. Title, deps, owner and status fields; no CrewAI file or identifier was copied. |
| An isolated workspace per task | OpenHands workspace per task (idea only) | MIT | Ideas only, no code. A git worktree per claimed task with a cleanup policy in `workspace.js`; written from scratch. |
