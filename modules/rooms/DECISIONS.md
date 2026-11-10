# Decisions: rooms

Module-owned log. Append only, one line per decision with the reason. Trunk decisions are in the root DECISIONS.md.

- Room ids must match [A-Za-z0-9_-]+. The rooms module skips others with a `problems` entry, because the device allowlist admits only that shape and stays narrow (fail closed).
- Open: a room's transcript loads in full on first open (no paging yet). The chat-ui race guards (stale poll, composer clear) are covered by static checks only.
- Open: `voice_transcript` is passed through the rooms say route when the caller sends `type`, but nothing upstream sends it yet.
- Engine member replies dropped by the floor (still held after the wait, or the human spoke meanwhile) append a `room_event` `reply_dropped` with reason `floor_held`/`human_spoke` and no text. Journal only: the rooms engine has no event stream to carry it.
- A deliverer's `intensity` is kept only with a kept emotion, only if finite, clamped to [0,1]; it is stored on the message next to emotion. No new emotion values.
- chat-endpoint sends `senses: {text, ear, eyes}` on every request; `ear` follows the trigger's `voice_transcript` input and `endpoint.senses` booleans override the defaults (unknown keys ignored).
