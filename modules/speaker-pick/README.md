# speaker-pick

Optional, off by default (`"modules": {"speaker-pick": true}`, settings section `speaker_pick`).

In a room with several bots, when a human message names no bot, this module picks who
speaks next. An @mention or @everyone always wins: the module then returns `bot: null,
reason: "mention"` and rooms routes as before.

Modes (`mode`): `round_robin` (members in room order), `keyword` (overlap between the
message and each bot's owner-set description in `bots`; a tie or zero falls back to round
robin), `model` (a cheap engine is shown the last few messages and must answer exactly one
listed bot id; anything else, a timeout or an error falls back to keyword, then round robin).

Guardrails: only bots in the `members` the caller passes can be chosen; the same bot is not
picked more than `max_consecutive` times in a row per room; `max_auto_turns` (default 1)
automatic picks per human message, and a message flagged `from_bot` never gets a pick, so a
bot reply cannot start a pick loop. The journal gets `{type: speaker_pick, room, bot, mode,
reason}` and never message text.

Owner-only: route `POST /m/speaker-pick/pick` (body `{room, text, members:[{id,name?,description?}], recent?, from_bot?, msg_id?}`),
and a beforeTool guard stops agents from calling it or editing its settings.

## SEAM REQUEST (rooms)

Rooms exposes `{createEngine, registerDeliverer}` only; nothing lets a module choose
recipients. Rooms would need, in the step where `route()` returns `lead` or `none` for
human text, to call `ctx.api('speaker-pick').pick({room, text, members, recent, msgId}, opts)`
(or an equivalent `registerRecipientPicker(fn)` on its api) and use a non-null `bot` as the
single recipient. Until then the module is advisory via its route.

## Model mode

Uses the contract 6 seam (manifest stays `contract: 2`, which trunk currently requires). Set `speaker_pick.model_engine` to the name of an engine listed in config
`engines`; model mode then calls `ctx.engines.run(engine, prompt, {timeoutMs: model_timeout_ms})`
(prompt on stdin; trimmed stdout must equal one listed bot id). Default `""` (unset): no
engine call, and `api.setModelFn(fn)` (if injected) is used, else model mode falls back to
keyword, then round robin. A timeout, error, non-zero exit or unlisted engine falls back the same way.
