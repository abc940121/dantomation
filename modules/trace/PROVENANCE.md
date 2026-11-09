# trace provenance

- Per-task timeline of start, tool calls, end, tokens and duration: idea from agent tracing SDKs (spans per agent run). No code copied.
- Tokens times a price table as cost, shown as unknown when usage is missing: idea from LLM cost trackers. No code copied.
- Record a prediction first, compare with the actual later, alert on 2x: idea from predict-then-do practice. No code copied.
- File-per-task state with a lock file: pattern from this repo's task-watchdog module.
