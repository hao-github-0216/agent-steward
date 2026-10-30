# 專案管家 iPhone 原生版(SwiftUI)

**結構、名稱、規則跟管家網頁一樣;元件和操作用 Apple 的。** 換裝置時知道東西在哪,手機上用起來像 Apple 的 app。

```
┌ agent-steward ⌄          ⋯  ⚙ ┐  ← 系統導覽列:標題是目前專案,點了出選單換專案(在三個模式上一層)
│                               │
│  看板:系統清單 + 提醒事項式欄位 │
│  程式碼 / 終端機:管家網頁內容   │
│                      (圈選)(貓) │  ← 貓咪浮動球(問管家)和唯一的圈選鈕
└ 看板 · 程式碼 · 終端機        ┘  ← 系統分頁列(跟網頁三個模式同順序)
```

- 主畫面名稱「專案管家 β」,bundle ID `io.github.haogithub0216.agentsteward.native`(跟 `ios-app/` 的 Tauri 版分開)
- iPhone 和 iPad 都能用(iPad 上分頁列在頂端、看板一次看得到好幾欄、可以分割畫面)
- 顏色用 iOS 系統顏色(深淺色由系統處理),強調色是網頁的藍;文字跟著 iPhone 的文字大小設定
- 身分:透過 Tailscale 的 https 網址連線時管家自動認得;否則用管理密碼登入

## 網頁版和 iPhone 版對照

