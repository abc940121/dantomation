# presets

The `preset` verb: `taskmote preset <name>` lists the modules a profile from `presets/` turns on, which of your own `modules` entries win, and the one line to add to your config. It never writes a file.

The `"preset": "<name>"` config key is applied by the trunk at load, with or without this module.

Can touch: reads `presets/` and your config. On by default so the verb keeps working; turn it off with `"presets": false`.
