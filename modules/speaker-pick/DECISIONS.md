# Decisions: speaker-pick

Module-owned log. Append only.

- Pure selector in lib/select.js; index.js only wires route, journal and guard, so rooms can adopt it through one call.
- Mention detection is re-implemented here (a module never requires another module); it counts only tokens that match a listed member or everyone.
- Model answers must equal a listed bot id after trim; the prompt marks messages as data. Invalid, error or timeout falls back to keyword then round robin.
- Journal reason is a short code, never text.
- Per-process memory (last bot, run length, auto turns) is not persisted: a restart only resets caps.
- rooms exposes no recipient hook, so this module does not depend on it; the seam is reported instead.
- Contract 6 seam (manifest still contract 2: trunk test requires it, ctx.engines is available to contract >= 1): model mode calls ctx.engines.run via the `model_engine` setting. It is a string defaulting to `""` (the settings schema has no null default); empty means unset and keeps the old fallback. A non-zero engine exit is a model error. hookTimeoutMs stays 1000 (beforeTool and statusLines are cheap).
