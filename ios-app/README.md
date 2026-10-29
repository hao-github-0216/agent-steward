# 專案管家 iPhone app

用 [Tauri 2](https://v2.tauri.app/)(Rust)包成的 iPhone app。管家本身還是跑在你的電腦上,app 連過去顯示管家的網頁,
跟用 Safari 開一樣,但有自己的圖示、全螢幕、不會被 Safari 分頁洗掉。

- 第一次打開:填管家網址(建議用電腦的專案管家「設定 → 遠端存取」裡的 Tailscale https 網址)
- 之後打開:先確認連得上,連得上直接進管家;連不上回到填網址的畫面
- 連線中的畫面可以按「更換管家網址」

## 需要的東西(只在要建置的那台 Mac 上)

- Xcode(App Store),並在 Xcode → Settings → Accounts 加入你的 Apple ID
  - 免費 Apple ID:裝到自己手機上可以用,但每 7 天要重新安裝一次
  - Apple 開發者帳號(一年 99 美元):可以長期使用、用 TestFlight 給別人裝
- Xcode 的 iOS 平台:`xcodebuild -downloadPlatform iOS`
- Rust:`curl https://sh.rustup.rs -sSf | sh`,再 `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`
- `brew install xcodegen cocoapods`

## 建置

```sh
cd ios-app
npm install
npm run ios:init      # 第一次:產生 src-tauri/gen/apple 的 Xcode 專案
npm run ios:dev       # 裝到接著 USB 的 iPhone 或模擬器上,邊改邊看
npm run ios:build     # 正式建置
```

Xcode 不是預設的開發工具時(`xcode-select -p` 顯示 CommandLineTools),指令前面加
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`。

改 app 圖示:換掉 `app-icon.svg`,再跑 `npm run icons`(會重產 `src-tauri/icons`)。
