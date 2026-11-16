#!/bin/sh
# 從這台 Mac 把 iPhone App(ios-native)上傳到 TestFlight。
# 簽章與上傳都用 Xcode → Settings → Accounts 裡登入的 Apple 開發者帳號,不需要 API 金鑰。
# 用法:sh scripts/ios-testflight.sh          archive 後直接上傳
#       sh scripts/ios-testflight.sh --no-upload  只 archive 並匯出 ipa(不上傳)
# 上傳前要先在 App Store Connect 建好 App 記錄(bundle id io.github.haogithub0216.agentsteward.native)。
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
UPLOAD=1
[ "${1:-}" = "--no-upload" ] && UPLOAD=0

command -v xcodegen >/dev/null || { echo "需要 xcodegen:brew install xcodegen" >&2; exit 1; }
if [ -n "$(git -C "$ROOT" status --porcelain -- ios-native)" ]; then
	echo "ios-native 有沒 commit 的改動,先 commit 再上傳(TestFlight 的版本要對得回 commit)" >&2
	exit 1
fi

# build 號用時間(UTC 年月日時分),每次上傳都會比上一次大
BUILD=$(date -u +%Y%m%d%H%M)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/steward-testflight.XXXXXX")
trap 'rm -rf "$WORK/dd"' EXIT

cd "$ROOT/ios-native"
xcodegen generate --quiet
echo "archive(build ${BUILD},commit $(git -C "$ROOT" rev-parse --short HEAD))…"
xcodebuild archive -project Steward.xcodeproj -scheme Steward -configuration Release \
	-destination 'generic/platform=iOS' -archivePath "$WORK/Steward.xcarchive" \
	-derivedDataPath "$WORK/dd" -allowProvisioningUpdates \
	CURRENT_PROJECT_VERSION="$BUILD" -quiet

# 匯出設定沿用 ExportOptions.plist,只把 destination 換成 upload(直接送到 App Store Connect)或 export
DEST=export
[ "$UPLOAD" = 1 ] && DEST=upload
cp ExportOptions.plist "$WORK/ExportOptions.plist"
/usr/libexec/PlistBuddy -c "Set :destination $DEST" "$WORK/ExportOptions.plist"

echo "$( [ "$UPLOAD" = 1 ] && echo 上傳到 App Store Connect || echo 匯出 ipa )…"
# 匯出要用系統的 rsync;Homebrew 的 rsync 3.x 排在 PATH 前面時,Xcode 會在打包 ipa 時 Copy failed
PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH" xcodebuild -exportArchive -archivePath "$WORK/Steward.xcarchive" \
	-exportOptionsPlist "$WORK/ExportOptions.plist" -exportPath "$WORK/export" \
	-allowProvisioningUpdates -quiet

if [ "$UPLOAD" = 1 ]; then
	echo "已上傳 build ${BUILD}。App Store Connect 處理完(通常 10–30 分鐘)會出現在 TestFlight。"
else
	echo "ipa 在 $WORK/export"
fi
echo "archive 留在 $WORK/Steward.xcarchive(含 dSYM),不需要時可以刪掉。"
