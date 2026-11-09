# search

Full-text search over the owner's own history: task requests, chat messages
(prompts and replies) and room transcripts, read from the journal. Off by
default; turn on with `"modules": { "search": true }`.

## Route

`GET /m/search/search?q=&kind=&bot=&room=&limit=&offset=` (owner only)

| Param | Meaning |
|---|---|
| `q` | required; every word must occur (AND), case-insensitive; max `max_query_chars` |
| `kind` | `task` (task request), `message` (prompt or reply), `room` (room message) |
| `bot` | bot id (a reply carries the bot of its task; a room message the bot speaker) |
| `room` | room id |
| `limit` | 1..`max_results`, default 20 |
| `offset` | 0..100000 |

Answer: `{total, limit, offset, next_offset|null, results: [{kind, id, task_id, bot, room, ts, snippet}]}`,
newest first. `id` is the journal record id.

## Index

In memory, built from the journal and kept current by reading only the bytes
appended since the last query (no full re-scan). Latin text is indexed by word,
CJK text by character and character bigram. Secret-shaped strings are redacted
before indexing, so they are neither searchable nor shown. Past `max_docs`
entries the oldest are dropped.

## Config (`search`)

`max_query_chars` (200), `max_results` (50), `max_docs` (50000), `max_doc_chars` (4000).

Test: `node modules/search/test/search.js`.
