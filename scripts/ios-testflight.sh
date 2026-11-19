#!/bin/sh
# 從這台 Mac 把 iPhone App(ios-native)上傳到 TestFlight。
# 用法:sh scripts/ios-testflight.sh          archive 後直接上傳
#       sh scripts/ios-testflight.sh --no-upload  只 archive 並匯出 ipa(不上傳)
# 上傳前要先在 App Store Connect 建好 App 記錄(bundle id io.github.haogithub0216.agentsteward.native)。
#
# 簽章與上傳的身分(擇一):
#   1. App Store Connect API 金鑰(角色要 Admin,才能用雲端代管的發佈憑證)。
#      在 ~/.agent-steward/testflight.env(或 STEWARD_TESTFLIGHT_ENV 指定的檔案)寫:
#        ASC_KEY_ID=<Key ID>
#        ASC_ISSUER_ID=<Issuer ID>
#      .p8 放在登入鑰匙圈:service agent-steward-asc-api、account AuthKey_<Key ID>,內容是 base64;
#      或用 ASC_KEY_PATH=<.p8 路徑> 直接指定檔案。
#   2. 沒有設定金鑰時，用 Xcode → Settings → Accounts 裡登入的 Apple 開發者帳號。
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
UPLOAD=1
[ "${1:-}" = "--no-upload" ] && UPLOAD=0

ENV_FILE=${STEWARD_TESTFLIGHT_ENV:-$HOME/.agent-steward/testflight.env}
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
ASC_KEY_ID=${ASC_KEY_ID:-}
ASC_ISSUER_ID=${ASC_ISSUER_ID:-}
ASC_KEY_PATH=${ASC_KEY_PATH:-}
ASC_KEYCHAIN_SERVICE=${ASC_KEYCHAIN_SERVICE:-agent-steward-asc-api}

command -v xcodegen >/dev/null || { echo "需要 xcodegen:brew install xcodegen" >&2; exit 1; }
if [ -n "$(git -C "$ROOT" status --porcelain -- ios-native)" ]; then
	echo "ios-native 有沒 commit 的改動,先 commit 再上傳(TestFlight 的版本要對得回 commit)" >&2
	exit 1
fi

# build 號用時間(UTC 年月日時分),每次上傳都會比上一次大
BUILD=$(date -u +%Y%m%d%H%M)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/steward-testflight.XXXXXX")
trap 'rm -rf "$WORK/dd" "$WORK/key"' EXIT

# 有 API 金鑰就用金鑰簽章、上傳;金鑰只寫成權限 600 的暫存檔，結束時刪掉
AUTH=""
if [ -n "$ASC_KEY_ID" ]; then
	[ -n "$ASC_ISSUER_ID" ] || { echo "有 ASC_KEY_ID 但沒有 ASC_ISSUER_ID($ENV_FILE)" >&2; exit 1; }
	if [ -z "$ASC_KEY_PATH" ]; then
		mkdir -m 700 "$WORK/key"
		ASC_KEY_PATH="$WORK/key/AuthKey_${ASC_KEY_ID}.p8"
		( umask 077
		  security find-generic-password -s "$ASC_KEYCHAIN_SERVICE" -a "AuthKey_${ASC_KEY_ID}" -w | base64 -D > "$ASC_KEY_PATH" ) || {
			echo "鑰匙圈找不到 API 金鑰(service $ASC_KEYCHAIN_SERVICE、account AuthKey_${ASC_KEY_ID})" >&2; exit 1; }
	fi
	[ -s "$ASC_KEY_PATH" ] || { echo "API 金鑰檔是空的或不存在:$ASC_KEY_PATH" >&2; exit 1; }
	AUTH="-authenticationKeyPath $ASC_KEY_PATH -authenticationKeyID $ASC_KEY_ID -authenticationKeyIssuerID $ASC_ISSUER_ID"
	echo "用 App Store Connect API 金鑰 ${ASC_KEY_ID} 簽章、上傳"
else
	echo "沒有設定 API 金鑰，用 Xcode 帳號登入簽章、上傳"
fi

cd "$ROOT/ios-native"
xcodegen generate --quiet
echo "archive(build ${BUILD},commit $(git -C "$ROOT" rev-parse --short HEAD))…"
xcodebuild archive -project Steward.xcodeproj -scheme Steward -configuration Release \
	-destination 'generic/platform=iOS' -archivePath "$WORK/Steward.xcarchive" \
	-derivedDataPath "$WORK/dd" -allowProvisioningUpdates $AUTH \
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
	-allowProvisioningUpdates $AUTH -quiet

if [ "$UPLOAD" = 1 ]; then
	echo "已上傳 build ${BUILD}。App Store Connect 處理完(通常 10–30 分鐘)會出現在 TestFlight。"
else
	echo "ipa 在 $WORK/export"
fi
echo "archive 留在 $WORK/Steward.xcarchive(含 dSYM),不需要時可以刪掉。"
