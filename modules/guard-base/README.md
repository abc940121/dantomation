# guard-base

The generic guard rules, the same for every owner. Nothing owner-specific. Rules are in `rules.js`; `index.js` is the module.

It blocks and logs to `logs/guard.jsonl`:

- (a) paid API keys (setting `*_API_KEY` variables, calling the paid API endpoints, `apiKeyHelper`)
- (b) data deletion (recursive delete, `git clean`, force push, hard reset over unpushed work)
- (c) skipped git hooks (`--no-verify`, `core.hooksPath`)
- (d) printing or sending secrets (`.env`, key files, token variables, `printenv`)
- (f) agents naming `restore` or `undo` (`harness.js` / `taskmote`) or `HARNESS_OWNER`, in a command or in a file they write

## Turn it on

    "modules": { "guard-base": true }

It is on in `config/harness.config.json` and in `config/example.config.json`. Keep it on: it keeps paid keys and destructive commands out. With it off, nothing in the harness stops an agent from running them.

## Test

    node modules/guard-base/test/guard-base.js

## Known limits

- **The guard is not a sandbox.** It matches patterns, so obfuscated commands can get past it: deletes run through a script file, `node -e` or `python -c`, base64 piped to a shell, and similar. It catches honest mistakes and plain forbidden commands, not a model that is trying to evade it. For real isolation, run the engine in a container or a restricted user account.
- The owner-only rule (f) is the same kind of match: an obfuscated command could still set `HARNESS_OWNER` itself. `HARNESS_OWNER` is stripped from the engine environment, but real separation needs the engine in a restricted account.
