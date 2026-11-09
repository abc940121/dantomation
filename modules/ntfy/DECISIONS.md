# Decisions: ntfy

Module-owned log. Append only, one line per decision with the reason. Trunk decisions are in the root DECISIONS.md.

- Own module, not a channel in notifications: notifications is an in-app log with no outbound path; an outbound network sender is a different trust level and must be switchable off alone.
- Topic is a `secret` setting: on the public server the topic is the only access control for reading.
- Messages carry kind, task id and optional first request line only: card summaries and watchdog details can hold command lines or secrets.
- `include_title` off by default for the same reason.
- No `redirect: follow`: a redirect would send the topic URL to a host the owner did not choose.
- Fetch errors are logged as `timeout` or `network`, never `e.message`, which can carry the URL.
- Per-minute cap, so a looping task cannot flood the phone.
- Blocked = watchdog stall or non-zero exit; there is no single "blocked" event in trunk.
