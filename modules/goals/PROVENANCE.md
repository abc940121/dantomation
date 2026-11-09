# Provenance: goals

Module-owned. Append only. Trunk provenance is in the root PROVENANCE.md.

## Ideas referenced (no code)

| Idea | Where it came from | How it was used |
|---|---|---|
| Goal-grilling interview: ask the owner what done looks like and what is out of scope before work starts | the goal-grilling interview pattern | `goal interview` lists the questions still open on the card; nothing is guessed. Idea only, no code. |
| Reflexion-style lessons: keep a short written note of what went wrong and put it in the next attempt's prompt | Reflexion (verbal reinforcement learning) | Each owner correction is a lesson row (what, which check missed it, fix) injected by `prepareTurn`. Idea only, no code. |
| Skill library: keep what worked, retire what did not | skill-library agents | A lesson is kept only while its weekly repeats drop; otherwise it is marked stale and left out of the prompt. Idea only, no code. |
