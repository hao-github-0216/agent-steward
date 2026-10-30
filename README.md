# 專案管家 agent-steward

[English](README.en.md)

同時用好幾個 AI coding agent(Claude Code、Codex、pi、opencode、Gemini CLI…)做好幾個專案時,
很容易忘記每個專案做到哪、誰在做什麼、哪裡卡住。專案管家會:

- **自動記錄進度**:agent 做完一段工作,管家讀它的終端機輸出,整理成每個專案的目標、進度、下一步、卡住的地方。
- **開工簡報**:agent 一開工就讀到這個專案的最新狀態,不用每次重講。
- **看板派工**:管家發現該做的事會提案成工作卡;你拖到「已核准」,它就開一個終端機把工作交給指定的 agent。做完(或卡住)後可以在卡片裡**接著追問**做這張卡的 agent,問題和完整回覆排成一串對話。
- **問管家**:右下角的浮動球,隨時問「這個專案做到哪了?」。
- **網頁上就能工作**:看板、程式碼(編輯、Git、比對)、終端機都在同一個網頁,手機和平板也能用。

![看板](docs/images/board.png)

| 問管家 | 程式碼與 Git |
|---|---|
| ![問管家](docs/images/chat.png) | ![程式碼](docs/images/code.png) |

| 自訂 AI 接口與路由 | 偵測並接上 agent | 手機 |
|---|---|---|
| ![路由](docs/images/settings-routing.png) | ![Agent](docs/images/settings-agents.png) | ![手機](docs/images/mobile.png) |

> 介面目前只有繁體中文。

## 安裝

**macOS / Linux**(終端機):

```sh
curl -fsSL https://raw.githubusercontent.com/hao-github-0216/agent-steward/main/install.sh | sh
```

**Windows**(PowerShell,不需要系統管理員):

```powershell
irm https://raw.githubusercontent.com/hao-github-0216/agent-steward/main/install.ps1 | iex
```

裝完會自動打開瀏覽器(`http://127.0.0.1:8791/`),跟著第一次設定精靈走:

1. 管家怎麼稱呼你
2. 接上至少一個 AI 接口(貼 API 金鑰,或填自架模型的網址)
3. 勾選要接上專案管家的 agent
4. (選用)設定管理密碼、開啟 Tailscale 或區網存取,用手機連進來

安裝程式會準備好:

| 項目 | 位置 |
|---|---|
| 程式、設定、資料 | `~/.agent-steward/` |
| `steward` 指令 | `~/.local/bin/steward`(Windows:`steward.cmd`) |
| Node.js 22.6+ | 沒有的話自動下載到 `~/.agent-steward/node`(macOS 有 Homebrew 就用 Homebrew) |
| [herdr](https://github.com/hao-github-0216/herdr)(終端機多工、agent 狀態偵測) | `~/.agent-steward/bin/`;已經自己裝了 herdr 不會覆蓋 |
| [ttyd](https://github.com/tsl0922/ttyd)(網頁終端機) | Homebrew 或 `~/.agent-steward/bin/` |
| 開機自動啟動 | macOS launchd、Linux systemd --user、Windows 工作排程器 |

## 更新與移除

- **更新**:設定 → 關於 → 檢查更新 → 「更新到 vX.Y.Z」。或再跑一次安裝指令。
- **移除**(資料會保留,加 `--purge` / `-Purge` 連資料一起刪):

  ```sh
  sh ~/.agent-steward/app/uninstall.sh
  ```

  ```powershell
  powershell -ExecutionPolicy Bypass -File $HOME\.agent-steward\app\uninstall.ps1
  ```

  移除時會先拿掉各 agent 設定檔裡專案管家加的部分。

## AI 接口與路由

管家自己也會用 AI:回答問題、整理 agent 的回報、決定要不要提案、產生 Git 提交訊息。在「設定 → AI 接口」可以加:

- 雲端服務:OpenAI、Anthropic、Google Gemini、OpenRouter、DeepSeek、Groq、Mistral、xAI(貼 API 金鑰)
- 任何 OpenAI 相容的網址:Ollama、LM Studio、vLLM、自架伺服器…
- 已經在用 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的話,可以直接沿用它的登入和模型設定

「設定 → 路由」可以替每項工作分別選主要和備用模型(例如聊天用雲端、整理回報用本地模型)。
**隱私專案**:標記為隱私的專案(或放在隱私資料夾底下的)只會用你指定的模型,內容不會送到其他地方。

## 支援的 agent

自動接上(開工簡報、MCP 工具、自動記錄):**Claude Code、Codex、pi、opencode、Gemini CLI、Qwen Code**;
Cursor、GitHub Copilot CLI、Amp 自動接 MCP;其他 herdr 認得的 agent(共 24 種)可以手動接 MCP、也能被派工。
接上時會修改該 agent 的設定檔,修改前會先備份成 `*.bak-steward-日期`。

## 遠端存取與安全

- 預設只聽本機(`127.0.0.1`),還沒設管理密碼時只有這台電腦能用。
- **Tailscale**:開啟後自動設定 `tailscale serve`,經 HTTPS 連進來;你自己帳號的個人裝置免密碼。
- **區網**:要先設管理密碼,同一個 Wi-Fi 的裝置用密碼登入。
- 網頁終端機和程式碼頁能讀寫你的檔案,請只開放給自己的裝置。

## 開發

```sh
git clone https://github.com/hao-github-0216/agent-steward
cd agent-steward && npm install
# 改完 commit 後部署到本機(跟一般安裝走同一套 install.sh,不會下載 herdr)
sh scripts/deploy.sh
```

程式是 Node.js(TypeScript,直接用 `--experimental-strip-types` 執行,不需要編譯),網頁是單一 HTML。
`herdr` 用的是 [hao-github-0216/herdr](https://github.com/hao-github-0216/herdr),上游 [herdrdev/herdr](https://github.com/herdrdev/herdr) 加上資料夾導覽等修改。

## 授權

[MIT](LICENSE)
