# device-pairing

A phone gets its own revocable token instead of the owner token. Off by default (`"device-pairing": true` under `modules`).

## Flow

1. The owner runs `node bin/harness.js pair` (or `POST /m/device-pairing/mint` with the owner token). It prints a six-digit code and a long code for a QR or link.
2. On the phone open `http://<server address>/m/chat-ui/ui/#p=<long code>` (QR), or open the page and type the six digits. The page POSTs the code to `/m/device-pairing/redeem` (no token needed) and gets a per-device token. The fragment is stripped from the address bar at once.
3. The phone keeps that token in localStorage and sends it as a bearer token. The owner token never reaches the phone.

Transport is the owner's job: Tailscale or another private network. This module adds no relay, tunnel or cloud part.

## Rules

- A code is single use, lives 2 minutes, and only its SHA-256 is stored. Both the long and the six-digit form redeem the same pairing.
- Five wrong guesses (counted across all callers) wipe every pending code and refuse redeem for 30 seconds (429). Minting a new code resets the guess counter.
- A device token is `dvt_<id>.<secret>`. Only its SHA-256 and a record are stored: label, created, last seen, revoked. All comparisons are constant time.
- A device unused for 30 days must pair again; each use renews that (sliding).
- `node bin/harness.js devices` lists devices, `node bin/harness.js revoke <id>` (or `POST /m/device-pairing/devices/:id/revoke`) revokes one. Revocation takes effect on the next request.
- Every state-changing call by a device is journaled as `device_action` with the device id, label, method and path. Reads are not.

## What a device may call (deny by default)

| Allowed | Why |
| --- | --- |
| `GET /api/bots, tasks, tasks/:id, cards, status, events` | read the chat, the roster, pending cards, the event stream |
| `POST /api/chat` | send a message (the only way a device starts work) |
| `POST /api/cards/:id` | answer an approval card, the phone's main job |
| `POST /api/tasks/:id/stop` | the safe action: stop a runaway task |
| `POST /m/voice-chat/utterance, poll, playback` | voice chat |

Everything else is 403: creating a task with an arbitrary bot, undo and resume (they rewrite files), `/api/settings`, `/api/worker`, pairing admin (mint, list, revoke), and every other module route. A device that could change config or mint codes could grant itself more.

The allowlist lives in `store.js`; core consults it through the module's `api` and has no copy.

## Deprecated: the owner token on the phone

Opening the chat page as `#t=<owner token>` still works so existing setups keep running. It is deprecated: that token can do everything and cannot be revoked per device. Use pairing. Removal is a later decision.

## Core seams (two small ones)

- `access: 'public-post'` for a module route: a tokenless POST, same-origin only. Used only by `/redeem`, which rate-limits itself.
- The server asks this module's `api` to authenticate a bearer token, then gates the request on `allows`, journals via `audit`, and runs allowed calls as the owner with actor id `device:<id>`.
