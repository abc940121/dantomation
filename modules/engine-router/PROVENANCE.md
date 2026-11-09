# Provenance: engine-router

Module-owned. Append only. Trunk provenance is in the root PROVENANCE.md.

## Ideas referenced (no code)

| Idea | Where it came from | License | How it was used |
|---|---|---|---|
| Architect/editor split: a strong model plans, a cheaper one applies the edits | common AI coding-assistant practice (pair-programming style tools) | idea only | the planner/editor roles and the escalate-on-failure order; no code copied |
| Switch after repeated identical failures | the repo's own task-watchdog module (consecutive-failure rule) | MIT, same repo | same consecutive-failure counting idea, own code |
