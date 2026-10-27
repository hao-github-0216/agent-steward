#!/bin/sh
# 開發用部署:用安裝程式把目前的 commit 裝到 ~/.agent-steward/app 並重啟服務
# (跟一般使用者走同一套 install.sh;herdr 用你自己編的,不下載)。
# 用法:sh scripts/deploy.sh
set -eu
SRC=$(cd "$(dirname "$0")/.." && pwd)
cd "$SRC"
if [ -n "$(git status --porcelain -- src bin web integrations herdr-plugins install.sh herdr.json package.json package-lock.json)" ]; then
	echo "有未 commit 的改動,先 commit 再部署" >&2
	exit 1
fi
exec sh "$SRC/install.sh" --from "$SRC" --skip-herdr --no-open
