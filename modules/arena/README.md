# arena

Run one request two ways in two isolated git worktrees, judge the results, and let the owner keep one. Off by default.

Enable with `"modules": {"arena": true}` in the config.

## Use

    taskmote arena "<request>" [--engines a,b] [--dir <repo>]
    taskmote arena keep <id> A|B|none
    taskmote arena list

- Variant A is told to make the smallest change. Variant B is told to make the cleanest design.
- The two runs go one after the other through the normal engine runner, so the executor lock is respected.
- If `arena.test_cmd` is set it runs in each worktree (exit 0 = pass). Exactly one side passing decides the winner over the judge.
- The judge gets both diffs (stat plus size-capped diff) and answers `{"winner":"A"|"B"|"tie","reasons":[...]}`. Unusable output counts as a tie.
- With question-cards on, an owner question offers Keep A / Keep B / Keep neither. Without it, the result line prints the `arena keep` command.
- Keep A or B applies that worktree's diff to the target folder as a patch. It refuses when the target has uncommitted changes. Then both worktrees are removed.
- No answer keeps both worktrees and changes nothing.
- `GET /m/arena/runs` lists runs (owner only).
- Journal: `{kind:"arena", id, engines, winner, tests, kept}`.

## Limits

- The default runner uses the harness's normal engine; the engine names given go to the judge and any injected runner.
- The judge needs an `engines` entry in the config, otherwise the result is a tie.
- It cannot run inside a running task (the task holds the executor lock). From inside a task use `taskmote arena "<request>" --queue --json`: the request is recorded, and a detached drainer starts it after the task releases the lock (it never bypasses the lock). `taskmote arena queue` lists waiting requests.

## Tests

    node test/run-all.js module arena
