[English](README.md) | **繁體中文**

> 以英文版為準；本翻譯同步至英文版 README.md（git blob `2467967`，可用 `git hash-object README.md` 核對）。

# Taskmote

**在你自己電腦上執行的個人代理（agent）工具：從終端機、瀏覽器或手機交代任務，它透過 Claude Code 完成工作，每一步都有紀錄，而且可以復原。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **開始之前：** Taskmote 會在你的電腦上以你的使用者權限執行 AI 代理。主幹只監聽 `127.0.0.1`，所有選用模組在你開啟前都是**關閉**的。要讓手機或網路連進來之前，請先讀[安全性](#security)。

> **配對過的手機擁有你的權限。** 預設（`engine.profile: "full"`）每個 bot 都是一個持續存在的 Claude Code 工作階段，使用你自己的 Claude 設定、工具與 MCP 伺服器。任何拿著已配對裝置的人，都能讓它做你坐在這台電腦前能做的事；只有紅線動作會被防護擋下，或等你在卡片上同意。請把配對當成交出一台已登入的筆電：只配對你自己的裝置，用 `node bin/harness.js devices` 列出，用 `node bin/harness.js revoke <id>` 移除。若要回到舊的窄工具白名單，把 `engine.profile` 設為 `"locked"`。

Taskmote 在 2026 年 11 月前叫做 *dantomation*。舊指令名稱 `dantomation` 仍可作為別名使用。

## Why

程式代理很會做事，但不太會在筆電睡眠時乾淨地停下、誠實告訴你測試到底有沒有過，或在 `git push` 前先等你同意。Taskmote 是包在 Claude Code 外面的小工具，專門處理這些：防當機的日誌、一個任務只有一個執行者、每次修改前先存檢查點，以及危險動作先停下來等你說好。

## What it is, and what it is not

**它是**
- 本機、單一擁有者的工具。純 Node.js 18+，核心不需安裝任何套件。
- 一個小主幹（日誌、鎖、引擎啟動、續跑、設定、模組載入器），加上可選模組：手機聊天、語音、審核卡片、多角色房間、第二台機器的 worker。
- 隨時關機都不怕：`do` 不帶請求會續跑未完成的任務，任何副作用都不會執行兩次。

**它不是**
- **不是沙盒。** 防護是在代理工具前做樣式比對，不是隔離。代理能做你帳號能做的事。
- 不是雲端服務，也不支援多使用者。只有一個擁有者，沒有帳號系統。
- 不需要 API 金鑰。它使用你已登入的 Claude Code 訂閱，並把 API 金鑰類環境變數從代理環境中移除。
- 還沒完成。這是 v1 基礎版；見[已知限制](docs/reference.md#known-limits)。

## Quickstart

**需要：** Node.js 18 以上、Git，以及已安裝並登入的 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（先執行一次 `claude` 並登入）。

```sh
git clone https://github.com/abc940121/taskmote
cd taskmote
```

接著在該資料夾中執行：

```sh quickstart
node bin/taskmote.js do "create hello.txt that says hello"
node bin/taskmote.js status
node bin/taskmote.js undo
node bin/taskmote.js undo
```

**成功的話**，`status` 會顯示任務已完成，而它列出的 `work/` 底下資料夾裡會有 `hello.txt`。每次 `undo` 會把資料夾退回一個修改，所以 `hello.txt` 會消失；沒有可復原的步驟時它會告訴你。每次復原都會印出一行指令，可以把狀態還原回來。

- `do "<請求>"`：在 `work/` 下開新資料夾執行任務（`--workdir <dir>` 改用你的資料夾）。
- `do` 不帶請求：續跑被中斷的任務。
- `status`：顯示進行中任務、上一個完成的任務、復原點和已開啟的模組。
- `undo`：把任務資料夾退回上一個修改；再執行一次可再往前退。

Windows 上 `bin\taskmote.cmd` 效果相同；把 `bin` 加入 PATH 就能直接打 `taskmote do "..."`。

## Try the v1 base (phone chat, voice, approval cards)

`v1` 是一組預先選好的模組。它不改任何設定，也不含任何密鑰。

1. 在設定檔（`~/.harness/config.json`，或 `HARNESS_CONFIG` 指定的檔案）加入 `"preset": "v1"`。還沒有設定檔的話，建立內容為 `{ "preset": "v1" }` 的檔案。你自己寫的 `modules` 設定永遠優先於 preset。
2. 執行 `node bin/taskmote.js serve`，它會監聽 `127.0.0.1:7420`。
3. 開啟 <http://127.0.0.1:7420/m/app-ui/ui/>（結尾的 `/ui/` 要保留）。第一次開啟時頁面會要求配對碼，在本機也一樣：執行 `node bin/harness.js pair`，輸入它印出的六位數字。**成功的話**，送出 "hello" 會看到回覆。
4. **手機（選用）。** 手機連不到 `127.0.0.1`。把這台電腦加入你自己控制的私人網路（例如 Tailscale），把 `server.host` 設成該位址，重新啟動 `serve`。然後執行 `node bin/harness.js pair`，在手機上開啟印出的連結或輸入配對碼。`node bin/harness.js devices` 列出手機，`node bin/harness.js revoke <id>` 移除手機。絕對不要把連接埠開放到網際網路。

`node bin/taskmote.js preset v1` 會列出這個 preset 開啟哪些模組，它不會寫入任何檔案。

## How it fits together

架構圖與說明請見[英文版](README.md#how-it-fits-together)。重點：每個副作用都以「意圖、執行、完成」記入日誌；同時只有一個執行者；每次工具呼叫前都會詢問已開啟的防護模組；模組就是一個資料夾加一行設定。

## Features

- **代理改過的東西都能復原**（`checkpoint`）。
- **危險動作會等你**（`approval-cards`）：`git push`、任務資料夾外的刪除、安裝、付費 API 呼叫會停下，等你回答 `do yes` 或 `do no`；10 分鐘沒回答視為拒絕。
- **誠實的回覆**（`tripwires`、`claim-audit`）：回覆宣稱「測試通過」但執行其實失敗時會被標記；在設定加上 `"tripwires": {"mode": "block"}` 則會直接扣住該回覆。
- **用手機聊天**（`chat-ui`/`app-ui` 搭配 `device-pairing`）。
- **語音**（`voice`、`voice-chat`）。
- **第二台機器**（`worker`，只用對外 HTTP）。

## Modules

除了兩個安全模組 `guard-base` 和 `checkpoint`，所有模組預設都關閉。完整表格（含「能碰到什麼」欄位）見[英文版](README.md#modules)。

## Security

**威脅模型。** 你（擁有者）是被信任的。以下都不被信任：網路上的其他人、任何能在聊天或房間送出文字的人，以及代理讀到的任何文字（網頁、檔案、工具輸出）。這類文字可以操縱代理，而代理以你的權限執行。

Taskmote 用以下方式降低風險：
- 除非你修改 `server.host`，否則只綁定 `127.0.0.1`。它本身沒有中繼或通道。
- 從代理環境中移除 `*_API_KEY`、`*_AUTH_TOKEN`、`ANTHROPIC_*` 和 `OPENAI_*`。
- 手機使用各自的裝置權杖，可列出與撤銷；路由預設拒絕。
- 復原、還原與卡片回答在代理內部執行時會被拒絕。

它**無法**防範：繞過樣式比對防護的代理（例如混淆過的指令）、你開啟的模組（模組是受信任的程式碼，就像你安裝的程式），以及你開放到網際網路的連接埠。

紅線防護（安裝軟體、持久設定、登入帳號、改寫 git 歷史、付費運算與金錢，都會跳出核准卡）只能降低風險，擋不住刻意繞過的代理。它是樣式比對，所以腳本、別名或編碼過的指令都可能繞過。檔案路徑會照原樣比對，也會解開符號連結後再比對，但執行時才組出來的路徑看不到。

紅線卡片不會逾時；卡片等待期間，所有 bot 都會暫停，直到你回答或停止任務（在 app 裡按該任務的「停止」即可結束等待）。紅線核准需要開啟 approval-cards 模組；未開啟時紅線一律拒絕，agent 會告訴你。

**只從** <https://github.com/abc940121/taskmote> **取得。** 沒有 npm 套件。

**回報漏洞：** 見 [SECURITY.md](SECURITY.md)。請不要開公開 issue。

## FAQ

<details><summary><b><code>do</code> 說已有另一個任務（exit 4）</b></summary>

同時只能跑一個任務。執行不帶請求的 `node bin/taskmote.js do` 來續跑，或先看 `status`。
</details>

<details><summary><b>Exit 3：UNCERTAIN</b></summary>

日誌無法判斷某一步是否已經發生，所以 Taskmote 停下來而不是猜。`status` 會顯示是哪一步；手動確認後再續跑。
</details>

<details><summary><b>手機打不開頁面</b></summary>

伺服器預設只監聽 `127.0.0.1`。把 `server.host` 設成這台電腦的私人網路位址（例如 Tailscale），再重新啟動 `serve`。
</details>

<details><summary><b>會用到我的 API 金鑰或額外收費嗎？</b></summary>

不會。它使用你已登入的 Claude Code 訂閱，並從代理環境移除 API 金鑰變數。
</details>

<details><summary><b>設定和資料放在哪裡？</b></summary>

設定在 `~/.harness/config.json`（或 `HARNESS_CONFIG`）。日誌和檢查點在 `state/`，防護紀錄在 `logs/`。
</details>

## Docs

- [docs/reference.md](docs/reference.md)（英文）：CLI、架構層、設定鍵、測試與已知限制。
- [docs/MODULES.md](docs/MODULES.md)（英文）：模組規格。
- 問題與錯誤回報：[GitHub issues](https://github.com/abc940121/taskmote/issues)。

## Contributing

- 用 `node test/run-all.js` 跑測試，不需網路也不呼叫模型。
- 新功能通常是新模組：複製 `modules/hello-stub`，核心不用改。
- 翻譯：編輯 `README.zh-TW.md`，並保持標題與英文版完全相同。

## License

MIT，見 [LICENSE](LICENSE)。部分 app 介面改編自 Apache-2.0 程式碼；見 [NOTICE](NOTICE) 和 [PROVENANCE.md](PROVENANCE.md)。
