# 專案管家 iPhone 原生版(SwiftUI)

原生畫面:專案列表、專案狀態、工作卡(跨專案看板,核准派工/標完成/卡住/退回)、問管家(含數學式排版、請管家擬工作卡、附圖片(相簿或拍照,最多 4 張)與檔案(專案裡的檔案或 iPhone「檔案」App 的文字檔,最多 10 個))、圈選提問(右下角的圈選鈕:畫面凍結後拉框,用 Vision 讀出框裡的字,文字優先、讀不到才送截圖;解釋/翻譯/找錯/開工作卡/自己問,可接著問)、設定。
終端機(「終端機」分頁)和程式碼(專案頁的「程式碼」)這些重的工具沿用管家網頁(`?app=1` 模式,藏掉網頁自己的專案和模式切換)。
管家有變動時透過 `/api/events` 即時更新。
管家本身還是跑在你的電腦上,app 透過管家的 API(`/api/board`、`/api/chat`…)讀寫。

- 主畫面名稱「專案管家 β」,bundle ID `io.github.haogithub0216.agentsteward.native`(跟 `ios-app/` 的 Tauri 版分開,可以同時裝)
- 身分:透過 Tailscale 的 https 網址連線時管家自動認得;否則用管理密碼登入
- 連結:`agentsteward://project/<專案 id>`、`…/<專案 id>/chat`、`agentsteward://card/<卡片 id>`、`agentsteward://cards/<proposed|running|blocked|done>`

## 建置

需要 Xcode、`brew install xcodegen`。Xcode 專案由 `project.yml` 產生,不放進 git。

```sh
cd ios-native
xcodegen generate
open Steward.xcodeproj     # 用 Xcode 跑;或命令列:

# 模擬器(不用簽名)
xcodebuild -project Steward.xcodeproj -scheme Steward -sdk iphonesimulator -arch arm64 \
  CODE_SIGNING_ALLOWED=NO -derivedDataPath build build

# 真機(接 USB、手機開「開發者模式」)
xcodebuild -project Steward.xcodeproj -scheme Steward -sdk iphoneos -configuration Release \
  -derivedDataPath build -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
xcrun devicectl device install app --device <UDID> build/Build/Products/Release-iphoneos/Steward.app
```

測試小技巧(模擬器):
- 先填好管家網址:`xcrun simctl spawn <UDID> defaults write io.github.haogithub0216.agentsteward.native serverURL https://…/`
- 直接打開某個畫面:`xcrun simctl launch <UDID> io.github.haogithub0216.agentsteward.native -openURL agentsteward://project/<id>/chat`

## 推播通知

管家直接送 Apple Push Notification service(APNs),不經第三方:

1. developer.apple.com → Certificates, IDs & Profiles → Keys → 「+」,勾 Apple Push Notifications service (APNs),下載 `AuthKey_<KEY ID>.p8`(只能下載一次)
2. 放進管家那台電腦的 `~/.agent-steward/apns/`,同一個資料夾加 `config.json`:
   `{"teamId": "<Team ID>", "bundleId": "io.github.haogithub0216.agentsteward.native"}`
3. iPhone app 連上管家後會問推播權限,允許後自動把裝置登記給管家;設定頁可以「傳一則測試通知」

推播的時機:新提案、工作卡卡住、派出去的工作在等你回應、派出去的工作完成(只推 iPhone)、每日提醒。點通知會打開那個專案。

## 還沒做的

- 推播金鑰還沒設定(見上面「推播通知」)
