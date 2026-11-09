# Decisions: gitleaks

Module-owned log. Append only, one line per decision with the reason. Trunk decisions are in the root DECISIONS.md.

- Calls the gitleaks binary as a child process; no gitleaks code is copied, so MIT code never enters the repo.
- Missing binary fails open with a warning on every commit/push (default; a one-time line scrolls away and a push is public), like the other optional modules (an absent input is skipped); `on_missing: block` is the strict opt-out. Crash or timeout of an installed gitleaks still blocks. Fail-closed by default also broke guard-base test cases that commit/push when the module is on without the program.
- Report goes to a temp file and only RuleID, File, StartLine are kept, so a secret cannot reach the block reason even if `--redact` changes.
- `scan` is a module command reached by `bin/harness.js scan`; `taskmote` has a fixed verb list, and changing it is a trunk change.
