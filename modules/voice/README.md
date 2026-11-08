# voice

A voice bridge that uses the same executor lock as typed tasks, so a voice turn and a task never act at once. Files: `bridge.py` (the bridge), `harness_seam.js` (what the bridge calls), `mac_client.py` (a client), `vad.py` (hands-free speech detection), `index.js` (the guard half). By a voice bridge contributor; see PROVENANCE.md.

- `bridge.py` takes `state/executor.lock` for one voice turn (bridge pid + claude pid), via `harness_seam.js turn-begin`, and releases it at the end of the turn.
- Each turn starts with a short journal status (open task, last steps).
- If a harness task holds the lock, the turn runs without tools: the seam sets `state/voice-notools.flag`, and this module blocks every tool call from the voice session (`HARNESS_VOICE=1`, kind `voice_busy`). The reply says a task is running.
- A turn that never reached turn-end (error, timeout) does not hold the lock for the life of the long-lived voice claude: the bridge's next turn-begin first releases a voice lock held by its own bridge pid (journal `voice_lock_released`). If the bridge itself is killed, its claude gets stdin EOF and exits, the lock goes stale, and the next task takes it over.
- Voice tool calls are checkpointed like task calls (when `checkpoint` is on): `harness_seam.js argv <workdir>` returns `env` with `HARNESS_TASK_ID=voice` and `HARNESS_TASK_DIR=<voice work dir>`.

## Turn it on

    "modules": { "voice": true }

Then start the bridge (see the header of `bridge.py`). Off by default.

## What stays in core, and why

The executor lock is core. A `start`/`resume` that finds the lock held by a short-lived holder waits for it instead of exiting at once. The lock record says so itself: the seam writes `transient: true` and `label: "voice turn"`, and core waits up to 60 s (`HARNESS_VOICE_WAIT_MS`) for any holder with `transient: true`, then exits 4 naming the label. Core knows nothing about voice: with the module off nothing writes such a record, and the wait never triggers. This is the only voice interplay in core. It has to be there because the wait happens in the lock code that runs before any module hook.

## Hands-free client (S4)

`mac_client.py --listen` removes push-to-talk. It runs on the machine with the microphone (the Mac), not the desktop.

- **VAD.** `vad.py` is a self-written energy detector, Python stdlib only. `find_utterances(frames)` is a pure function over 20 ms frames of 16-bit mono PCM and returns `(start, end)` frame ranges; `Segmenter` is the streaming form. A frame is voiced when its RMS is above `max(min_rms, noise_floor * ratio)`; the floor adapts to steady hum. Defaults: 60 ms to open, 700 ms hangover to close, 250 ms minimum, 15 s maximum, 200 ms pre-roll. All are keyword parameters.
- **Mic mute during TTS.** Audio is dropped while the client's own TTS plays and for 300 ms after, and a half-heard utterance is discarded.
- **Text target.** `TEXT_TARGET=turn` (default) sends text to the bridge's `/turn`, exactly as before. `TEXT_TARGET=voice-chat` sends `{text, spokenAt}` to `{VOICE_CHAT_URL}/m/voice-chat/utterance` and reports playback start/end; see `modules/voice-chat/README.md`.
- **Capture is the one non-stdlib piece.** Python's standard library cannot open a microphone, so `capture_frames()` runs a child process that writes 16 kHz mono s16le to stdout. Default: `rec` from sox, so on the Mac run `brew install sox` (and allow the terminal to use the microphone). Any other command works via `VOICE_CAPTURE_CMD`. `--text` and `--wav` need nothing extra.

Run: `TEXT_TARGET=voice-chat VOICE_CHAT_URL=http://<desktop>:7420 python3 mac_client.py --listen`

## Test

    node modules/voice/test/voice-lock.js
    node modules/voice/test/vad.js          # runs test_vad.py (35 unittest checks); SKIP if python is not on PATH
    python modules/voice/test/test_vad.py   # the same, directly

The Python tests use synthetic PCM (silence, tone bursts, noise) and need no microphone or network.

## Known limits

- `voice_busy` blocks tools only while the flag file exists; like the other guards it is not a sandbox.
- Only two parties take the executor lock today (harness and voice). A three-way takeover race (the put-back step) could let two holders both believe they hold it; a third locker needs a different takeover.
- `bridge.py` and the network/audio parts of `mac_client.py` are not run by the test suite (no model, no microphone); the seam, the lock, `vad.py`, the target switch and the mute gate are.
- The VAD is energy-based: it cannot tell speech from other loud sounds, and a very noisy room needs `min_rms`/`ratio` tuned. Live first-sound latency on the Mac has not been measured.
- With speakers (no headphones) the mute-during-TTS rule stops the client hearing itself, but also means you cannot interrupt it by speaking (half-duplex).
