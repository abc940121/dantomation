# Provenance: device-pairing

Module-owned. Append only. Trunk provenance is in the root PROVENANCE.md.

## Ideas referenced (no code)

| Idea | Where it came from | License | How it was used |
|---|---|---|---|
| OpenMausBot (Apache-2.0), idea only: a phone pairs with a short code and ends up holding its own device token | OpenMausBot, read for the idea; no OMB file, comment or identifier was copied | Apache-2.0 | Ideas only, no code. `modules/device-pairing/`: one-time 2-minute pairing code (link plus 6 digits) redeemed for a revocable per-device token, only a sha256 stored, deny-by-default route allowlist, journaled device actions. |
