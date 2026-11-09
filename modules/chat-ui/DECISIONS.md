# Decisions: chat-ui

Module-owned log. Append only, one line per decision with the reason. Trunk decisions are in the root DECISIONS.md.

- S2: chat-ui is a module (off by default) that only declares a static panel; the field names are in one provisional constant until the S0 contract lands.
- S2: the page reads events with fetch streaming, not EventSource, because EventSource cannot send the Authorization header and the token must not go in a URL.
- S2: event-to-state reduction lives in ui/state.js, loaded by the page and by Node tests, so the logic is tested without a browser; the page renders only through textContent, and a test bans innerHTML-style sinks and dialogs.
- S2: undo confirmation is an in-page two-step (Undo, then Yes undo / Cancel); card answers are Yes/No buttons only and the countdown is cosmetic, the server owns expiry.
- S2: a non-final message is treated as a live bubble replaced by the next message of the task (spec does not say); /api/tasks is assumed newest first.
- Room picker in chat-ui is feature-detected: it appears only when GET /m/rooms/rooms succeeds, with no core or config coupling. Paired devices get list rooms, read messages and say only; the summary stays owner-only.
