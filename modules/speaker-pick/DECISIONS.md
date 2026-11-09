# Decisions: speaker-pick

Module-owned log. Append only.

- Pure selector in lib/select.js; index.js only wires route, journal and guard, so rooms can adopt it through one call.
- Mention detection is re-implemented here (a module never requires another module); it counts only tokens that match a listed member or everyone.
- Model answers must equal a listed bot id after trim; the prompt marks messages as data. Invalid, error or timeout falls back to keyword then round robin.
- Journal reason is a short code, never text.
- Per-process memory (last bot, run length, auto turns) is not persisted: a restart only resets caps.
- rooms exposes no recipient hook, so this module does not depend on it; the seam is reported instead.
