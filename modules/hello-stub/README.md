# hello-stub

The template module. It uses every part of module contract 1 once (see
`docs/MODULES.md`) and does nothing useful. Off by default.

| Part | Here |
|---|---|
| hook | `beforeTool` blocks a shell command containing `block_word` (empty = off) |
| command | `harness hello [name]` prints the greeting |
| route | `GET /m/hello-stub/hello?name=x` returns `{greeting}` |
| panel | `ui/hello.js`, mounted in the sidebar |
| job | `tick`, every 60 s, counts ticks (`api.ticks()`) |
| settings | `hello_stub.greeting` (string, `"hello"`), `hello_stub.block_word` (string, `""`) |
| runsOn | `main` |

To start a module: copy this folder to `modules/<name>/`, set `name` to the
folder name, delete the parts you do not need, add `"<name>": true` under
`modules` in the config, and put your settings under `"<name with - as _>"`.
Test: `node modules/hello-stub/test/hello-stub.js`.
