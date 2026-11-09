# Decisions: demo

Module-owned log. Append only, one line per decision with the reason. Trunk decisions are in the root DECISIONS.md.

- D1: the sandbox is made in bin/taskmote.js before any config loads (a trunk change), because a module only loads after the config is read, which is too late to keep away from the owner's config. The wrapper re-runs itself inside the sandbox and removes the sandbox when the child exits.
- D1: the agent is a scripted engine (HARNESS_ENGINE_SCRIPT) that runs the real hook and prompt-tool commands from the files harness.js wrote, so every decision comes from the real guard chain and card path, and no model or network is needed.
- D1: crash and resume kills the agent, not the server. On Windows, killing the server kills its child tasks, and on restart the server closes orphaned cards. The existing HARNESS_PAUSE_EFFECT test seam makes the crash point deterministic.
- D1: no new features. Undo, checkpoint, cards, resume and effect reconcile are all existing code. The narration points out what Claude Code does not do on its own: a red line that cannot be switched off, a card you can answer away from the desk, and resume from the journal.
