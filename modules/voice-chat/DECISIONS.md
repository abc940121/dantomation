# Decisions: voice-chat

Module-owned log. Append only, one line per decision with the reason. Trunk decisions are in the root DECISIONS.md.

- S4: voice-chat is a Node module that turns text utterances into spoken sentences; it holds no audio, and the Mac client owns the microphone, VAD, ASR and TTS.
- S4: the wake word is text-level (a phrase list in `voice_chat.wake`, English and Chinese), so it runs on ASR output and can be swapped for an audio wake word later without touching the rest.
- S4: an utterance is acted on only if it has a wake phrase, a card is pending and live, or the follow-up window (`followup_s`, 8 s after the last spoken line) is open.
- S4: playback start/end is reported to the server (`POST /m/voice-chat/playback`, client clock) rather than guarded only client-side, because the text-level echo and follow-up rules live on the server and need to know when speech ended; the client also mutes its own mic, so both layers exist.
- S4: the echo guard drops an utterance that starts inside a playing window plus 300 ms, or whose text closely matches (character-bigram Dice, 0.6 or more) something spoken in the last 10 s; a bare one-word reply such as "yes" is not text-matched against a longer prompt, so a real answer right after "Allow X, yes or no?" still works.
- S4: the card prompt is spoken once; after that only parseAnswer yes/no approves; unclear is re-asked once, then the card is parked (stays pending, needs a wake phrase) and the user is told so.
- S4: nothing is approved from text that started while TTS was playing, since the echo check runs before any card handling.
- S4: the chat stream ends when a card goes pending (read aloud, then the stream closes); the answer arrives as the next utterance. Narrating past a card is a known limit.
- S4: `POST /m/voice-chat/poll` lets the client have a newly pending card announced without the user speaking first; it says nothing if one was already announced or TTS is playing.
- S4: routes are plain handler functions plus a provisional route declaration, because S0 finalizes field names; only index.js knows the route shape.
- S1-4 merge: voice-chat's routes answer a buffered {lines:[..., {done:true}]} instead of a stream, because contract 1 has no streaming responses yet (Planned additive extensions).
- Voice has no barge-in yet: the client is half-duplex (echo guard), so speaking over the bot is not detected until the client can listen while it plays.
- voice-chat waits up to `reply_grace_s` (default 8) after task_end for the final reply, because a bot can report done before its last message.
