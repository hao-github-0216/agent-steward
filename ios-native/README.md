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

- 主畫面名稱「專案管家」,bundle ID `io.github.haogithub0216.agentsteward.native`(跟 `ios-app/` 的 Tauri 版分開)
- iPhone 和 iPad 都能用(iPad 上分頁列在頂端、看板一次看得到好幾欄、可以分割畫面)
- 顏色用 iOS 系統顏色(深淺色由系統處理),強調色是網頁的藍;文字跟著 iPhone 的文字大小設定
- 身分:透過 Tailscale 的 https 網址連線時管家自動認得;否則用管理密碼登入

## 語言

App 支援繁體中文與 English，預設跟著系統的第一個偏好語言：任何中文變體（`zh-*`，包括簡體中文）都顯示原有的繁體中文，其他語言顯示英文。也可以到 iOS「設定 → 專案管家 → 語言」為這個 App 單獨切換，不需要在 App 裡另設語言。

示範模式的專案、工作卡、對話、檔案與 Git 訊息也會使用對應語言。使用者自己的資料和管家回傳的內容不會被翻譯；嵌入的管家網頁仍使用管家自己的語言設定。

新增介面字串時，請寫進 `Steward/Localizable.xcstrings` 並填好英文。SwiftUI 的 `Text`、`Button` 等可直接使用字面值；需要 `String` 的地方使用 `String(localized: "…", bundle: AppLanguage.bundle)`。Info.plist 的顯示名稱、權限說明與類型描述放在 `Steward/InfoPlist.xcstrings`。不能翻譯的協定值，需在行尾加上 `// i18n-ok: 原因`。

`LocalizationTests` 會檢查編譯後的中英文 key、英文是否殘留中文字，以及插值參數的數量和型別；靜態檢查會擋下沒有本地化、也沒有豁免理由的中文字面值。`EnglishTests` 會以英文示範模式走過看板、卡片、問管家、程式碼、Git、八個設定分頁與網址畫面，逐頁檢查文字並保留截圖。

## 網頁版和 iPhone 版對照

