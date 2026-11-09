# Provenance: voice

Module-owned. Append only. Trunk provenance is in the root PROVENANCE.md.

## Written new for modules/voice/ (MIT)

| File | Author | Note |
|---|---|---|
| `modules/voice/bridge.py` | voice bridge contributor, 2026-11-08 | stdlib Python; claude argv/env/settings come from `bin/harness.js` via `modules/voice/harness_seam.js` |
| `modules/voice/harness_seam.js` | voice bridge contributor, 2026-11-08 | uses only exports of `bin/harness.js` and `lib/journal.js` |
| `modules/voice/mac_client.py` | voice bridge contributor, 2026-11-08 | stdlib Python; talks to a local ASR/TTS server (see THIRD_PARTY.md) |
