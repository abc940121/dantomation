# chat-endpoint

An engine for [rooms](../rooms/README.md) members that talks to an OpenAI-style chat URL (for a bot that lives outside this harness). Off by default; needs `rooms`. No network dependency of its own: it only calls the URL you configure, over built-in `fetch`.

Enable: `"chat-endpoint": true` and `"rooms": true` under `modules`. Store the bearer token(s) as one secret, a JSON map of name to token (never in the config):

    node bin/harness.js secret chat-endpoint tokens     # value: {"example-token": "<bearer token>"}

Example private config (the per-bot block lives on the rooms member, so there is one place to configure a bot):

```json
{
  "modules": { "rooms": true, "chat-endpoint": true },
  "settings": {
    "chat-endpoint": { "timeout_s": 20, "allowed_hosts": [], "pii_log_path": "<path to a private log file>" },
    "rooms": { "rooms": { "main": { "lead": "ann", "members": [
      { "id": "ann", "name": "Ann", "bot": "ann-bot" },
      { "id": "example-bot", "name": "Example", "engine": "chat-endpoint",
        "endpoint": {
          "mode": "shadow",
          "url": "http://127.0.0.1:<port>",
          "token_secret": "example-token",
          "session_prefix": "taskmote:",
          "member_id": "example-bot",
          "sees": "addressed",
          "context_lines": 6,
          "journal_text": false,
          "lead_eligible": false,
          "voice": "<voice id owned by this bot>",
          "everyone_min_gap_s": 30,
          "everyone_once_per_round": true
        } }
    ] } } }
  }
}
```

Shadow mode: `mode` is `"live"` or `"shadow"`. Missing or unknown means `"shadow"` (fail safe), so a bot only speaks in the room once `"mode": "live"` is set explicitly. In shadow the bot builds the request and calls the endpoint as in live (same screens and timeout) and then throws the reply away: nothing is posted, no voice, no "unavailable" line, and it never counts as having replied. The call is fire and forget: the turn returns at once, so a slow or hanging endpoint never holds the room queue (a shadow call is not cancelled when the owner speaks later; it ends by its own timeout). At most 2 shadow calls per bot are in flight; above that no call is made and the outcome is `skipped_busy`. Each call appends one metadata-only journal record `chat_endpoint_shadow` `{ts, bot, room, mode, would_reply, reply_len, latency_ms, outcome}` with outcome `ok|no_reply|busy|timeout|error|aborted|pii_dropped|token_dropped|skipped_busy`. Never any reply text, even with `journal_text: true`.

Request body (JSON), besides the OpenAI-style `model`, `stream` and `messages` (kept for compatibility):