| 網頁版 | iPhone 版 | 元件 |
|---|---|---|
| 標題列「專案管家 ▸」開專案欄 | 導覽列標題是目前專案(隱私專案下面多一行「隱私專案」),點了出選單:直接點專案換過去(打勾的是目前的、有鎖的是隱私專案),「所有專案…」打開完整的專案清單;名字太長系統會縮短,右邊按鈕放不下會收進「⋯」,不會互相蓋住 | 系統導覽列的標題選單 + 清單 |
| 看板 / 程式碼 / 終端機 三個模式 | 底部分頁列,同樣三個、同樣順序 | 系統分頁列 |
| 專案欄:＋建立專案、整理 spaces、專案、其他、要登記成專案嗎?、已收起、已停止追蹤、「⋯」(在終端機開啟/在程式碼模式開啟/改名/停止追蹤) | 專案清單:同樣的分組和按鈕名稱;「⋯」的動作改成長按或左滑;「＋」建立專案、整理 spaces | 系統清單、長按選單、左滑 |
| 看板:顯示所有專案的工作卡、收起看板、五欄、點卡片開視窗、拖拉換欄 | 「⋯」選單裡兩個開關;五欄像「提醒事項」的欄位左右滑;點卡片開視窗;長按選動作或拖到別欄 | 系統清單、長按選單 |
| 專案說明(目標、目前進度/補建、下一步、卡住的地方、重要決定、最近的工作、herdr space、隱私專案、拆出子資料夾) | 同樣內容,清單分段;隱私專案是系統開關;拆出子資料夾是原生清單(每個子資料夾一個「拆成專案」,也可以輸入完整路徑) | 系統清單 |
| 工作卡視窗(核准派工/不要、重新派工/標成完成、重做一次、在終端機看這個窗格) | 同樣的按鈕和規則 | 系統視窗 |
| 浮動球(貓)→ 問管家面板(清除紀錄、建議問題、引用、＋檔案/＋圖片/目前檔案、開工作卡、改用備用模型) | 同樣的功能;對話是 iMessage 式泡泡,開工作卡在右上,清除紀錄在「⋯」(會先確認),附件在輸入框左邊「＋」 | 系統視窗、iMessage 式 |
| 圈選鈕(貓旁邊)、Alt+S | 同一個位置、只有這一顆,三個分頁都用 app 自己的圈選(系統視窗):看板用 iPhone 的文字辨識;程式碼頁打開檔案時,辨識出的字會對回檔案的原文和行號(「檔名 第 a–b 行」);終端機直接拿圈到的終端機原文;終端機圈的管家會認出是哪個 agent 窗格,可以「交給這個 agent」(貼進它的輸入框,不按 Enter) | 原生 |
| 程式碼:檔案(瀏覽、搜尋、新增/改名/刪除、Git 標記、顯示 . 開頭的檔案)、⇪ 上傳(檔案、整個資料夾、拖進檔案樹,同名問覆蓋/略過) | 原生:「找檔名」在「檔案|版本控制」下面(搜整個專案);系統清單一層層點進資料夾;右上「＋」:新檔案、新資料夾、上傳(從「檔案」挑檔案、上傳整個資料夾、從照片、拍照;照片轉 JPEG、影片轉 H.264)、顯示 . 開頭的檔案;iPad 可以把檔案從「檔案」app 拖進清單;同名檔案問覆蓋/略過/之後全部…(覆蓋時舊檔先移到電腦的垃圾桶);長按資料夾:上傳到這個資料夾、在這裡新增檔案/資料夾;長按/左滑:問管家這個檔案、重新命名、複製路徑、移到垃圾桶 | 原生 |
| 程式碼:編輯器(存檔、衝突、檔案被改自動重新載入、尋找、右鍵問管家/建立工作卡)、預覽、Office 歷史版本、大檔載入更多 | 原生:程式碼/文字用原生檢視(行號,長行不折、手指左右拖看右邊)和編輯(存檔衝突會問、iPad 鍵盤 ⌘S 存檔、⌘F 尋找);沒在編輯時電腦上的檔案被改(agent 改檔)會自動重新載入,被刪掉會提示;「⋯ → 在檔案中尋找」;點行號選行(再點另一個行號選範圍)→ 問管家 / 開工作卡(管家擬草稿)/ 複製;Markdown、Notebook 預覽/原文;圖片用系統的縮放(雙指在手指的位置放大、雙擊放大/還原,最小縮到寬度塞滿畫面)、PDF 用 PDFKit(最小只能縮到最寬的那一頁塞滿寬度,轉向、拖格子會跟著調)、Word/Excel/PowerPoint 用 Quick Look 和「歷史版本」(預覽、還原);很大的檔案「載入更多」;看檔案(程式碼、Markdown/Notebook 預覽、圖片、PDF)時點一下畫面全螢幕:導覽列、分頁列、動作列、浮動球、管家側欄、狀態列都收起來(iPad 分割時是目前這一格佔滿整個畫面,點別格的第一下只是換格子),再點一下或按 Esc 回來;編輯、選行、尋找時不會切換 | 原生 |
| 程式碼:Git(切換/建立分支、拉取/推送/抓取、暫存/取消暫存/捨棄、全部暫存/全部捨棄、提交、AI 提交訊息、差異、提交紀錄) | 原生:同樣的功能;分支選單裡「建立新分支…」;左滑暫存/捨棄、區段標題「全部暫存」「全部捨棄」(捨棄會先確認);差異是綠/紅統一格式 | 原生 |
| 程式碼:分割編輯器(最多 4 欄 × 每欄 3 格、每格有分頁、拖分頁到邊緣分割、版面記住) | 原生(跟網頁一樣能自由排版):**iPad** 左邊側欄(檔案|版本控制,左上角按鈕可收起)+ 右邊分割編輯區;每格有自己的分頁列(未存的有小圓點、關掉前會問;改到一半的內容重開 app 還在;「關閉其他分頁/關閉所有分頁」會留下沒存的)和動作列(預覽/原文、編輯、尋找、⋯);長按分頁或側欄檔案「在右邊打開/在下面打開」,把分頁或側欄檔案拖到某一格的上下左右邊緣就分割(藍色提示)、拖到中間加成分頁;拖分隔線調大小;太窄自動少開幾欄;同一個檔案全場只開一個分頁。版本控制點變更的檔案開成差異分頁。外接鍵盤 ⌘\ 向右分割、⌘W 關分頁、⌘⇧] / ⌘⇧[ 切分頁(跟 Safari 一樣;⌃Tab 有時被 iPadOS 拿去移動鍵盤焦點)。**iPhone 和窄視窗** 一格加上方分頁列。版面每個專案在這台裝置各自記,「⋯ → 帶入網頁版的版面」可以接上電腦網頁版開的檔案(只讀不寫回)。圈選對回圈到的那一格 | 原生 |
| 程式碼:編譯 LaTeX、執行 Notebook、語法上色、用電腦的 Office 編輯 | 檔案右上「⋯ → 在網頁版編輯器打開」 | 網頁 |
| 終端機 | 管家網頁的內容(app 模式);＋支線/帶回、管家側欄的按鈕在導覽列;斷線會自動重連。手機/平板(觸控)下方有按鍵列(參考 Moshi):⌨︎ 固定在左邊(叫出/收起鍵盤),其他鍵左右捲:↑↓←→ ⏎、Esc Tab、Ctrl Alt(點一下只用在下一個鍵、點兩下鎖住)、herdr ▴(上一個/下一個分頁、切換 space、跳到、放大窗格、新分頁)、⇧Tab ⌃C、~ / \| - _、Home End PgUp PgDn;按下去先不送、沒滑動放開才算按,方向鍵按住連續送。點一下終端機 = 滑鼠點一下(選 Claude 的選項、點窗格,不跳鍵盤);左右滑 = herdr 下一個/上一個分頁 | 網頁 |
| 管家側欄 | Apple 的 inspector:iPhone 是疊在程式碼/終端機上面、從底下升起的視窗(預設半個螢幕,往上拖展開;半高時後面還可以操作;點工作卡再疊一層);iPad 是右邊一欄,跟程式碼/終端機並排 | 系統 inspector |
| 設定 ⚙(一般、AI 接口、路由、Agent、存取、推播、外掛、關於) | 同樣八頁(內容是網頁那一頁)+ 這支 iPhone 的管家網址、iPhone 推播 | 系統表單 |
| 建立專案、整理 spaces、帶回主線 | 打開網頁的對話框 | 網頁 |

### 這次拿掉的重複入口

之前 app 有些功能同時出現兩次(原生一次、裡面的網頁又一次),現在網頁在 app 裡只負責程式碼和終端機本身:

- 圈選:原生浮動鈕 + 網頁浮動球旁的圈選鈕/長按浮動球 → 只剩貓旁邊那一顆
- 問管家:原生頁 + 網頁浮動球 → 只剩原生的貓;網頁編輯器右鍵「問管家」、圈選的「到問管家繼續」「開工作卡」都送到原生的問管家
- 專案狀態/工作卡:原生頁 + 網頁管家側欄 → 只剩原生的(看板、管家側欄)
- 設定:原生分頁 + 網頁 ⚙ → 只剩標題列的 ⚙
- 專案切換:原生「專案」分頁跟終端機同一層 → 改成在上一層:導覽列標題是目前專案,點了出選單換專案;看板/程式碼/終端機都是目前專案的

### 網頁版有、iPhone 版還是開網頁的

建立專案(選資料夾)、整理 spaces、帶回主線的對話框、設定內容、完整網頁版(設定 → 完整網頁版)。

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
  - `project/<id>`(看板)、`project/<id>/chat|code|terminal`、`card/<id>`、`cards/<欄位>`、`nav`(專案清單)、`snap`(圈選)、`snap?all=1`(圈整個畫面)
  - 程式碼頁:`project/<id>/code?file=<路徑>`、`?git=1`、`?diff=<路徑>&which=<staged|unstaged|untracked>`
    - 打開檔案時可以再加 `&line=12` 或 `&line=12-20`(選好這幾行並捲過去)、`&find=字`(打開後尋找)、`&snap=1`(打開後圈整個畫面問管家);檔案和差異都開成目前那一格的分頁
  - `split`:目前專案的「拆出子資料夾」
  - 注意:模擬器的 `simctl spawn … defaults write` 寫不進 app 自己的設定;要暫時改設定用啟動參數,例如 `-showHiddenFiles YES`
  - `-noPush YES`:不問推播權限(截圖用)
- 手勢(手指拖動、往上拉視窗)用 UI 測試:`TEST_RUNNER_STEWARD_PROJECT=<專案 id> xcodebuild test -project Steward.xcodeproj -scheme Steward -destination 'id=<模擬器 UDID>'`,截圖用 `xcrun xcresulttool export attachments --path <.xcresult> --output-path <資料夾>` 拿出來(見 `StewardUITests/GestureTests.swift`;只開看板/程式碼頁和管家側欄,不切終端機;程式碼頁的測試用 `-resetCodeLayout YES` 從空的版面開始,有幾個要先建 `ios-native/zz-scratch.txt`(兩行文字)和 `ios-native/zz-mixed.pdf`(三頁,第二頁比較寬)、測完刪掉)
  - 最好接隔離的管家跑(`TEST_RUNNER_STEWARD_TEST_SERVER=http://127.0.0.1:<port>`,專案用那個管家裡登記的 repo 複本):用連結打開專案會把它記成「目前專案」,接真的管家會把你其他裝置的專案也換掉
  - 標題列的測試 `testProjectTitleMenu` 只在隔離的管家跑(會換專案):另外給 `TEST_RUNNER_STEWARD_TITLE_PROJECT`(長名字、隱私的專案 id)、`TEST_RUNNER_STEWARD_TITLE_NAME`(它的名字)、`TEST_RUNNER_STEWARD_TITLE_OTHER`(另一個專案的名字)
- 注意:切到終端機、在終端機換專案會讓 herdr 跳到那個專案的 space(跟網頁一樣),電腦上的 herdr 畫面也會跟著換

## 推播通知

管家直接送 APNs:developer.apple.com → Keys → 「+」勾 Apple Push Notifications service,下載 `AuthKey_<KEY ID>.p8`,
放進管家電腦的 `~/.agent-steward/apns/`,同資料夾加 `config.json`:`{"teamId": "<Team ID>", "bundleId": "io.github.haogithub0216.agentsteward.native"}`。

## 還沒做的

- iPhone 推播的金鑰(上面)
- SwiftMath 不支援的數學指令(例如 `\underbrace`)照原文顯示
