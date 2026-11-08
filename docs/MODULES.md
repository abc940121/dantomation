# Module contract (version 1, document v1.2)

A module is a folder `modules/<name>/` whose `index.js` exports one manifest
object. It is switched on with `"modules": { "<name>": true }` in the config.
Core (`bin/`, `lib/`, `guards/`) never names a module: `lib/modules.js` finds the
enabled ones at run time, checks each manifest and builds the registry. Adding a
feature = adding a folder and a config line. `modules/hello-stub/` uses every
field once; copy it.

Document v1.2 adds optional fields and seams only; manifests still say
`contract: 1` and every v1.1 module loads unchanged.

## Trust model

A module is trusted code. It runs inside the harness process with the owner's
rights and can read or write anything that process can. Enabling a module is
the owner's decision, the same as installing a program. `dependsOn`, `emits`,
`ctx.state` and route `access` are rules core follows when it calls modules and
serves routes: `dependsOn` governs only what `ctx.api` / `registry.api` hand
out, and none of it is a sandbox. Do not enable a module you would not run as a
script.

## Rules for every field

- Only the fields below are allowed. An unknown field, a wrong type, a duplicate
  id or route, a missing or off dependency, a dependency cycle, or a config
  section that does not match `settings` is a load error
  `<name>: <every problem, joined by "; ">`. The other modules still load. The
  guard then blocks every call and `start`/`resume` exit 2 until it is fixed
  (fail closed).
- A module may `require` core (`lib/`). Core never requires a module. A module
  never requires another module's folder (`require('../<other>/...')`); it lists
  the other module in `dependsOn` and calls `ctx.api('<other>')`. A static scan in
  `test/module-events.js` fails on any such require.
- Every hook, event handler, command, route handler and job may be `async`; core
  awaits it.
- Every timed callback gets `ctx.signal`, an `AbortSignal` aborted when core
  stops waiting (hook timeout, or job shutdown). Pass it to `fetch` and the like.
  A synchronous busy loop cannot be stopped by anything; keep callbacks short.
- Every callback's ctx also has `ctx.secret(key)` (see Secret settings) and
  `ctx.tasks` `{enqueue, get, cancel}`: a stub reserved for the task service of
  S1. Until then each call rejects with "tasks service not available until S1".
- Error text from a module is scrubbed of that module's secret values before
  core prints or journals it.
- Callbacks must not exit the process (commands excepted), must not keep timers
  outside `jobs`, and write only through `ctx.state` (see State), the log dir or
  the task folder.
- In-repo modules are all contract 1. A manifest without `contract` is a legacy
  contract-0 module, for modules kept outside this repo: it loads, unchecked,
  with a printed warning (`module <name> uses legacy contract 0`). Only `name`,
  `priority`, `beforeTool`, `afterTool`, `onTaskStart`, `onTaskEnd`,
  `statusLines` and `commands` are read; its ctx is the old one (no `state`,
  `api`, `emit`).

## Load order

Dependencies first, then `priority` (lower first), then config order. This one
order is used for `beforeTool`, events, status lines and command claims.

## Fields

### `contract`: integer, required
The contract version the module was written for. A value above the core's version is a load error ("needs module contract 2").
`contract: 1`

