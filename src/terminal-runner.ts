// 網頁終端機:用 ttyd 跑 herdr,只綁 127.0.0.1,由管家網頁 /terminal/ 轉接。
// 登入由管家轉接層負責,ttyd 只認管家加上的 X-Steward-User 標頭(外面連不到 ttyd)。
// macOS 和 Windows 共用(開機自動啟動的服務執行這支)。
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { herdrBin, ttydBin } from "./platform.ts";
import { DATA_DIR, settings } from "./settings.ts";

const port = String(process.env.STEWARD_TERMINAL_PORT ?? settings().server.terminalPort);
const env: NodeJS.ProcessEnv = { ...process.env, COLORTERM: "truecolor" };
// 從 herdr 裡啟動時會帶 HERDR_* 變數,herdr 會以為自己被巢狀執行而拒絕啟動
for (const k of Object.keys(env)) if (k.startsWith("HERDR_")) delete env[k];
// herdr 預設把複製的文字寫到「主機」的剪貼簿;網頁版要改用 OSC 52 交給瀏覽器(看板網頁會接住)。
// herdr 只在 SSH / VS Code 遠端時改用 OSC 52,這個變數只影響那個判斷,而且只設在 herdr 畫面這個程序。
env.VSCODE_IPC_HOOK_CLI = "steward-web-terminal";

const args = [
	"--interface", "127.0.0.1", "--port", port,
	"--base-path", "/terminal", "--writable", "--auth-header", "X-Steward-User",
	"--client-option", "fontSize=15",
	"--client-option", process.platform === "win32" ? "fontFamily=Cascadia Mono, Consolas, monospace" : "fontFamily=Menlo, monospace",
	"--client-option", "lineHeight=1.15",
	"--client-option", "disableLeaveAlert=true",
	"--client-option", "macOptionClickForcesSelection=true",
	"--client-option", "titleFixed=herdr",
	"--client-option", 'theme={"background":"#1d2021","foreground":"#ebdbb2","cursor":"#ebdbb2"}',
	herdrBin(),
];
const exe = ttydBin();
const runDir = join(DATA_DIR, "run");
const pidFile = join(runDir, "ttyd.pid");
mkdirSync(runDir, { recursive: true });
const child = spawn(exe, args, { env, stdio: "inherit" });
let desktopShutdown = false;
let killTimer: ReturnType<typeof setTimeout> | undefined;
process.on("exit", () => { try { rmSync(pidFile, { force: true }); } catch { /* 已經移除或無法存取 */ } });
child.once("spawn", () => {
	try { writeFileSync(pidFile, JSON.stringify({ pid: child.pid, exe }) + "\n"); }
	catch (error) { console.error("[terminal] 無法寫入 ttyd.pid", error); child.kill("SIGTERM"); process.exit(1); }
});
child.on("error", (error) => { console.error("[terminal] ttyd 啟動失敗", error); process.exit(1); });
child.on("exit", (code) => {
	clearTimeout(killTimer);
	process.exit(desktopShutdown ? 0 : (code ?? 1));
});
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => child.kill(sig));
if (process.env.STEWARD_DESKTOP === "1") {
	const shutdown = () => {
		if (desktopShutdown) return;
		desktopShutdown = true;
		child.kill("SIGTERM");
		killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
	};
	process.stdin.once("end", shutdown);
	process.stdin.once("close", shutdown);
	process.stdin.resume();
}
