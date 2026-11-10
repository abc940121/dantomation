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
11. OpenCode engine: `engine` may also be "opencode", with an optional `model`. `engines/opencode.js` mirrors codex.js
    (plain stdout, session id in module state, one fresh retry) but passes the prompt as an attached file with stdin closed
    (the recipe that works with the real client). Only two model ids are allowed (free, then the Go plan); anything else is
    refused unless listed in `roles.opencode_extra_paid_models`, so nothing can start billing per use. Free exhausted: one retry
    on Go and a 120 minute memory; quota and key errors get a bilingual reply, never a retry loop. Success = exit 0 + non-empty text.
    A per-run `opencode.json` carries the tools server and permission denies; shell is off unless `opencode_allow_bash`.
    Network stays on by default (`opencode_allow_web`, true). A real run showed that denying `webfetch` alone is not enough:
    the model falls back to the Code Mode `execute` tool, whose `fetch` is not governed by that rule. Web off therefore denies
    `execute` and the other network tools; the cost is that the MCP tools (reached through Code Mode) go away with it.
    Each run has a timeout (default 900 s, process tree killed). Go turns are counted across roles with an optional
    `go_daily_cap` (named in snake_case because module setting keys must be lowercase).
12. Daily turn cap for non-Claude engines: `engines/limits.js` counts turns per role and local day in module state.
    The engine scripts are separate processes, so they read `roles.daily_turn_cap` (default 200, 0 = off) from the config file
    themselves. A refused turn is a normal reply (exit 0) with a bilingual notice, so the owner sees it in chat.
13. Roles talking to each other (`role_ask`) is asynchronous, a mailbox. A synchronous version (the tool waits for the answer)
    cannot work: the executor runs one task at a time, so while the asking role waits inside its turn the target's task never
    starts, and it also runs into the engines' MCP tool timeouts. So `role_ask` queues a `queue_add` for the target through the
    journal (what the server does for a chat message, so no trunk change) and returns; `ask.js` records the ask in
    `asks.json` and, once the target task is over (`task_done`, `queue_fail` or `queue_cancel` in the journal), queues the reply
    into the asker's own thread. The return leg is driven by journal state from a module job plus `task.end`, because a stopped
    task may never emit `task.end`, and a restart must not lose answers. The entry is marked delivered before the reply is queued
    (reverted if queueing fails) under a lock directory, so delivery is once. Chain depth (3) and size (12) are capped, and loops
    are refused, so two roles cannot talk forever. Engine tool timeouts are left alone.
