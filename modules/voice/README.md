# voice

A voice bridge that uses the same executor lock as typed tasks, so a voice turn and a task never act at once. Files: `bridge.py` (the bridge), `harness_seam.js` (what the bridge calls), `mac_client.py` (a client), `index.js` (the guard half). By a voice bridge contributor; see PROVENANCE.md.

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

## Test

    node modules/voice/test/voice-lock.js

## Known limits

- `voice_busy` blocks tools only while the flag file exists; like the other guards it is not a sandbox.
- Only two parties take the executor lock today (harness and voice). A three-way takeover race (the put-back step) could let two holders both believe they hold it; a third locker needs a different takeover.
- `bridge.py` and `mac_client.py` are not run by the test suite (no Python or model in the tests); only the seam and the lock behaviour are.
