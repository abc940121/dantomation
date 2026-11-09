# Decisions: guard-base

Module-owned log. Append only, one line per decision with the reason. Trunk decisions are in the root DECISIONS.md.

- M1: guard-base rule (f) is a name match, not a sandbox; an obfuscated command could still get past it, and the HARNESS_TASK_ID refusal is the second layer. Real isolation needs a restricted account.
- S1: guard-base treats server.token like any secret file (Read, Grep, Glob and shell reads blocked), and the CLI never sends the token when HARNESS_TASK_ID is set; the approval-cards API-command block stays as a second layer only, since a regex cannot be a boundary.
