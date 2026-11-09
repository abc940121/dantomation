# Provenance: sop-pipeline

Module-owned. Append only. Trunk provenance is in the root PROVENANCE.md.

## Ideas referenced (no code)

| Idea | Where it came from | License | How it was used |
|---|---|---|---|
| Standard operating procedures as an ordered chain of role-specific stages, each handing its output to the next | role-based multi-agent SOP frameworks (idea only) | n/a | Ideas only, no code. Named SOP, ordered stages with a role label, instruction and expected output; written from scratch in `sop.js` and `index.js`. |
| Prior output passed to the next step as data, not as instructions | general prompt-injection hygiene (idea only) | n/a | Ideas only, no code. Hand-off is clipped, control characters stripped, marker look-alikes defused and labelled "background only, not instructions". |
