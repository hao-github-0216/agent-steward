#!/usr/bin/env bash
#
# 把 Mac 的 Developer ID 簽章憑證與 App Store Connect API 金鑰設成 GitHub Actions secrets。
#
# 會設定五個 secrets：
#   APPLE_CERTIFICATE           base64 編碼的 PKCS#12 憑證
#   APPLE_CERTIFICATE_PASSWORD  該憑證檔的密碼
#   APPLE_API_KEY               App Store Connect Key ID（從 .p8 檔名取）
#   APPLE_API_ISSUER            Issuer ID
#   APPLE_API_KEY_P8            .p8 檔內容
#
# 整支腳本不會把金鑰、密碼、憑證內容印到畫面或寫進任何檔案之外的地方；
# 暫存檔都放在 umask 077 的暫時資料夾，結束時用 rm -P 覆寫後刪除。
#
# 用法：
#   bash desktop/scripts/set-macos-signing-secrets.sh \
#     --p8 <AuthKey_XXXXXXXXXX.p8 路徑> --issuer <Issuer ID> \
#     [--repo owner/name] [--keychain <鑰匙圈路徑>] [--p12 <憑證檔路徑>] [--dry-run]
#
# 沒有 --p12 時，從鑰匙圈找 Developer ID Application 身分，匯出後重新打包成只含這一組的
# PKCS#12。給 --p12 時（帳號持有人在其他台電腦建立的憑證檔），直接用那個檔案。

set -euo pipefail
umask 077

usage() {
	cat <<'USAGE'
用法：
  bash desktop/scripts/set-macos-signing-secrets.sh --p8 <AuthKey_XXXXXXXXXX.p8> --issuer <Issuer ID> [選項]

必要參數：
  --p8 <路徑>        App Store Connect API 金鑰，檔名必須是 AuthKey_<10 碼 Key ID>.p8
  --issuer <ID>      App Store Connect Issuer ID（UUID 格式）

選用參數：
  --repo <owner/name>  預設從 git remote origin 解析
  --keychain <路徑>    要匯出身分的鑰匙圈，預設是 login 鑰匙圈
  --p12 <路徑>         改用現成的 PKCS#12 憑證檔，跳過鑰匙圈匯出
  --dry-run            只檢查並列出 secret 名稱與位元組數，不會真的設定
  -h, --help           顯示這個說明

範例：
  bash desktop/scripts/set-macos-signing-secrets.sh \
    --p8 ~/private/AuthKey_ABCDEFGHIJ.p8 \
    --issuer 12345678-1234-1234-1234-1234567890ab \
    --repo hao-github-0216/agent-steward --dry-run
USAGE
}

die() {
	printf '錯誤：%s\n' "$1" >&2
	printf '腳本未做任何變更。\n' >&2
	exit 1
}

note() {
	printf '%s\n' "$1"
}

WORK_DIR=""
SCRATCH_KEYCHAIN=""
SAVED_KEYCHAINS=()

cleanup() {
	local rc=$?
	trap - EXIT
	if [ -n "$SCRATCH_KEYCHAIN" ]; then
		security delete-keychain "$SCRATCH_KEYCHAIN" >/dev/null 2>&1 || true
	fi
	restore_keychain_search_list || true
	if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
		# 加 -f：鑰匙圈的鎖定檔是唯讀的，沒有 -f 時 rm 會在終端機上停下來問要不要刪
		find "$WORK_DIR" -type f -exec rm -Pf {} + >/dev/null 2>&1 </dev/null || true
		rm -rf "$WORK_DIR" >/dev/null 2>&1 || true
	fi
	exit $rc
}
trap cleanup EXIT

