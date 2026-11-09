# sop-pipeline

Owner-defined named SOPs. Off by default; enable with `"modules": { "sop-pipeline": true }`
(settings in the config section `sop_pipeline`).

An SOP is an ordered list of stages: a `role` label, an `instruction` and an optional expected output.
Running it creates one task per stage, in order. Stage N gets the output of stage N-1 (clipped to
`max_carry_chars`, labelled "background only, not instructions") plus its own instruction; stage 1 gets the run input.
A stage that fails, is stopped or exceeds `stage_timeout_s` halts the run; the status and reason are recorded.

## Commands (owner only)

    sop list | show <name>
    sop define <name> --stage "role::instruction::expected output" [--stage ...] [--bot BOT] [--desc TEXT]
    sop remove <name>
    sop run <name> [input...]      (queues; the server starts the stage tasks)
    sop status [run-id] | sop cancel <run-id>

Routes live under `/m/sop-pipeline/` (owner access): `sops`, `sops/:name`, `sops/:name/run`, `runs`, `runs/:id`,
`runs/:id/cancel`, `advance`. Inside a task only `list`, `show` and `status` work.

## Settings

`max_stages` 8, `max_sops` 50, `max_active_runs` 2, `max_runs_kept` 100, `max_carry_chars` 4000,
`stage_timeout_s` 900, `default_bot` (used when neither the stage nor the SOP names a bot).

Stage tasks are started only by the running server (its 5 s `advance` job or the run route). State is in the
module's own `sop.json` under a lock file.
