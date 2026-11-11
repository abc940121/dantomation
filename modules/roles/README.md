# roles

Owner-made roles. A role is a bot that is registered while the server runs: a
full agent session with its own conversation, plus a persona text that is added
to its prompt. The owner makes roles by asking in chat; there is no form and no
extra HTTP route. Off by default.

Enable: `"modules": { "roles": true }`. No settings.

How the owner uses it: tell any bot "make a role called X, who is ...". The
agent calls the MCP tool `role_create` (Taskmote's own MCP server lists the
tools of enabled modules). The role shows in `GET /api/bots` and can be used in
`POST /api/chat` at once, with no restart. The chat page refreshes its bot list
after each finished task and every 15 seconds while visible.

MCP tools (provided through `api.mcpTools`):

- `role_create {name, persona, engine?}`: name 1-40 characters, unique (case-insensitive)
  among live roles; persona up to 4000 characters; engine `claude` (default), `codex` or `opencode`;
  optional `model` (OpenCode only, see below). Returns `{id, name, persona, engine}` plus `model` when set.
- `role_update {role, name?, persona?, engine?, model?}`: `role` is an id or the current name. An empty `model` clears it.
- `role_remove {role}`: archives the role (hidden from the bot list). Nothing is
  deleted: the record and the role's conversation and work folder stay.
- `role_list {}`: live roles, with their engine.

A role id looks like `r-1a2b3c4d`. It is the bot id, so the role has its own
tasks, history and work folder (created on its first task, like any bot).
The persona is added to each turn through `prepareTurn` as plain context. It
changes voice and character only: tools are not narrowed, approval cards and
limits apply as for any bot.

Seams in core: `lib/server.js` merges `api.dynamicBots()` of every module into
the bot list (`GET /api/bots`, task creation, `POST /api/chat`; `bots: "all"`
still means the configured bots only), and `bin/taskmote-mcp.js` lists and runs
`api.mcpTools` of enabled modules.

State: `state/m/roles/roles.json`, rewritten atomically. The journal gets
`role_created`, `role_updated`, `role_archived` records (id and name, never the
persona). Tests: `node modules/roles/test/roles.js`.

## GPT roles (Codex)

A role can run its chat turns on the OpenAI Codex CLI instead of Claude Code. Tell any bot "make a role called X on GPT"
(it calls `role_create` with `engine: "codex"`), or `role_update` an existing role. Roles without the field are Claude roles.

One config entry is needed, because the core only runs engines it finds in the config `engines` table. Use an absolute
path: the engine starts in the role's work folder, so a relative path would not be found.

```json
"engines": { "codex": { "bin": "node", "args": ["<repo>/modules/roles/engines/codex.js"], "turn": true } }
```

The module answers `chooseEngine` with `"codex"` for a role set to codex and has no opinion otherwise. Without the entry
the core ignores the choice (journal `engine_choice_ignored`) and the role keeps running on Claude. Needs `codex` on PATH,
already logged in (the engine uses the owner's existing Codex login) and the `roles` module on.

How it works: `engines/codex.js` gets the prompt on stdin and runs `codex exec` in the role's work folder with the
workspace-write sandbox and no approval prompts, `--skip-git-repo-check`, and the `taskmote-tools` MCP server attached. Its
final message is the reply. The Codex session id is kept in `state/m/roles/codex-session-<role id>.json`, so later turns
use `codex exec resume`; if resume fails, one fresh session starts. A turn is stopped after 10 minutes.

Differences from a Claude role:

- No Claude skills, slash commands, hooks or settings. The Taskmote guard hooks and approval cards do not run for it: its
  safety is the Codex sandbox, which limits writes to the role's work folder. Network and other limits follow the Codex defaults.
- Persona and module context are part of the prompt, as for any role. The Taskmote tools (task, journal and role tools) are available.
- The Codex session is separate from any Claude session the role had before. Switching the engine does not carry the
  conversation across; the stored history of each stays.

Undo: set the role's engine back with `role_update {role, engine: "claude"}` (or remove the `codex` entry from the config
`engines` table, which makes every role fall back to Claude at once). Deleting `codex-session-*.json` starts a fresh Codex conversation.
The `roles-codex-engine` suite tests the engine script with a fake codex: `node modules/roles/test/codex-engine.js`.

