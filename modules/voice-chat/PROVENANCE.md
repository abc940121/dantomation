# Provenance: voice-chat

Module-owned. Append only. Trunk provenance is in the root PROVENANCE.md.

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
| OpenMausBot (Apache-2.0), idea only: markdown to speakable text and sentence-by-sentence TTS prefetch | OpenMausBot, read for the idea; no OMB file, comment or identifier was copied | Apache-2.0 | Ideas only, no code. `modules/voice-chat/speak-text.js` and the speech pipeline: markdown/table/code/URL rewriting and a sentence splitter with prefetch and cancel; local TTS only. |
