# Decisions: digest

Module-owned log. Append only, one line per decision with the reason. Trunk decisions are in the root DECISIONS.md.

- S0: the digest reads the journal and does not depend on other modules, so a missing module just means a zero count and the module still loads.
- S1: push emits the event `digest.ready {text}` instead of calling a notifier. A hard dependsOn would drop digest whenever notifications or ntfy is off, and neither exposes a send call. ntfy and notifications handle that event.
- S2: only the command writes the last-run time; the route never does, so a page refresh cannot hide items from the next morning run.
- S2: spend is the growth of each session's running usd in logs/spend.jsonl inside the window (last value before it is the baseline), summed. The log holds running totals, so adding lines would overcount.
- S3: `include_titles` (default true) lets the owner drop card titles from the digest, so a pushed digest to a public topic carries counts, spend and ids only; the number of notable items is unchanged.
