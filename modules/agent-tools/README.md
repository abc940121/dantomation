# agent-tools

Tells the agent running a task which module commands it can call. Off by default.

Enable: `"modules": {"agent-tools": true}`.

## What it does

Before each engine turn it adds a short block to the prompt, built from the modules that are enabled:

    Tools you can call (run in your shell, inside this task):
    - taskmote digest --json: what happened recently (read only)
    - taskmote grill check "<request>" --json: is a request too vague to start? ...

Only enabled modules appear. If none of the known ones is on, nothing is added. The block is capped at 1500 characters and ends with ` [clipped]` if cut.

`taskmote tools [--json]` prints the same list (JSON: `{"tools":[{"module","cmd","use"}]}`).

## Covered modules

| Module | Command an agent can call |
|---|---|
| task-grill | `taskmote grill check "<request>" --json` -> `{vague, reasons, questions}`; makes no card and no hold |
| question-cards | `taskmote ask "<text>" <option> <option> --free` |
| digest | `taskmote digest --json` (read only inside a task) |
| quiet-hours | `taskmote quiet status --json` (changing the window is owner only) |
| change-card | `taskmote changes --json` -> `{pending:[...]}` |
| arena | `taskmote arena "<request>" --queue --json` -> `{queued, id, position}` |

Adding a module to the list means adding an entry to `TOOLS` in `index.js`. See DECISIONS.md.
