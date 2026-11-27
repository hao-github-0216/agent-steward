# App Store / Google Play 上架資料

上架時填進 App Store Connect 和 Google Play Console 的文字。改這裡，再複製過去。

## 基本資料

| 欄位 | 內容 |
|---|---|
| App 名稱 | 英文：Agent Steward；繁體中文：專案管家 Agent Steward |
| Bundle ID | io.github.haogithub0216.agentsteward.native |
| 主要類別 | 開發者工具（Developer Tools） |
| 次要類別 | 生產力工具（Productivity） |
| 年齡分級 | 4+（問卷全部選「無」） |
| 價格 | 免費，沒有 App 內購買 |
| 上架地區 | 174 個國家或地區，排除中國大陸（上架中國大陸需要 ICP 備案） |
| 版權 | 2026 Agent Steward contributors |
| 發佈方式 | 審查通過後手動發佈 |
| 隱私權政策網址 | https://github.com/hao-github-0216/agent-steward/blob/main/docs/privacy.md（英文：privacy.en.md） |
| 支援網址 | https://github.com/hao-github-0216/agent-steward/blob/main/docs/support.md（英文：support.en.md） |
| 原始碼 | https://github.com/hao-github-0216/agent-steward |

## 繁體中文

**副標題**（30 字內）：AI agent 的工作看板，隨身帶著

**宣傳文字**（170 字內，可以隨時改）：
在手機上看電腦裡每個 AI agent 做到哪、核准它們的提案，工作卡住或完成時馬上收到通知。通知內容端對端加密。

**描述**：
專案管家把你電腦上各個 AI coding agent 的工作整理成一個看板。這個 App 讓你離開電腦時也能跟上進度。

看板
• 提案、已核准、進行中、卡住、完成五欄，每張工作卡是一件交給 agent 的事
• 核准提案就會派工；卡住的卡可以看原因、重新派工或追問 agent

問管家
• 用自然語言問「這個專案做到哪了」「為什麼卡住」，管家依照專案的紀錄回答
• 可以附照片、引用程式碼片段，或直接把回答整理成新的工作卡
• 隨時點浮動的貓咪就能問：iPad 上是浮在畫面上的視窗，可以拖著移動、調整大小，開著時後面照樣能操作；iPhone 上是從底下升起的面板，高度可以調
• 回答裡的數學式會排成公式；比較複雜的式子（例如 \underbrace、含中文的式子）改用 KaTeX 排版，跟網頁版顯示的一樣

程式碼
• 瀏覽專案檔案、搜尋、看和編輯程式碼，預覽 Markdown（數學式用 KaTeX）、PDF、圖片和 Notebook
• 看 Git 狀態、差異和歷史，寫 commit

終端機
• 在手機上看電腦裡的終端機和每個 agent 的窗格，下方有方向鍵、Ctrl、Esc 等按鍵列
• 點終端機只會點選，不會跳出鍵盤，要打字時再按 ⌨；按住再拖曳可以選取並複製文字
• 一個按鈕就能關閉分頁，關之前會先請你確認

Apple Watch
• 在手錶上看各專案的進度和工作卡，核准提案、重新派工，也可以用聽寫問管家
• 錶面小工具顯示卡住和提案的數量；通知上的按鈕在手錶上也能按
• 需要配對的 iPhone

通知
• 有新提案、工作卡卡住、工作完成或 agent 在等你回應時通知你，點通知直接打開那個專案
• 通知內容在你的電腦上加密，只有你的手機解得開

需要什麼
• 這個 App 要連到你自己電腦上的專案管家（開源、免費），請先照 github.com/hao-github-0216/agent-steward 的說明安裝
• 建議用 Tailscale 讓手機連到電腦
• 沒有電腦也可以按「先看示範」，用範例資料看看各個畫面

不收集任何個人資料，沒有廣告和追蹤。

**關鍵字**（100 字元內，逗號分隔）：AI,agent,看板,工作卡,程式碼,Git,開發者,Claude,Codex,Tailscale,通知,專案管理,終端機,Apple Watch,KaTeX,數學式

## English

**Subtitle** (30 characters max): AI agent board, on the go

**Promotional text** (170 characters max):
See what every AI agent on your computer is doing, approve their proposals, and get notified the moment work is blocked or done. Notifications are end-to-end encrypted.

**Description**:
Agent Steward turns the work of the AI coding agents on your computer into one board. This app keeps you up to date when you're away from your desk.

Board
• Five columns (Proposed, Approved, In progress, Blocked, Done), where each card is a task handed to an agent
• Approving a proposal dispatches it; for a blocked card you can read why, redispatch it, or ask the agent a follow-up

