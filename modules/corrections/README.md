# corrections

Remembers what the owner corrected, so the same correction is not needed a second time, even after the
conversation is compacted or a new session starts.

- **Saved the moment it is said.** A cue-word check (English and Traditional Chinese: "don't", "never",
  "不要", "別", ...) saves the sentence as a `candidate` scoped to that task. Nothing is asked of the owner.
- **Confirmed by the agent or by repeating.** The agent confirms with `correction propose` (the owner's exact
  words, the why, and where it applies), or the owner says it again (a near-duplicate): the rule becomes `active`.
- **Put back only when relevant.** Each turn, only the rules that share words with the request are injected
  (top 3, inside a byte budget). 500 stored rules inject the same size as 5. Each line carries the why and the
  date. A candidate is labeled "unconfirmed, may apply to that task only".
- **A rule is a past statement, not a law.** The block tells the agent to say why when a rule no longer fits.
  An active rule not re-checked for `review_days` is flagged "still valid?". A candidate never relevant again
  within `candidate_days` is switched `off` (kept, not deleted).
- **The owner can view, edit and delete** every rule. An agent can only read, search and propose.

## Turn it on

In your config: `"modules": { "corrections": true }`. Optional section `corrections`:

| Setting | Default | Meaning |
|---|---|---|
| `detect` | true | save a correction when the owner says one, as an unconfirmed candidate |
| `max_inject` | 3 | most rules put in front of the agent in one turn |
| `max_inject_bytes` | 1500 | byte budget for the rule lines of one block, whatever is stored |
| `min_overlap` | 2 | shared-word points before a rule is relevant (Latin word 1, Chinese 2-char word 2) |
| `review_days` | 90 | days after which an active rule is flagged for a re-check |
| `candidate_days` | 14 | days a candidate may go unused before it is switched off |
| `max_rules` | 300 | rules kept; over the cap off rules go first, then candidates, then the oldest |
| `repeat_similarity` | 0.6 | how alike two sentences must be to count as a repeat |

## Commands

    taskmote correction [list]
    taskmote correction search <words>
    taskmote correction show <id>
    taskmote correction propose --quote "<owner's exact words>" --why "<reason>" [--scope ".."] "<rule>"
    taskmote correction add "<rule>" [--why ".."] [--scope ".."]        owner only
    taskmote correction edit <id> [--rule ..] [--why ..] [--scope ..] [--status candidate|active|review|off]
    taskmote correction keep <id>                                       owner only
    taskmote correction delete <id>                                     owner only

`add`, `edit`, `keep` and `delete` are refused inside a task (`HARNESS_TASK_ID` set; exit code 6), and an
agent shell call to them or to the API path is blocked.

## Routes (owner access, under `/m/corrections/`)

`GET /rules` (`?q=` searches), `GET /rules/:id`, `POST /rules`, `PATCH /rules/:id`,
`POST /rules/:id/keep`, `DELETE /rules/:id`.

Data: `state/m/corrections/rules.json`. See DECISIONS.md for the choices and their limits.

---

# corrections（繁體中文）

記住主人說過的更正，讓同一件事不必講第二次；對話被壓縮或換新工作階段後仍然有效。

- **當下就記。** 以關鍵詞（中英文，如「不要」「別」「never」）偵測，存成「候選」並限定在該任務；不會問主人要不要確認。
- **由代理或重複來確認。** 代理用 `correction propose`（主人的原話、原因、適用範圍）確認，或主人再說一次，就變成「生效」。
- **只在相關時才放回。** 每回合只注入與請求有共同字詞的規則（最多 3 條，有位元組上限）。存 500 條與存 5 條注入的大小相同。每條附原因與日期；候選會標示「未確認，可能只適用於該任務」。
- **規則是過去的說法，不是法律。** 提示會要求代理在規則不再適用時說明原因。生效規則超過 `review_days` 未檢查會標示「是否仍有效？」；候選在 `candidate_days` 內都沒再相關就轉為 `off`（保留，不刪除）。
- **主人可查看、修改、刪除**每一條；代理只能讀取、搜尋與提議。

啟用：設定檔 `"modules": { "corrections": true }`。設定項目見上表。指令與路由同上；`add`、`edit`、`keep`、`delete` 在任務內會被拒絕（結束碼 6）。
