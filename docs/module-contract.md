# Module contract v3 (FROZEN)

Version: **contract v5**

This page is the frozen list of what a module may use, plus the additions made since
v1 (tests, logs, branch rule, manifest version). Field semantics are specified in
[MODULES.md](MODULES.md) (document v1.2). Anything not listed here is not part of
the contract and a module must not depend on it.

Version line: the single line `Version: **contract vN**` at the top of this page. A
contract bump changes that line and adds one row to the Changelog table (`| N | ... |`,
same N) in the same commit, and that commit's subject starts with `contract:`.

The manifest field `contract` is the contract version the module was written
against. The loader accepts 1 up to the trunk's supported version and refuses a higher number
with a load error ("needs module contract N; this core supports up to M"). All
modules in this repo set it explicitly (currently `contract: 2`). A manifest
without `contract` is refused ("module <name> has no contract field"); `contract: 0`
explicitly marks a legacy module (see MODULES.md).

## The rule

A module branch must not touch trunk paths: `lib/`, `bin/`, `guards/`, `config/`,
`test/*.js` (core suites and `test/run-all.js`), root docs (`README.md`,
`DECISIONS.md`, `PROVENANCE.md`, `THIRD_PARTY.md`, `docs/`). It adds or changes files
only under `modules/<name>/`. The only exception is a contract version bump: a
commit whose subject starts with `contract:` **and** that itself changes this page
(`docs/module-contract.md`) by bumping the `Version:` line and adding a Changelog
row for that version. A `contract:` commit without that doc change is an ordinary
commit and its files outside `modules/<name>/` fail. Check it with:

    node test/trunk-diff.js <base-ref> [--module <name>]

It lists the files changed in each non-merge commit of `<base>..HEAD` and fails when
one is outside `modules/<name>/` (any single module folder, or the named one with
`--module`). `node test/run-all.js all --base <ref>` runs it as the `trunk-diff`
suite; without a base it prints SKIP.

## Hooks a module may use (all in `modules/<name>/index.js`)

Manifest fields (unknown fields are a load error):

| Field | Purpose |
|---|---|
| `contract` | integer: the contract version the module was written for (1 to the version above; in-repo modules set 2) |
| `name` | equals the folder name |
| `description` | one line |
| `runsOn` | `"main"` and/or `"worker"` |
| `priority` | order within dependency order |
| `dependsOn` | modules reached through `ctx.api(name)` |
| `beforeTool(ctx)` | guard hook, `null` allows, `[kind, reason]` blocks |
| `statusLines(J, ctx)` | lines for `dantomation status` |
| `prepareTurn(ctx)` | context strings added to the engine prompt |
| `on` | event handlers (events below) |
| `emits` | extra event prefixes the module may emit |
| `commands` | `harness.js <verb>` / `dantomation <verb>` |
| `routes` | HTTP routes under `/m/<name>/`: `{method, path, handler, description?, access?}` |
| `panels` | UI panels `{id, title, mount, entry}` |
| `jobs` | background work started by `registry.startJobs(ctx)`: `{id, every, run}` or `{id, start}` |
| `settings` | typed schema of the config section `modules.<name>` / section `<name with - as _>`; `type: 'secret'` for secrets |
| `provides` | `{tools, bots, engines}` lists |
| `stateVersion`, `migrate` | layout version of `state/m/<name>/` |
| `uninstall(ctx)` | cleanup outside `state/m/<name>/` |
| `api` | module exports for `ctx.api(name)` |

Route access kinds: `owner` (default), `worker`, `public-get` (GET only),
`public-post` (POST only; the module rate-limits itself).

Actor kinds in `ctx.actor`: `owner`, `worker`, `anonymous`, each with an `id` (a
paired device is `device:<id>`).

Events: `task.start`, `task.end`, `tool.done` (core), plus `<module>.*` and declared
`emits` prefixes. `module.*` and `core.*` are reserved.

UI serving: static files under `modules/<name>/ui/` are served at
`/m/<name>/ui/...` (regular files inside the module folder only); a panel entry is
a browser ES module exporting `mount(el, {base, fetch})`.

Context a callback gets: `settings`, `secret(key)`, `config`, `state`
(`dir`, `append`), `api`, `emit`, `tasks`, `signal`, and per hook the extras listed
in MODULES.md.

## v2 additions

### Tests: `modules/<name>/tests.json`

    { "suites": [ { "label": "my-suite", "file": "test/my-suite.js", "needs": ["my-module"] } ] }

`file` is relative to the module folder; `needs` lists modules that must be on
(empty: the suite runs in any mode). A suite is a Node script: exit 0 passes, a
`SKIP:` line skips. `run-all` discovers every `modules/*/` with an `index.js`, so
adding a module never edits `test/run-all.js`:

    node test/run-all.js module <name>   only that module's suites
    node test/run-all.js all [--parallel] [--jobs N] [--base <ref>]

Suites must be safe to run in parallel: bind port 0 and read the real port back,
use a private temp state dir, and no fixed ports or shared paths.
A suite that creates folders under `modules/` or scans the whole tree may set
`"exclusive": true` in its tests.json entry: with `--parallel` it then runs alone,
after the parallel phase. `--jobs N` caps concurrent suites (default 2 to 4).

### Logs: `modules/<name>/DECISIONS.md` and `PROVENANCE.md`

Module decisions and provenance live in the module folder (append only). The root
`DECISIONS.md` and `PROVENANCE.md` hold trunk rows only.

### Decisions that span modules: `docs/decisions/<slug>.md`

One file per cross-cutting decision, listing the modules it spans. A decision that
affects only one module goes in that module's `DECISIONS.md`; one that affects
trunk only goes in the root `DECISIONS.md`. The root file keeps a pointer line to
each cross-cutting file. Because these files live under `docs/`, adding one is a
trunk (`contract:`-style) change, not a module-branch change.

### Not in the contract

`README.md` of a module is free text. Core never requires a module by name; a module
never requires another module's folder.

## Changelog

| Version | Change |
|---|---|
| 1 | Manifest loader (`contract: 1`, strict field check), MODULES.md v1.2. |
| 2 | Per-module `tests.json` suites, per-module DECISIONS/PROVENANCE logs, trunk-diff branch rule, parallel runs. |
| 3 | Manifest `contract` field is the contract version (1 to 3, higher refused); in-repo modules set 2. `contract:` commits are exempt from trunk-diff only when they change this page (version line + changelog row). One file per cross-cutting decision in `docs/decisions/`. |
| 4 | Suite assertions follow the manifest `contract` field (in-repo modules declare 2); no behaviour change. |
| 5 | A manifest without `contract` is refused with a load error; legacy modules must say `contract: 0`. |
