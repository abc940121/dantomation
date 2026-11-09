# Provenance: repo-map

Module-owned. Append only. Trunk provenance is in the root PROVENANCE.md.

## Ideas referenced (no code)

| Idea | Where it came from | How it was used |
|---|---|---|
| A compact repo map of files and top-level symbols, fitted to a size budget, helps a coding agent orient itself | coding-agent repo maps built on syntax-tree parsing | Same goal, but symbols come from simple per-language line patterns instead of a parser. Idea only, no code. |
| Rank files by how much the rest of the code refers to their symbols | graph-ranking of definitions and references in coding agents | A plain count of other files that mention each symbol name, capped, plus a small recency bonus from version history. Idea only, no code. |
