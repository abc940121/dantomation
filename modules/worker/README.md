# worker (provisional, off by default)

A second machine runs tool jobs for the main server. The worker pulls: it makes outbound HTTP calls only, opens no port, uses no SSH and changes nothing on the machine except its own work folder, its journal and one token file. Written against `server-api-v0` ("Worker (pull, S3)"); the module contract (docs/MODULES.md) is still draft, so `index.js` is a minimal provisional manifest (`runsOn: "worker"`).

## What runs where

| Machine | Runs | Needs |
|---|---|---|
| Main (server) | `taskmote serve`, the approval cards, the roster, the job queue | inbound TCP 7420 allowed from the worker machine |
| Worker | `node modules/worker/worker.js` (loop: hello, claim, run, progress, result) | outbound HTTP to the server, Node 22, Git Bash or PowerShell 5.1 for shell jobs |

The server-side approval card still comes first. The worker then checks every job again itself, before running anything.

## Setup

On the worker machine (a copy of this repo, Node 22):

1. `node modules/worker/setup.js token` writes `~/.harness/worker-token`, owner-only (on Windows: `icacls`, current user only), and prints the token ONCE. Copy it to the server. (If the server already made a token, use `token --set <token>` instead.)
2. Edit the config (`~/.harness/config.json`, or `HARNESS_CONFIG`):
   ```json
   {
     "modules": { "worker": true },
     "worker": {
       "server": "http://192.0.2.10:7420",
       "work_dir": "D:\\worker-files",
       "daily_cap": 50,
       "deny": { "any": ["D:\\private"], "read_only": ["D:\\pictures"] }
     }
   }
   ```
   `work_dir` is required. `deny` entries are absolute paths (the folder and everything under it) or `re:<regex>`. Optional: `token_file`, `id`, `backoff_ms` `[1000, 30000]`, `heartbeat_ms`, `max_run_ms`. The owner's private rules are the usual `private_rules` file of the same config.
3. `node modules/worker/setup.js check --server http://192.0.2.10:7420` says whether the server is reachable and accepts the token.
4. `node modules/worker/worker.js` (or `--server URL`). `--max-jobs N` exits after N reported jobs.

On the server: allow inbound TCP 7420 from the worker machine only, and bind to the LAN in the server config. The worker machine needs no firewall rule: it only connects out. Exit code 2 means a setup problem (message says what); the worker never retries those. An unreachable server or a 5xx is retried with growing waits.

## What the worker enforces before running a job

Refusal = result `{ok:false, error:"refused by worker: <reason>"}`, logged to `logs/worker.jsonl`; nothing ran, no checkpoint was taken.

1. Payload shape, supported tool (Bash, PowerShell, Read, Write, Edit), deadline not already past.
2. Work-dir jail: writes only under `worker.work_dir` (real paths: `..`, symlinks and junctions are resolved).
3. Deny list: `any` blocks reads and writes, `read_only` blocks writes.
4. `guard-base` (always on in the worker) and the owner's private rules.
5. Daily cap `worker.daily_cap` (default 50 runs per local day, counted from the journal so a restart does not reset it).

Then a checkpoint (private shadow repo) of the work folder before a write job, then the run, with the job deadline as the kill time (process tree killed).

Idempotence: the worker journals `start`, then the outcome (`done`, fsynced), and only then posts. After a crash it re-posts the stored result and never reruns; a job that was mid-run is reported as outcome unknown. A job id seen again is not rerun either.

Kinds: `tool` (`payload: {tool, input, cwd?}`) and `task` (`payload: {prompt}`; starts the engine through `bin/harness.js start` in `work_dir/<job>`, honoring `HARNESS_ENGINE_SCRIPT`).

## Known limits

- Shell commands are checked by reading their text, not sandboxed. Word-level path checks catch redirects and arguments, but a program the command runs can still touch anything the user can (`python -c`, an installed script). Commands that change something must run inside the work folder, may not use substitution, and any `$VAR`/`%VAR%`/`~` in a path is refused. Do not treat the jail as a security boundary against a hostile server; it limits mistakes. Run the worker as a low-privilege user if the server is not fully trusted.
- Output is capped at 64 KB and redacted for known secret shapes; Read returns at most 256 KB.
- `task` jobs do not get the per-tool jail inside the engine's own session; they get the engine's normal hooks (guard modules enabled in the worker's config).
- A single job runs at a time. The token is a shared secret over plain HTTP: use a trusted LAN or an https URL.
- The token file permission check on non-Windows refuses a group/world readable file; on Windows it relies on the icacls setup step.
- Windows only exercised; Linux/macOS paths are written but untested.
