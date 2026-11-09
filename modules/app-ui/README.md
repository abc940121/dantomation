# app-ui

Optional taskmote module (off by default). A browser UI served at `/m/app-ui/ui/`, ported from the
OpenMausBot React UI (Apache-2.0, see `LICENSE-APACHE`, `NOTICE`, root `PROVENANCE.md`). Server code, auth,
routing and client glue are MIT.

Enable with `"app-ui": true` under `modules` in the config. Pair a device through the device-pairing module
(`#t=<token>` or `#p=<code>` in the URL; the hash is stripped after use).

## What the foundation does

Bot list, one chat thread per bot, a plain composer, live streaming over core SSE (`/events`, replay with
`?since=`), English and Traditional Chinese (browser language: zh-Hant, zh-TW, zh-HK, zh-MO give zh-tw, else en).
Send uses `POST /m/app-ui/api/bots/:id/messages`, which calls `ctx.tasks.enqueue(bot, text)`.

## Layout

- `index.js` manifest. `adapter/` server side: `lib.js`, `snapshot.js`, `routes.js`, `frames.mjs`.
- `web/` Vite + React 19 + Tailwind 4 + TypeScript source. `ui/` is the committed build.
- `tools/build.js` (typecheck, build, verify), `tools/provenance.js` (PROVENANCE.md block).
- `provenance/<area>.md` one table per package. `test/*.test.js` run by `test/run.js`.

## Build

```
cd modules/app-ui/web && npm ci
node modules/app-ui/tools/build.js     # typecheck + build into ../ui + verify
node modules/app-ui/tools/provenance.js
node modules/app-ui/test/run.js
```

Areas must not change `web/package.json` or `package-lock.json`. Only the foundation and integration step commit `ui/`.

## Area registry (web)

Add `web/src/areas/<name>/register.ts` (auto-loaded by `areas/index.ts`) and call `registerArea({ id, ... })`.
Never edit foundation files. Fields of `AreaDef`:

- `strings: { en: {...}, "zh-tw": {...} }` registered into i18n. Do not edit `locales/*.json`.
- `slices`: `{ id, initial, reduce(state, action) }`. Every slice sees every action; state is lazy, starting at `initial`.
- `gates`: functions called as hooks each render by the GateHost; the first non-null result replaces the app (pairing uses priority -100).
- `views`/slots (multi slots sort by ascending priority then registration order; single-winner slots take the highest priority, later registration wins ties):
  `main-view` (matched against `ui.view`), `thread`, `composer`, `header-action`, overlays (receive props plus `close`).
- `eventMappers`: run for each live event inside try/catch. `start(api)` runs after the snapshot loads.
- Read state with `useSelector`, act through `useArea()` (`AreaApi`: dispatch, client, navigate, openOverlay, closeOverlay).

New Tailwind tokens: `bg-app bg-panel bg-raised bg-card bg-inset bg-composer border-hairline text-ink
text-ink-secondary text-ink-tertiary bg-accent text-accent-text bg-bubble-user text-danger bg-warning bg-success`.

## Adapter conventions (server)

- Area routes: put a CommonJS file in `adapter/areas/*.js` exporting an array of `{ method, path, handler }`
  (paths without the `/m/app-ui` prefix; duplicate method+path, even with different param names, is refused).
  Route ctx: `{ config, query, params, body, state: { dir }, tasks }`. Handlers return `{ status, json }`.
- Core events are translated by `adapter/frames.mjs` `translate(ev, state)` into frames with stable ids
  (`<task>:u`, `<task>:<bot>:a`, one activity id per tool call). Replays must give identical ids. Unknown events give `[]`.
- Device tokens only reach paths in `modules/device-pairing/store.js` ALLOW; add area paths there deliberately.

## Licensing rules for copied code

Copy only OMB UI code (src, shared type files, manifest). Every copied or derived source file starts with the
3-line Apache header (CSS uses a block comment); JSON files are listed in `provenance/` only. Do not copy
anything from the OMB server, electron, relay, companion, cloudflare, enterprise or connector code, any
T3-derived file, mascot art or brand assets.

## Cards (approvals, questions, notifications)

Area `cards` (`web/src/areas/cards/`, `adapter/areas/cards.js`, `adapter/areas/cards-map.mjs`).

- Core approval cards (`GET /api/cards`, answered with `POST /api/cards/<id>`) show inline in the bot thread with
  Allow and Deny. `card_pending` and `card_resolved` arrive on the event stream.
- Questions are new and live in this module: `POST /m/app-ui/api/questions` (worker or owner) with
  `{bot, task?, title, questions:[{prompt, options:[{label, description?}], multi?, allowText?}], expiresInSec?}`
  (1 to 6 questions, up to 12 options, default 30 minutes, at most 24 hours). Read with `GET api/questions?state=pending|all`
  and `GET api/questions/:id`; answer with `POST api/questions/:id/answer` `{answers:[{selected:[index], text?}]}`.
  A second answer or an expired question gives 409. At most 200 are kept; the oldest answered go first.
  Devices may answer and read questions but not create them.
- Module events do not reach `/api/events`, so the page polls `GET /m/app-ui/api/questions?state=pending` every 5 seconds
  while it is visible. Core card events still come by the stream.
- The header bell counts open, unread cards and questions; its panel jumps to the bot. Read state and the
  notification settings page (browser notifications, include questions) are kept in localStorage, and the page works without it.
  A system notification shows only when the tab is hidden and the browser has granted permission.
- The components are our own (no OpenMausBot file is copied for this area), so `provenance/cards.md` has no rows.
