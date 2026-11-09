# Decisions: approval-cards

Module-owned log. Append only, one line per decision with the reason. Trunk decisions are in the root DECISIONS.md.

- M2: approval-cards is a module, off by default: the stop-and-ask behaviour changes what agents may do unattended, so the owner opts in.
- M2: cards are journal records (card, card_answer, card_used) and state/cards/<id>.json is only a mirror; one fsynced append is the commit point, so a crash leaves either one pending card or none, and a resume cannot make a duplicate.
- M2: a card approves one sha256 of tool plus canonical input, once; a changed input or a second identical call needs a new card, so a yes can never be stretched to a different action.
- M2: the owner answers through the existing `do` verb (`do yes`, `do no`, or `do "yes <id>"`) and `status` lists the card, so there is no fourth verb; only a pending card turns `do <text>` into an answer.
- M2: parseAnswer is a closed word list over the whole text, not a keyword search: any extra word, hedge, question mark, mixed yes/no or unknown token gives unclear, and unclear never approves, because a wrong yes is the costly error and asking again is cheap.
- M2: an expired card counts as no and is swept (answer written once) on resume, answer or the next risky call; the resumed agent is told "denied (timeout)" through a `history_note` journal record that `buildPrompt` prints.
- M2: the answer verb refuses inside an engine and the module blocks agent spellings of it, the same convention-level protection as undo; the clock seam is HARNESS_NOW so expiry tests need no sleeping.
- M2: the risky list is data (modules/approval-cards/default-risky.json) plus config `approval_cards.risky` rules and `skip` ids, like the private rules; deleting outside the task folder only counts when a path argument resolves outside it, and unknown paths (variables, ~) count as outside.
- S0: approval-cards reads its settings from ctx.settings (validated) instead of the raw config, and its command and its answer route share one record() so a web answer and `do yes` write the same journal lines.
- S0: parseAnswer moved under the module's `api` field (still in parse.js): contract 1 forbids unknown top-level exports, and `api` is the one place for module-specific exports.
- S1: approval-cards blocks agent shell commands that touch the server API, so an agent cannot answer its own cards over HTTP.
- S1-4 merge: cards go through approval-cards' own route and api (fold, pending, isExpired); the server API body stays {answer}, mapped to the route's {text}. The server sweeps expired cards through the module's GET /cards.
- S1-4 merge: approval-cards' module-off test also turns voice-chat off, since voice-chat dependsOn approval-cards and a missing dependency is a load error by design.
- Approval timeout default: 10 minutes became 15 (setting timeout_minutes, min 1), to leave time to answer from a phone.
- Approval cards: a denied or expired card for the exact same call stays closed (no new card, no re-ask, the agent gets the plain denial text), and a yes that arrives at or after the deadline is recorded as a timeout, so a late approval cannot happen.
- Approval who/where: the answering device id comes only from the authenticated actor (device-pairing's token mapped to actor id `device:<id>`), never from the request body; a device is always where=phone, an owner may name where only from chat, phone, voice, cli; any other actor is refused (fail closed). Core change: the server passes the caller's actor to the card answer route and shows the `decision` label in the card list.
- Approval timeout default: 0, meaning no deadline. An unanswered card is never a no; it waits until answered or the task is stopped. timeout_minutes (min 0) still sets a deadline when the owner wants one.
- A live card (raised by the engine's permission-prompt tool) is used only by the waiter that raised it; the hook does not use its yes.
