# Provenance: checkpoint

Module-owned. Append only. Trunk provenance is in the root PROVENANCE.md.

## Ideas referenced (no code)

| Idea | Where it came from | How it was used |
|---|---|---|
| Fork from step N: resume a run from an earlier saved state as a new branch | time-travel and replay-from-checkpoint features in graph-based agent frameworks | `fork <task> <n>` restores snapshot N into a new folder plus a fork record; the original is untouched. Idea only, no code. |
| Per-step state history with a diff between two states | state-history views in the same frameworks | `fork steps` lists steps; `fork diff` compares two snapshots with git diff-tree. Idea only, no code. |