## OpenCode roles

A role can also run its chat turns on the OpenCode CLI. Tell any bot "make a role called X on OpenCode" (it calls
`role_create` with `engine: "opencode"`, optional `model`), or `role_update` an existing role. `role_list` shows the model and
`opencode_go_turns_today` (Go plan turns of all roles today).

Config entry (the core runs it as a turn engine, same as Codex):

```
"engines": { "opencode": { "bin": "node", "args": ["<repo>/modules/roles/engines/opencode.js"], "turn": true } }
```

Needs `opencode` on PATH (the real binary: free models only answer inside the unmodified OpenCode client) and the `roles`
module on. Without the entry the core ignores the choice and the role keeps running on Claude.

Models and money. The engine never causes new charges on its own. Exactly two model ids are allowed:
`opencode/deepseek-v4.1-flash-free` (free, tried first) and `opencode-go/deepseek-v4.1-flash` (the flat Go plan). Any other
model is refused with a bilingual message unless the owner lists it in `roles.opencode_extra_paid_models`. The engine does not
log in, top up or change any OpenCode account or config.

- "Free usage limit reached" on the free id: one retry on the Go id, and "free exhausted" is remembered for 120 minutes
  (`state/m/roles/opencode-free-exhausted.json`), so later turns start on the Go id. Never more than that one retry.
- "rate limit" or "usage limit reached" from the Go id: no retry, bilingual quota reply.
- "API key has expired" / "unauthorized": bilingual key-renewal reply.
- Success means exit code 0 and a non-empty reply text, nothing else. Words like "success" in the reply mean nothing.
- Go plan turns are counted per day across all roles (`state/m/roles/opencode-go-turns.json`, shown by `role_list`).
  `roles.go_daily_cap` (default 0 = off) refuses with a bilingual reply when reached. This is separate from the per-role cap.

```
"roles": { "opencode_extra_paid_models": [], "opencode_allow_bash": false, "opencode_allow_web": true, "opencode_timeout_s": 900, "go_daily_cap": 0, "daily_turn_cap": 200 }
```

How it works: `engines/opencode.js` gets the prompt on stdin, writes it to a file and runs
`opencode run <short message> --standalone --auto --format json -m <id> [-s <session id>] -f <prompt file>` in the role's work
folder with stdin closed, no shell, no console window. The reply is the text of the last assistant message. The OpenCode
session id is kept in `state/m/roles/opencode-session-<role id>.json`; if resume fails, one fresh session starts.
Each run is stopped after `roles.opencode_timeout_s` seconds (default 900): the process tree is killed and the reply says so, bilingual.

Each run writes an `opencode.json` into the work folder (owned by this module, rewritten every turn) with:

- the `taskmote-tools` MCP server (`node <repo>/bin/taskmote-mcp.js`, env HARNESS_STATE_DIR / HARNESS_CONFIG / HARNESS_TASK_ID);
- permissions: access outside the work folder denied, reading `*.env` denied, editing `opencode.json`, `AGENTS.md`,
  `CLAUDE.md`, `.opencode/`, `.claude/`, `.codex/` denied, shell commands denied unless `roles.opencode_allow_bash` is true;
  network tools (web fetch, web search, Code Mode `execute` with its `fetch`) allowed unless `roles.opencode_allow_web` is
  false, which denies all of them. With web off the `taskmote-tools` MCP tools are unreachable too (OpenCode exposes them
  through Code Mode), so web off suits roles that only read and write files.

Differences from a Codex role: `--auto` approves everything that is not explicitly denied and is not an OS sandbox; the
denies above are OpenCode's own permission rules, not a sandbox. The network is on by default (see `opencode_allow_web`).

Undo: `role_update {role, engine: "claude"}` (clear a model with `model: ""`), or remove the `opencode` entry from the config
`engines` table so every OpenCode role falls back to Claude. Deleting `opencode-session-*.json` starts a fresh conversation.
The `roles-opencode-engine` suite tests the script with a fake opencode: `node modules/roles/test/opencode-engine.js`.

## Roles talking to each other