- `session_id`, `user` and `chat_id`: `<session_prefix><roomId>`. `room_id`: the room. `member_id`: the bot.
- `from`: `{id, name, is_bot}` of the trigger line's speaker (the owner is `id: "human"`). `text`: the trigger line, screened. If the trigger line is withheld, nothing is sent.
- `mentions`: member ids addressed in the trigger line, plus `"everyone"` for @everyone. `is_host`: true when the owner wrote the trigger line.
- `prev_turns`: up to 6 earlier screened lines, oldest first, as `[{id, from:{id, name, is_bot}, text, hop}]`.
- `msg_id` and `ts`: id and timestamp of the trigger message (null when there is none). `mention_type`: `direct` (an @mention, or a bot-to-bot hop), `everyone` (@everyone) or `role` (woken because it is the room lead). `type`: `text`, or `voice_transcript` when the line was said with `type: "voice_transcript"` (rooms `say`). `text_len`: length of `text` as sent. `truncated`: `true`, present only when the trigger text was cut at 2000 characters.
- `senses`: `{text: true, ear, eyes: false}`, which senses this channel has so the remote side never claims to have heard or seen something it did not. `ear` is true only when the trigger line is a `voice_transcript`. A member's `endpoint.senses` (an object of booleans) is merged over these defaults; unknown keys are ignored.
- `hop`: 0 when the trigger line is a person's, 1 when it is a bot's own first-hand line. A bot reply that was itself triggered by a bot line would be hop 2; it is never sent (dropped from `lines` and `prev_turns`; a trigger at that depth sends nothing), as a second check on the one-hop rule.
- `lines`: every kept line as `{id, speaker, is_bot, text}`. `via`: why the bot was woken.
- Names and text are both screened: a line with a secret or PII is withheld, and every name (`from.id`, `from.name`, `lines[].speaker`, the labels and the member's own name inside `messages`) goes through one helper (`screenName`: one line, redacted in place, at most 80 characters). A PEM block (`-----BEGIN ...-----` to `-----END ...-----`, any label) is removed whole; an unterminated BEGIN removes everything to the end of the text.

What it does, per turn of an `engine: "chat-endpoint"` member:

- Request: `POST <url>/v1/chat/completions` (the path is added unless the url already ends in `completions`), `Authorization: Bearer <token>`, body with `messages` (one user message: the current line, then a labelled read-only background block), `lines` (`id`, `speaker`, `is_bot`, `text`), `user` and `session_id` = `<session_prefix><roomId>`, `member_id`, `via`. Redirects are not followed.
- Url: loopback by default. Any other host must be in `allowed_hosts`. Only http(s), no credentials in the url.
- Sees only lines addressed to it (@mention or @everyone) plus `context_lines` before them (`sees: "all"` lifts that). Lines by other bots are background, flagged `is_bot: true`. Only one hop: a bot's reply can wake at most one more member, and that reply wakes nobody. Originals are always sent as they are; a room summary never replaces them.
- `@everyone` reaches it once per round and not within `everyone_min_gap_s` (30) of the last one it got.
- Screen on send: a line holding a secret, token, password, private key, email, phone or card number is dropped, not sent and not marked. If the current line is dropped nothing is sent. Screen on receive: the same kinds are redacted in place before the reply is posted. Each hit emits `chat-endpoint.pii` `{direction, kind, count}` and, when `pii_log_path` is set, appends `{"ts","direction","kind","count"}` as one JSON line (parent dir created; a failed write never breaks a turn). Never any text.
- Journal: metadata only (`chat_endpoint_call`: ok, status, lengths, ms). With `journal_text: false` (default) the room store keeps no text of this bot's replies either (lengths and a flag; the text is held in this process for the live transcript and reads `[text not kept]` after a restart). The token is never logged and never in an error.
- Reply: `{reply_text, voice?, emotion?, intensity?}` or plain `choices[0].message.content`. A refusal such as a daily cap is just text. `{"no_reply": true}`, a busy endpoint (HTTP 429 or 503, or `{"busy": true}`) (when a member's last 3 calls were all busy or timed out, `status` shows one line for it until a call gets through), an aborted call or a timeout (`timeout_s`, default 20, one deadline for the fetch and the body read) posts nothing; the line is dropped, never re-queued or replayed later, in shadow mode as well. A reply that contains any configured token value (any entry of the `tokens` map) is dropped whole; it emits `chat-endpoint.token_echo` `{count}` and nothing else. `voice` is used only if it equals the configured `voice`. `emotion` is kept only if it is one of neutral, happy, sad, angry, surprised, calm, excited, worried, tender, playful (anything else is ignored), and never when `journal_text` is false; nothing consumes it yet. `intensity` is kept only together with a kept emotion and only if it is a finite number; it is clamped to 0..1 and stored next to the emotion.
- Owner speaks or flushes the queue: the in-flight request is cancelled and the endpoint gets a best-effort `{"abort": true, "session_id", "member_id"}`.
- Fail closed: endpoint down, HTTP error, bad reply, unlisted host or unknown token name gives one short "unavailable" system line. It never falls back to another engine under the same name.
- Never the lead unless `lead_eligible: true` and `sees: "all"`.

Limits to know: voice-chat has no per-bot voice or room hook, so voice exclusivity is enforced in rooms (`canUseVoice(voice, memberId, roomId)`, keyed by room and member; a reserved voice is stripped from other members, also a member with the same id in another room), and the owner-is-speaking hold needs a client with voice activity detection to call `POST /m/rooms/rooms/:id/floor {speaking}`. The `tokens` secret is one JSON map because secret settings are declared per module, not per name.