| 網頁版 | iPhone 版 | 元件 |
|---|---|---|
| 標題列「專案管家 ▸」開專案欄 | 導覽列標題是目前專案(隱私專案下面多一行「隱私專案」),點了出選單:直接點專案換過去(打勾的是目前的、有鎖的是隱私專案),「所有專案…」打開完整的專案清單;名字太長系統會縮短,右邊按鈕放不下會收進「⋯」,不會互相蓋住 | 系統導覽列的標題選單 + 清單 |
| 看板 / 程式碼 / 終端機 三個模式 | 底部分頁列,同樣三個、同樣順序 | 系統分頁列 |
| 專案欄:＋建立專案、整理 spaces、專案、其他、要登記成專案嗎?、已收起、已停止追蹤、「⋯」(在終端機開啟/在程式碼模式開啟/改名/停止追蹤) | 專案清單:同樣的分組和按鈕名稱;「⋯」的動作改成長按或左滑;「＋」建立專案、整理 spaces | 系統清單、長按選單、左滑 |
| 看板:顯示所有專案的工作卡、收起看板、五欄、點卡片開視窗、拖拉換欄 | 「⋯」選單裡兩個開關;五欄像「提醒事項」的欄位左右滑;點卡片開視窗;長按選動作或拖到別欄 | 系統清單、長按選單 |
| 專案說明(目標、目前進度/補建、下一步、卡住的地方、重要決定、最近的工作、herdr space、隱私專案、拆出子資料夾) | 同樣內容,清單分段;隱私專案是系統開關;拆出子資料夾是原生清單(每個子資料夾一個「拆成專案」,也可以輸入完整路徑) | 系統清單 |
| 工作卡視窗(核准派工/不要、重新派工/標成完成、重做一次、在終端機看這個窗格、追問) | 同樣的按鈕和規則;追問:完成/卡住的卡在下面的輸入框接著問做這張卡的 agent(同一個窗格,窗格關了就開新的 agent 帶著紀錄),進行中的先排隊(可以取消);卡片裡排成一串對話:原本的結果、你的問題、agent 的完整回覆(Markdown);送出後卡片回到進行中,回答完回到完成並推播;看板卡片上標出追問次數 | 系統視窗、像「訊息」的輸入列 |
| 浮動球(貓)→ 問管家面板(清除紀錄、建議問題、引用、＋檔案/＋圖片/目前檔案、開工作卡、改用備用模型) | 同樣的功能;對話是 iMessage 式泡泡,開工作卡在右上,清除紀錄在「⋯」(會先確認),附件在輸入框左邊「＋」 | 系統視窗、iMessage 式 |
| 圈選鈕(貓旁邊)、Alt+S | 同一個位置、只有這一顆,三個分頁都用 app 自己的圈選(系統視窗):圈到那一塊的截圖一律附給管家看,讀到的字一起送;看板用 iPhone 的文字辨識;程式碼頁打開檔案時,辨識出的字會對回檔案的原文和行號(「檔名 第 a–b 行」);終端機直接拿圈到的終端機原文;終端機圈的管家會認出是哪個 agent 窗格,可以「交給這個 agent」(貼進它的輸入框,不按 Enter) | 原生 |
| 程式碼:檔案(瀏覽、搜尋、新增/改名/刪除、Git 標記、顯示 . 開頭的檔案)、⇪ 上傳(檔案、整個資料夾、拖進檔案樹,同名問覆蓋/略過) | 原生:「找檔名」在「檔案|版本控制」下面(搜整個專案);系統清單一層層點進資料夾;右上「＋」:新檔案、新資料夾、上傳(從「檔案」挑檔案、上傳整個資料夾、從照片、拍照;照片轉 JPEG、影片轉 H.264)、顯示 . 開頭的檔案;iPad 可以把檔案從「檔案」app 拖進清單;同名檔案問覆蓋/略過/之後全部…(覆蓋時舊檔先移到電腦的垃圾桶);長按資料夾:上傳到這個資料夾、在這裡新增檔案/資料夾;長按/左滑:問管家這個檔案、重新命名、複製路徑、移到垃圾桶 | 原生 |
| 程式碼:編輯器(存檔、衝突、檔案被改自動重新載入、尋找、右鍵問管家/建立工作卡)、預覽、Office 歷史版本、大檔載入更多 | 原生:程式碼/文字用原生檢視(行號,長行不折、手指左右拖看右邊)和編輯(存檔衝突會問、iPad 鍵盤 ⌘S 存檔、⌘F 尋找);沒在編輯時電腦上的檔案被改(agent 改檔)會自動重新載入,被刪掉會提示;「⋯ → 在檔案中尋找」;點行號選行(再點另一個行號選範圍)→ 問管家 / 開工作卡(管家擬草稿)/ 複製;Markdown 預覽跟網頁一樣排版(同樣用 marked + DOMPurify、同一套樣式:表格、圖片、HTML、清單、核取方塊;數學式用 KaTeX;字型跟著系統文字大小、深淺色跟系統;專案裡的圖片經 app 讀、連到專案裡別的檔案就打開它、外面的連結用 Safari;排版程式跟網頁一樣從 cdn.jsdelivr.net 載,載不到時退回簡單預覽)、Notebook 預覽/原文;圖片用系統的縮放(雙指在手指的位置放大、雙擊放大/還原,最小縮到寬度塞滿畫面)、PDF 用 PDFKit(最小只能縮到最寬的那一頁塞滿寬度,轉向、拖格子會跟著調)、Word/Excel/PowerPoint 用 Quick Look 和「歷史版本」(預覽、還原);很大的檔案「載入更多」;看檔案(程式碼、Markdown/Notebook 預覽、圖片、PDF)時點一下畫面全螢幕:導覽列、分頁列、動作列、浮動球、管家側欄、狀態列都收起來(iPad 分割時是目前這一格佔滿整個畫面,點別格的第一下只是換格子),再點一下或按 Esc 回來;編輯、選行、尋找時不會切換 | 原生 |
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
  - 登入後的版面測試(`IPadChromeTests.testLoginThenPDFHasNoChromeGap`、`IPhoneChromeTests.testLoginThenPDFHasNoGap`)只接 `http://127.0.0.1:18799` 的隔離管家，而且那個管家要設好管理密碼：給 `TEST_RUNNER_STEWARD_TEST_PASSWORD`(密碼)、`TEST_RUNNER_STEWARD_PDF_PROJECT`(專案 id)、`TEST_RUNNER_STEWARD_PDF_FILE`、`TEST_RUNNER_STEWARD_PDF_FILE_2`(專案裡的兩個 PDF)。測試開始前會把同一個密碼再設一次，讓所有登入失效，App 才會停在登入畫面。不要對真的管家跑，那會讓你所有裝置都要重新登入
