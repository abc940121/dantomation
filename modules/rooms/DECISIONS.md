# Decisions: rooms

Module-owned log. Append only, one line per decision with the reason. Trunk decisions are in the root DECISIONS.md.

- Room ids must match [A-Za-z0-9_-]+. The rooms module skips others with a `problems` entry, because the device allowlist admits only that shape and stays narrow (fail closed).
- Open: a room's transcript loads in full on first open (no paging yet). The chat-ui race guards (stale poll, composer clear) are covered by static checks only.
- Open: `voice_transcript` is passed through the rooms say route when the caller sends `type`, but nothing upstream sends it yet.
