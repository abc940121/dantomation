# gitleaks

Runs the separate [`gitleaks`](https://github.com/gitleaks/gitleaks) program (MIT; not bundled, no code copied) before an agent's `git commit` or `git push`, and blocks the call when it reports findings. The block names only rule id, file and line; gitleaks runs with `--redact` and the secret text is never read into the message.

## Turn it on

    "modules": { "gitleaks": true }

Off by default. Install gitleaks yourself and put it on `PATH` (or set `gitleaks.binary` to its path).

## What runs

- `git commit` (a shell call containing it, also in `a && b` chains, `git -C dir ...`): `gitleaks git --staged`.
- `git push`: `gitleaks git --log-opts="HEAD --not --remotes"` (commits no remote has yet).
- Both with `--report-format json --report-path <temp file> --redact --no-banner --no-color --exit-code 1`; the temp report is deleted.
- Verb: `node bin/harness.js scan` scans staged changes in the current folder; `scan <path>` or `scan --dir` runs `gitleaks dir`. Exit 0 clean, 1 findings, 2 could not scan. (`taskmote` forwards only its own fixed verbs, so there is no `taskmote scan` until the trunk forwards module verbs.)

## Settings (`gitleaks` section)

`binary` (default `gitleaks`), `scan_commit` and `scan_push` (true), `scan_timeout_ms` (4000; the guard hook is cut off at 5000), `no_remote_commits` (200: in a repo with no remote-tracking branches, e.g. one pushed by URL, a push scans this many recent commits instead of the whole history, and says so when there are more), `on_missing` (`allow` default, or `block`).

## When gitleaks is missing or fails

Missing program: fail open with a warning (default `on_missing: "allow"`): commit and push go through, and each one prints a line on stderr saying it was not scanned. This matches the other optional modules, which skip quietly when what they need is absent (spend-count counts a missing transcript as zero); only a broken config or rules file makes a guard module fail closed. Set `on_missing: "block"` to refuse commit and push until it is installed.

A program that is installed but crashes, exits oddly or times out always blocks that commit/push (fail closed); other tool calls are never touched.

## Test

    node test/run-all.js gitleaks

The tests put a fake `gitleaks` first on `PATH`; the real program is not needed.

## Known limits

- Pattern matching on the command text, like guard-base: `git commit` built at run time, or run by a script, is not seen. A `cd dir && git commit` scans the guard's folder, not `dir`.
- `git commit -a` also stages tracked files at commit time; `--staged` does not see those until staged.
- Only what gitleaks's rules know. Findings in git history older than the push range are not checked.
