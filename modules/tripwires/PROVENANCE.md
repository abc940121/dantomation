# Provenance: tripwires

Module-owned. Append only. Trunk provenance is in the root PROVENANCE.md.

## Ideas referenced (no code)

| Idea | Where it came from | License | How it was used |
|---|---|---|---|
| An output guardrail checks the model's final reply and a "tripwire" halts or flags the run | the output-guardrail feature of agent SDKs | idea only | `rules.js` and `index.js` are written from scratch; no text or code copied |
| Secret-looking strings have well known shapes (key prefixes, key headers, bearer tokens) | common secret-scanner practice | idea only | own regex list in `rules.js` |
| A reply that claims success while the process failed is worth catching | general agent-evaluation practice | idea only | own sentence check against the task exit code |
| A trip record carries the rule and a redacted snippet, never the match | common secret-scanner reporting practice | idea only | snippets mask the match and every other sensitive shape |
