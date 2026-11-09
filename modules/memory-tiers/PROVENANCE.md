# Provenance: memory-tiers

Module-owned. Append only. Trunk provenance is in the root PROVENANCE.md.

## Ideas referenced (no code)

| Idea | Where it came from | How it was used |
|---|---|---|
| Split agent memory into a small always-in-context tier, a recent-history tier and a large searched-on-demand tier | operating-system-style memory hierarchies for LLM agents | the core, recall and archive tiers. Idea only, no code. |
| Move items between tiers by size pressure and age, with explicit owner edits to the always-in-context tier | paged-context agent memory designs | count and age demotion, owner pin/unpin/restore/forget. Idea only, no code. |
