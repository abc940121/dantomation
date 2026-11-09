# Provenance: claim-audit

Module-owned. Append only. Trunk provenance is in the root PROVENANCE.md.

## Ideas referenced (no code)

| Idea | Where it came from | License | How it was used |
|---|---|---|---|
| A reviewer interrogates a claim with short "which line shows X?" questions and records the answers | the "interrogating review" pattern in the pstack skill set | idea only | `interrogate.js` writes its own question templates, store and answer check; no text or code copied |
| A claim needs a citation to a journal line, test output or command result | this module's own earlier claim audit (M5) | MIT, this repo | extended with an event, a prepareTurn reminder and the reviewer step |
| The reviewer should be from a different model family than the worker | common practice in cross-model review | idea only | `family.js` has its own name-to-family table and refuses same or unknown family |
