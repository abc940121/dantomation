# Provenance

## Copied code

None. Every file in this repo was written new for this repo. No file, function or snippet was copied from any other project.

| File | Source repo | Path | Commit |
|---|---|---|---|
| (none) | | | |

## Written new for modules/voice/ (MIT)

| File | Author | Note |
|---|---|---|
| `modules/voice/bridge.py` | voice bridge contributor, 2026-11-08 | stdlib Python; claude argv/env/settings come from `bin/harness.js` via `modules/voice/harness_seam.js` |
| `modules/voice/harness_seam.js` | voice bridge contributor, 2026-11-08 | uses only exports of `bin/harness.js` and `lib/journal.js` |
| `modules/voice/mac_client.py` | voice bridge contributor, 2026-11-08 | stdlib Python; talks to a local ASR/TTS server (see THIRD_PARTY.md) |

## Written new for modules/voice-chat/ and the hands-free client (MIT)

No code was copied from any source. The similarity function (character-bigram Dice), the sentence splitter, the energy VAD and the wake-phrase matcher are original.

| File | Author | Note |
|---|---|---|
| `modules/voice-chat/index.js`, `voice-chat.js`, `speak.js`, `echo.js`, `api.js` | written new in the S4 milestone | Node stdlib only; uses `modules/approval-cards/parse.js` for yes/no |
| `modules/voice-chat/test/voice-chat.js` | written new in the S4 milestone | mock of server API v0 on 127.0.0.1 |
| `modules/voice/vad.py` | written new in the S4 milestone | energy VAD, Python stdlib only |
| `modules/voice/test/test_vad.py`, `modules/voice/test/vad.js` | written new in the S4 milestone | synthetic PCM; the JS file only launches the Python tests |
| `modules/voice/mac_client.py` (target switch, mute gate, `--listen`, poll) | extends the file by the voice bridge contributor | additions written new in the S4 milestone |

## Ideas referenced (no code)

| Idea | Where it came from | License | How it was used |
|---|---|---|---|
| Block `git commit --no-verify` from a PreToolUse hook (exit 2 + reason) | ECC, affaan-m/ECC `scripts/hooks/block-no-verify.js` @ d2ef2680594f9a17526a6e1a2e18b3d242c5d17b | MIT | Concept only; `modules/guard-base/rules.js` written from scratch |
| Keep "current task" and "history" in separate sections; never let history wrap the live request | OpenMausBot failure at `context-rebuild.ts:210`, as described in a review note. OMB source was not opened. | Apache-2.0 | Idea only, zero code |
| OpenMausBot (Apache-2.0), idea only: a phone pairs with a short code and ends up holding its own device token | OpenMausBot, read for the idea; no OMB file, comment or identifier was copied | Apache-2.0 | Ideas only, no code. `modules/device-pairing/`: one-time 2-minute pairing code (link plus 6 digits) redeemed for a revocable per-device token, only a sha256 stored, deny-by-default route allowlist, journaled device actions. |
| OpenMausBot (Apache-2.0), idea only: multi-character rooms: @everyone, @mentions, a lead, one hop, and a post budget | OpenMausBot, read for the idea; no OMB file, comment or identifier was copied | Apache-2.0 | Ideas only, no code. `modules/rooms/`: local routing (everyone, mention, lead), a serial per-room queue, a single bot-to-bot hop and a bot post budget; designed and written from scratch. |
| OpenMausBot (Apache-2.0), idea only: context replay with the summary kept in a separate, labelled, non-instruction channel | OpenMausBot, read for the idea; no OMB file, comment or identifier was copied | Apache-2.0 | Ideas only, no code. `modules/rooms/replay.js`: quoted, speaker-labelled replay lines and the summary in its own DATA BLOCK that states past events and is never an instruction. |
| OpenMausBot (Apache-2.0), idea only: approval who/where, expiry, and a voice yes/no hook | OpenMausBot, read for the idea; no OMB file, comment or identifier was copied | Apache-2.0 | Ideas only, no code. `modules/approval-cards/`: every decision records who (owner, device, timeout, system) and where (chat, phone, voice, cli); cards expire and stay closed; a strict yes/no voice route. |
| OpenMausBot (Apache-2.0), idea only: markdown to speakable text and sentence-by-sentence TTS prefetch | OpenMausBot, read for the idea; no OMB file, comment or identifier was copied | Apache-2.0 | Ideas only, no code. `modules/voice-chat/speak-text.js` and the speech pipeline: markdown/table/code/URL rewriting and a sentence splitter with prefetch and cancel; local TTS only. |

## Not used

- The 21 Apache-2.0 logistics skills in ECC (8 SKILL.md files plus their ja-JP and zh-CN translations)
- The 2 CC-BY-SA-4.0 osint files in ECC
- pstack and mattpocock skills (MIT): nothing taken in this round
