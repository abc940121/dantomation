# Provenance: rooms

Module-owned. Append only. Trunk provenance is in the root PROVENANCE.md.

## Ideas referenced (no code)

| Idea | Where it came from | License | How it was used |
|---|---|---|---|
| OpenMausBot (Apache-2.0), idea only: multi-character rooms: @everyone, @mentions, a lead, one hop, and a post budget | OpenMausBot, read for the idea; no OMB file, comment or identifier was copied | Apache-2.0 | Ideas only, no code. `modules/rooms/`: local routing (everyone, mention, lead), a serial per-room queue, a single bot-to-bot hop and a bot post budget; designed and written from scratch. |
| OpenMausBot (Apache-2.0), idea only: context replay with the summary kept in a separate, labelled, non-instruction channel | OpenMausBot, read for the idea; no OMB file, comment or identifier was copied | Apache-2.0 | Ideas only, no code. `modules/rooms/replay.js`: quoted, speaker-labelled replay lines and the summary in its own DATA BLOCK that states past events and is never an instruction. |
