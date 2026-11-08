# rooms

Multi-character rooms with local routing and safe context replay. Off by default; API only (no chat-ui picker).

Enable: set `"rooms": true` under `modules` in the config, and define `settings.rooms`:

```json
{ "dev": { "lead": "ann", "window": 20, "members": [
  { "id": "ann", "name": "Ann", "bot": "ann-bot", "voice": "voice-a" },
  { "id": "bob", "name": "Bob", "neverLead": true, "addressedOnly": true, "contextLines": 3, "noRoomMemory": true }
] } }
```

Routes (under `/m/rooms`): `GET /rooms`, `GET /rooms/:id/messages?since=`, `POST /rooms/:id/say {text}` (202, answers arrive as transcript lines), `POST /rooms/:id/summary {text}`.

Routing, fixed and local: `@everyone` wakes all; else unambiguous @mentions (same-name ties dropped); else the lead; a room may have no lead, then nobody auto-answers. One responder at a time per room. A "(pass)" or empty reply is no reply. A bot reply's @mention causes at most one hop.

Bot post limits: duplicate within 60s, more than 10 per minute, A to B to C to A ring. A trip closes bot posts for 5 minutes; refused text is never stored. A human line flushes all pending bot turns.

Replay: other members' lines are JSON-quoted with a provenance label and treated as background; cut history becomes one "N earlier messages omitted" line; a summary is a labeled data block and never the assistant role. Per-member flags: `neverLead`, `addressedOnly`/`contextLines`, `window`, `noRoomMemory` (room lines not stored as its memory, PII scrubbed), `voice` (a line is only voiced as its own speaker).

Records in the journal: `room_msg`, `room_seen`, `room_summary`, `room_event`.
