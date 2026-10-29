# 專案管家 iPhone 原生版(SwiftUI)

排版跟管家網頁一樣,兩邊用起來是同一個東西:

```
┌ 專案管家 ▸ │ 看板 程式碼 終端機 │ ＋支線 管家 ▸ │ ⚙ ┐   ← 標題列(原生)
│                                                │
│  看板:原生畫面,排法跟網頁看板一樣                │
│  程式碼 / 終端機:管家網頁(只有內容,標題列是原生的) │
│                                     (圈選)(貓) │   ← 右下角浮動球(原生)
└ 程式碼/終端機可以打開下面的管家側欄(原生)      ┘
```

- 主畫面名稱「專案管家 β」,bundle ID `io.github.haogithub0216.agentsteward.native`(跟 `ios-app/` 的 Tauri 版分開)
- 顏色、文字、按鈕、分組都照網頁(`Steward/Theme.swift` 是網頁 `:root` 的顏色,淺色/深色各一組)
- 身分:透過 Tailscale 的 https 網址連線時管家自動認得;否則用管理密碼登入

## 網頁版和 iPhone 版對照

| 網頁版 | iPhone 版 | 怎麼畫的 |
|---|---|---|
| 標題列:專案管家 ▸、看板/程式碼/終端機、＋支線/帶回、管家 ▸、⚙ | 同樣的位置和文字;終端機放不下時改緊湊排法(網頁在手機上也會擠掉 ⚙) | 原生 |
| 專案欄:＋建立專案、整理 spaces、專案(數字 = 提案+卡住)、其他、要登記成專案嗎?、已收起、已停止追蹤、每個專案的「⋯」 | 同樣的分組和按鈕,從左邊滑出 | 原生(建立專案、整理 spaces 打開網頁的對話框) |
| 看板:顯示所有專案的工作卡、規則提示、收起看板、欄位點、五欄、點欄名收合、完成欄只顯示 8 張 | 同樣的排法;手機上每欄 78% 寬左右滑;長按拖到別欄 | 原生 |
| 專案說明:名稱、路徑、herdr space(改名、搬窗格)、目標、目前進度(或補建)、下一步、卡住的地方、重要決定、最近的工作、隱私專案、拆出子資料夾 | 同樣的內容和按鈕 | 原生(拆出子資料夾打開網頁) |
| 工作卡視窗:欄位/編號/agent/專案/第幾次派工、備註、指示、完成標準;提案(不要/核准派工)、卡住(標成完成/重新派工)、完成(重做一次)、在終端機看這個窗格 | 同樣(手機上一樣從下面升起) | 原生 |
| 浮動球(貓):問管家面板「問管家 · 專案」清除紀錄/關閉、對話、建議問題、引用、＋檔案、＋圖片、目前檔案、送出、開工作卡、改用備用模型回答 | 同樣;數學式用 SwiftMath、圖片可以拍照、檔案可以選 iPhone 上的 | 原生 |
| 圈選鈕(貓旁邊) | 同一個位置,只有這一顆:看板用 iPhone 的文字辨識;程式碼/終端機用網頁的圈選(帶行號、分得出 agent 窗格、交給 agent) | 看板原生,其他網頁 |
| 程式碼:檔案、Git、編輯器、預覽、LaTeX、Notebook、Office | 同一個網頁 | 網頁 |
| 終端機:herdr、字體、開支線、帶回主線 | 同一個網頁;開支線/帶回的按鈕在原生標題列 | 網頁 |
| 管家側欄(程式碼/終端機) | 標題列「管家 ▸」打開,在下面 | 原生 |
| 設定 ⚙:一般、AI 接口、路由、Agent、存取、推播、外掛、關於 | 同樣八頁(打開就是網頁那一頁),加上這支 iPhone 的管家網址、iPhone 推播 | 清單原生,內容網頁 |
| 推播:Telegram / Hermes / webhook | 另外加 iPhone 推播(管家直接送 APNs;金鑰還沒設定) | 原生 |
| Alt+S 圈選、⌘/Ctrl+Enter 送出 | 外接鍵盤時網頁畫面裡一樣有效 | — |

### 這次拿掉的重複入口

