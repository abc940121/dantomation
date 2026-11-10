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
  among live roles; persona up to 4000 characters; engine `claude` (default) or `codex`.
  Returns `{id, name, persona, engine}`.
- `role_update {role, name?, persona?, engine?}`: `role` is an id or the current name.
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

## Undo

Two steps, in this order:

1. Set `"modules": {"roles": false}` in the config (or restore the config backup made before the module was enabled). A config that still enables a module whose folder is gone stops the server at start with `module load error`.
2. Revert the commits that added the module.

`roles.json` in the module state folder can stay; nothing reads it while the module is off. Roles and their conversations come back when the module is enabled again.
