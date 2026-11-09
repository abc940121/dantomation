# Reference

The lower-level reference that used to live in the README: the CLI details, the layers, the modules, `bin/harness.js`, the config keys, the tests and the known limits. Start with the [README](../README.md).

## CLI details

- `do "<request>"` starts a task in a fresh folder under `work/` (add `--workdir <dir>` to use your own). If it is interrupted (shutdown, kill), run `node bin/taskmote.js do` with no request to resume it. Starting a second task while one is open is refused, with the resume command in the message.
- `status` prints the open task (request, steps done, last step), the last finished task, how many undo points exist, which modules are on, and any config warning.
- `undo` rolls the latest task's folder back to the state before the agent's last change; run it again to step back one more. It needs the `checkpoint` module (on by default) and works only for tasks started while it was on. It cannot run while a task is running, and agents cannot run it. When nothing is left it says so. Each undo first takes a fresh checkpoint and prints the line that brings the undone state back (`HARNESS_OWNER=1 node bin/harness.js restore <task> <n>`), so an undo can itself be undone.
- With the `approval-cards` module on, a risky action (git push, deleting outside the task folder, installs, publishing, paid API calls) stops and waits for you. `status` shows the card; answer with `node bin/taskmote.js do yes` or `do no` (an unclear answer asks again; no answer for 10 minutes counts as no). See [`approval-cards`](../modules/approval-cards/README.md).
- Undo is protected by convention only (see Known limits).


## Config file

One file outside the repo: `HARNESS_CONFIG=<file>`, else `~/.harness/config.json`. If it is missing the harness runs with safe defaults (`guard-base` and `checkpoint` on) and `status` shows a warning. To create it, copy `config/example.config.json` there. The journal and checkpoints are kept in `state/`, guard blocks in `logs/` (override with `HARNESS_STATE_DIR`, `HARNESS_LOG_DIR`; `HARNESS_WORK_DIR` moves the task folders).

## v1 preset

In v1: chat-ui, chat-endpoint, rooms, app-ui, voice, voice-chat, device-pairing, guard-base, guard-private-rules, tripwires, approval-cards, question-cards, notifications, worker, checkpoint, task-watchdog, task-board, memory-tiers, trace. Every other module stays off. `chat-endpoint` needs `rooms`, so both are in v1. `node test/combo-v1.js` loads the whole set together and runs one task through it.

## Layers

The core is always on: the journal, effects, the executor lock, the engine launch, task resume, the config and a module loader. Everything else is an optional module (see Modules, below), switched in the config.

1. **Engine** (`bin/harness.js`)
   - Runs Claude Code headless on the owner's subscription login.
   - Removes every `*_API_KEY`, `*_AUTH_TOKEN`, `ANTHROPIC_*` and `OPENAI_*` variable from the child's environment, and records the removed names in the journal.
   - Loads only local settings plus the harness guard, two tools (Bash, Read), no MCP and no skills. This keeps the always-on context near 6k tokens in total, of which the harness's own share is about 0.6k.
2. **Journal** (`lib/journal.js`, `bin/effect.js`)
   - `state/journal.jsonl` is append-only and fsynced, with one id per line. An append after a torn last line starts on a new line, so only the torn line is lost.
   - A journal that exists but cannot be read (anything but "missing") stops the harness with exit 5. It is never treated as empty.
   - Every side effect is written in three parts: intent, then the act, then done. The intent records the effect's params (target, content sha256, commit message and paths, the sha to push).
   - Re-running an effect does not repeat it:
     - If done is recorded, the effect is skipped.
     - If the rerun's params differ from the recorded ones (another body, message, path, branch), the effect is marked UNCERTAIN (exit 3) and nothing is done.
     - If only the intent is recorded, the harness reconciles:
       - write: file with the intended sha counts as written; missing file is written again; a file with other content is UNCERTAIN and left untouched.
       - commit: counts as made if a commit carries its `Effect-Id:` trailer as a whole line. A leftover `index.lock` is UNCERTAIN.
       - push: the intent records `local_sha`, and a redo pushes exactly that sha, never the current tip. Counts as made if the remote tip is `local_sha` or contains it (`git merge-base --is-ancestor` after a fetch). If the remote has no branch or does not contain it, a plain (non-force) push is redone, so git refuses a diverged remote. If the remote cannot be reached, the effect is UNCERTAIN and the owner is asked.
       - message: the outbox file is written via tmp + rename. Counts as sent if the file parses and matches recipient and body hash; missing is sent again; other content or unparseable JSON is UNCERTAIN.
   - On resume, a fresh session gets a prompt with two separate sections:
     - `## Current task`: the live request, verbatim, placed first.
     - `## History`: bounded, and never wraps the request.
