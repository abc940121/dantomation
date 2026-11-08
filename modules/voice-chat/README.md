# voice-chat

Hands-free voice, no push-to-talk. The Mac client listens all the time, cuts the audio into utterances and turns them into text; this module decides what to do with each text and answers with short spoken sentences. Off by default.

    "modules": { "voice-chat": true }

Routes and field names are provisional until S0 fixes the module route shape. The logic is plain functions (`utteranceHandler`, `createVoiceChat`); only `index.js` knows the route declaration.

## How it works

1. The Mac client records continuously, detects the end of each utterance (`modules/voice/vad.py`), transcribes it locally and posts `{text, spokenAt}` to `POST /m/voice-chat/utterance`. `spokenAt` is epoch milliseconds on the Mac's clock.
2. The reply is NDJSON like `/turn`: `{"say": "..."}` lines, then `{"done": true}` (with `ignored: "<reason>"` when the utterance was dropped).
3. An utterance is acted on only if one of these holds:
   - it starts with a wake phrase (`voice_chat.wake`, English and Chinese defaults such as "hey assistant", "你好助手");
   - an approval card is pending and not parked;
   - the follow-up window is open: `voice_chat.followup_s` (default 8) seconds after the last spoken line.
4. Pending card: the question is read once in one short sentence ("Allow <summary>, yes or no?"). The next utterance is accepted only if `parseAnswer` (the approval-cards closed word list) says yes or no. Unclear gets one re-ask ("Sorry, yes or no?"); a second unclear leaves the card pending, says so, and parks it until a wake phrase is spoken. Text that started while speech was playing is never taken as an answer.
5. Otherwise the text goes to `POST /api/chat` for `voice_chat.bots` (default: the first bot). Sentences from SSE `message` events are spoken as they arrive: short, code blocks replaced by a placeholder, URLs read as their domain. A `tool_call` gives "Running <tool>." at most every `status_s` seconds (default 4). If a card becomes pending during the task, it is read aloud and the stream closes; the answer comes as the next utterance.

### The wake word is text-level

The wake phrase is matched on the ASR transcript, not on audio. That is deliberate and simple: it needs no extra model, but ASR must transcribe the phrase correctly and the Mac transcribes every utterance. It can be swapped for an audio wake word later: an audio detector on the Mac would only decide whether to send the utterance, and the module's text rule could then be switched off or kept as a second check. Nothing else depends on it.

### Echo guard (half-duplex)

The assistant must not hear itself. Two server-side rules, plus the client muting its own mic:

- timing: an utterance whose `spokenAt` falls inside a playing window plus 300 ms is ignored;
- text: an utterance that closely matches something spoken in the last ~10 s is ignored (character-bigram Dice similarity, 0.6 or more, in `echo.js`; a bare one-word reply is not matched against a longer prompt, so a real "yes" after the question still counts).

Playback start/end is reported by the client to `POST /m/voice-chat/playback {state: "start"|"end", at}` using the Mac clock, the same clock as `spokenAt`. See DECISIONS.md for why this is server-side.

### Other routes

`POST /m/voice-chat/poll` announces a newly pending card without waiting for the user to speak (once per card, never while speech is playing). The client calls it about every 3 s.

## Speech output

What the bot says is rewritten before it is spoken (`speak-text.js`, pure, never throws): markdown, emoji and decorative symbols are dropped, tables become sentences ("Name: Bob, Age: 3."), a code block becomes "(code omitted)." (or the Traditional Chinese equivalent when the reply is Chinese), URLs are read as their domain and file paths as their last segment. A code-only reply produces nothing. Sentences split on `. ! ?` and on `。！？`.

The Mac client (`modules/voice/mac_client.py`, `TEXT_TARGET=voice-chat` only) then speaks sentence by sentence through `speech_pipeline.py`: the first sentence starts at once and the next `TTS_PREFETCH` (default 2) are synthesized ahead by the same local TTS server as before. A new utterance cancels playback and drops the prefetched sentences (`PIPE.cancel()`). `pipeline.js` is the same logic in Node, with the engine injected; it is what the tests exercise.