- 注意:切到終端機、在終端機換專案會讓 herdr 跳到那個專案的 space(跟網頁一樣),電腦上的 herdr 畫面也會跟著換

## TestFlight

**目前用的方式：從這台 Mac 上傳。** 在 repo 根目錄執行 `sh scripts/ios-testflight.sh`，它會 archive 並直接上傳到 App Store Connect，簽章和上傳都用 Xcode → Settings → Accounts 裡登入的開發者帳號，不需要 API 金鑰。加 `--no-upload` 只匯出 ipa。build 號用上傳當下的 UTC 時間（年月日時分），每次都會比上一次大。

下面的 GitHub Actions 流程要用 **Admin 角色**的 App Store Connect API 金鑰（Apple 代管發佈憑證需要 Admin），目前的金鑰是開發者角色，所以先不用。


在 GitHub 開啟 **Actions → iOS App → Run workflow**，填入要建置的 `ref`（分支、tag 或 commit，預設 `main`）。`upload` 預設為 `true`，會在單元測試、archive 和 IPA 匯出成功後上傳到 TestFlight；取消勾選則只建置、封存和匯出，不上傳。這個 workflow 只接受手動觸發，push 不會執行。

需要下列三個 GitHub Actions repository secrets，桌面 App 已經使用同一組，不需要另外新增憑證：

| Secret | 內容 |
|---|---|
| `APPLE_API_KEY` | App Store Connect API Key ID |
| `APPLE_API_ISSUER` | App Store Connect API Issuer ID |
| `APPLE_API_KEY_P8` | API 金鑰的 `.p8` 全文 |

API 金鑰在 App Store Connect 的角色必須是 **Admin**，Xcode 才能使用雲端管理的發佈憑證（cloud-managed distribution certificate）。CI 透過 API 金鑰與 Xcode 自動簽章，不匯入發佈憑證，也不另設鑰匙圈；暫存的 `.p8` 權限為 `600`，job 結束時會清除。任何一個 secret 缺少時，第一個步驟就會失敗，僅列出缺少的名稱。

第一次上傳前，先在 App Store Connect 建立 App 記錄，bundle ID 選 **`io.github.haogithub0216.agentsteward.native`**。

build 號以這個 workflow 的 `github.run_number + 100` 計算，例如第 1 次執行為 `101`。archive 時用 `xcodebuild CURRENT_PROJECT_VERSION=…` 覆寫，App 與通知擴充會使用同一個 build 號；不會改寫 `project.yml`。版本號沿用 `project.yml` 的 `MARKETING_VERSION`。重新執行同一次 run 不會增加 build 號；若該 build 已上傳，請重新按 **Run workflow** 建立新的 run。

成功匯出後，IPA 與 archive 裡的 dSYMs 會保存在該次執行的 `ios-<run_number>` artifact，保留 **14 天**；即使取消勾選 `upload`，仍可下載。

## 示範模式

第一次打開 App 時，在管家網址欄下方點「先看示範」，不用安裝電腦版，也不用連到管家。這個模式供 App Store 審查與功能展示使用，可以查看看板、工作卡、問管家、程式碼、Markdown 預覽與 Git 狀態。

- 專案、工作卡、檔案、對話和路徑全部是虛構範例。送出問題只會得到固定的示範回答；核准、追問、存檔、提交等動作不會真的執行，也不會改動範例資料。
- 不會要求推播權限或註冊推播。終端機、設定網頁、建立專案與完整網頁版會改顯示說明，不載入管家網頁。Markdown 預覽仍可從 CDN 載入排版程式。
- App 會記住示範狀態，重開後仍在示範模式。畫面底部橫幅的「離開」會回到網址畫面，還原進入前的管家網址，不會自動連線。
- 示範 API 固定使用 `https://demo.agentsteward.invalid/`，由 App 內的 URLProtocol 回覆；其他網址的請求不受影響。

UI 測試與截圖可用啟動參數 `-demo YES` 直接進入示範模式：

```sh
xcrun simctl launch <UDID> io.github.haogithub0216.agentsteward.native -demo YES
xcodebuild -project Steward.xcodeproj -scheme Steward \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  -only-testing:StewardTests -only-testing:StewardUITests/DemoTests test
```

