# bot-persona decisions

1. Seam: `prepareTurn` (docs/MODULES.md). It adds context under "Context from
   modules" as `[bot-persona] ...`, so no core change is needed. `onTaskStart`
   events cannot change the prompt.
2. Bot identity: `prepareTurn` ctx has no bot field. The module reads the
   `bot` of the task's `task_start` journal record, then `HARNESS_BOT`, then the
   first configured bot. A core ctx field `bot` would be cleaner (missing seam).
3. 8000-character clip: core clips each module's context at 8000 characters, but
   the default caps (4 KB + 24 KB) can exceed that. The module builds its own
   block to fit, persona first, memory clipped with a visible marker. Caps apply
   to storage; the prompt gets what fits.
4. Labeling: the block states it is owner-provided data, not commands, and uses
   fences. The fence word inside the text is rewritten so text cannot close a
   fence early. This is a mitigation, not a guarantee; the owner is trusted.
5. Caps in UTF-8 bytes, validated on every write; no partial writes on error.
6. Plain text files per bot and part, atomic rename, mode 600. Bot ids are
   restricted to `[a-z0-9][a-z0-9_-]{0,63}` and must be configured, so a path
   cannot escape the state dir.
7. Owner access on every route; `persona` command refuses inside a task.
8. Journal records hold sizes only, never persona or memory text.
9. Priority 60: after the modules that ask (50), before snapshots (90); only
   affects context order.
