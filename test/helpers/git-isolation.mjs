// 測試建的暫存 repo 不吃使用者電腦的 git 設定(例如 ~/.config/git/ignore 裡的 .claude/ 會讓測試失敗)。
// 要在載入任何 ../src/*.ts 之前 import,src 呼叫的 git 才會用到這些環境變數。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "steward-git-isolation-"));
// git 一定會讀 $XDG_CONFIG_HOME/git/ignore(沒設就是 ~/.config/git/ignore),指到空資料夾
const xdg = join(dir, "xdg");
mkdirSync(xdg);
process.env.XDG_CONFIG_HOME = xdg;
// 全域設定換成空檔案(Windows 沒有 /dev/null),也不讀系統設定
const globalConfig = join(dir, "gitconfig");
writeFileSync(globalConfig, "");
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
