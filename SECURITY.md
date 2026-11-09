# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting instead: on the repository page, open **Security → Report a vulnerability**. Include what you ran, what happened, and what you expected. You should get a first answer within a week.

## Scope

In scope:
- The trunk (`lib/`, `bin/`): journal, executor lock, engine launch, environment stripping, the guard hook, the server.
- The shipped modules in `modules/`, especially `device-pairing`, `chat-ui`, `app-ui`, `approval-cards`, `guard-base` and `worker`.

Out of scope, by design (see the README's Security section):
- An agent getting past the pattern-matching guard with an obfuscated command. The guard reduces risk; it is not a sandbox.
- Anything a module you enabled does. Modules are trusted code.
- A server you exposed to the internet yourself.

## Supported versions

Only the latest commit on `main` gets fixes.

## Getting the code

The only official source is <https://github.com/abc940121/taskmote>. There is no npm package; anything published under this name elsewhere is not ours.
