# guard-private-rules

The owner's own red lines, from a private rules file kept outside the repo, plus self-protection: agents cannot write the harness config or the rules file.

A rule is `{kind, match: shell|path|content, pattern, access: write|any, reason}`. `shell` matches the command, `path` the file a tool touches (or a path named in a shell command), `content` text being written. `access: write` (default) only blocks calls that change something; `any` also blocks reads. `example-private.json` holds harmless sample rules.

## Turn it on

Either set it in the config:

    { "private_rules": "private-rules.json", "modules": { "guard-private-rules": true } }

or set `private_rules` (a path relative to the config file) and leave out the `modules` key: the module then turns on by itself, so a config written before modules existed keeps enforcing its rules. If the config has a `modules` key, only that key decides (`false` turns the rules off). It is off in the shipped defaults, since there is no rules file to read.

## Test

    node modules/guard-private-rules/test/private-rules.js

The test writes its own temp configs. If your own config names a rules file with a `checks` array (`[{tool, path|command, blocked}]`), those checks run too, so private paths stay out of the repo.

## Known limits

- Same as guard-base: pattern matching, not a sandbox. A command that builds a path at run time gets past a `path` rule.
- A rules file that exists but cannot be read, or has a bad rule, makes the module fail to load: `harness.js start`/`resume` exit 2 and the guard blocks every call, until the file is fixed. This is deliberate (fail closed).
- Self-protection covers the two files named by the config (the config file itself and the rules file).
