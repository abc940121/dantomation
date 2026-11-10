# Decisions

- A prompt hook already exists (`prepareTurn`, module contract v7), so no trunk change is needed. This module returns `{context:[block]}`.
- The tool list is a table in this module, keyed by module name, not an `agentTools` manifest field. The manifest field list is strict (an unknown field is a load error), so a per-module field would need a trunk change. The cost: a new module that wants to be listed adds one row here. If the trunk later allows a module-declared field, the table can be replaced by reading it.
- "Enabled" means `config.modules[name] === true`. A module that is on but failed to load is still listed; calling it prints the usual "needs the module" error.
- Cap 1500 characters, clipped at a word with ` [clipped]`. Nothing is added when no known module is on.
- The block never throws into a turn; any error returns no context.
- Related agent-facing changes made alongside (in the modules themselves): `grill check`, `arena --queue`, `changes`, `quiet status --json`, and in-task guards for `digest --push`, `quiet on|off|flush`.
