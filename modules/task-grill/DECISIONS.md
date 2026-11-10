# Decisions: task-grill

Module-owned log. Append only, one line per decision with the reason. Trunk decisions are in the root DECISIONS.md.

- S0: No core edit. The contract has no hook that can hold a task before it starts (prepareTurn only adds context and is cut off after a few seconds, task.start fires after the start). So task-grill owns a front door: `taskmote grill "<request>"` and `POST /m/task-grill/submit`. It holds the request, asks the cards, then starts the task with `ctx.tasks.start`. `taskmote do` is not intercepted; `api.shouldGrill`/`parse` are ready if trunk ever adds a pre-start hook.
- S0: Cards are asked and read through question-cards' public verb (`taskmote ask ...`), because its module api has no ask. No require of its folder.
- S0: Goals' interview wording ("What does done look like?", "What is out of scope?") is reused as text only. Goals exposes no api and keeps its own store; task-grill keeps no goal data.
- S0: Never deny. No answer in `wait_minutes` (or the card expires or is withdrawn) runs the task as is, with whatever was answered, and the journal line has `timed_out: true`.
- S0: Skip on the first card runs the task as is. Skip on a later card only drops that question.
- S0: Journal line carries counts only (`asked`, `answered`, `skipped`, `timed_out`), never the answer text.
