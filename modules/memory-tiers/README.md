# memory-tiers

Three memory tiers, in the spirit of core / recall / archival memory. Off by default.

| Tier | What it holds | In the prompt? | Limit |
|---|---|---|---|
| core | facts the owner pinned | yes, every turn | `core_chars` total characters (item max 400) |
| recall | clipped replies of recently finished tasks | the newest `recall_in_prompt` | `recall_max` items, `recall_days` age |
| archive | recall items demoted by count or age | never; fetched by keyword | `archive_max` items (oldest deleted), 2000 items overall |

**Capture (opt-in).** When enabled, on `task.end` the module takes the reply text the core already journaled for that task, flattens
it to one line and clips it to 400 characters. The request text is never read. Capture is off by default
(`capture: false`): only owner-pinned facts exist until the owner sets `capture: true`.

**Rules.** Demotion: a recall item beyond `recall_max` (oldest first) or older than `recall_days` moves to the
archive; an archive past `archive_max` loses its oldest. Promotion: `pin <id>` moves a recall or archive item
into core if it fits the budget. `unpin` moves core back to recall. `restore` moves archive back to recall.
`forget` deletes from any tier. Nothing is promoted automatically.

## Turn it on

`"modules": { "memory-tiers": true }`. Optional section `memory_tiers`:

| Setting | Default | Meaning |
|---|---|---|
| `core_chars` | 1500 | total characters in core |
| `recall_max` | 20 | recall items kept |
| `recall_days` | 14 | recall age limit in days (0 = count only) |
| `archive_max` | 500 | archive items kept |
| `recall_in_prompt` | 3 | newest live recall items in each prompt (0 = core only) |
| `capture` | false | record a recall item when a task ends |

## Commands (writes owner only, refused inside a task with exit 6)

    dantomation memory [list]
    dantomation memory search <words> [--all|--core|--recall]     (default tier: archive)
    dantomation memory pin "<fact>" | <id>
    dantomation memory unpin <id>
    dantomation memory restore <id>
    dantomation memory forget <id>
    dantomation memory sweep                                       (apply age and count rules now)

## Routes (`/m/memory-tiers/`, all owner access)

`GET /memory`, `GET /search?q=&tier=&limit=`, `POST /core` ({text} or {id}), `POST /core/:id/unpin`,
`POST /archive/:id/restore`, `POST /items/:id/forget`, `POST /sweep`.

State: `state/m/memory-tiers/data.json` (texts) plus journal records with ids only.
