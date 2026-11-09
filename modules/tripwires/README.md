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

## beforeReply (contract 6)

The manifest declares `contract: 2` (core does not gate the v6 hooks by number), `failMode: "closed"` (a throwing or timed-out hook blocks the
reply) and `hookTimeoutMs: 1000` (the checks are cheap regex scans). `beforeReply(reply, ctx)`
depends on `mode` (default `flag`, which leaves the reply alone, so behaviour is unchanged):

- `redact`: returns the reply with secrets, home paths and private IPs masked.
- `block`: returns `{block: true, reason}` when secrets, paths, private IPs, banned phrases or
  oversize trip. The reason lists rule ids only and never the matched text.

What `redact` masks or `block` withholds is recorded at that moment (`enforced: true`), because the
after-the-fact `task.end` check (journal record, event, list; runs in every mode) only sees the cleaned reply.
`success_claim` needs the exit code, which core does not pass to `beforeReply`, so it is a `task.end` (flag)
check in every mode.