The tool `role_ask({ role, message })` lets one role (or the main bot, `"main"`) send a message to another role, whatever engine
either one runs on (Claude, Codex, OpenCode). It does not wait. It checks the target, queues the message into the target's own
conversation (the same journal record a chat message to that bot makes) and returns at once with `{ queued: true, task_id, to }`
and a bilingual note telling the asking role to end its turn. When the target's task ends, the module queues the reply into the
asker's own conversation as a new message headed `[角色「Y」的回覆 / reply from role "Y"]`, so the asker continues from there.

- The target sees `[來自角色「X」的訊息 / message from role "X"]` and one line saying its answer is sent back automatically.
- A reply is cut at 8000 characters (marked). A failed, stopped or cancelled target gives a short bilingual failure note instead.
- Refused with a clear bilingual text: unknown or archived role, asking yourself, a role already in the chain (a loop), a chain
  deeper than `roles.ask_depth_cap` (default 3), or more than `roles.ask_chain_cap` messages in one chain (default 12). The role is
  told to answer with what it has. The reply-delivery turn counts as part of the same chain.
- Only usable inside a role conversation (it needs the running task). Outside one it says to use the chat page.
- State: `state/m/roles/asks.json`, one entry per ask keyed by the target task id (`from`, `to`, `depth`, `chain`, `asked_at`,
  later `delivered_at`). Entries are marked, never deleted. Delivery is exactly once, also across a server restart: a module job
  (every 5 seconds) and the `task.end` event sweep every finished, undelivered ask.
- It needs the running server: in direct mode nothing runs the queued message.
- The tests are `node modules/roles/test/ask.js` (suite `roles-ask`).

## Daily turn cap

Roles on the Codex and OpenCode engines count their turns per role and local day in `state/m/roles/turns-<role id>.json`.
The cap is the config key `roles.daily_turn_cap` (default 200, `0` = off). When a role reaches it, the turn is not run and the
reply states the cap and that it resets tomorrow, in English and Traditional Chinese. Refused turns are not counted.

## Group chats

The owner can ask in chat for a group ("make a group called 週末計畫 with Ann and Bob"): no config edit and no restart. Needs `modules.rooms: true`; with rooms off the tools answer with a bilingual error that says so.
群組聊天：直接在聊天裡說「開一個群組」即可，不用改設定也不用重新啟動；需要先開啟 rooms 模組，沒開時工具會回覆中英文說明。

- Tools: `group_create {name, members}`, `group_update {group, name?, add?, remove?}`, `group_remove {group}` (archives, never deletes), `group_list`. Members are role names or ids; `group` is the `g-<8hex>` id or the current name.
- Stored in `<state>/m/roles/groups.json` (same atomic save and damaged-file handling as `roles.json`). The room id is `g-<8hex>`; the display name is whatever the owner chose, in any language.
- The main bot is always a member and the lead (a message with no @mention goes to it; `@everyone` wakes all; `@<role id>` wakes one role). Each role member is its own bot (`bot: "r-..."`), so it answers with its own persona, engine and conversation.
- A role that is archived or removed drops out of the group on read; the stored list is not rewritten.
- How it reaches the chat page: a job registers a room source with the rooms module (only when rooms is on). The chat page re-reads the room list every 5 seconds, so a new group shows up without a reload.
- In a group, `@name` wakes that role. A Chinese name works without spaces around it (`@小橘你好`); the longest matching name wins.

## Known limits

- A Codex or OpenCode role can read any file the user can read. Only Codex writes are sandboxed (to the work folder); OpenCode has no OS sandbox.
- The Claude Code guard hooks (and Taskmote approval cards) do not run inside the Codex or OpenCode engines.
- The network is on in an OpenCode turn by default (web fetch, web search, Code Mode `fetch`). Set `roles.opencode_allow_web` to false to deny every network tool; a shell command (`opencode_allow_bash`) could still reach the network, so keep that off too.

## Undo

Two steps, in this order:

1. Set `"modules": {"roles": false}` in the config (or restore the config backup made before the module was enabled). A config that still enables a module whose folder is gone stops the server at start with `module load error`.
2. Revert the commits that added the module.

`roles.json` in the module state folder can stay; nothing reads it while the module is off. Roles and their conversations come back when the module is enabled again.

Undoing a `role_ask` chain: each ask and each delivered reply is its own turn, so a chain is undone one turn at a time (the latest turn of each role), not as a whole. A message from another role is marked as text from a role, not from the owner; the receiving role is told to treat it as data, not as instructions.