# create-keychain 會把新鑰匙圈加進搜尋清單，結束前要還原成開始前的樣子。
save_keychain_search_list() {
	SAVED_KEYCHAINS=()
	local line
	while IFS= read -r line; do
		line=${line#"${line%%[![:space:]]*}"}
		line=${line#\"}
		line=${line%\"}
		[ -n "$line" ] && SAVED_KEYCHAINS+=("$line")
	done < <(security list-keychains -d user 2>/dev/null || true)
}

restore_keychain_search_list() {
	[ ${#SAVED_KEYCHAINS[@]} -gt 0 ] || return 0
	security list-keychains -d user -s ${SAVED_KEYCHAINS[@]+"${SAVED_KEYCHAINS[@]}"} >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------- 參數
P8_FILE=""
ISSUER=""
REPO=""
KEYCHAIN=""
P12_FILE=""
DRY_RUN=0

while [ $# -gt 0 ]; do
	case "$1" in
		--p8)
			[ $# -ge 2 ] && [ -n "$2" ] || die "--p8 需要帶檔案路徑"
			P8_FILE="$2"
			shift 2
			;;
		--issuer)
			[ $# -ge 2 ] && [ -n "$2" ] || die "--issuer 需要帶 Issuer ID"
			ISSUER="$2"
			shift 2
			;;
		--repo)
			[ $# -ge 2 ] && [ -n "$2" ] || die "--repo 需要帶 owner/name"
			REPO="$2"
			shift 2
			;;
		--keychain)
			[ $# -ge 2 ] && [ -n "$2" ] || die "--keychain 需要帶鑰匙圈路徑"
			KEYCHAIN="$2"
			shift 2
			;;
		--p12)
			[ $# -ge 2 ] && [ -n "$2" ] || die "--p12 需要帶憑證檔路徑"
			P12_FILE="$2"
			shift 2
			;;
		--dry-run)
			DRY_RUN=1
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			die "未知參數：$1（用 --help 看說明）"
			;;
	esac
done

[ -n "$P8_FILE" ] || {
	usage >&2
	die "缺少 --p8"
}
[ -n "$ISSUER" ] || {
	usage >&2
	die "缺少 --issuer"
}
if [ -n "$P12_FILE" ] && [ -n "$KEYCHAIN" ]; then
	die "--p12 與 --keychain 只能選一個：--p12 已經指定憑證檔，不需要再從鑰匙圈匯出"
fi

for tool in security openssl gh git; do
	command -v "$tool" >/dev/null 2>&1 || die "找不到 $tool 指令"
done

# ---------------------------------------------------------------- 檢查 .p8 與 issuer
[ -f "$P8_FILE" ] && [ -r "$P8_FILE" ] || die "讀不到 .p8 檔案：$P8_FILE"

P8_BASENAME=$(basename -- "$P8_FILE")
if ! printf '%s\n' "$P8_BASENAME" | grep -Eq '^AuthKey_[A-Z0-9]{10}\.p8$'; then
	die ".p8 檔名必須是 AuthKey_<10 碼大寫英數>.p8，目前檔名不符合（只看檔名，沒讀內容）"
fi
KEY_ID=$(printf '%s\n' "$P8_BASENAME" | sed -E 's/^AuthKey_([A-Z0-9]{10})\.p8$/\1/')

first_line=$(head -n 1 "$P8_FILE" | tr -d '\r')
if [ "$first_line" != "-----BEGIN PRIVATE KEY-----" ]; then
	die "$P8_FILE 看起來不是 PKCS#8 格式的私密金鑰（第一行不對）"
fi
unset first_line

if ! printf '%s\n' "$ISSUER" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'; then
	die "Issuer ID 必須是 UUID 格式，例如 12345678-1234-1234-1234-1234567890ab"
fi

if [ -n "$P12_FILE" ]; then
	[ -f "$P12_FILE" ] && [ -r "$P12_FILE" ] || die "讀不到憑證檔：$P12_FILE"
fi

# ---------------------------------------------------------------- 檢查 gh 與 repo
gh auth status >/dev/null 2>&1 || die "gh 尚未登入或 token 已失效，請先執行 gh auth login"

if [ -z "$REPO" ]; then
	remote_url=$(git remote get-url origin 2>/dev/null) ||
		die "找不到 git remote origin，請用 --repo 指定 owner/name"
	REPO=$(printf '%s\n' "$remote_url" |
		sed -E -e 's#^(git@[^:]+:|https?://[^/]+/|ssh://git@[^/]+/)##' -e 's#\.git$##' -e 's#/*$##')
	printf '%s\n' "$REPO" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' ||
		die "無法從 git remote 解析出 owner/name，請用 --repo 指定"
fi
printf '%s\n' "$REPO" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' ||
	die "--repo 必須是 owner/name 格式，目前是 $REPO"

# ---------------------------------------------------------------- 暫存區與鑰匙圈清單
WORK_DIR=$(mktemp -d)
[ -d "$WORK_DIR" ] || die "無法建立暫時資料夾"
chmod 700 "$WORK_DIR"
save_keychain_search_list

# 系統 LibreSSL 預設就用 3DES/SHA1；Homebrew 的 OpenSSL 3/4 要明確指定傳統演算法，
# macOS 的 security import 才讀得懂我們重新打包的 PKCS#12。
OPENSSL_FLAVOUR="libressl"
case "$(openssl version 2>/dev/null || true)" in
"OpenSSL 3."* | "OpenSSL 4."*) OPENSSL_FLAVOUR="modern" ;;
esac

# ---------------------------------------------------------------- 找 Developer ID 身分
# 不用 -v：自簽或未被信任的身分也會列出來；受信任的身分會在「Matching」和「Valid」兩段各出現一次，所以要去重。輸出格式是
#   1) <SHA1> "Developer ID Application: 名稱 (TEAMID)" (CSSMERR_TP_NOT_TRUSTED)
developer_id_names() {
	security find-identity -p codesigning "$1" 2>/dev/null |
		sed -nE 's/^[[:space:]]*[0-9]+\)[[:space:]]+[^"]*"(.*)".*/\1/p' |
		grep -E '^Developer ID Application:' | sort -u || true
}

line_count() {
	if [ -s "$1" ]; then
		wc -l <"$1" | tr -d '[:space:]'
	else
		printf '0'
	fi
}

# ---------------------------------------------------------------- 暫存鑰匙圈驗證
# 把 PKCS#12 匯進全新的暫存鑰匙圈，確認裡面剛好一個 Developer ID Application 身分。
# 回傳該身分名稱（身分名稱不是秘密，可以印）。
verify_p12_has_single_developer_id() {
	local p12="$1"
	local password="$2"
	local kc="$WORK_DIR/verify.keychain-db"
	local kpass
	kpass=$(openssl rand -hex 24)

	security create-keychain -p "$kpass" "$kc" >/dev/null 2>&1 ||
		die "無法建立暫存鑰匙圈做驗證"
	SCRATCH_KEYCHAIN="$kc"
	restore_keychain_search_list
	security unlock-keychain -p "$kpass" "$kc" >/dev/null 2>&1 ||
		die "無法解鎖暫存鑰匙圈"
	security import "$p12" -k "$kc" -P "$password" \
		-T /usr/bin/security -T /usr/bin/codesign >/dev/null 2>&1 ||
		die "macOS 讀不了這個憑證檔：密碼不對，或是用新式演算法打包的 PKCS#12。自己用 openssl 做的話，請加 -legacy 重做一份；Keychain Access 匯出的檔案可以直接用。CI 的 security import 也要讀這個檔案，所以這個檢查不能省"
	security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$kpass" "$kc" >/dev/null 2>&1 || true

	local names_file="$WORK_DIR/verify-names.txt"
	developer_id_names "$kc" >"$names_file"
	local count
	count=$(line_count "$names_file")
	if [ "$count" = "0" ]; then
		die "憑證檔裡找不到 Developer ID Application: 開頭的身分；簽章與公證需要 Developer ID Application 憑證，Apple Development 憑證不夠用"
	fi
	if [ "$count" != "1" ]; then
		die "憑證檔裡有 $count 個 Developer ID Application 身分，需要剛好一個"
	fi
	head -n 1 "$names_file"
}

# ---------------------------------------------------------------- 讀 PKCS#12 內容
# macOS security export 做出來的 PKCS#12 用 RC2 等傳統演算法，新 OpenSSL 要加 -legacy
# 才讀得懂，所以先試一般讀法，失敗再試 -legacy。任何一種失敗都不印出 openssl 的訊息。
p12_to_pem() {
	local in="$1" passfile="$2" what="$3" out="$4"
	local mode=()
	case "$what" in
		certs) mode=(-nokeys) ;;
		keys) mode=(-nocerts -nodes) ;;
		*) die "內部錯誤：未知的 pkcs12 讀取模式" ;;
	esac
	if ! openssl pkcs12 -in "$in" -passin "file:$passfile" ${mode[@]+"${mode[@]}"} \
		-out "$out" >/dev/null 2>&1; then
		openssl pkcs12 -in "$in" -passin "file:$passfile" -legacy ${mode[@]+"${mode[@]}"} \
			-out "$out" >/dev/null 2>&1 ||
			die "讀不了 PKCS#12 內容（密碼不對，或格式不支援）"
	fi
}

# 把 PEM 裡的憑證或私密金鑰拆成一個檔案一個項目。
split_pem() {
	local in="$1" outdir="$2" kind="$3"
	awk -v outdir="$outdir" -v kind="$kind" '
		/^-----BEGIN CERTIFICATE-----[[:space:]]*$/ && kind == "cert" { if (f != "") close(f); f = sprintf("%s/cert%d.pem", outdir, ++n) }
		/^-----BEGIN [A-Z0-9 -]*PRIVATE KEY-----[[:space:]]*$/ && kind == "key" { if (f != "") close(f); f = sprintf("%s/key%d.pem", outdir, ++n) }
		/^-----END / { if (f != "") { print > f; close(f); f = "" } next }
		f != "" { print > f }
	' "$in"
}

# 取出憑證的 CN。-nameopt multiline 在系統的 LibreSSL 與 Homebrew OpenSSL 都輸出
# 「    commonName = <值>」一行，用這個取 CN 最穩定。
certificate_cn() {
	openssl x509 -in "$1" -noout -subject -nameopt multiline 2>/dev/null |
		awk '
			/^[[:space:]]*commonName[[:space:]]*=/ {
				sub(/^[[:space:]]*commonName[[:space:]]*=[[:space:]]*/, "")
				sub(/[[:space:]]*$/, "")
				gsub(/^"|"$/, "")
				print
				exit
			}
		' || true
}

public_key_of_cert() {
	openssl x509 -in "$1" -noout -pubkey 2>/dev/null
}

public_key_of_key() {
	openssl pkey -in "$1" -pubout 2>/dev/null
}

# ---------------------------------------------------------------- 取得要上傳的憑證檔
CERT_P12=""      # 要 base64 上傳的 PKCS#12 檔案
CERT_PASSWORD="" # 該 PKCS#12 的密碼
IDENTITY_NAME=""

if [ -n "$P12_FILE" ]; then
	# 使用者直接給憑證檔：跳過鑰匙圈匯出與重新打包。
	note "使用現成的憑證檔，不會碰鑰匙圈。"
	if [ -n "${STEWARD_P12_PASSWORD:-}" ]; then
		CERT_PASSWORD="$STEWARD_P12_PASSWORD"
	else
		printf '憑證檔密碼：' >&2
		read -r -s CERT_PASSWORD </dev/tty
		printf '\n' >&2
	fi
	[ -n "$CERT_PASSWORD" ] || die "憑證檔密碼不能是空的"
	if [ ${#CERT_PASSWORD} -gt 1024 ]; then
		die "讀到的密碼長度不合理，請改用 STEWARD_P12_PASSWORD"
	fi
	CERT_P12="$P12_FILE"
	IDENTITY_NAME=$(verify_p12_has_single_developer_id "$CERT_P12" "$CERT_PASSWORD")
	note "憑證檔裡的身分：$IDENTITY_NAME"
else
	# 從鑰匙圈匯出：先確認剛好一個 Developer ID Application 身分。
	[ -n "$KEYCHAIN" ] || KEYCHAIN=$(security default-keychain -d user 2>/dev/null |
		sed -e 's/^[[:space:]]*//' -e 's/^"//' -e 's/"$//' || true)
	[ -n "$KEYCHAIN" ] || die "找不到 login 鑰匙圈，請用 --keychain 指定路徑"
	[ -f "$KEYCHAIN" ] || [ -e "$KEYCHAIN" ] || die "鑰匙圈不存在：$KEYCHAIN"

	note "搜尋鑰匙圈裡的 Developer ID Application 身分：$KEYCHAIN"
	names_file="$WORK_DIR/identities.txt"
	developer_id_names "$KEYCHAIN" >"$names_file"
	identity_count=$(line_count "$names_file")
	if [ "$identity_count" = "0" ]; then
		die "這個鑰匙圈裡沒有 Developer ID Application: 開頭的身分。請先在 Xcode 建立 Developer ID Application 憑證，或改用 --p12 直接指定現成的憑證檔"
	fi
	if [ "$identity_count" != "1" ]; then
		die "這個鑰匙圈裡有 $identity_count 個 Developer ID Application 身分，需要剛好一個；請先移除不要的那幾個，或改用 --p12 指定要用的憑證檔"
	fi
	IDENTITY_NAME=$(head -n 1 "$names_file")
	note "找到身分：$IDENTITY_NAME"

	CERT_PASSWORD=$(openssl rand -hex 24)
	printf '%s' "$CERT_PASSWORD" >"$WORK_DIR/pass.txt"

	note "鑰匙圈有多個身分，會全部匯出後只留下這個 Developer ID 身分；在 login 鑰匙圈上 macOS 可能會跳視窗請你按「允許」。"
	security export -k "$KEYCHAIN" -t identities -f pkcs12 -P "$CERT_PASSWORD" \
		-o "$WORK_DIR/all.p12" >/dev/null 2>&1 ||
		die "無法從鑰匙圈匯出身分。請確認鑰匙圈已解鎖，並在跳出的視窗按「允許」；也可以改用 --p12 直接指定憑證檔"
	[ -s "$WORK_DIR/all.p12" ] || die "從鑰匙圈匯出的結果是空的"

	p12_to_pem "$WORK_DIR/all.p12" "$WORK_DIR/pass.txt" certs "$WORK_DIR/certs.pem"
	p12_to_pem "$WORK_DIR/all.p12" "$WORK_DIR/pass.txt" keys "$WORK_DIR/keys.pem"
	mkdir -p "$WORK_DIR/certs" "$WORK_DIR/keys"
	split_pem "$WORK_DIR/certs.pem" "$WORK_DIR/certs" cert
	split_pem "$WORK_DIR/keys.pem" "$WORK_DIR/keys" key

	match_cert=""
	match_key=""
	for cert in "$WORK_DIR"/certs/cert*.pem; do
		[ -f "$cert" ] || continue
		cn=$(certificate_cn "$cert")
		[ "$cn" = "$IDENTITY_NAME" ] || continue
		cert_pub="$WORK_DIR/cert-pub.pem"
		if ! public_key_of_cert "$cert" >"$cert_pub" 2>/dev/null || [ ! -s "$cert_pub" ]; then
			continue
		fi
		for key in "$WORK_DIR"/keys/key*.pem; do
			[ -f "$key" ] || continue
			key_pub="$WORK_DIR/key-pub.pem"
			if ! public_key_of_key "$key" >"$key_pub" 2>/dev/null || [ ! -s "$key_pub" ]; then
				continue
			fi
			if cmp -s "$cert_pub" "$key_pub"; then
				if [ -n "$match_cert" ]; then
					die "在匯出的內容裡找到好幾組符合 $IDENTITY_NAME 的憑證與私密金鑰，無法決定要哪一組"
				fi
				match_cert="$cert"
				match_key="$key"
			fi
		done
	done
	[ -n "$match_cert" ] || die "匯出的內容裡找不到與 $IDENTITY_NAME 相符的憑證與私密金鑰"

	# 重新打包成只含這一組憑證與私密金鑰的 PKCS#12。
	if [ "$OPENSSL_FLAVOUR" = "modern" ]; then
		openssl pkcs12 -export -in "$match_cert" -inkey "$match_key" \
			-out "$WORK_DIR/devid.p12" -passout "file:$WORK_DIR/pass.txt" \
			-keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 >/dev/null 2>&1 ||
			die "重新打包憑證失敗"
	else
		openssl pkcs12 -export -in "$match_cert" -inkey "$match_key" \
			-out "$WORK_DIR/devid.p12" -passout "file:$WORK_DIR/pass.txt" >/dev/null 2>&1 ||
			die "重新打包憑證失敗"
	fi
	[ -s "$WORK_DIR/devid.p12" ] || die "重新打包出來的憑證檔是空的"
	CERT_P12="$WORK_DIR/devid.p12"

	# 確認 macOS 的 security import 讀得懂，而且裡面的確只有這一個身分。
	IDENTITY_NAME=$(verify_p12_has_single_developer_id "$CERT_P12" "$CERT_PASSWORD")
	note "重新打包完成，暫存鑰匙圈裡只看到這一個身分：$IDENTITY_NAME"
fi

# ---------------------------------------------------------------- 準備五個值
openssl base64 -A -in "$CERT_P12" -out "$WORK_DIR/certificate.b64" >/dev/null 2>&1 ||
	die "無法把憑證檔轉成 base64"
[ -s "$WORK_DIR/certificate.b64" ] || die "base64 結果是空的"
printf '%s' "$CERT_PASSWORD" >"$WORK_DIR/password.txt"
printf '%s' "$KEY_ID" >"$WORK_DIR/api-key.txt"
printf '%s' "$ISSUER" >"$WORK_DIR/api-issuer.txt"

SECRET_NAMES=(APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_P8)
SECRET_FILES=("$WORK_DIR/certificate.b64" "$WORK_DIR/password.txt" "$WORK_DIR/api-key.txt"
	"$WORK_DIR/api-issuer.txt" "$P8_FILE")
# 只有 APPLE_CERTIFICATE_PASSWORD 的內容是秘密，其他四個名稱對應的值可以讓使用者核對。
SECRET_LABELS=("PKCS#12 憑證的 base64" "憑證檔密碼" "API Key ID" "Issuer ID" ".p8 檔內容")

byte_count() {
	wc -c <"$1" | tr -d '[:space:]'
}

# ---------------------------------------------------------------- 設定 secrets
if [ "$DRY_RUN" = "1" ]; then
	note ""
	note "[dry-run] 不會執行 gh secret set。要設定的 secrets："
	i=0
	while [ $i -lt ${#SECRET_NAMES[@]} ]; do
		printf '  %-28s %8s bytes  (%s)\n' "${SECRET_NAMES[$i]}" "$(byte_count "${SECRET_FILES[$i]}")" "${SECRET_LABELS[$i]}"
		i=$((i + 1))
	done
else
	i=0
	while [ $i -lt ${#SECRET_NAMES[@]} ]; do
		gh secret set "${SECRET_NAMES[$i]}" --repo "$REPO" <"${SECRET_FILES[$i]}" >/dev/null 2>&1 ||
			{ printf '錯誤：設定 %s 失敗（前 %d 個已經設好），請確認你對 %s 有設定 secrets 的權限後重跑\n' "${SECRET_NAMES[$i]}" "$i" "$REPO" >&2; exit 1; }
		i=$((i + 1))
	done
	note "已設定 $REPO 的 secrets："
	# gh secret list 的欄位是 NAME 與 UPDATED，只取名稱，而且只列我們設的這五個。
	list_file="$WORK_DIR/secret-list.txt"
	gh secret list --repo "$REPO" >"$list_file" 2>/dev/null || die "gh secret list 失敗"
	i=0
	while [ $i -lt ${#SECRET_NAMES[@]} ]; do
		if awk '{ print $1 }' "$list_file" | grep -Fxq "${SECRET_NAMES[$i]}"; then
			printf '  %s\n' "${SECRET_NAMES[$i]}"
		else
			die "${SECRET_NAMES[$i]} 設定後沒出現在 gh secret list，請手動確認"
		fi
		i=$((i + 1))
	done
fi

note ""
note "提醒：App Store Connect 的 .p8 只能下載一次。請先把它存進密碼管理器，再自行刪掉原檔；"
note "這個腳本不會刪除你的 ${P8_FILE}。"
