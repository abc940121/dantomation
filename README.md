**English** | [繁體中文](README.zh-TW.md)

# Taskmote

**Approve Claude Code's risky actions from your phone. Crash-safe, undoable.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<!-- demo: docs/demo.gif (phone approval card, 20s) -->


- **Phone approval cards:** risky steps wait for your tap before they run.
- **A guard that blocks red-line commands** before the agent can run them.
- **A journal that survives crashes:** close the lid mid-task, then run `do` with no request to resume; no side effect runs twice.
- **One-command undo:** `undo` steps the task folder back one change.

## Quick start

You need Node.js 18+, Git, and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in.

```sh
git clone https://github.com/abc940121/taskmote && cd taskmote
node bin/taskmote.js do "create hello.txt that says hello"
node bin/taskmote.js status
node bin/taskmote.js undo
```

Phone approval cards need the `v1` preset: see [Try the v1 base](#try-the-v1-base-phone-chat-voice-approval-cards).

## Before you rely on it

> **Before you start:** Taskmote runs AI agents on your machine, with your user's rights. The trunk only listens on `127.0.0.1`, and every optional module is **off** until you turn it on. Read [Security](#security) before you expose it to a phone or a network.

> **A paired phone has your powers.** By default (`engine.profile: "full"`) each bot is a persistent Claude Code session with your own Claude settings, tools and MCP servers. Anyone holding a paired device can make it do what you could do at this keyboard, except the red-line actions, which the guard blocks or holds for your yes. Treat pairing like handing over a logged-in laptop: pair only devices you own, list them with `node bin/harness.js devices`, and remove one with `node bin/harness.js revoke <id>`. Set `engine.profile` to `"locked"` for the older narrow tool allowlist.

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

Coding agents are good at doing things, but they are less good at stopping cleanly when your laptop sleeps, telling you honestly whether a test passed, or waiting for you before they `git push`. Taskmote is a small wrapper around Claude Code that handles those parts: it keeps a crash-safe journal, gives one task one executor, takes a checkpoint before every change, and stops risky actions until you say yes.

## What it is

**It is**
- A local, single-owner tool. Pure Node.js 18+, no dependencies to install for the core.
- A small trunk (journal, lock, engine launch, resume, config, module loader) plus opt-in modules: phone chat, voice, approval cards, rooms, a worker on a second machine.
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
- `undo` steps the task folder back one change; run it again to go back further.

On Windows, `bin\taskmote.cmd` does the same; put `bin` on your PATH to type `taskmote do "..."`.

## Try the v1 base (phone chat, voice, approval cards)

`v1` is a ready-made set of modules. It changes no settings and holds no secrets.

1. In your config file (`~/.harness/config.json`, or the file named by `HARNESS_CONFIG`), add `"preset": "v1"`. If you have no config yet, create the file as `{ "preset": "v1" }`. Your own `modules` entries always win over the preset.
2. Run `node bin/taskmote.js serve`. It listens on `127.0.0.1:7420`.
3. Open <http://127.0.0.1:7420/m/app-ui/ui/> (keep the `/ui/` at the end). The page asks for a pairing code the first time, even on this computer: run `node bin/harness.js pair` and type the six digits it prints. **It worked if** you can send "hello" and see a reply.
4. **Phone (optional).** A phone cannot reach `127.0.0.1`. Put this computer on a private network you control (for example Tailscale), set `server.host` to that address, and restart `serve`. Then run `node bin/harness.js pair`, and open the printed link on the phone or type the code there. `node bin/harness.js devices` lists phones and `node bin/harness.js revoke <id>` removes one. Never open the port to the internet.

`node bin/taskmote.js preset v1` shows what the preset turns on. It never writes a file. The verb is the `presets` module (on by default); with it off, the verb says to turn it on.

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

- **Undo anything the agent changed.** `checkpoint` snapshots before each change; `undo` and `restore` are owner-only.
- **Risky actions wait for you.** With `approval-cards`, a `git push`, a delete outside the task folder, an install or a paid API call stops until you answer `do yes` or `do no`. No answer in 10 minutes counts as no.
- **Honest replies.** `tripwires` flags a reply that claims "tests pass" when the run exited with an error, and with `"tripwires": {"mode": "block"}` in the config it holds that reply back; `claim-audit` checks "done" claims against the journal.
- **Chat from your phone.** `chat-ui`/`app-ui` with `device-pairing` gives one-time codes and per-device tokens you can revoke.
- **Voice.** `voice` and `voice-chat` add hands-free turns, including answering approval cards by voice.
- **A second machine.** `worker` pulls jobs over outbound HTTP only.

## Modules

Every module is off by default, except the two safety modules `guard-base` and `checkpoint` and the CLI helper modules `scaffold` and `presets`. `guard-base` is locked on: a config or preset that turns it off is refused, so `serve` will not start and every tool call is blocked until it is fixed. Turning `approval-cards` off is allowed, but `serve` warns that every red-line step will then be refused. "Can touch" is what the module itself reads or changes beyond the trunk.

| Module | What it does | Can touch | Default | In v1 |
|---|---|---|---|---|
| `guard-base` | blocks API keys, mass deletion, skipped git hooks, secret writes | nothing; it only blocks | on (locked) | ✓ |
| `checkpoint` | snapshot before every change; `undo`/`restore` | the task folder (git snapshots) | on | ✓ |
| `scaffold` | the `new-module` verb: skill folder to module folder | writes a new folder under `modules/` | on | |
| `presets` | the `preset` verb: shows what a profile from `presets/` turns on | reads `presets/` and your config; writes nothing | on | |
| `guard-private-rules` | your own red lines from a rules file | reads your rules file | off | ✓ |
| `gitleaks` | runs the `gitleaks` program before git commit/push; blocks on findings | runs an external program you installed; reads the repo | off | |
| `approval-cards` | risky actions ask yes/no | nothing; it only pauses | off | ✓ |
| `question-cards` | an agent asks you a multiple-choice question | its own state | off | ✓ |
| `tripwires` | flags (or, in block mode, withholds) replies that contradict the exit code | engine output files of that turn | off | ✓ |
| `task-watchdog` | flags stalled or looping tasks; can cancel them | the running task | off | ✓ |
| `task-board`, `memory-tiers`, `trace`, `notifications` | task claims, memory, per-task timeline, inbox | their own state | off | ✓ |
| `chat-ui`, `app-ui` | browser and phone chat | serves pages on the server address | off | ✓ |
| `device-pairing` | pairing codes and per-device tokens | issues tokens that can reach the chat | off | ✓ |
| `voice`, `voice-chat` | voice bridge and hands-free layer | microphone and speaker through the voice client | off | ✓ |
| `rooms`, `chat-endpoint` | multi-bot rooms; a bot behind an OpenAI-style URL | sends room text to the URL you configure | off | ✓ |
| `worker` | runs queued jobs on a second machine | one work folder on that machine; outbound HTTP | off | ✓ |
| `ntfy` | push pings (task finished, blocked, approval waiting) to your phone | outbound HTTP POST to the ntfy server you configure | off | |
| `ccusage` | per-day / per-session Claude Code token and cost reports (runs the ccusage program via npx) | runs `npx`; reads Claude Code logs through it | off | |
| `spend-count`, `claim-audit`, `engine-router`, `routines`, `search`, … | see each module's README | see its README | off | |

Each module has its own `README.md` with its limits. To write one, copy [`modules/hello-stub`](modules/hello-stub/README.md).

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
