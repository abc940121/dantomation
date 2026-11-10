# ccusage

Per-day, per-month and per-session Claude Code token and cost reports. The module runs the separate program [ccusage](https://github.com/ryoppippi/ccusage) (MIT) through `npx` and shows its JSON. No ccusage code is in this repo.

## Turn it on

    "modules": { "ccusage": true }

Off by default. Needs Node's `npx` and, the first time, network access to fetch ccusage. The version is pinned by the `version` setting (default `20.0.48`); change it on purpose. The call is `npx -y ccusage@<version> claude <daily|monthly|session> --json --offline`.

## Use

    taskmote check usage                              daily table
    taskmote check usage session --since 2026-11-01   per-session table
    taskmote check usage monthly --json               raw ccusage JSON

The old spelling `taskmote usage ...` still runs and prints the new one.

Route (owner only): `GET /m/ccusage/usage?report=daily&since=2026-11-01&until=2026-11-10` returns ccusage's JSON. If npx or ccusage cannot run you get a one-line hint and exit 1 (route: 503). The server is never affected.

## Relation to spend-count

`spend-count` is a guard: it estimates one session's cost from the live transcript and blocks past a limit. `ccusage` is a report: history across days and sessions, with ccusage's own price data. They do not share code; use `ccusage` to look back and pick a sensible `spend_limit_usd_per_session`.

## Test

    node test/run-all.js module ccusage

The tests stub the child process; nothing touches the network.

## Known limits

- Costs are ccusage's estimates from local logs, not a bill. On a subscription login they are notional.
- Only Claude Code logs are reported (`ccusage claude ...`). `--offline` uses ccusage's bundled prices, so a very new model may show as zero cost.
- Session tables print the session id and last-activity date, not the project path. `--json` and the route include everything ccusage returns, paths included.
