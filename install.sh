#!/bin/sh
# 專案管家(agent-steward)安裝 / 更新程式:macOS、Linux。
#
#   一行安裝: curl -fsSL https://raw.githubusercontent.com/hao-github-0216/agent-steward/main/install.sh | sh
#   更新:     設定頁的「檢查更新」,或再跑一次上面那行
#   移除:     sh ~/.agent-steward/app/uninstall.sh
#
# 選項:
#   --from DIR       用本機的原始碼安裝(開發用;DIR 是 git repo 時用目前的 commit)
#   --version TAG    安裝指定版本(預設:最新 release;還沒有 release 時用 main)
#   --skip-herdr     不安裝/更新 herdr(自己編譯了 herdr 時用)
#   --no-open        裝完不打開瀏覽器
#   --no-service     不設定開機自動啟動(測試用)
#
# 會放東西的地方:~/.agent-steward(程式、設定、資料)、~/.local/bin/steward、
# ~/.config/herdr/plugins-local(herdr 外掛)、開機自動啟動(launchd / systemd --user)。
set -eu

REPO="${STEWARD_REPO:-hao-github-0216/agent-steward}"
ROOT="$HOME/.agent-steward"
APP="$ROOT/app"
BINDIR="$ROOT/bin"
LOCALBIN="$HOME/.local/bin"
FROM=""
VERSION=""
SKIP_HERDR=0
OPEN=1
SERVICE=1
while [ $# -gt 0 ]; do
	case "$1" in
		--from) [ $# -ge 2 ] || { echo "--from 後面要接資料夾" >&2; exit 2; }; FROM="$2"; shift 2 ;;
		--version) [ $# -ge 2 ] || { echo "--version 後面要接版本" >&2; exit 2; }; VERSION="$2"; shift 2 ;;
		--skip-herdr) SKIP_HERDR=1; shift ;;
		--no-open) OPEN=0; shift ;;
		--no-service) SERVICE=0; OPEN=0; shift ;;
		--update) shift ;; # 舊參數,等同直接再跑一次
		*) echo "不認得的參數:$1" >&2; exit 2 ;;
	esac
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m注意:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m錯誤:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "需要 $1"; }
need curl
need tar

OS=$(uname -s)
ARCH=$(uname -m)
case "$OS" in Darwin) PLATFORM=macos ;; Linux) PLATFORM=linux ;; *) die "不支援的系統 $OS(Windows 請用 install.ps1)" ;; esac
case "$ARCH" in arm64|aarch64) ARCH=aarch64 ;; x86_64|amd64) ARCH=x86_64 ;; *) die "不支援的處理器 $ARCH" ;; esac
mkdir -p "$ROOT" "$BINDIR" "$LOCALBIN" "$ROOT/logs"
TMP=$(mktemp -d)
# 結束時(成功或失敗)清掉暫存檔和設定頁「一鍵更新」的鎖
trap 'rm -rf "$TMP" "$ROOT/update.lock"' EXIT

# ---------- 1. Node.js(22.6 以上) ----------
node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)' 2>/dev/null; }
NODE=""
# STEWARD_FORCE_NODE_DOWNLOAD=1:不用這台電腦現有的 Node,一律下載(測試「全新電腦」用,也可以在現有 Node 有問題時用)
[ -n "${STEWARD_FORCE_NODE_DOWNLOAD:-}" ] || for c in "$(command -v node 2>/dev/null || true)" "$LOCALBIN/node" /opt/homebrew/bin/node /usr/local/bin/node "$ROOT/node/bin/node"; do
	if [ -n "$c" ] && [ -x "$c" ] && node_ok "$c"; then NODE="$c"; break; fi
done
if [ -z "$NODE" ]; then
	if [ "$PLATFORM" = macos ] && [ -z "${STEWARD_FORCE_NODE_DOWNLOAD:-}" ] && command -v brew >/dev/null 2>&1; then
		say "安裝 Node.js(Homebrew)"
		brew install node >/dev/null
		NODE=$(brew --prefix)/bin/node
	else
		say "下載 Node.js(放在 $ROOT/node,不需要管理員權限)"
		case "$PLATFORM-$ARCH" in macos-aarch64) NA=darwin-arm64 ;; macos-x86_64) NA=darwin-x64 ;; linux-aarch64) NA=linux-arm64 ;; linux-x86_64) NA=linux-x64 ;; esac
		BASE="https://nodejs.org/dist/latest-v22.x"
		curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/node.sums" || die "連不上 nodejs.org"
		LINE=$(awk -v na="$NA" '$2 ~ "node-v.*-"na".tar.gz$" {print; exit}' "$TMP/node.sums")
		FILE=$(echo "$LINE" | awk '{print $2}'); WANT=$(echo "$LINE" | awk '{print $1}')
		[ -n "$FILE" ] || die "找不到 Node.js 下載檔"
		curl -fsSL "$BASE/$FILE" -o "$TMP/node.tgz"
		GOT=$( (shasum -a 256 "$TMP/node.tgz" 2>/dev/null || sha256sum "$TMP/node.tgz") | awk '{print $1}')
		[ "$WANT" = "$GOT" ] || die "Node.js 檔案驗證失敗(sha256 不符)"
		rm -rf "$ROOT/node" && mkdir -p "$ROOT/node"
		tar -xzf "$TMP/node.tgz" -C "$ROOT/node" --strip-components 1
		NODE="$ROOT/node/bin/node"
	fi
