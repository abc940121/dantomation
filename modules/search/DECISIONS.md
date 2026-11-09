# search decisions

- Index source: the journal file, tailed by byte offset at query time. The contract has no journal-append event (only task.*, tool.done), so event-driven updates are not possible; tailing is incremental and also sees other processes (worker, server) writing the journal.
- No background job: a query catches up first, so the index is never stale and idle cost is zero.
- Indexed record types: `task_start.request` (task), `queue_add.prompt` and `reply.text` (message), `room_msg.text` (room). Other records carry no owner text worth searching.
- Matching: AND of query words; CJK via character bigrams (single char also indexed), then confirmed by substring so non-adjacent characters do not match. Newest first, no ranking.
- Paging by `offset` (cap 100000); stable because the journal is append-only and order is newest first (new records shift offsets, accepted).
- Memory bound: `max_docs`, dropping the oldest 10% and re-indexing when exceeded; text clipped to `max_doc_chars`. After a restart the index is rebuilt from the journal in one pass on first query (bounded by the same caps).
- Privacy: text goes through core `redactFull` before indexing; snippets are 120 chars.
- Owner-only (`access: owner`); filters validated against a strict id pattern; no logging of queries.
- Journal shrink (rotation) resets the index and re-reads.
