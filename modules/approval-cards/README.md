# approval-cards

Risky actions stop and ask you yes or no instead of running. The agent's call is held with a card; you answer; the task resumes. It only asks about calls the hard blockers (`guard-base`, private rules) already allow: their blocks stay blocks.

## When to turn it on

Turn it on when you let the harness run unattended but want the last word on a few actions that are legitimate yet hard to take back: pushing commits, deleting files outside the task folder, installing packages, publishing, calling paid APIs. Leave it off if you prefer those to run without asking, or if you rely on `guard-base` alone.

    "modules": { "approval-cards": true }

Off by default. It works alone and together with every other module. It only acts inside a harness task (`HARNESS_TASK_ID` set by the engine launch).

## How it works

1. The agent makes a risky call. The guard writes a card (id, task, tool, the exact input, its sha256, a one-line summary, created_at, expires_at) to the journal (records carry `module: "approval-cards"`) and the mirror `state/m/approval-cards/<id>.json`, and blocks the call with `waiting for approval card <id>; stop and end your turn`.
2. You see it in `node bin/taskmote.js status` (it lists the pending card and how to answer). You answer with the existing `do` verb:

        node bin/taskmote.js do yes        # or: do no
        node bin/taskmote.js do "yes card-3fa9c2"    # when more than one card is pending

   `do` with no answer while a card is pending does not resume; it tells you the card is waiting.
3. A yes approves exactly that input hash, once. The task resumes, the agent is told the card was approved, and the identical call passes once; the card is then marked used. A second identical call, or any changed input, needs a new card.
4. A no denies it; the resumed agent is told not to retry or reword it.
5. No answer in 15 minutes (`approval_cards.timeout_minutes`, default 15) counts as no and the card is closed for good.

The card is a journal record, so a crash or power cut between the card and your answer loses nothing: the card is still pending after a restart and the same call does not create a second one.

## Answers (`parseAnswer`)

`parseAnswer(text)` returns `'yes'`, `'no'` or `'unclear'` and is exported as `api.parseAnswer` (also `parse.js`; a voice entry can call it). It is strict: the whole answer must be made of known words.

- yes: yes, y, ok, okay, approve, confirm, agree, go ahead, 是, 好, 可以, 確定, 同意, and close variants (yess, OK!, 好的, yes please).
- no: no, n, nope, deny, stop, cancel, 不要, 不, 否, 取消, and close variants.
- unclear: everything else. Hedges ("maybe", "I guess", "好像可以吧"), "yes but not now", mixed yes and no, any question or question mark ("yes?"), "yeah right", "嗯", "等一下", unknown words, empty input.

Unclear never approves. The card stays pending and `status` says the last answer was unclear.

## Risky list (data, extendable)

Defaults are in `default-risky.json`: `git push`; deleting files outside the task folder; package installs (npm, pnpm, yarn, pip, winget, choco, apt, brew, cargo, go); anything that publishes (`gh release`, `gh repo`, `npm publish`, `docker push`); calls to well-known paid API hosts, by URL or bare host name (shell or fetch tool, so curl, wget, `Invoke-WebRequest`, Python and Node one-liners all count); and the OpenAI and Anthropic SDKs or CLIs used from the shell. It is pattern matching, so a call that hides the host or the SDK name gets through. Extend or trim in your config, like the private rules:

    "approval_cards": {
      "timeout_minutes": 10,
      "risky": [ { "id": "deploy", "match": "shell", "pattern": "\\bdeploy-site\\b", "summary": "deploys the site" } ],
      "skip": [ "package_install" ]
    }

The `approval_cards` section is checked against the module's settings schema when the module is on: an unknown key or a wrong type (for example `"timeout_minutes": "10"`) is a load error naming the key, and the guard blocks every call until it is fixed.

A rule is `id`, `match` (`shell`, `url`, or a list), `pattern` (JavaScript regex source), optional `flags`, `summary`, and `outside_workdir` (only count when a path argument points outside the task folder).

## Routes and panel (module contract 1)

For the coming server and web UI (not built yet), the module declares:

- `GET /m/approval-cards/cards` -> `{cards: [...]}`, the pending cards.
- `POST /m/approval-cards/cards/:id/answer` with body `{text}` -> `{card_id, answer, resume}`; 400 without text, 404 when the card is not pending. The text goes through `parseAnswer` and is recorded exactly like `do yes` / `do no`.
- Panel `cards` (`ui/cards-panel.js`, mount `chat`): lists pending cards with yes/no buttons.

Who may call the routes (the owner only) is the server's job.

## Test

    node modules/approval-cards/test/approval-cards.js
    node modules/approval-cards/test/contract.js   # routes, panel, settings, in-process

## Known limits

- **A pattern list, not a sandbox.** A risky action spelled in a way the patterns do not match (a script that pushes, a renamed tool, a variable holding the command) is not held. The cards are a convenience for honest agents, not containment.
- **Answering is protected by convention.** The answer verb refuses when `HARNESS_TASK_ID` is set and the module blocks agent commands that name `taskmote`/`harness` followed by `do yes`, `do no` or `answer`. An agent that bypasses the guard (guard-base off, or an obfuscated command) could answer its own card.
- Delete detection resolves path arguments textually. Wildcards and paths held in variables count as outside (it asks); a symlink inside the task folder that points outside is not seen.
- Only calls that reach the guard are covered, and only inside an engine run. Calls made by you in your own shell are never asked about.
- The agent must end its turn for the card to be answered; a task waiting on a card stays open. The window is measured from card creation, not from when you first look.
- Cards are matched on the exact tool input: a harmless difference (an extra space) makes a different hash and a new card.

## Who decided, and where

Every decision (`card_answer` record) carries `who`: `owner`, `device` (+ `device_id`, an opaque string such as a paired phone's id), `timeout`, or `system` (fail-closed paths, `cards.systemDeny`). It also carries `where`: `chat`, `phone`, `voice`, `cli` (null for timeout/system). The card UI shows it after the decision, for example `Denied · timeout` or `Approved · owner via phone` (`GET /m/approval-cards/cards/decided`, field `decision`). `POST .../answer` takes optional `{where}` from an owner caller (chat, phone, voice, cli). The `device_id` is never read from the body: when the caller authenticated with a device token the server sets the actor id `device:<id>` and the module records `who=device`, that id and `where=phone` (any body `where` or `device_id` is ignored). Callers cannot claim `timeout` or `system`; an unknown actor is refused.

## Expiry

Default 15 minutes: long enough to see a phone notification and answer away from the desk, short enough that a stale request does not hang a task. An expired card is journaled as `timeout` and is closed forever: a late yes is recorded as a timeout, it is never re-posted after a restart (the journal fold keeps it expired), and the same call in the same task gets the denial message, not a new card. A different call needs its own card.

## Deny message

After a no, a timeout or a system denial the agent is told to skip the step, not retry or reword it, tell the person why it was not done, and carry on with what does not depend on it. Approval stays hash-bound and once-only.

## Voice hook (not wired)

`POST /m/approval-cards/cards/:id/voice` with `{text}` (a device caller's id comes from its token, not the body), or `api.voiceAnswer(ctx, {card_id, text, device_id})`. Only a strict yes or no decides (recorded `where=voice`); anything else changes nothing and returns `{reask: true, say: "Please answer with a clear yes or no."}`.
