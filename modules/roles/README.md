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

- `role_create {name, persona}`: name 1-40 characters, unique (case-insensitive)
  among live roles; persona up to 4000 characters. Returns `{id, name, persona}`.
- `role_update {role, name?, persona?}`: `role` is an id or the current name.
- `role_remove {role}`: archives the role (hidden from the bot list). Nothing is
  deleted: the record and the role's conversation and work folder stay.
- `role_list {}`: live roles.

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

## Undo

Two steps, in this order:

1. Set `"modules": {"roles": false}` in the config (or restore the config backup made before the module was enabled). A config that still enables a module whose folder is gone stops the server at start with `module load error`.
2. Revert the commits that added the module.

`roles.json` in the module state folder can stay; nothing reads it while the module is off. Roles and their conversations come back when the module is enabled again.
