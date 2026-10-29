# 專案管家 iPhone 原生版(SwiftUI)

專案列表、專案狀態、問管家是 iPhone 原生畫面;終端機、程式碼、檔案預覽這些重的工具在「終端機」分頁用管家網頁版。
管家本身還是跑在你的電腦上,app 透過管家的 API(`/api/board`、`/api/chat`…)讀寫。

- 主畫面名稱「專案管家 β」,bundle ID `io.github.haogithub0216.agentsteward.native`(跟 `ios-app/` 的 Tauri 版分開,可以同時裝)
- 身分:透過 Tailscale 的 https 網址連線時管家自動認得;否則用管理密碼登入
- 連結 `agentsteward://project/<專案 id>`、`agentsteward://project/<專案 id>/chat` 直接打開某個專案或它的問管家

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

## 第一版還沒做的

- 數學式($…$)和表格照原文顯示
- 即時更新(`/api/events`):目前是下拉更新、回到 app 時自動更新
- 推播通知、看板拖拉、派工