之前 app 有些功能同時出現兩次(原生一次、裡面的網頁又一次),現在網頁在 app 裡只負責程式碼和終端機本身:

- 圈選:原生浮動鈕 + 網頁浮動球旁的圈選鈕/長按浮動球 → 只剩貓旁邊那一顆
- 問管家:原生頁 + 網頁浮動球 → 只剩原生的貓;網頁編輯器右鍵「問管家」、圈選的「到問管家繼續」「開工作卡」都送到原生的問管家
- 專案狀態/工作卡:原生頁 + 網頁管家側欄 → 只剩原生的(看板、管家側欄)
- 設定:原生分頁 + 網頁 ⚙ → 只剩標題列的 ⚙
- 專案切換:原生「專案」分頁跟終端機同一層 → 改成跟網頁一樣,標題列「專案管家 ▸」打開專案欄,看板/程式碼/終端機都是目前專案的

### 網頁版有、iPhone 版還是開網頁的

建立專案(選資料夾)、整理 spaces、拆出子資料夾、帶回主線的對話框、設定內容、完整網頁版(設定 → 完整網頁版)。

## 跟網頁怎麼溝通

網頁 `?app=1` 進「app 模式」(`web/index.html` 的 `inApp()` / `toApp()`):藏掉標題列、專案欄、看板、浮動球、側欄、工作卡視窗;
透過 `window.webkit.messageHandlers.steward` 告訴 app:

| 訊息 | 什麼時候 |
|---|---|
| `ready` | 網頁載好了(app 再對一次模式和專案) |
| `project` | 網頁裡換了專案(herdr 自己切了 space、圈選) |
| `chat` / `draft` | 打開問管家(帶引用)/ 請管家擬工作卡 |
| `termState` | 終端機能不能開支線、是不是停在支線上 |
| `needSpace` | 這個專案還沒有 herdr space |
| `settingsClosed` / `dialogClosed` | 設定、對話框關掉了 |

app 叫網頁:`setMode('board'|'code'|'term')`、`selectProject(id,'app')`、`snapStart()`、`openBranchHere(here)`、`enterTerminal({create:true})`。
看板時網頁也切回看板(藏著),在看板換專案才不會讓 herdr 跳過去。

## 建置

需要 Xcode、`brew install xcodegen`。Xcode 專案由 `project.yml` 產生,不放進 git。

```sh
cd ios-native
xcodegen generate
# 模擬器(不用簽名)
xcodebuild -project Steward.xcodeproj -scheme Steward -sdk iphonesimulator -arch arm64 \
  CODE_SIGNING_ALLOWED=NO -derivedDataPath build build
# 真機(接 USB、手機開「開發者模式」)
xcodebuild -project Steward.xcodeproj -scheme Steward -sdk iphoneos -configuration Release \
  -derivedDataPath build -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
xcrun devicectl device install app --device <UDID> build/Build/Products/Release-iphoneos/Steward.app
```

模擬器測試:
- 先填好管家網址:`xcrun simctl spawn <UDID> defaults write io.github.haogithub0216.agentsteward.native serverURL https://…/`
- 直接打開某個畫面:`xcrun simctl launch <UDID> io.github.haogithub0216.agentsteward.native -noPush YES -openURL agentsteward://…`
  - `project/<id>`(看板)、`project/<id>/chat|code|terminal`、`card/<id>`、`cards/<欄位>`、`nav`(專案欄)、`snap`(圈選)
  - `-noPush YES`:不問推播權限(截圖用)
- 注意:切到終端機、在終端機換專案會讓 herdr 跳到那個專案的 space(跟網頁一樣),電腦上的 herdr 畫面也會跟著換

## 推播通知

管家直接送 APNs:developer.apple.com → Keys → 「+」勾 Apple Push Notifications service,下載 `AuthKey_<KEY ID>.p8`,
放進管家電腦的 `~/.agent-steward/apns/`,同資料夾加 `config.json`:`{"teamId": "<Team ID>", "bundleId": "io.github.haogithub0216.agentsteward.native"}`。

## 還沒做的

- iPhone 推播的金鑰(上面)
- SwiftMath 不支援的數學指令(例如 `\underbrace`)照原文顯示