fi
export PATH="$(dirname "$NODE"):$PATH"
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM=$(command -v npm) || die "找不到 npm"
say "Node.js $("$NODE" -v)($NODE)"

# ---------- 2. 專案管家程式 ----------
NEW="$APP.new.$$"
rm -rf "$NEW" && mkdir -p "$NEW"
if [ -n "$FROM" ]; then
	FROM=$(cd "$FROM" && pwd)
	if [ -d "$FROM/.git" ]; then
		say "從本機原始碼安裝($FROM 目前的 commit)"
		git -C "$FROM" archive HEAD | tar -x -C "$NEW"
		git -C "$FROM" rev-parse --short HEAD > "$NEW/REVISION"
	else
		say "從本機資料夾安裝($FROM)"
		(cd "$FROM" && tar -cf - --exclude node_modules --exclude .git .) | tar -x -C "$NEW"
		echo "local-$(date +%Y%m%d%H%M)" > "$NEW/REVISION"
	fi
else
	if [ -z "$VERSION" ]; then
		VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1 || true)
	fi
	if [ -n "$VERSION" ]; then URL="https://codeload.github.com/$REPO/tar.gz/refs/tags/$VERSION"; else VERSION=main; URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/main"; fi
	say "下載專案管家 $VERSION"
	curl -fsSL "$URL" -o "$TMP/app.tgz" || die "下載失敗:$URL"
	tar -xzf "$TMP/app.tgz" -C "$NEW" --strip-components 1
	echo "$VERSION" > "$NEW/REVISION"
fi
say "安裝相依套件"
(cd "$NEW" && "$NPM" ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error --update-notifier=false >/dev/null) || die "安裝相依套件失敗"
chmod +x "$NEW/bin/"*.mjs 2>/dev/null || true
# 原子替換:舊版留一份 app.prev(出問題時可以換回去)
if [ -d "$APP" ]; then rm -rf "$APP.prev"; mv "$APP" "$APP.prev"; fi
mv "$NEW" "$APP"
say "已安裝到 $APP($(cat "$APP/REVISION"))"

# ---------- 3. herdr(專案管家用的版本,含資料夾導覽等修改) ----------
HERDR="$LOCALBIN/herdr"
if [ "$SKIP_HERDR" = 0 ]; then
	HREPO=$("$NODE" -e 'console.log(require(process.argv[1]).repo)' "$APP/herdr.json")
	HTAG=$("$NODE" -e 'console.log(require(process.argv[1]).tag)' "$APP/herdr.json")
	if [ "$(cat "$BINDIR/herdr.tag" 2>/dev/null || true)" != "$HTAG" ]; then
		ASSET="herdr-$PLATFORM-$ARCH"
		say "下載 herdr $HTAG($ASSET)"
		if curl -fsSL "https://github.com/$HREPO/releases/download/$HTAG/$ASSET" -o "$TMP/herdr" && curl -fsSL "https://github.com/$HREPO/releases/download/$HTAG/$ASSET.sha256" -o "$TMP/herdr.sha256"; then
			WANT=$(awk '{print $1}' "$TMP/herdr.sha256")
			GOT=$( (shasum -a 256 "$TMP/herdr" 2>/dev/null || sha256sum "$TMP/herdr") | awk '{print $1}')
			[ "$WANT" = "$GOT" ] || die "herdr 檔案驗證失敗(sha256 不符)"
			chmod +x "$TMP/herdr" && mv "$TMP/herdr" "$BINDIR/herdr" && echo "$HTAG" > "$BINDIR/herdr.tag"
		else
			warn "下載 herdr 失敗:終端機、自動記錄、派工會先無法使用(之後再跑一次安裝即可)"
		fi
	fi
	# ~/.local/bin/herdr:原本沒有才建立(不覆蓋使用者自己裝的 herdr)
	if [ -x "$BINDIR/herdr" ] && [ ! -e "$HERDR" ]; then ln -s "$BINDIR/herdr" "$HERDR"; fi
