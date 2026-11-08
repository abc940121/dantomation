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

## Ideas referenced (no code)

| Idea | Where it came from | License | How it was used |
|---|---|---|---|
| Block `git commit --no-verify` from a PreToolUse hook (exit 2 + reason) | ECC, affaan-m/ECC `scripts/hooks/block-no-verify.js` @ d2ef2680594f9a17526a6e1a2e18b3d242c5d17b | MIT | Concept only; `modules/guard-base/rules.js` written from scratch |
| Keep "current task" and "history" in separate sections; never let history wrap the live request | OpenMausBot failure at `context-rebuild.ts:210`, as described in a review note. OMB source was not opened. | Apache-2.0 | Idea only, zero code |

## Not used

- The 21 Apache-2.0 logistics skills in ECC (8 SKILL.md files plus their ja-JP and zh-CN translations)
- The 2 CC-BY-SA-4.0 osint files in ECC
- pstack and mattpocock skills (MIT): nothing taken in this round
