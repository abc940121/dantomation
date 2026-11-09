# Decisions: device-pairing

Module-owned log. Append only, one line per decision with the reason. Trunk decisions are in the root DECISIONS.md.

- The `#t=` owner-token link is deprecated in favour of device pairing but not removed yet; the owner token keeps working until a later round removes it.
- Open: the pairing lockout is global (30 s after 5 bad guesses, for all clients), so one bad actor can briefly stop a legitimate pairing; per-source limiting is not done.
