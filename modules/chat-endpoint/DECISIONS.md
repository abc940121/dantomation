# Decisions: chat-endpoint

Module-owned log. Append only, one line per decision with the reason. Trunk decisions are in the root DECISIONS.md.

- chat-endpoint (OpenAI-style chat engine) is off by default and starts in mode `shadow`: it calls the door, discards the reply, and logs metadata only. `live` must be set explicitly per bot.
- Shadow calls are fire and forget, at most 2 in flight per bot; extra calls are recorded as `skipped_busy`. A shadow call is not aborted by later owner speech; it ends on its own timeout.
- Emotion tags pass an allowlist of 10 values and are never stored when `journal_text` is false.
- A reply containing any configured token is dropped whole; the event carries only a count. Any PEM block is removed whole; an unterminated BEGIN removes everything after it.