fi
[ -x "$HERDR" ] || HERDR="$BINDIR/herdr"

# ---------- 4. ttyd(網頁終端機) ----------
TTYD=$(command -v ttyd 2>/dev/null || true)
for c in /opt/homebrew/bin/ttyd /usr/local/bin/ttyd "$BINDIR/ttyd"; do [ -z "$TTYD" ] && [ -x "$c" ] && TTYD="$c"; done
if [ -z "$TTYD" ]; then
	if [ "$PLATFORM" = macos ] && command -v brew >/dev/null 2>&1; then
		say "安裝 ttyd(Homebrew)"; brew install ttyd >/dev/null && TTYD=$(brew --prefix)/bin/ttyd
	elif [ "$PLATFORM" = linux ]; then
		say "下載 ttyd"
		curl -fsSL "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.$( [ "$ARCH" = aarch64 ] && echo aarch64 || echo x86_64)" -o "$BINDIR/ttyd" && chmod +x "$BINDIR/ttyd" && TTYD="$BINDIR/ttyd"
	fi
	[ -n "$TTYD" ] || warn "沒有 ttyd:網頁終端機先無法使用(其他功能照常),裝完最後會說明怎麼補上"
fi

# ---------- 5. steward 指令 ----------
if [ -L "$LOCALBIN/steward" ] || [ -f "$LOCALBIN/steward" ]; then rm -f "$LOCALBIN/steward"; fi
cat > "$LOCALBIN/steward" <<EOF
#!/bin/sh
exec "$NODE" "$APP/bin/steward.mjs" "\$@"
EOF
chmod +x "$LOCALBIN/steward"
case ":$PATH:" in *":$LOCALBIN:"*) ;; *) warn "$LOCALBIN 不在 PATH 裡:要用 steward 指令請把它加進 shell 設定(例如 ~/.zshrc)" ;; esac