### `name`: string, required
Must equal the folder name (`[a-z0-9][a-z0-9-]*`). `task`, `tool`, `module` and `core` are reserved (core's event prefixes).
`name: 'approval-cards'`

### `description`: string, optional
One line for listings.
`description: 'Risky actions stop and ask the owner.'`

### `runsOn`: `"main"` | `"worker"` | both as an array, default `"main"`
Where the module loads. `load(cfg, {role})` skips modules whose `runsOn` leaves the role out. The worker (S3) loads with `role: 'worker'`.
`runsOn: ['main', 'worker']`

### `priority`: number, default 0
Order within the dependency order: lower runs first, ties keep config order. Hard blockers use 0, modules that ask use 50, snapshots use 90.
`priority: 50`

### `dependsOn`: `[name]`, default `[]`
Modules this one calls through `ctx.api(name)`. `ctx.api` throws for a name not listed here, so `dependsOn` is the only way to reach another module. A listed module that is missing, off, not run on this role or failed to load makes this one a load error (`x: depends on "y", which is off in config "modules"`), and so does a cycle (`x: dependency cycle: x -> y -> x`).
`dependsOn: ['guard-base']`

### `beforeTool(ctx) -> null | [kind, reason]`
Runs in the guard before every tool call, in load order, with ctx `{input, tool, ti, cwd, config, settings, secret, state, api, emit, tasks, signal}`. The first hit blocks.

- Only `null`, `undefined` or `false` allow. `[kind, reason]` (two strings) blocks. Any other result (a string, `true`, an object, a short array) blocks with kind `module_bad_result`, so a mistake fails closed.
- A throw or reject is a block of kind `module`.
- It is cut off after `modules_hook_timeout_ms` (config, default 5000): a block of kind `module_timeout`, never a pass, and `ctx.signal` is aborted. A synchronous busy loop cannot be cut off; keep it fast.
- It must not prompt.

`beforeTool({ tool, ti, settings }) { return ti.command === settings.block_word ? ['hello_stub', 'blocked'] : null; }`

### `statusLines(J, ctx) -> [string]`
Adds lines to `dantomation status`, in load order. It must only read. A throw becomes one line saying so.
`statusLines: J => ['undo points: 3']`

### `prepareTurn(ctx) -> null | { context: [string] }`
Runs before each engine turn (`harness start` / `resume`, after `task.start`), in load order, with the hook timeout. ctx is the module ctx plus `{task_id, request, workdir, resumed, signal}`. The strings are joined and added to the prompt under "Context from modules" as `[<module>] <text>`, clipped at 8000 characters per module. A throw, timeout or other shape is reported and skipped, never a block. Voice turns do not call it yet.
`prepareTurn: ({ resumed }) => ({ context: resumed ? ['this task was resumed'] : [] })`

### `on`: `{ "<event>": fn(payload, ctx) }`
Event handlers. See Events for the names and payloads. Each runs in load order with the hook timeout; a throw, reject or timeout is printed and returned as an error, and never stops core or the other handlers. The payload is a frozen copy.
`on: { 'task.end': async ({ task_id }, { state }) => { state.append({ type: 'my_note', task_id }); } }`

### `emits`: `[prefix]`, default `[]`
Extra event prefixes this module may emit besides its own name. A module emits through `ctx.emit('<prefix>.<name>', payload)` (returns a promise) and only under its own name or a declared prefix; core's prefixes and another module's name or declared prefix are refused, and two modules declaring one prefix is a load error.
`emits: ['card']`

### `commands`: `{ <verb>: fn(args, ctx) }`
Adds `harness.js <verb>` and `dantomation <verb>`, with ctx `{J, EXEC_LOCK, settings, state, api, emit, config}`. The first module in load order to claim a verb wins. A command may print and may exit with a code. It runs as the person at the keyboard, so a command for owners only must refuse when `HARNESS_TASK_ID` is set.
`commands: { hello(args, ctx) { console.log(ctx.settings.greeting); } }`

### `routes`: `[{ method, path, handler, description?, access? }]`
HTTP endpoints for the server (S1). Core serves them at `/m/<name><path>`, so modules cannot collide.

- `method` is one of GET, POST, PUT, PATCH or DELETE.
- `path` starts with `/` and may contain `:param` segments. It may not contain `..` or `//`.
- A duplicate method plus path (with params treated as equal) is a load error.
- Params are URL-decoded before the handler sees them. A request whose decoded param holds `..`, `/`, `\` or NUL, or still holds a percent escape after one decode (`%252e%252e%252f`), matches no route. Among matching routes, a literal path segment beats a `:param` at the first segment (from the left) where they differ (`/admin` wins over `/:page`, and `/lit/:b/:c` over `/:a/b/c`, whatever the declaration order); otherwise the earlier declaration wins. A secret setting must be at least 4 characters (shorter ones cannot be scrubbed from output); output scrubbing also hides each secret's JSON-escaped form, and `ctx.state.append` hides secrets anywhere in the record (any depth, object keys too; the record goes through a JSON round trip, so a Date becomes its ISO string; a record that cannot be serialized is refused).
- `access` says who may call it: `owner` (default), `worker` (the owner or a worker) `public-get` (anyone; GET routes only) or `public-post` (anyone, no token; POST routes only, from a same-origin or no-Origin caller; the module must rate-limit itself, as device-pairing's redeem does). Core enforces it in `callRoute` against `ctx.actor` and answers 403 `{error: 'forbidden'}` before the handler runs. The server (S1) authenticates the caller and passes `actor: {kind: 'owner'|'worker'|'anonymous', id}`; a missing or unknown actor is anonymous. Modules never check tokens.
- `handler(ctx) -> {status, json}` may be async. Its ctx is `{params, query, body, actor, settings, secret, config, state, api, emit, tasks, core}`.
- A throw becomes a generic 500 `{error: 'internal error', ref}`. The detail (secrets scrubbed) goes to a `route_error` journal record whose `id` is `ref`; it never reaches the caller.

`{ method: 'POST', path: '/cards/:id/answer', access: 'owner', handler: ({ params, body, actor }) => ({ status: 200, json: {} }) }`

### `panels`: `[{ id, title, mount, entry }]`
UI for the web app (S2).

- `entry` is a browser ES module under the module's `ui/` folder. After resolving symlinks it must be a regular file inside the module folder; a missing file, a folder or a link pointing outside is a load error. Core serves `ui/` as static files at `/m/<name>/ui/...`, each request resolved through `registry.uiFile` by the same rule.
- The UI imports `entry` and calls `mount(el, {base, fetch})`: `base = '/m/<name>'`, and `fetch` is an authed fetch with `window.fetch`'s signature. A panel calls its routes only through that `fetch`. `mount` may return an unmount function.
- `mount` is one of `chat` (inline in the conversation), `sidebar` or `page`.
- A duplicate `id` within the module is a load error.

`panels: [{ id: 'cards', title: 'Approval cards', mount: 'chat', entry: 'ui/cards-panel.js' }]`

### `jobs`: `[{ id, every, run }]` or `[{ id, start }]`
Background work, started and stopped by core through `await registry.startJobs(ctx)`, which resolves to `{stop()}` (`stop` returns a promise).

- An interval job, `{every, run}`, runs `run(ctx)` every `every` seconds. `every` must be a finite number above 0 and at most 2147483 (the timer limit). A run never overlaps the previous one, so a slow run skips ticks.
- A long-running job, `{start}`, calls `start(ctx)` once. It must return (or resolve to) a stop function. `start` is cut off after the hook timeout; one that settles later is stopped at once.
- `stop()` aborts every job's `ctx.signal`, clears the timers, then goes in reverse load order: it waits for a job's in-flight run, then calls its stop function, each within the hook timeout.
- ctx is the module ctx (`settings, secret, config, state, api, emit, tasks, signal`). Errors are reported and never stop other jobs.

`jobs: [{ id: 'tick', every: 60, run(ctx) {} }]`

### `settings`: `{ <key>: { type, default, description, min?, max?, enum?, items? } }`
The schema of the module's config section. The section is named after the module, with `-` replaced by `_` (`approval-cards` uses `"approval_cards"`).

- `type` is one of string, number, integer, boolean, array, object or secret.
- `items` gives the element type of an array. `min` and `max` apply to numbers, must be finite numbers, and `min` may not exceed `max`.
- `default` must itself be valid.
- When the module is on, core rejects unknown keys and wrong types (`config "approval_cards.timeout_minutes" must be a number, got string "10"`). Every callback then gets the merged values as `ctx.settings`.

`settings: { timeout_minutes: { type: 'number', default: 10, min: 1, description: 'minutes before a card counts as no' } }`

#### Secret settings (`type: 'secret'`)
Write-only. No `default`, `enum`, `min` or `max`.

- The owner sets one with `node bin/harness.js secret <module> <key>` (value on stdin; an empty value removes it). The verb refuses inside a task (`HARNESS_TASK_ID`).
- It is stored in `state/secrets/<module>.json`, owner-only: mode 600 (dir 700) on POSIX; on Windows (icacls) inheritance is removed, the current account is granted full control and every other entry is removed, then the result is checked. On POSIX a file readable by others is a load error. On Windows the entries are checked again on every read and a widened file prints a warning (once per file) instead of failing; the warning carries the exact fix for that file, `icacls "<file>" /inheritance:r /grant:r "<account>:F"`, built from the running account and the real path (never the secret).
- A secret in the config file is a load error that says to remove it and use the verb.
- `ctx.secret(key)` is the value, or `null` when not set; it is the only way a module gets it. `ctx.settings.<key>` and every listing (`settingsFor`, `modules()`) show only `"configured"` or `"missing"`; routes and panels never carry it. Core never puts a secret value in an error or log line, and scrubs a module's secret values out of the errors it reports.

`settings: { api_token: { type: 'secret', description: 'token for the remote service' } }`

### `provides`: `{ tools?, bots?, engines? }`, optional
What this module contributes for others to pick up, each a list of `{id, description?, ...}` (ids unique per kind within the module; other fields are free). Core only validates and lists them: `registry.providers(kind)` returns `[{module, kind, id, ...}]` in load order. This is the seam for custom tools, MCP connectors (a `tools` entry describing a connector), bot types (`bots`) and per-bot model selection (`engines`); the consumers arrive with the server and worker.
`provides: { tools: [{ id: 'hello', description: 'says hello' }] }`

### `stateVersion`: integer >= 1, and `migrate(fromVersion, ctx)`, optional
The layout version of the module's files in `state/m/<name>/`. Core keeps the stored version in `state/m/<name>/state-version.json` (none = 0). On load (`harness start`, `resume` and the dantomation verbs, through `registry.migrate()` / `migrate(mods)`), when the stored version is below `stateVersion`, `migrate(from, ctx)` runs once, timed (60 s), and the new version is written; a `module_migrated` record follows when `from` was above 0. A failure, or a stored version above the module's, is an error and `start`/`resume` exit 2. `migrate` requires `stateVersion`. The guard does not run migrations.
`stateVersion: 2, async migrate(from, { state }) { if (from === 1) {/* rewrite files in state.dir */} }`

### `uninstall(ctx)`, optional
Runs when the owner types `harness uninstall <name>` (refused inside a task), timed (60 s). Cleanup rule: the hook removes what the module made outside `state/m/<name>/` (for example a git ref or an external registration); core then removes `state/m/<name>/` and the module's secrets file and writes a `module_uninstalled` record. Journal records stay. Removing the config line and `modules/<name>/` is left to the owner, and the verb says so.
`uninstall() {}`

### `api`: object, optional
Module-specific exports. Other modules reach it through `ctx.api(name)` (needs `dependsOn`); core reaches it through `registry.api(name)`.
`api: { parseAnswer }`

## Hook time budget

The engine kills a hook call that runs longer than 60 s (`ENGINE_HOOK_LIMIT_MS`). The hooks of one call run one after the other, each within `modules_hook_timeout_ms` (default 5000), so at load core adds up the timeouts of every module that can run on one call: all `beforeTool` hooks (PreToolUse), and all `tool.done` handlers (PostToolUse). A total of 60000 ms or more is a load error that names the modules and the total (`hook time budget: ...`); lower `modules_hook_timeout_ms` or turn a module off.

## Events

Core owns `task.*` and `tool.*` (and reserves `module.*`, `core.*`). Core emits
after the matching journal write, so a handler that reads the journal sees it.

| Event | When | Payload |
|---|---|---|
| `task.start` | `harness start` / `resume`, after the `engine_start` record, before the engine runs | `{task_id, request, workdir, resumed}` |
| `task.end` | after the engine exits and the `engine_exit` record | `{task_id, code, workdir}` |
| `tool.done` | `guard.js --after` (PostToolUse hook, generated into `state/claude-settings.json` next to PreToolUse); also journaled as a `tool_done` record `{task_id, tool, tool_use_id, ok, durationMs}` (no tool input), written before the event | `{tool, input, cwd, session_id, task_id, tool_use_id, ok, durationMs}` (`task_id` null outside a task; `ok` false when the tool reported an error or was interrupted; `durationMs` from the guard's pre-call stamp, null when unknown) |

`tool.done` may later gain `result` and `usage`; handlers must treat both as optional.

Module events, for example approval-cards: `card.created {card_id, task_id, summary, rule, expires_at}` and `card.answered {card_id, task_id, answer}` (yes | no | timeout), each after its journal record.

Handlers in the same process see each other's emits; a nested emit deeper than 8 is dropped and reported.

## State (`ctx.state`)

- `ctx.state.dir` is `state/m/<name>/`, created on first use. Files a module keeps go there.
- `ctx.state.append(record)` writes one journal record `{...record, module: '<name>'}` (fsynced, with `id` and `ts`) and returns it. `record.type` is required.
- A module never writes anywhere else in `state/`. Documented exceptions: `checkpoint` keeps its git snapshots in `state/ckpt/` (restore needs a fixed place) and `voice` uses the flag file `state/voice-notools.flag` (written by the voice seam process, outside any ctx).

## Registry (`lib/modules.js`)

`registry(cfg, {role})` returns:

- `mods`, `errors`
- `modules()`: `[{name, contract, runsOn, dependsOn, secrets: {key: 'configured'|'missing'}, stateVersion}]`
- `listCommands()`
- `listRoutes()`: `[{module, method, path, handler, description, access}]`
- `listPanels()`: `[{module, id, title, mount, entry, url, file}]`
- `listJobs()`: `[{module, id, kind, every}]`
- `providers(kind)`: `provides.<kind>` of every loaded module (kind is `tools`, `bots` or `engines`)
- `settingsFor(name)`: settings with secrets masked, or `null` if the module is not loaded
- `settingsSchema(name)`: `{section, settings}` (the schema, for a settings UI) or `null`
- `updateSettings(name, patch, {save})`: validates the whole patch first (nothing changes if a key is bad); `null` resets a key to its default; a secret key goes to the secrets file (`''` or `null` removes it), never to the config; the rest updates the loaded settings and `await save(section, values)` persists the config section (the server owns writing the config file). Returns the masked settings.
- `api(name)`: a loaded module's `api`, or `null`
- `uiFile(name, rel)`: the real path of a module's `ui/` file to serve, or `null` (outside the folder after symlinks, not a regular file)
- `migrate()`: runs pending state migrations (see `stateVersion`), `{errors}`
- `findRoute(method, urlPath)`: `{route, params}` or `null`
- `callRoute(found, ctx)`: enforces `access` against `ctx.actor`, then runs the handler
- `emit(event, payload)`: core's emit for the server process
- `startJobs(ctx, onError)`: async, resolves to `{stop()}`

It serves no HTTP. The server (S1) and UI (S2) are built on it.

## Planned additive extensions

Later versions are expected to add, as optional fields that leave contract 1
manifests valid: streaming and binary route responses and response headers
(today a handler returns `{status, json}` only); a service-worker scope for
panels that work offline; named UI contribution slots beyond the three `mount`
places (toolbar, settings page, task view); i18n message catalogs shipped in a
module's folder; and a cross-process event transport so emits reach handlers in
the server and worker processes, not only the emitting process. None of these
exist yet; do not depend on them.
