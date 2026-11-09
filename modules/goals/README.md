# goals

Two things the owner enters by hand, kept in one small store.

**Goal card.** The owner's goal in their own words, what done looks like, what is out of scope, and a
`confirmed` flag the owner sets once. Each turn the active card is added to the engine prompt so work is
checked against it. An unconfirmed card is marked as such.

**Lessons.** Each owner correction becomes a row: what went wrong, which check missed it, the fix.
Repeats are counted per week. A lesson is kept only while its repeats drop; if they do not, it is marked
`stale` and left out of the prompt. Nothing is captured from conversation text; rows are entered explicitly.

## Turn it on

In your config: `"modules": { "goals": true }`. Optional section `goals`:

| Setting | Default | Meaning |
|---|---|---|
| `stale_window_weeks` | 2 | weeks per window for the stale rule (recent window vs the one before) |
| `max_lessons_in_prompt` | 10 | newest non-stale lessons added to each prompt |

## Commands (owner only, refused inside a task, except `goal show` and `goal interview`)

    taskmote goal set "<your words>" [--done "<text>"] [--out "<text>"]
    taskmote goal interview          questions still open on the card
    taskmote goal edit [--done ".."] [--out ".."]   (clears the confirmation)
    taskmote goal confirm            needs done and out of scope
    taskmote goal [show] | done | drop
    taskmote lesson add "<what went wrong>" --missed "<which check missed it>" --fix "<fix>"
    taskmote lesson repeat <id>
    taskmote lesson list             status (new | kept | stale) and weekly counts

## Routes (owner access, under `/m/goals/`)

`GET /goal`, `POST /goal`, `PATCH /goal`, `POST /goal/confirm`, `POST /goal/close`,
`GET /lessons`, `POST /lessons`, `POST /lessons/:id/repeat`.

Data: `state/m/goals/data.json`. See DECISIONS.md for the stale rule and other choices.