Ask the steward
• Ask in plain language ("How far along is this project?" "Why is this stuck?") and the steward answers from the project's records
• Attach photos, quote code, or turn an answer into a new card
• Tap the floating cat to ask from any screen. On iPad it opens a floating window you can move and resize while you keep working behind it; on iPhone it's a panel that slides up to the height you choose
• Math in answers is typeset as formulas. Harder expressions (such as \underbrace or formulas with Chinese text) are rendered with KaTeX, so they look the same as in the web version

Code
• Browse, search, read, and edit project files; preview Markdown (with KaTeX math), PDF, images, and notebooks
• See Git status, diffs, and history, and write commits

Terminal
• See your computer's terminal and each agent's pane, with a key bar for arrows, Ctrl, Esc, and more
• Tapping the terminal selects without popping up the keyboard; tap ⌨ when you want to type. Touch and hold, then drag to select and copy text
• Close a tab with one button, after a confirmation

Apple Watch
• Check each project's progress and cards, approve proposals, redispatch blocked work, or ask the steward by dictation
• Complications show how many cards are blocked or proposed, and notification buttons work on the watch too
• Requires a paired iPhone

Notifications
• Get notified about new proposals, blocked cards, finished work, or an agent waiting for you; tap to open that project
• Notifications are encrypted on your computer and only your phone can decrypt them

Requirements
• The app connects to Agent Steward running on your own computer (open source and free). Install it first by following github.com/hao-github-0216/agent-steward
• Tailscale is recommended for connecting your phone to your computer
• No computer yet? Tap "Try the demo" to see every screen with sample data

No personal data is collected. No ads, no tracking.

**Keywords** (100 characters max): AI,agent,kanban,coding,Git,developer,Claude,Codex,Tailscale,notifications,terminal,watch,KaTeX,math

## 給 App 審查員的說明（App Review Information → Notes）

This app is the mobile client for Agent Steward, an open-source tool that users run on their own computer (https://github.com/hao-github-0216/agent-steward). The app has no server of its own: users connect it to their own steward, usually over Tailscale.

To review the app without installing anything, tap "先看示範" (Try the demo) on the first screen. Demo mode runs entirely offline with built-in sample data and covers the board, card details, the steward chat, the code browser, and Git. Screens that exist only in the desktop web version (the terminal) show an explanation in demo mode.

The floating cat button opens the steward chat on every screen: a movable, resizable floating window on iPad and a height-adjustable panel on iPhone. Math in chat answers is typeset on device; expressions the native renderer cannot handle are rendered with KaTeX, loaded from cdn.jsdelivr.net, and shown as plain text until it loads. The terminal (outside demo mode) is the steward's own web terminal: tapping it does not open the keyboard, touch-and-hold then drag copies text, and closing a tab asks for confirmation first.

Apple Watch: the watch app needs the paired iPhone and has no connection of its own. With the iPhone in demo mode, the watch shows the same sample data, so you can review the project list, progress, cards, approval buttons, and suggested questions without a steward.

Push notifications: the user's own computer encrypts each notification with a key generated on the device, then sends it through our push relay (a Cloudflare Worker, source in relay/ of the repository) to APNs. The notification service extension decrypts it on the device. The relay cannot read notification content.

Encryption: the app uses AES-GCM only to protect the user's own notification content (exempt under category 5D992 / mass-market; ITSAppUsesNonExemptEncryption = NO).

No sign-in is required in demo mode. A real connection requires the user's own steward address.

## App 隱私問卷（App Store Connect → App Privacy）

- **Do you or your third-party partners collect data from this app?** → No（不收集）
  - 理由：資料只在使用者自己的手機和電腦之間傳送，開發者收不到。推播中繼只轉送加密內容與推播代碼，不儲存、不連結到使用者身分，屬於「僅為傳送通知而短暫處理」，不算收集。
- **Tracking** → No

## Google Play 資料安全表單（Data safety）

- 是否收集或分享使用者資料：否
- 傳輸中的資料是否加密：是（連到管家用 HTTPS；通知內容另外端對端加密）
- 使用者能否要求刪除資料：不適用（沒有收集）

## 截圖

用示範模式的 UI 測試自動產生：中文用 ios-native/StewardUITests/DemoTests.swift，英文用 EnglishTests.swift（截圖名稱 01-board、02-card…，en- 開頭是英文）。目前上傳的是英文 6 張（看板、卡片、問管家、程式碼、Git、設定），Apple 會套用到所有語言與尺寸：
- iPhone：App Store Connect 預設區塊是 6.3 吋（1206 × 2622），用 iPhone Pro 模擬器拍，或把 Pro Max 的 1320 × 2868 等比例縮成 1206 × 2622。
- iPad 13 吋：iPad Pro 13 吋模擬器，2064 × 2752。
