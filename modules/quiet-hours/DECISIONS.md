# Decisions: quiet-hours

Module-owned log. Append only, one line per decision with the reason. Trunk decisions are in the root DECISIONS.md.

- S0: the hold uses a send gate added to the ntfy module (`api.setSendGate`), because ntfy had no event or hook before a send and core must not change. The gate is generic and fails open: an error sends the ping.
- S0: urgent kinds pass and never release the queue; nothing is denied or auto-answered, so a blocked task is never worse off.
- S0: the notifications module is left alone: it only writes an in-app log and pushes nothing.
- S0: a manual on/off lasts until the next window edge (start or end), then the schedule applies again.
- S0: a bad time setting cannot fail at load (the loader has no setting validator); it fails at job start, in the command and in status with a clear message.
- S0: flush empties the queue only after ntfy confirms the send, so a failed send keeps the held pings.