### TTS engine seam

An engine is two functions, nothing else: `synth(text, {signal}) -> audio` and `play(audio, {signal}) -> Promise` (Python: `synth(text) -> audio`, `play(audio)`). Today's engine is the local mlx_audio server with macOS `say` as fallback (`_synth`/`_play` in `mac_client.py`). A later optional module that `dependsOn: ['voice-chat']` can call `ctx.api('voice-chat').registerEngine(name, factory)` and `createEngine(name, opts)` and hand the pipeline its own engine; no voice-chat edit is needed. No cloud engine ships here.

## What runs where

| Machine | Runs |
|---|---|
| Desktop (where the harness server runs) | the server, this module (`voice-chat`), the bots |
| Mac (microphone and speakers) | an ASR/TTS server (mlx_audio, see `modules/voice/` and THIRD_PARTY.md) and `modules/voice/mac_client.py --listen` |

The Mac needs to reach the desktop's server. Same LAN is enough. Use Tailscale only if the Mac is off the LAN. Audio never leaves the Mac; only text crosses.

## Setup

1. Desktop: set `"voice-chat": true` under `modules` in the config and restart the server. Optional `voice_chat` block (all keys optional):

        "voice_chat": {
          "wake": ["hey assistant", "你好助手"],
          "followup_s": 8,
          "bots": null,
          "status_s": 4,
          "timeout_s": 180,
          "api_base": "http://127.0.0.1:7420",
          "token": ""
        }

   `bots` is a list of bot ids or `"all"`; null means the first bot. `api_base` is where this module reaches the server's `/api`. The token can also come from env `VOICE_CHAT_TOKEN`; on localhost none is needed.
2. Mac: start the ASR/TTS server as described in `modules/voice/` and THIRD_PARTY.md.
3. Mac, one install for continuous capture: `brew install sox` (provides `rec`). Allow your terminal to use the microphone in System Settings. Or set `VOICE_CAPTURE_CMD` to any command that writes 16 kHz mono signed 16-bit raw PCM to stdout.
4. Mac: run

        TEXT_TARGET=voice-chat VOICE_CHAT_URL=http://<desktop address>:7420 python3 modules/voice/mac_client.py --listen

   Set `VOICE_CHAT_TOKEN` too if the server requires one. Without `TEXT_TARGET`, the client behaves as before and posts to the bridge `/turn`.
5. Say "hey assistant, ..." and wait for the reply.

## Test

    node modules/voice-chat/test/voice-chat.js
    node modules/voice-chat/test/speak-text.js
    node modules/voice/test/vad.js
    python modules/voice/test/test_vad.py

The Node suite runs against a mock of server API v0 on 127.0.0.1: wake phrase (English, Chinese), follow-up window, card read-aloud with yes/no/unclear/re-ask/parked, echo guard by timing and by text (including the assistant's own "Yes?" not being taken as an answer), speakable sanitizing, and the HTTP routes.

## Known limits

- The live first-sound latency on the Mac has not been measured. The pieces are: the wait for end of speech (700 ms hangover by default), ASR, a network hop, the first model sentence, and TTS first audio.
- The wake phrase depends on ASR accuracy; a misheard phrase is silently ignored.
- The chat stream closes when a card goes pending; narration of what the bot does after approval needs the next utterance (or a new request).
- Half-duplex: you cannot interrupt the assistant by speaking while it talks. With open speakers, a very loud reply can still leak past the 300 ms tail; headphones avoid it.
- Echo text-matching can wrongly drop a genuine utterance that repeats what was just said aloud.
- Routes and field names are provisional until S0. Bot errors are reduced to a short spoken line.
- The client and the server clocks are never compared: `spokenAt` and playback times both use the Mac's clock.
