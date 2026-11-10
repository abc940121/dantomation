# Decisions

- Core logic in `core.js` with every side effect injected (`runTask`, `judge`, `runTests`, `ask`), so tests use stubs and need no network or engine.
- The two runs are sequential and go through `bin/harness.js start`, which takes the executor lock itself. The lock is never bypassed.
- Worktrees are detached checkouts under the module state dir, so the target repo gets no extra branches.
- Keep applies `git diff --cached --binary` of the chosen worktree with `git apply --binary`. A dirty target is refused so nothing is mixed in.
- Tests outrank the judge, but only when exactly one side passes. A bad judge answer is a tie, never an error.
- No hard dependency on question-cards: arena asks through the `ask` verb when that module is on, and listens for `question.answered`.
- No answer changes nothing; the worktrees stay until `arena keep` is run.
- `--queue` lets a task agent ask for an arena run. The request is stored in `queue.json` (cap 20) in module state. `task.end` fires while the lock is still held, so it only spawns a detached `arena drain`; the drainer holds `drain.lock`, waits for the executor lock to be free, then runs each request through the normal path (which takes the lock itself). Still-busy after the wait leaves the queue for the next task end.
