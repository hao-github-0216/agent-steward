#!/bin/sh
# 開發用部署：把目前的 commit 裝到 ~/.agent-steward/app 並重啟服務。
# 使用本機安裝腳本；herdr 沿用本機編譯的版本，不下載。
# 用法:sh scripts/deploy.sh
set -eu
SRC=$(cd "$(dirname "$0")/.." && pwd)
cd "$SRC"
if [ -n "$(git status --porcelain -- src bin web integrations herdr-plugins scripts/dev scripts/deploy.sh scripts/gen-install.mjs i18n/installer.json components.json herdr.json package.json package-lock.json)" ]; then
	echo "有未 commit 的改動,先 commit 再部署" >&2
	exit 1
fi
exec sh "$SRC/scripts/dev/install.sh" --from "$SRC" --skip-herdr --no-open --yes
