# chat-ui

A phone-first web chat for the taskmote server. Plain HTML, CSS and JS: no framework, no CDN, no build step. Off by default.

Turn it on with `"chat-ui": true` under `modules` in the config. The module only declares its panel (`index.js`, module contract 1; entry `ui/panel.js`); core serves `ui/` as static files under `/m/chat-ui/ui/` through the registry (GET and HEAD only). Static files are public (they hold no data); every `/api` call still needs the token.

## What it shows

- **Roster.** Bots from `GET /api/bots`, each with a status dot (idle, busy, offline) and a "waiting" count when a bot has a pending approval card. Tap a bot to read only its thread, or "All activity" for the combined view.
- **Rooms.** When the rooms module is on (`GET /m/rooms/rooms` answers), the roster also lists rooms. Pick one to see its lines with speaker labels (polled every 3 s with `?since=`) and send with `POST .../say`. When rooms is off nothing changes. A paired device may read rooms and say, never the summary.
- **Sending.** Under the thread, toggle "All bots" or any number of bots, type, and send (`POST /api/chat`). Opening a bot's thread preselects that bot. Ctrl/Cmd+Enter sends.
- **Threads.** One block per task: your message, the bot's messages (a non-final message is a live bubble that the next message replaces), and the task state.
- **Tool chips.** Each `tool_call` is a chip that goes from running to ok or failed on `tool_result`. Tap it for the summaries.
- **Approval cards.** A `card_pending` shows inline with big Yes and No buttons and a countdown to `expiresAt`. After `card_resolved` it shows approved, denied or timed out. An answer the server finds unclear (409) shows a message and the card stays open.
- **Undo.** A task with `undo_point` events shows Undo once it is no longer running. Tapping it asks "Roll back?" inside the page, and only "Yes, undo" calls `POST /api/tasks/:id/undo`. The restore point and redo hint are shown as a note.
- **Claims.** The `claims` event gives a per-task badge (verified / checked) and a header total of unverified claims.
- **Connection.** Events come over SSE with automatic reconnect using `?since=<last seq>`. A silent connection (no bytes for 45 s) is dropped and reopened.

All server text reaches the page through `textContent`; the page never builds HTML from data. No browser dialogs are used.

## Token

Every `/api` call sends `Authorization: Bearer <token>`. Open the page once as `.../m/chat-ui/ui/#t=<token>`: the fragment is removed from the address bar at once and the token is kept in this browser's localStorage. Without a token, the page asks for one when the server answers 401 (not needed for loopback while the server's `local_no_auth` is on). Events are read with `fetch`, not `EventSource`, because `EventSource` cannot send the header and the token must never go in a URL.

## Open it from a phone

The server listens on 127.0.0.1 only by default. To reach it from a phone:

1. Set `server.host` to the machine's LAN address (or `0.0.0.0`) and choose `server.port` in the config, then restart `taskmote serve`. This is opt-in, and the server requires the token for any non-loopback caller.
2. Put the phone and the machine on one private network. The simplest safe way is a VPN such as Tailscale: install it on both, and use the machine's VPN address. Setting this up is the owner's job; the module does not do it.
3. Make a token with `taskmote token new`, then open `http://<machine address>:<port>/m/chat-ui/ui/#t=<token>` on the phone. Add it to the home screen if you like.

Do not expose the port to the public internet. The page is served over plain HTTP; the VPN is what encrypts it.

## Try it without the server

    node modules/chat-ui/mock-server.js        # http://127.0.0.1:7421/m/chat-ui/ui/

The mock implements the API draft (bots, chat, tasks, undo, cards, SSE with `since`). A message containing "risky" raises an approval card; one containing "fail" makes a tool fail with an unverified claim. `MOCK_TOKEN=x` turns auth on; `PORT`, `HOST` and `MOCK_DELAY_MS` also work. The mock stores everything in memory.

## Tests

`node test/run-all.js chat-ui` (or `all`). One suite, no browser:

- the pure client logic in `ui/state.js` (event reduction, SSE parser, countdown, request bodies);
- the mock server's endpoints over HTTP, and its real SSE stream folded through the same reducer;
- static checks on `ui/`: no external URLs, no `innerHTML`-style sinks, no `alert`/`confirm`, a viewport meta tag, dark mode, safe-area insets.

## Known limits

- Not checked in a real browser by the suite: layout, touch behaviour and rendering are reviewed by eye. Run the mock and open it at 360 px and at desktop width.
- History is whatever `GET /api/tasks` and the event replay give. The page replays events from sequence 0 on load, so a very long journal means a long first load.
- Two spec gaps are assumed: `GET /api/tasks` is newest first, and a non-final `message` is a live bubble replaced by the next message of the same task.
- A card answer is Yes or No only; free text is not offered. The countdown is cosmetic: the server decides expiry.
- The page does not stop tasks (`/api/tasks/:id/stop`) yet and does not show worker jobs.
- State is kept in memory; a reload rebuilds it from the server. Only the token, and nothing else, is kept in localStorage.
- Plain HTTP on the LAN is readable by anyone on that network. Use the VPN.
