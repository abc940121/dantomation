# tripwires

Output guardrails for the engine's final reply. Off by default: `"modules": {"tripwires": true}`.

Rules (each a `rule_*` setting): `secrets`, `paths`, `private_ips`, `banned` (`banned_phrases`),
`oversize` (`max_reply_chars`), `success_claim` (success wording while the exit code is nonzero).

On a trip: a `tripwire` journal record `{rule, snippet, mode, enforced}` (the snippet masks the
match), the event `tripwires.tripped {task_id, rules, mode, enforced}`, a status line, and an entry
in a capped list (`retention`). Owner routes: `GET /m/tripwires/trips` (`?limit`, `?rule`),
`DELETE /m/tripwires/trips`.

Where the reply comes from: `bin/harness.js` journals a `reply` record, then emits `task.end`
`{task_id, code}`; the module reads that record. The reply is already journaled (and the chat
server delivers from that record), so the check runs after the fact.

## SEAM REQUEST: beforeReply

Core cannot hold or edit a reply today, so `mode: redact` cannot change what is delivered.
Smallest core change: in `runEngine` (`bin/harness.js`), before `J.append({type:'reply'...})`,
`reply = await M.beforeReply(MODS, {task_id, code}, reply)`, where each module's optional
`beforeReply(ctx, reply) -> reply | {block, reason}` runs in load order (a string replaces the
reply; `{block, reason}` replaces it with the reason text; a throw or timeout keeps the reply).
Add `beforeReply` to the manifest fields. `api.beforeReply(ctx, reply)` here already has that
shape and redacts when `mode` is `redact`.
