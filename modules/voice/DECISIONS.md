# Decisions: voice

Module-owned log. Append only, one line per decision with the reason. Trunk decisions are in the root DECISIONS.md.

- S4: the VAD is an adaptive-floor energy detector in pure Python (`vad.py`), no webrtcvad or other dependency; thresholds, hangover (700 ms) and minimum length (250 ms) are parameters.
- S4: continuous capture is isolated in `capture_frames()` and runs sox `rec` as a child process (`brew install sox`, or `VOICE_CAPTURE_CMD`), because the standard library cannot open a microphone.
- S4: the text target is pluggable via `TEXT_TARGET` (`turn` default, `voice-chat`), so existing bridge behaviour is unchanged unless the user opts in.
- S4: the Python tests are launched from run-all through a small Node wrapper that prints SKIP without python, because the runner only spawns Node.
- Possible future optional module: paid cloud voice, off by default, using the user's own key. Not built; local ASR/TTS stays the default.
- mac_client sends a TTS speaker (`TTS_VOICE`, default vivian); CustomVoice TTS models refuse requests without one.
