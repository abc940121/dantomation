# rooms

Multi-character rooms with local routing and safe context replay. Off by default; the chat-ui shows a room picker when this module is on.

Enable: set `"rooms": true` under `modules` in the config, and define `settings.rooms`:

```json
{ "dev": { "lead": "ann", "window": 20, "members": [
  { "id": "ann", "name": "Ann", "bot": "ann-bot", "voice": "voice-a" },
  { "id": "bob", "name": "Bob", "neverLead": true, "addressedOnly": true, "contextLines": 3, "noRoomMemory": true }
] } }
```

Room ids must match `[A-Za-z0-9_-]+` (the device allowlist only admits that shape). A room with any other id (for example `dev.team`) is skipped and listed in `problems`.

A room's transcript loads in full on first open (no paging yet).

Routes (under `/m/rooms`): `GET /rooms`, `GET /rooms/:id/messages?since=`, `POST /rooms/:id/say {text}` (202, answers arrive as transcript lines), `POST /rooms/:id/summary {text}`.

Routing, fixed and local: `@everyone` wakes all; else unambiguous @mentions (same-name ties dropped); else the lead; a room may have no lead, then nobody auto-answers. One responder at a time per room. A "(pass)" or empty reply is no reply. A bot reply's @mention causes at most one hop.

Bot post limits: duplicate within 60s, more than 10 per minute, A to B to C to A ring. A trip closes bot posts for 5 minutes; refused text is never stored. A human line flushes all pending bot turns.

Replay: other members' lines are JSON-quoted with a provenance label and treated as background; cut history becomes one "N earlier messages omitted" line; a summary is a labeled data block and never the assistant role. Per-member flags: `neverLead`, `addressedOnly`/`contextLines`, `window`, `noRoomMemory` (room lines not stored as its memory, PII scrubbed), `voice` (a line is only voiced as its own speaker).

Records in the journal: `room_msg`, `room_seen`, `room_summary`, `room_event`.

External engines: a member with `"engine": "<name>"` (and an `endpoint` block) is answered by an engine module that registered a deliverer through `ctx.api('rooms').registerDeliverer(name, fn)` (see `chat-endpoint`), never by a harness task. With no deliverer registered the member is unavailable: one short system line, no fall-back. Such a member defaults to `neverLead` (unless `endpoint.lead_eligible` and `sees: "all"`), `addressedOnly`, `contextLines` 6, no room memory, and its text is kept out of the room store unless `endpoint.journal_text` is true (the text is then held in this process only, and reads `[text not kept]` after a restart). A summary is never sent to an engine member; it gets the original lines. A voice id held by an engine member is reserved: other members lose it (reported under `problems`), and `canUseVoice(voice, memberId, roomId)` tells (ownership is keyed by room and member, so the same member id in another room does not inherit it). A deliverer may return `{text, voice?, emotion?, intensity?}`; `voice` counts only if it equals the member's own voice, `emotion` is stored on the message as a cue only if it is one of neutral, happy, sad, angry, surprised, calm, excited, worried, tender, playful and the member keeps text (`journal_text`); otherwise it is dropped (nothing consumes it yet). `intensity` is stored next to a kept emotion only if it is a finite number, clamped to 0..1. A reply is checked against the floor before delivery and again before posting: if the owner holds the floor the turn waits up to 20 s, then drops the reply if the floor is still held or the human spoke meanwhile. Each such drop of an engine member's reply appends a journal `room_event` `{kind: 'reply_dropped', event: 'reply_dropped', room, member, reason: 'floor_held'|'human_spoke', at}`; the dropped text is never stored. It is a journal record only (the engine has no event stream). `POST /rooms/:id/say` accepts `type: "voice_transcript"` to mark a spoken line. `scrub` removes whole PEM blocks (BEGIN to END, or to the end of the text when unterminated).

`POST /rooms/:id/floor {speaking}`: a client with voice activity detection calls it while the owner is speaking; bot turns in that room wait (auto-release after 15 s, or when the owner says a line).

Rooms from another module: `require('../rooms').api.registerRoomSource(fn)` (called from a module job, so rooms stays an optional dependency and there is no `dependsOn`) registers `fn() -> { "<room id>": { name?, lead?, members: [...] } }`, the same shape as `settings.rooms`, plus an optional display `name` (trimmed, at most 80 characters) that the chat page shows instead of the id; it returns an unregister function. Sources are read on every request, so a room that appears there needs no config edit and no restart (queues and budgets of the other rooms are kept). A config room wins an id clash; a source that throws or returns a non-object adds nothing. The `roles` module uses this for owner-made groups (see its README).
