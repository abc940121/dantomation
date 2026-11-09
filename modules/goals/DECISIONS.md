# goals decisions

1. One module, one file (`state/m/goals/data.json`) for goals and lessons. Both are small,
   owner-entered rows; a fold over the journal would add nothing. Writes are atomic (temp file,
   rename) under a lock file so the CLI and the server do not lose each other's rows.
2. Texts live only in `data.json`, never in the journal. They can hold private words; the journal
   gets metadata (`goal_set`, `goal_confirm`, `lesson_add`... with an id).
3. Never capture conversation text. The module has no `on` handlers; every row comes from an explicit
   command or owner route call.
4. Goals and lessons are written by the owner only: routes are `owner` access, commands refuse inside
   a task (exit 6), and `beforeTool` blocks agent shell calls to those verbs and to `/m/goals`.
   An agent may read the card (`goal show`) and receives it through `prepareTurn`.
5. One active goal. Setting a new goal marks the old one `replaced`; closing marks it `done` or
   `dropped`. History stays in the file.
6. Confirm is a flag set once by the owner, and only when `done` and `out_of_scope` are filled in.
   Editing either one clears the confirmation, because the owner agreed to different words.
7. An unconfirmed card is still injected, but the prompt says it is not confirmed and that the done
   and out-of-scope lines are not agreed. The verbatim goal is always the owner's own words, trimmed.
8. The goal interview is a fixed list of questions for the missing fields (`goal interview`, and
   `questions` in the route answer). The module asks; it never invents answers.
9. A lesson repeat is counted explicitly (`lesson repeat <id>`), by the owner. Weekly counts group
   repeats by Monday (UTC).
10. Stale rule: compare the last N weeks with the N before (N = `stale_window_weeks`, default 2).
    Younger than 2N weeks is `new` (too early to judge, still injected). Fewer recent than prior
    repeats, or none in both, is `kept`. Anything else is `stale`: it did not work, so it leaves the
    prompt and `status` says so. The owner decides whether to rewrite it (add a new lesson).
11. Lessons are never deleted by the module; stale only hides them from the prompt.
12. Prompt size: the goal card first (so core's clip never cuts it), then at most
    `max_lessons_in_prompt` newest non-stale lessons.
13. Limits: goal 2000 characters, done / out of scope 1000, lesson what 500, missed_by 300, fix 500;
    no control characters.
