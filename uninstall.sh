#!/bin/sh
# 移除專案管家(macOS / Linux)。
#   sh ~/.agent-steward/app/uninstall.sh           移除程式與服務,保留資料(設定、專案、聊天紀錄)
#   sh ~/.agent-steward/app/uninstall.sh --purge   連資料一起刪掉
# 各 agent 的整合(hook、MCP、AGENTS.md 段落)會先拿掉;herdr 本身不會移除。
set -eu
ROOT="$HOME/.agent-steward"
APP="$ROOT/app"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1
say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

NODE=$(sed -n 's/^exec "\([^"]*\)".*/\1/p' "$HOME/.local/bin/steward" 2>/dev/null || true)
[ -x "${NODE:-}" ] || NODE=$(command -v node || true)

# 1. 先拿掉各 agent 的整合(趁程式還在)
if [ -n "$NODE" ] && [ -f "$APP/src/refresh-agents.ts" ]; then
	say "拿掉各 agent 的專案管家整合"
	STEWARD_APP_DIR="$APP" "$NODE" --experimental-strip-types --no-warnings "$APP/src/refresh-agents.ts" --remove-all || true
fi

# 拿掉 herdr 設定裡的資料夾導覽
if [ -n "$NODE" ] && [ -f "$APP/src/herdr-setup.ts" ]; then
	"$NODE" --experimental-strip-types --no-warnings "$APP/src/herdr-setup.ts" --remove || true
fi

# 2. 停掉服務
if [ "$(uname -s)" = Darwin ]; then
	for l in com.agent-steward com.agent-steward.terminal; do
		launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
		rm -f "$HOME/Library/LaunchAgents/$l.plist"
	done
else
	for u in agent-steward agent-steward-terminal; do
		systemctl --user disable --now "$u" 2>/dev/null || true
		rm -f "$HOME/.config/systemd/user/$u.service"
	done
	systemctl --user daemon-reload 2>/dev/null || true
fi
say "已停止服務"

# 3. 外掛與指令
HERDR=$(command -v herdr || echo "$ROOT/bin/herdr")
for p in local.current-space-agents local.folder-nav; do
	[ -x "$HERDR" ] && "$HERDR" plugin unlink "$p" >/dev/null 2>&1 || true
done
PLUG="${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins-local"; rm -rf "$PLUG/current-space-agents" "$PLUG/folder-nav"
rm -f "$HOME/.local/bin/steward"
# ~/.local/bin/herdr 是安裝程式建的連結才拿掉
if [ -L "$HOME/.local/bin/herdr" ] && [ "$(readlink "$HOME/.local/bin/herdr")" = "$ROOT/bin/herdr" ]; then rm -f "$HOME/.local/bin/herdr"; fi

# 4. 程式 / 資料
if [ "$PURGE" = 1 ]; then
	rm -rf "$ROOT"
	say "已刪除 $ROOT(含所有資料)"
else
	rm -rf "$APP" "$APP.prev" "$ROOT/node" "$ROOT/bin"
	say "已移除程式;資料留在 $ROOT(要全部刪掉:rm -rf $ROOT)"
fi
