# spend-count

Blocks a session whose notional spend is over `spend_limit_usd_per_session` (env `HARNESS_SPEND_LIMIT_USD` overrides it). The spend is read from the session transcript Claude Code gives the hook: tokens times the price table `prices_usd_per_mtok` in the config. Every check is logged to `logs/spend.jsonl`; a block is logged to `logs/guard.jsonl` as kind `spend`.

## Turn it on

    "modules": { "spend-count": true }

Off by default. On a subscription login there is no per-token bill, so the number is only a rough guard against a runaway session.

## Test

    node modules/spend-count/test/spend.js

## Known limits

- The check reads the transcript, which Claude Code writes slightly after each reply. The model call in flight is counted on the next tool call, not the current one. A session that makes only one tool call can go over the limit once.
- Spend in USD is notional: token counts multiplied by the price table in `config/harness.config.json`, with cache writes at 1.25x and cache reads at 0.1x input. It is not a bill.
- A missing or unreadable transcript counts as zero.