# ---------- 6. herdr 外掛(資料夾導覽 popup、agents 只顯示目前 space) ----------
PLUG="${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins-local"
mkdir -p "$PLUG"
for d in "$APP"/herdr-plugins/*/; do
	name=$(basename "$d")
	# 原地覆蓋檔案,不要先刪資料夾:herdr 看到資料夾消失會把外掛註銷
	mkdir -p "$PLUG/$name"
	for f in "$d"*; do
		[ "$(basename "$f")" = herdr-plugin.toml ] && continue
		cp -R "$f" "$PLUG/$name/"
	done
	# 外掛用的 node 寫成絕對路徑(herdr 啟動外掛時不一定有使用者的 PATH);manifest 最後寫,一次換掉
	sed "s#\"node\"#\"$NODE\"#g" "$d/herdr-plugin.toml" > "$PLUG/$name/herdr-plugin.toml.tmp" && mv "$PLUG/$name/herdr-plugin.toml.tmp" "$PLUG/$name/herdr-plugin.toml"
	if [ -x "$HERDR" ]; then
		"$HERDR" plugin link "$PLUG/$name" >/dev/null 2>&1 || warn "herdr 外掛 $name 沒有接上(herdr 還沒啟動過?之後再跑一次安裝即可)"
	fi
done

# 資料夾導覽的快捷鍵(prefix+e)與 herdr 選單項目;herdr 正在跑的話讓它重新讀設定
"$NODE" --experimental-strip-types --no-warnings "$APP/src/herdr-setup.ts" || warn "設定 herdr 的資料夾導覽失敗"
[ -x "$HERDR" ] && "$HERDR" server reload-config >/dev/null 2>&1 || true

# ---------- 7. 已經接上專案管家的 agent:更新路徑(新的 agent 在設定頁「Agent」接上) ----------
STEWARD_APP_DIR="$APP" "$NODE" --experimental-strip-types --no-warnings "$APP/src/refresh-agents.ts" || warn "更新 agent 整合失敗"

ttyd_note() {
	if [ -z "$TTYD" ]; then
		echo
		if [ "$PLATFORM" = macos ]; then
			warn "網頁終端機需要 ttyd,而 macOS 上的 ttyd 要用 Homebrew 安裝。要用網頁終端機的話:"
			echo '    1. 安裝 Homebrew:/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
			echo '    2. 再跑一次專案管家的安裝指令(會自動裝好 ttyd)'
		else
			warn "網頁終端機需要 ttyd,下載失敗了;再跑一次安裝指令即可補上"
		fi
		echo
	fi
}
# ---------- 8. 開機自動啟動 ----------
if [ "$SERVICE" = 0 ]; then say "略過開機自動啟動(--no-service)"; ttyd_note; exit 0; fi
PATHS="$LOCALBIN:$BINDIR:$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [ "$PLATFORM" = macos ]; then
	UID_=$(id -u)
	# 舊版的服務名稱(有個人名字)換成通用名稱
	for old in "$HOME"/Library/LaunchAgents/com.*.agent-steward*.plist; do
		[ -f "$old" ] || continue
		case "$(basename "$old")" in com.agent-steward*) continue ;; esac
		launchctl bootout "gui/$UID_/$(basename "$old" .plist)" 2>/dev/null || true
		rm -f "$old"
		say "移除舊的服務 $(basename "$old" .plist)"
	done
	service() { # label 程式 log 沒改也重啟(1/0)
		plist="$HOME/Library/LaunchAgents/$1.plist"
		cat > "$TMP/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>--experimental-strip-types</string><string>--no-warnings</string><string>$2</string></array>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$PATHS</string>
    <key>HOME</key><string>$HOME</string>
    <key>LANG</key><string>${LANG:-en_US.UTF-8}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$ROOT/logs/$3.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/$3.err.log</string>
</dict></plist>
EOF
		if ! cmp -s "$TMP/$1.plist" "$plist" 2>/dev/null; then
			mkdir -p "$(dirname "$plist")"
			mv "$TMP/$1.plist" "$plist"
			launchctl bootout "gui/$UID_/$1" 2>/dev/null || true
			launchctl bootstrap "gui/$UID_" "$plist"
		elif ! launchctl print "gui/$UID_/$1" >/dev/null 2>&1; then
			launchctl bootstrap "gui/$UID_" "$plist"
		elif [ "$4" = 1 ]; then
			launchctl kickstart -k "gui/$UID_/$1" >/dev/null 2>&1
		fi
	}
	service com.agent-steward "$APP/src/main.ts" steward 1
	# 網頁終端機重啟會讓開著的終端機斷線一次:啟動程式有改才重啟
	TCH=0; cmp -s "$APP/src/terminal-runner.ts" "$APP.prev/src/terminal-runner.ts" 2>/dev/null || TCH=1
	if [ -n "$TTYD" ]; then service com.agent-steward.terminal "$APP/src/terminal-runner.ts" terminal $TCH; fi
else
	UNIT="$HOME/.config/systemd/user"
	mkdir -p "$UNIT"
	unit() { # 名稱 程式 log
		cat > "$UNIT/$1.service" <<EOF
[Unit]
Description=$1
[Service]
ExecStart=$NODE --experimental-strip-types --no-warnings $2
WorkingDirectory=$APP
Environment=PATH=$PATHS
Restart=always
RestartSec=10
StandardOutput=append:$ROOT/logs/$3.log
StandardError=append:$ROOT/logs/$3.err.log
[Install]
WantedBy=default.target
EOF
	}
	unit agent-steward "$APP/src/main.ts" steward
	if [ -n "$TTYD" ]; then unit agent-steward-terminal "$APP/src/terminal-runner.ts" terminal; fi
	systemctl --user daemon-reload
	systemctl --user enable --now agent-steward >/dev/null 2>&1 && systemctl --user restart agent-steward
	if [ -n "$TTYD" ]; then systemctl --user enable --now agent-steward-terminal >/dev/null 2>&1 || true; fi
	command -v loginctl >/dev/null 2>&1 && loginctl enable-linger "$(id -un)" 2>/dev/null || true
fi

# ---------- 9. 確認啟動 ----------
PORT=$("$NODE" -e 'try{console.log(require(process.argv[1]).server.port||8791)}catch{console.log(8791)}' "$ROOT/settings.json")
URL="http://127.0.0.1:$PORT/"
i=0
until curl -fsS "$URL"api/health >/dev/null 2>&1; do
	i=$((i + 1)); [ $i -gt 30 ] && die "專案管家沒有啟動起來,看 $ROOT/logs/steward.err.log"
	sleep 1
done
say "專案管家已經在跑:$URL"
ttyd_note
if [ "$OPEN" = 1 ]; then
	if [ "$PLATFORM" = macos ]; then open "$URL"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true; fi
	say "第一次使用:在瀏覽器裡設定管理密碼、AI 接口和要接上的 agent"
fi
