**English** | [繁體中文](README.zh-TW.md)

# Taskmote

**A small trunk plus opt-in modules for running Claude Code on your own computer. Crash-safe and undoable.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<!-- demo: docs/demo.gif (phone approval card, 20s) -->


- **A small trunk:** journal, one executor lock, engine launch, resume, config and a module loader. Nothing else is on until you turn it on.
- **Opt-in modules:** each one is a folder plus one config line, and is off until you enable it. Phone approval cards are one module in that list.
- **Crash-safe:** a journal records every side effect, so you can close the lid mid-task, then run `do` with no request to resume; no side effect runs twice.
- **Undoable:** a checkpoint is taken before every change, and `undo` steps the task folder back one change.
- **A guard that blocks red-line commands** before the agent can run them.

## Quick start

You need Node.js 18+, Git, and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in.

```sh
git clone https://github.com/abc940121/taskmote && cd taskmote
node bin/taskmote.js do "create hello.txt that says hello"
node bin/taskmote.js status
node bin/taskmote.js undo
```

Phone approval cards are an optional module and need the `v1` preset: see [Try the v1 base](#try-the-v1-base-phone-chat-voice-approval-cards).

## Before you rely on it

> **Before you start:** Taskmote runs AI agents on your machine, with your user's rights. The trunk only listens on `127.0.0.1`, and every optional module is **off** until you turn it on. Read [Security](#security) before you expose it to a phone or a network.

> **A paired phone has your powers.** By default (`engine.profile: "full"`) each bot is a persistent Claude Code session with your own Claude settings, tools and MCP servers. Anyone holding a paired device can make it do what you could do at this keyboard, except the red-line actions, which the guard blocks or holds for your yes. Treat pairing like handing over a logged-in laptop: pair only devices you own, list them with `node bin/harness.js device list`, and remove one with `node bin/harness.js device revoke <id>`. Set `engine.profile` to `"locked"` for the older narrow tool allowlist.

**It is not**
- **Not a sandbox.** The guard is pattern matching in front of the agent's tools, not isolation. An agent can do what your user account can do.
- Not a hosted service, and not for multiple users. There is one owner; there are no accounts.
- Not an API-key product. It drives your logged-in Claude Code subscription and strips API-key variables from the agent's environment.
- Not finished. It is a v1 base; see [Known limits](docs/reference.md#known-limits).

Taskmote was called *dantomation* until November 2026. The old command name `dantomation` still works as an alias.

## Try it in 60 seconds

`node bin/taskmote.js demo` needs no setup and never touches your own config: in a throwaway sandbox a scripted agent goes through the real guard, approval card and journal.
You see an edit with its checkpoint, a red line blocked for good, a crash and resume, an approval card you answer in the browser, and an undo.
Set `TASKMOTE_DEMO_AUTO=yes` (or `no`) to answer the card without the browser.

## Why

Coding agents are good at doing things, but they are less good at stopping cleanly when your laptop sleeps, telling you honestly whether a test passed, or waiting for you before they spend money. Taskmote is a small trunk around Claude Code that handles those parts: it keeps a crash-safe journal, gives one task one executor and takes a checkpoint before every change, so a task can resume and be undone. Everything beyond that, including stopping risky actions until you say yes, is an opt-in module.

## What it is

**It is**
- A local, single-owner tool. Pure Node.js 18+, no dependencies to install for the core.
- A small trunk (journal, lock, engine launch, resume, config, module loader) plus opt-in modules, all off until you enable them: approval cards (on your phone or in the browser), phone chat, voice, rooms, a worker on a second machine.
- Built to survive a shutdown at any moment: `do` with no request resumes the open task, and no side effect runs twice.

## Quickstart

**You need:** Node.js 18 or newer, Git, and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in (run `claude` once and sign in).

```sh
git clone https://github.com/abc940121/taskmote
cd taskmote
```

Then, from that folder:

```sh quickstart
node bin/taskmote.js do "create hello.txt that says hello"
node bin/taskmote.js status
node bin/taskmote.js undo
node bin/taskmote.js undo
```

**It worked if** `status` shows the task as finished and the folder it names under `work/` contains `hello.txt`. Each `undo` steps the folder back one change, so `hello.txt` goes away; when nothing is left, it says so. Every undo prints a line that brings the undone state back.

- `do "<request>"` starts a task in the bot's folder, `work/bot-main` (kept between tasks; with `engine.profile: "locked"` each task gets a fresh `work/<task id>`). `--workdir <dir>` uses your own.
- `do` with no request resumes a task that was interrupted.
- `status` shows the open task, the last finished one, the folder each works in, undo points and the modules that are on.
- `undo` steps the task folder back one change; run it again to go back further. If you edited a file by hand after the task ended, undo names it first; the printed restore line brings your version back.

On Windows, `bin\taskmote.cmd` does the same; put `bin` on your PATH to type `taskmote do "..."`.

## Try the v1 base (phone chat, voice, approval cards)

`v1` is a ready-made set of modules. It changes no settings and holds no secrets.

1. In your config file (`~/.harness/config.json`, or the file named by `HARNESS_CONFIG`), add `"preset": "v1"`. If you have no config yet, create the file as `{ "preset": "v1" }`. Your own `modules` entries always win over the preset.
2. Run `node bin/taskmote.js serve`. It listens on `127.0.0.1:7420`.
3. Open <http://127.0.0.1:7420/m/app-ui/ui/> (keep the `/ui/` at the end). The page asks for a pairing code the first time, even on this computer: run `node bin/harness.js device pair` and type the six digits it prints. **It worked if** you can send "hello" and see a reply.
4. **Phone (optional).** A phone cannot reach `127.0.0.1`. Put this computer on a private network you control (for example Tailscale), set `server.host` to that address, and restart `serve`. Then run `node bin/harness.js device pair`, and open the printed link on the phone or type the code there. `node bin/harness.js device list` lists phones and `node bin/harness.js device revoke <id>` removes one. Never open the port to the internet.

`node bin/taskmote.js preset v1` shows what the preset turns on. It never writes a file. The verb is the `presets` module (on by default); with it off, the verb says to turn it on.

### Roll back a stable copy

If a stable copy runs from a second git worktree, one command returns it to the previous release: `git -C <stable-worktree> checkout --detach <previous-main-sha>`. Then restart the server process.

## How it fits together

```
 you ── terminal / browser / phone / voice
          │
      ┌───▼──────────── trunk (always on) ────────────────┐
      │ journal · one executor lock · resume · config     │
      │ engine launch (Claude Code, API keys stripped)    │
      │ guard ── asks each enabled module before a tool   │
      └───┬───────────────────────────────────────────────┘
          │ modules (off until you enable them)
   guard-base · checkpoint · approval-cards · chat-ui · app-ui
   device-pairing · voice · rooms · worker · tripwires · …
```

- **Journal:** every side effect is written as intent, act, done. A rerun never repeats one, and anything unclear stops and asks you (exit 3).
- **One executor:** a second `do` while a task runs is refused, never run in parallel.
- **Guard:** one hook in front of every tool call; the first module that objects blocks it.
- **Modules:** a folder plus one config line. Core never names a module. See [docs/MODULES.md](docs/MODULES.md).

## Features

The trunk gives you the first two points; the rest are modules you switch on.

- **Resume after a crash.** The journal records intent, act and done for every side effect; `do` with no request picks the task up again.
- **Undo anything the agent changed.** `checkpoint` snapshots before each change; `undo` and `restore` are owner-only.
- **Risky actions wait for you (module `approval-cards`).** One of the modules, answered in the browser or on a paired phone: a delete outside the task folder, an install or a paid API call stops until you answer `do yes` or `do no`. No answer in 10 minutes counts as no.
- **Honest replies.** `tripwires` flags a reply that claims "tests pass" when the run exited with an error, and with `"tripwires": {"mode": "block"}` in the config it holds that reply back; `claim-audit` checks "done" claims against the journal.
- **Chat from your phone.** `chat-ui`/`app-ui` with `device-pairing` gives one-time codes and per-device tokens you can revoke.
- **Voice.** `voice` and `voice-chat` add hands-free turns, including answering approval cards by voice.
- **A second machine.** `worker` pulls jobs over outbound HTTP only.

## Use it from Claude Code (MCP)

`bin/taskmote-mcp.js` is an MCP stdio server. Any Claude Code session, or other MCP client, can then call what Claude Code does not have: cards to your phone, the task queue, undo and the journal.

Every tool is listed and works with no flag. The only things that still stop for your answer are the product red lines: spending money, deleting outside the task folder and touching secrets. Install it for every project of yours (user-wide) or for one project (the default scope):

```sh
# user-wide
claude mcp add --scope user taskmote -- node <path-to-repo>/bin/taskmote-mcp.js
# this project only (default project scope)
claude mcp add taskmote -- node <path-to-repo>/bin/taskmote-mcp.js
```

`--allow-write`, `--no-ask` and the environment variable `TASKMOTE_MCP_WRITE=1` are still accepted so older launch commands keep working, but they no longer change anything.

`undo_task` undoes at once, whoever queued the task, and returns the result right away; afterwards it posts an informational card (English and 繁中) to your phone, which needs no answer. If `question-cards` is off the undo still happens, just without the card. `queue_task` runs through the same path as `taskmote do`, so the same guards, approval cards and spend counting apply as for a typed command.

| Tool | What it does | Needs module | Listed |
|---|---|---|---|
| `ask_owner` | Ask a question with 2 to 6 choices on your phone and wait. No answer in time returns `{"answered":false}`, never an error. | `question-cards` | always |
| `task_status` | One task, or the recent tasks, from the journal. | none | always |
| `digest` | The while-you-were-away summary as JSON (honours `include_titles`). | `digest` | always |
| `search_journal` | Full-text search over past tasks, messages and rooms. | `search` | always |
| `queue_task` | Queue a task the way `taskmote do` does and return its id. `cwd` applies only when no server is running. | none | always |
| `undo_task` | Put a task's folder back, like the Undo button, at once, then sends you an info card. If a task is running it returns `blocked` and changes nothing. | `checkpoint` (`question-cards` for the notice) | always |

A tool whose module is off answers with text naming the module to turn on. The separate `bin/approve-mcp.js` permission-prompt server is unchanged.

## Modules

The modules are what you add to the trunk. Phone approval (`approval-cards` with `chat-ui`/`app-ui` and `device-pairing`) is one row below, not the product itself. Every module is off by default, except the two safety modules `guard-base` and `checkpoint` and the CLI helper module `presets`. `guard-base` is locked on: a config or preset that turns it off is refused, so `serve` will not start and every tool call is blocked until it is fixed. Turning `approval-cards` off is allowed, but `serve` warns that every red-line step will then be refused. "Can touch" is what the module itself reads or changes beyond the trunk.

| Module | What it does | Can touch | Default | In v1 |
|---|---|---|---|---|
| `guard-base` | blocks API keys, mass deletion, skipped git hooks, secret writes | nothing; it only blocks | on (locked) | ✓ |
| `checkpoint` | snapshot before every change; `undo`/`restore` | the task folder (git snapshots) | on | ✓ |
| `presets` | the `preset` verb: shows what a profile from `presets/` turns on | reads `presets/` and your config; writes nothing | on | |
| `guard-private-rules` | your own red lines from a rules file | reads your rules file | off | ✓ |
| `gitleaks` | runs the `gitleaks` program before git commit/push; blocks on findings | runs an external program you installed; reads the repo | off | |
| `approval-cards` | risky actions ask yes/no | nothing; it only pauses | off | ✓ |
| `question-cards` | an agent asks you a multiple-choice question | its own state | off | ✓ |
| `tripwires` | flags (or, in block mode, withholds) replies that contradict the exit code | engine output files of that turn | off | ✓ |
| `task-watchdog` | flags stalled or looping tasks; can cancel them | the running task | off | ✓ |
| `task-board`, `trace`, `notifications` | task claims, per-task timeline, inbox | their own state | off | ✓ |
| `chat-ui`, `app-ui` | browser and phone chat | serves pages on the server address | off | ✓ |
| `device-pairing` | pairing codes and per-device tokens | issues tokens that can reach the chat | off | ✓ |
| `voice`, `voice-chat` | voice bridge and hands-free layer | microphone and speaker through the voice client | off | ✓ |
| `rooms`, `chat-endpoint` | multi-bot rooms; a bot behind an OpenAI-style URL | sends room text to the URL you configure | off | ✓ |
| `worker` | runs queued jobs on a second machine | one work folder on that machine; outbound HTTP | off | ✓ |
| `ntfy` | push pings (task finished, blocked, approval waiting) to your phone | outbound HTTP POST to the ntfy server you configure; the topic is a secret: set it with `node bin/harness.js secret ntfy topic`, never written into config | off | |
| `spend-count`, `claim-audit`, `engine-router`, `routines`, `search`, … | see each module's README | see its README | off | |

Each module has its own `README.md` with its limits. To write one, copy [`modules/hello-stub`](modules/hello-stub/README.md).

### Removed modules

`repo-map`, `memory-tiers`, `sop-pipeline` and `scaffold` were removed. They overlapped with Claude Code's own search, memory, skills and workflows. They are recoverable from the git tag `archive/modules-2026-11-10`, e.g. `git checkout archive/modules-2026-11-10 -- modules/<name>`.

`task-grill`, `arena`, `ccusage` and `agent-tools` were removed too. Instead of `task-grill`, use a grilling skill with the MCP `ask_owner` tool. Instead of `arena`, use the pstack arena skill. Instead of `taskmote check usage`, run `npx ccusage` directly. Instead of `agent-tools`, use the MCP server (`bin/taskmote-mcp.js`). They are recoverable from the git tag `archive/convert-2026-11-10`, e.g. `git checkout archive/convert-2026-11-10 -- modules/<name>`.

## Security

**Threat model.** You, the owner, are trusted. These are not trusted: anyone else on the network, anyone who can send text into a chat or room, and any text an agent reads (web pages, files, tool output). Text like that can steer an agent, and an agent runs with your rights.

What Taskmote does to reduce that risk:
- Binds to `127.0.0.1` unless you change `server.host`. It has no relay or tunnel of its own.
- Strips `*_API_KEY`, `*_AUTH_TOKEN`, `ANTHROPIC_*` and `OPENAI_*` from the agent's environment.
- Phones get per-device tokens that you can list and revoke; routes are deny-by-default.
- Undo, restore and card answers refuse to run inside an agent.

What it does **not** protect against: an agent that gets past the pattern-matching guard (for example with an obfuscated command), a module you enable (modules are trusted code, like a program you install), or a port you expose to the internet.

The red-line guard (approval cards for installs, persistent config, sign-ins, history rewrites, paid compute and money) reduces risk; it does not stop a determined agent. It matches patterns, so a script, an alias or an encoded command can get past it. File paths are checked as written and with symlinks resolved, but a path built at run time is not seen.

A red-line card never times out, and a waiting approval pauses all bots until answered or stopped (Stop on the task in the app ends the wait). Red-line approvals need the approval-cards module: with it off, red lines are refused and the agent tells you so.

**Get it only from** <https://github.com/abc940121/taskmote>. There is no npm package.

**Reporting a vulnerability:** see [SECURITY.md](SECURITY.md). Please do not open a public issue.

## FAQ

<details><summary><b><code>do</code> says another task is open (exit 4)</b></summary>

One task runs at a time. Run `node bin/taskmote.js do` with no request to resume it, or check `status`.
</details>

<details><summary><b>Every tool call is blocked, even Read (or <code>serve</code> exits 2)</b></summary>

The config could not be loaded, so Taskmote fails closed. Common causes: invalid JSON, `"guard-base": false` (it is locked on), or an enabled module that cannot load. Run `node bin/taskmote.js serve` in a terminal to see the reason, then fix `~/.harness/config.json` (or the file `HARNESS_CONFIG` points to) by hand in an editor outside the agent.
</details>

<details><summary><b>Exit 3: UNCERTAIN</b></summary>

The journal cannot tell whether a step already happened, so Taskmote stopped instead of guessing. `status` shows the step; check it by hand, then resume.
</details>

<details><summary><b>My phone cannot open the page</b></summary>

The server listens on `127.0.0.1` by default. Set `server.host` to a private-network address of this computer (for example Tailscale) and restart `serve`.
</details>

<details><summary><b>Does it use my API key or cost extra?</b></summary>

No. It uses your logged-in Claude Code subscription and removes API-key variables from the agent's environment.
</details>

<details><summary><b>Where are my config and data?</b></summary>

The config is `~/.harness/config.json` (or `HARNESS_CONFIG`). The journal and checkpoints are in `state/`, and guard logs are in `logs/`.
</details>

## Docs

- [docs/reference.md](docs/reference.md): the CLI, layers, config keys, tests and known limits.
- [docs/MODULES.md](docs/MODULES.md): the module contract.
- Questions and bugs: [GitHub issues](https://github.com/abc940121/taskmote/issues).

## Contributing

- Run the tests with `node test/run-all.js`; they need no network and no model calls.
- A new feature is usually a new module: copy `modules/hello-stub`, and core needs no edits.
- Translations: edit `README.zh-TW.md` and keep its headings the same as this file.

## License

MIT, see [LICENSE](LICENSE). Parts of the app UI are adapted from Apache-2.0 code; see [NOTICE](NOTICE) and [PROVENANCE.md](PROVENANCE.md).
