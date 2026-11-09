# question-cards decisions

1. Journal is the source of truth, state is a fold over records (same as
   approval-cards). A crash never leaves a half question. No mirror files:
   nothing reads them.
2. First decision wins. Answer, cancel and expire only act on a pending
   question; later calls get 409. Expiry is applied lazily (on every read,
   ask, answer, `task.start`) by writing one `question_expire` record, so it
   emits once.
3. The answer is delivered two ways: the `question.answered` event (for UIs and
   other modules) and a `history_note` record for the asking task (same channel
   approval-cards uses), plus `question get` for polling. Events are
   in-process only today (see missing seams), so the note and `get` are the
   dependable path for a separate task process.
4. Owner only everywhere. Routes use the default `owner` access; a worker
   cannot ask through the server in v1 (bots ask via the command). Who
   answered comes from the authenticated actor, never the body; a device actor
   is always `where: phone`; an owner actor with an unexpected id is refused.
5. Agents may `ask` and `get` (own questions only) but never `list`, `answer`
   or `cancel`: the command exits 6 inside a task, and a priority-50
   `beforeTool` blocks those spellings and any `/m/question-cards` URL in shell
   commands. Same best-effort stance as approval-cards, not a sandbox.
6. Choices are 1-based numbers or option text (case-insensitive). Free text only
   when the asker set `allow_free`. An answer needs a choice or free text.
7. Limits (see README) keep records small; `max_pending` stops a looping bot
   from flooding the owner (429).
8. Default timeout 60 min, longer than approval-cards (15): a plain question
   blocks nothing dangerous, and the owner may be away.
9. Clock seam `HARNESS_NOW` (same as approval-cards) for tests.
10. Ids are `q-` plus 6 hex chars; every id and task id is pattern-checked.
