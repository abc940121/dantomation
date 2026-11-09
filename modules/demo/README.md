# demo

`node bin/taskmote.js demo`: a 60-second tour with zero setup. It never reads or writes your own config or state.

- `bin/taskmote.js` makes a throwaway sandbox in the OS temp dir. It points `HARNESS_CONFIG`, `HARNESS_STATE_DIR`, `HARNESS_WORK_DIR` and `HARNESS_LOG_DIR` at it, runs the demo inside it, and removes it on exit (Ctrl-C too). `demo.js` refuses to run outside that sandbox.
- The real server starts on a free `127.0.0.1` port with guard-base, checkpoint, approval-cards and chat-ui on, and the URL of the approval page is printed.
- One real task runs through the harness. Its engine is `agent.js` (via `HARNESS_ENGINE_SCRIPT`), a scripted stand-in for the model with no LLM and no network. It runs the real PreToolUse hook and the real permission-prompt MCP tool.
  - (a) An edit is allowed, and a checkpoint is taken first.
  - (b) `git push --force` is hard-blocked by a red line, and the reason is shown.
  - The agent is killed between a side effect's act and its done line (the `HARNESS_PAUSE_EFFECT` seam in `bin/effect.js`). The task is resumed through `POST /api/tasks/<id>/resume`. Done steps are skipped and the side effect is reconciled, not repeated.
  - (c) A call to a paid API raises a real approval card. The terminal waits until you press Approve or Deny on the page.
  - (d) `taskmote undo` rolls the change back, and the diff is shown.
- `TASKMOTE_DEMO_AUTO=yes|no` answers the card itself (used by `test/demo.js`). Color is used only when stdout is a TTY. The last line is `DEMO_RESULT {...}`.

The demo is loopback only. Phones need the device-pairing module and a private network.