3. **Guard** (`guards/guard.js`, the dispatcher)
   - One PreToolUse hook. It reads the hook JSON, calls each enabled module's `beforeTool` in config order, and blocks on the first hit (exit 2, `[guard] BLOCKED (kind): reason ...` on stderr, one line in `logs/guard.jsonl`). No hit: allow. With every module off the guard allows everything.
   - It fails closed: unreadable input, an unreadable config, or an enabled module that cannot load blocks every call.
   - What it blocks is up to the modules: `guard-base` (paid API keys, data deletion, skipped git hooks, secrets, agents naming restore, undo or HARNESS_OWNER), `guard-private-rules` (the owner's red lines, self-protection of the config), `spend-count` (session spend), `voice` (voice turns while a task runs), `checkpoint` (snapshot before each mutating call).
4. **One executor**
   - `start`/`resume` take `state/executor.lock` (harness pid + engine pid). While any pid in it is alive, a second `start`/`resume` exits 4 and changes nothing. After taking the lock, the harness re-reads the journal, so it acts on what is true under the lock.
   - Each lock carries a random nonce. A lock is released only by the holder of its nonce. A lock whose pids are all dead is taken over by renaming it to a unique `.stale` name, re-checking that the renamed file is still the dead one (else putting it back), then creating a new lock exclusively. Two processes racing for one stale lock: exactly one wins (`test/lock-race.js`, 50 rounds).
   - Each effect also takes `state/locks/<task>__<effect>.lock`; a second runner of the same effect gets `BUSY` and exit 4.
   - `engineSpec(prompt)` in `bin/harness.js` returns the engine binary, argv and stripped env, so other entry points (voice) reuse them.

## Modules

Each module lives in `modules/<name>/` with its own `README.md` (what it does, how to turn it on, Known limits), its tests in `modules/<name>/test/`, and an `index.js` that exports a manifest. The contract is [`docs/MODULES.md`](MODULES.md); [`modules/hello-stub`](../modules/hello-stub/README.md) is the template to copy. A module may require core (`lib/`); core never requires a module. The loader (`lib/modules.js`) picks the enabled ones from the config at run time with a computed path, so no static `require` of `modules/` exists in `bin/`, `lib/` or `guards/`.

    { contract: 1, name, description?, runsOn?, priority?, dependsOn?,
      beforeTool?, statusLines?, on?, emits?,
      commands?, routes?, panels?, jobs?, settings?, api? }

Every field but `contract` and `name` is optional, and every callback may be async. `beforeTool` runs inside the guard, for every tool call; a hit blocks, and a hook slower than `modules_hook_timeout_ms` (default 5000) is a `module_timeout` block. `on` subscribes to core events (`task.start`, `task.end`, `tool.done`), emitted after the journal write; a failing handler is reported and never stops anything. A module reaches another only through `dependsOn` plus `ctx.api(name)`, writes state only through `ctx.state` (`state/m/<name>/` and namespaced journal records), and keeps secrets in `type: 'secret'` settings set with `harness.js secret`, never in the config, and reads them only through `ctx.secret(key)`. Modules are trusted code in the harness process; these rules are not a sandbox. Routes declare `access` (owner by default), `prepareTurn` adds context lines to the engine prompt, `provides` lists tools, bots and engines for others, and `stateVersion` + `migrate` and `uninstall` (`harness.js uninstall <name>`) cover a module's state over time. `commands` adds `harness.js <name>` subcommands (an unknown subcommand is looked up there). `routes` are served under `/m/<name>/`, panels under `/m/<name>/ui/`, and `jobs` run in the server, all through the registry (`lib/modules.js` `registry()`); the server also has `GET/PATCH /api/settings/<module>` (owner token) and an optional worker token (`node bin/taskmote.js token new --worker`) that may only call worker routes. `settings` is a schema: the config section `"<name with - as _>"` is checked against it and the module gets the result as `ctx.settings`. A module without `contract` is a legacy contract-0 module: it loads with a printed warning and only its old hooks and `commands` are read.

| Module | What it does | Default |
|---|---|---|
| [`guard-base`](../modules/guard-base/README.md) | API keys, deletion, hook skip, secrets, rule against agents running restore, undo or naming HARNESS_OWNER | on |
| [`checkpoint`](../modules/checkpoint/README.md) | snapshot before each mutating call; owner-only `harness.js restore` | on |
| [`worker`](../modules/worker/README.md) | provisional: pull-based worker for a second machine (outbound HTTP only) | off |
| [`guard-private-rules`](../modules/guard-private-rules/README.md) | owner's rules file, self-protection of the config | off |
| [`spend-count`](../modules/spend-count/README.md) | block a session over the spend limit | off |
| [`ccusage`](../modules/ccusage/README.md) | per-day / per-session Claude Code token and cost reports (`taskmote usage`) | off |
| [`voice`](../modules/voice/README.md) | voice bridge, `voice_busy` block | off |
| [`voice-chat`](../modules/voice-chat/README.md) | hands-free voice: text wake phrase, spoken approval cards, echo guard (needs the voice client) | off |
| [`approval-cards`](../modules/approval-cards/README.md) | risky actions stop and ask you yes/no (`do yes` / `do no`) instead of running | off |
| [`claim-audit`](../modules/claim-audit/README.md) | checks "done"/"tested" claims in the final report against journal lines and command outputs; `status` lists the unverified ones | off |
| [`hello-stub`](../modules/hello-stub/README.md) | template: one of every contract part (hook, command, route, panel, job, settings) | off |
| [`chat-ui`](../modules/chat-ui/README.md) | phone-first web chat for the server: roster, per-bot threads, tool chips, approval cards, undo | off |

If an enabled module cannot load (unknown name, missing folder, throws on require, bad manifest, bad config section), `harness.js start`/`resume` exits 2 naming the module, and the guard blocks every call.

Other features checked and kept in core: the stale-lock wait for a "transient" holder in `bin/harness.js` (a generic lock-record field, not voice-specific; see the voice README), the `strip_env` of the engine environment (a safety property of the engine launch), and `effect.js`.

## Use

    node bin/harness.js start "<request>" [--workdir <dir>]
    node bin/harness.js resume        # after a shutdown or kill
    node bin/harness.js status        # print the resume prompt for the open task
    HARNESS_OWNER=1 node bin/harness.js restore <task> <n>   # owner only: roll the task folder back to checkpoint n
                                      # (PowerShell: $env:HARNESS_OWNER='1'; node bin/harness.js restore <task> <n>)

Interactive Claude Code sessions opened in this folder also get the guard (`.claude/settings.json`).

## Config

Everything specific to one owner lives outside this repo, in one file read at run time:

- `HARNESS_CONFIG=<file>`, else `~/.harness/config.json`. No other default.
- Missing: the harness runs with `config/harness.config.json` (default modules `guard-base` and `checkpoint`), and `start`/`resume`/`status` print one warning line.
- `"modules": {"<name>": true|false}` switches modules. The shipped defaults are `guard-base` and `checkpoint` on, everything else off; your keys override them, and the order of the keys is the order the guard runs them.
- If the config sets `private_rules` but has no `modules` key, `guard-private-rules` turns on automatically, so an older config keeps enforcing its rules. With a `modules` key, only what it says counts (an explicit `false` turns the rules off).
- `config/example.config.json` turns `guard-base` and `checkpoint` on explicitly, because they are what keeps paid keys and destructive commands out and makes every agent edit undoable. Turn them off only if you know why.
- Keys (all optional): `owner_name` (shown in "ask ..." messages; default "the owner"), `modules`, `private_rules` (path, relative to the config file), `spend_limit_usd_per_session`, `prices_usd_per_mtok`, `strip_env` (added to the built-in list), `engine`.
- Start from `config/example.config.json` and `modules/guard-private-rules/example-private.json` (harmless sample rules). A rule is `{kind, match: shell|path|content, pattern, access: write|any, reason}`; `write` (default) only blocks calls that change something.

## Tests

    node test/run-all.js core     # every module off: end-to-end fake-engine task + the crash/resume suites; module suites SKIP
    node test/run-all.js <module> # one module on (any folder under modules/)
    node test/run-all.js module <name>  # only that module's suites (from modules/<name>/tests.json)
    node test/run-all.js all      # every module on: all suites
    node test/run-all.js every    # core, each module alone, all
    node test/run-all.js default  # no HARNESS_CONFIG: your own config, if any

`run-all` writes a temp config under the OS temp dir, passes it as `HARNESS_CONFIG`, runs each suite and prints one PASS/FAIL/SKIP line. Suites can also be run alone:

    node test/combo-v1.js        # the v1 preset: apply, load all modules, no duplicates, hook budgets, one task end to end, a reply block
    node test/entry.js           # Quickstart lines from this README, run literally against the fake engine: do, status, undo, undo, guard
    node test/journal-prompt.js  # current-task vs history, torn line, append after torn line, unreadable journal -> exit 5
    node test/lock-race.js       # 50 rounds: two processes race for one stale lock, exactly one holds it
    node test/effect-verify.js   # write/message/push reconcile rules, params mismatch -> UNCERTAIN
    node test/push-reconcile.js  # push reconcile against a local bare repo
    node test/commit-crash.js    # kill mid-commit and between add and commit; leftover index.lock -> UNCERTAIN, no reset
    node test/executor-race.js   # parent killed, child lives: exactly one executor acts
    node test/public-boundary.js # private marker stays in ignored dirs; tree + history free of owner-specific strings
    node test/a1-live.js         # real session: 5 forbidden kinds (needs the claude CLI)
    node test/a3-resume.js a3|a3b-write|a3b-commit   # kill + resume
    node test/cost-engine.js     # session-start tokens, auth source, env
    node test/modules.js         # loader: auto-enable of private rules, load failures fail closed, no static require of modules/
    node test/module-contract.js # contract proof: add a module folder = hook, command, route, panel, job, settings with zero core edits; remove = gone; bad manifests
    node modules/guard-base/test/guard-base.js
    node modules/guard-private-rules/test/private-rules.js
    node modules/checkpoint/test/checkpoint.js
    node modules/voice/test/voice-lock.js
    node modules/voice/test/vad.js   # Python unittest for the VAD and client target switch (SKIP without python)
    node modules/voice-chat/test/voice-chat.js
    node modules/spend-count/test/spend.js
    node modules/approval-cards/test/contract.js
    node modules/hello-stub/test/hello-stub.js

A module suite prints `SKIP` when its module is off in the current config. Tests that need an engine but no model call set `HARNESS_ENGINE_SCRIPT=<absolute path>/test/fake-engine.js`. On `master`, `public-boundary`'s "history of HEAD" check fails by design (the history predates the public split); its tree check must pass.

## Seams (not built)

- **Voice entry, entry skills:** call `harness.js start`.
- **Voice answers to approval cards:** the `approval-cards` module exports `api.parseAnswer(text)`; a voice entry can pass the spoken answer through it and call the module's `answer` command.
- **Dispatch to the Windows worker:** `effect.js message` writes to `state/outbox/`. A dispatcher can take messages from there; the engine spawn in `runEngine` is the place to run tasks remotely.
- **Codex/OpenCode:** a second spawner beside `runEngine` (`HARNESS_CLAUDE` already overrides the binary).

## Known limits

- **Undo is protected by convention only.** `taskmote undo` refuses inside an engine (`HARNESS_TASK_ID` is set) and guard-base blocks agent spellings of it, but that is pattern matching, not a sandbox. An agent that gets past the guard (guard-base switched off, or an obfuscated command) could still run undo. The checkpoint taken just before every undo keeps that recoverable with `restore`.
- The same holds for answering approval cards: the answer verb refuses inside an engine and the module blocks agent spellings of it; with the guard bypassed an agent could answer its own card.

Core limits are here; each module's limits (the guard is not a sandbox, checkpoint coverage, spend accounting, voice) are in its README.

- Locks use pid liveness. A reused pid makes a dead lock look alive, which fails safe (exit 4, ask the owner). A git commit killed inside git's own index.lock window is marked UNCERTAIN; the harness never deletes index.lock or resets.
- Exit codes: 2 usage, 3 UNCERTAIN (ask the owner), 4 BUSY (another executor), 5 journal unreadable, 6 restore refused (not the owner).
- Killing the harness also kills its engine only on Windows, where Node puts non-detached children in a job object. On macOS/Linux the engine can outlive a killed harness. The executor lock still holds the engine pid, so a resume waits (exit 4) until it exits; no second executor starts.
- A commit removed later by a reset (no longer reachable) is not found by the trailer search, so a rerun with only the intent recorded commits again.

- Lock takeover with three parties: the put-back step (renamed lock was not the dead one) can, in a three-way race, let two holders both believe they hold the lock. Only two parties take this lock today (harness and voice), so it is not reachable now; a third locker needs a different takeover.