`StewardUITests/DemoTests.swift` 會依序操作主要畫面，並將 `01-board`、`02-card` 等英文名稱的截圖保留在測試結果中。可以用 `xcrun xcresulttool export attachments --path <結果.xcresult> --output-path <輸出資料夾>` 匯出截圖。測試結束後，請只移除模擬器中的測試 App 和測試 runner，清除測試資料，不要刪除模擬器。

## Apple Watch

iPhone App 內含 Apple Watch App（watchOS 10 以上），需要配對的 iPhone，不能獨立連到管家。手錶只透過 WatchConnectivity 請 iPhone 代為呼叫既有 API，不會儲存管家網址、登入資訊或密碼。第一次使用前，請先在 iPhone 上連到管家；iPhone 的示範模式也能提供示範快照。

- **看進度：** 專案清單顯示卡住與提案數、最後更新時間。專案頁可以查看目標、進度、最多三個下一步和卡點。
- **看工作卡與核准：** 每個專案最多顯示十五張提案、卡住或進行中的卡片。提案可以核准派工或退回；卡住的工作可以重新派工或標成完成。每次操作都會先請你確認。
- **問管家：** 可以點建議問題，或使用系統聽寫、鍵盤輸入問題，並查看最近五則對話。回答超過 25 秒時會先顯示等待訊息，iPhone 收到答案後再傳到手錶；也可以按「重新整理」讀取最近對話。程式碼區塊會提示改在 iPhone 上看。
- **iPhone 不在附近：** 仍可查看最後快照，但重新整理、提問與工作卡操作會停用，並顯示「iPhone 不在附近」。快照不是即時狀態，操作前請留意更新時間。
- **隱私專案：** 手錶只顯示「隱私專案」與各欄工作卡數，不傳送原始名稱、目標、進度、下一步、卡點或工作卡內容，也不能從手錶提問或操作這些卡片。
- **錶面小工具：** 圓形顯示卡住數，矩形與單行顯示卡住、提案數；矩形最多再顯示一個非隱私專案名稱。點擊即可開啟手錶 App。小工具和手錶 App 透過 App Group 共用快照，沒有快照時顯示「專案管家」。

手錶介面支援繁體中文與英文。建置與 UI 測試方式：

```sh
cd ios-native
xcodegen generate
xcodebuild -scheme StewardWatch \
  -destination 'platform=watchOS Simulator,name=Apple Watch Series 12 (46mm)' \
  test CODE_SIGNING_ALLOWED=NO
```

`StewardWatchUITests` 使用只編進 DEBUG 的 `-watchFixture YES` 假資料，不需要連到管家。測試會以繁中與英文各走一次專案清單、進度、工作卡、核准按鈕和建議問題，並保留 `watch-01-projects` 到 `watch-05-ask` 五張截圖。測試結束後，只移除模擬器裡的 App 與測試 runner，不刪除模擬器。

## 推播通知

- 提案通知可直接按「核准派工」或「不要」；卡住的工作可按「重新派工」或「標成完成」。只有通知附有有效類別與工作卡資訊時才顯示按鈕。
- 所有按鈕都要先解鎖才能執行，會在背景送給目前設定的管家，不會打開 App；成功不另通知，失敗會顯示原因，點失敗通知可開啟原本的專案。示範模式不執行通知操作。
- Apple Watch 會跟著 iPhone 的通知設定顯示通知和按鈕，也需要先解鎖；實際顯示位置由系統依裝置狀態決定。

推播預設經過推播中繼(`relay/`,規格見 `relay/PROTOCOL.md`):App 第一次允許通知時自己產生加密金鑰交給管家,管家把通知加密後交給中繼,中繼轉給 APNs,通知服務擴充(`StewardNotify/`)解密後顯示。中繼和 Apple 都看不到內容。

自己編 App(換了 bundle id 或 Team)的人,中繼送不到你的 App,要改成管家直接送:developer.apple.com → Keys → 「+」勾 Apple Push Notifications service,下載 `AuthKey_<KEY ID>.p8`,放進管家電腦的 `~/.agent-steward/apns/`,同資料夾加 `config.json`:`{"teamId": "<Team ID>", "bundleId": "<你的 bundle id>"}`。有這個資料夾時管家就不經過中繼。

## 還沒做的

- SwiftMath 不支援的數學指令(例如 `\underbrace`)照原文顯示
