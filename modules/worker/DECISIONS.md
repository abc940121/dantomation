# Decisions: worker

Module-owned log. Append only, one line per decision with the reason. Trunk decisions are in the root DECISIONS.md.

- S3: the worker pulls over outbound HTTP (hello, claim, progress, result) and opens no port; a shared bearer token in an owner-only file (icacls on Windows) is the only credential.
- S3: the worker keeps its own journal (state/worker): `start`, then `done` (fsync), then post; a restart re-posts a stored result and never reruns, and a job found mid-run is reported "outcome unknown".
- S3: local enforcement reuses guard-base and the private rules by direct require, plus a work-dir jail and deny list; shell commands are checked by reading the text, which is not a sandbox (README says so).
- S3: the daily cap counts journal `start` records per local day, so it survives restarts; a refused job does not count.
- S3: setup.js `check` probes GET /api/bots (read-only) as the auth test; `token --set` stores a token issued by the server.
- S1-4 merge: the worker's own token stays a file on the worker machine (setup.js token), not a setting, because worker.js reads it from an owner-only file; the worker module declares dependsOn guard-base, guard-private-rules and checkpoint and gets their apis from registry role worker (forced on there, since the jail is not optional).
