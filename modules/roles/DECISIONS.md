# roles decisions

1. Role = bot. A role gets the id `r-<8 hex>` and is listed as a bot, so it has
   its own conversation, tasks and work folder with no new concept in core. The
   engine is the default bot's engine; runs on main.
2. Dynamic registration seam: a module api function `dynamicBots()` returning
   `[{id, name}]`. Core (`allBots()` in lib/server.js) reads it on every call,
   so nothing is cached and no restart is needed. Config bots win an id clash;
   `bots: "all"` stays configured bots only, so a broadcast does not wake roles.
3. MCP seam: `api.mcpTools` = `[{name, description, inputSchema, run(args, ctx)}]`.
   The MCP server lists them while the module is on; core tool names win a
   clash. This is the only way the owner reaches roles: no UI form, no routes.
4. The api works with and without `this.ctx`: core calls it without (state dir
   `state/m/roles`, the path the loader uses), modules with it.
5. Persona goes in through `prepareTurn` (same pattern as bot-persona: bot of the
   task from `task_start`, then `HARNESS_BOT`). No tool is narrowed.
6. Remove = archive. Nothing is deleted; names of archived roles can be reused.
7. Writes: one JSON file, temp file plus rename, mode 600, re-read on every
   call because the server and the MCP process both write it. A rare
   simultaneous create from both could lose one record; roles are made by hand,
   so no lock was added.
8. Journal notes carry id and name only, never the persona text.
9. Work folder for a new bot id is created automatically (ensureWorkdir on the
   first task); nothing extra is needed.
10. Engine per role: `engine` is "claude" (also when the field is missing) or "codex". The module answers
    `chooseEngine` with the key "codex"; the owner adds one config `engines` entry (turn engine, plain stdout). The core
    is untouched. `engines/codex.js` is a plain script: Codex session id in module state (not the work folder), resume with
    one fresh retry, sandbox and approval policy as `-c` overrides because `codex exec resume` has no `-s`.
