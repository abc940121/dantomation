# Decisions: notifications

1. Storage is two small JSON files in `ctx.state.dir`, written tmp + rename. Reads and writes are synchronous, so handlers in one process never interleave. A corrupt file reads as empty rather than failing.
2. Bounded by `max_entries`; pruning drops read entries first (oldest first) so unread ones survive a flood.
3. Per-kind switch has two layers: boolean settings (config default) and a runtime override via `PUT /kinds` kept in `prefs.json`. Core's settings write path (`updateSettings`) is owned by the server, and a module route cannot call it, so the override lives in module state.
4. Subscribes to `card.created` and `task.end` (real events). `question.asked` and `rooms.mention` are subscribed by name because the contract allows any `prefix.name`, but nothing emits them yet; they cost nothing until someone does. A room mention counts only when `target` is `owner`.
5. `card.answered` is not recorded: the owner just did that. No auto mark-read.
6. Text is redacted and capped before it is stored, since card summaries may quote commands. The journal record carries ids only.
7. Ids are a per-store increasing integer, never reused after pruning.
8. All routes `owner`; workers and anonymous callers get 403 from core.
9. Priority 90 (observer), no hooks, no beforeTool, so enabling it cannot block anything.
