// 作業系統差異集中在這裡(macOS / Windows;Linux 大致同 macOS)。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export const IS_WIN = process.platform === "win32";
const HOME = homedir();

/** 比對用的路徑:Windows 不分大小寫、斜線統一 */
function norm(p: string): string {
	const r = resolve(p);
	return IS_WIN ? r.replace(/\//g, "\\").toLowerCase() : r;
}
/** child 是否就是 root 或在 root 底下 */
export function pathInside(child: string, root: string): boolean {
	if (!child || !root) return false;
	const c = norm(child), r = norm(root).replace(/[\\/]+$/, "");
	return c === r || c.startsWith(r + (IS_WIN ? "\\" : sep));
}
export function samePath(a: string, b: string): boolean {
	return !!a && !!b && norm(a) === norm(b);
}

/** 移到垃圾桶 / 資源回收筒(救得回來) */
export function trash(abs: string): Promise<void> {
	return new Promise((ok, fail) => {
		const done = (err: Error | null) => (err ? fail(err) : ok());
		if (IS_WIN) {
			// PowerShell + VisualBasic FileIO:檔案和資料夾都送進資源回收筒
			const ps = `Add-Type -AssemblyName Microsoft.VisualBasic; $p = $env:STEWARD_TRASH; if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }`;
			execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 30_000, env: { ...process.env, STEWARD_TRASH: abs } }, done);
		} else if (process.platform === "darwin") {
			execFile(existsSync("/usr/bin/trash") ? "/usr/bin/trash" : "trash", [abs], { timeout: 15_000 }, done);
		} else {
			execFile("gio", ["trash", abs], { timeout: 15_000 }, done);
		}
	});
}

/** herdr 執行檔 */
export function herdrBin(): string {
	if (process.env.HERDR_BIN_PATH) return process.env.HERDR_BIN_PATH;
	const candidates = IS_WIN
		? [join(HOME, ".agent-steward", "bin", "herdr", "herdr.exe"), join(HOME, ".agent-steward", "bin", "herdr.exe"), join(process.env.LOCALAPPDATA ?? join(HOME, "AppData", "Local"), "Programs", "herdr", "herdr.exe"), join(HOME, ".local", "bin", "herdr.exe")]
		: [join(HOME, ".local", "bin", "herdr"), join(HOME, ".agent-steward", "bin", "herdr"), "/opt/homebrew/bin/herdr", "/usr/local/bin/herdr"];
	return candidates.find((p) => existsSync(p)) ?? (IS_WIN ? "herdr.exe" : "herdr");
}

/** herdr 的設定資料夾:macOS/Linux 是 ~/.config/herdr,Windows 是 %APPDATA%\\herdr */
export function herdrConfigDir(): string {
	if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "herdr");
	if (IS_WIN) return join(process.env.APPDATA ?? join(HOME, "AppData", "Roaming"), "herdr");
	return join(HOME, ".config", "herdr");
}

/** herdr 的連線點:macOS/Linux 是 unix socket 檔,Windows 是 named pipe(\\.\pipe\<路徑>) */
export function herdrSocket(): string {
	const p = process.env.HERDR_SOCKET_PATH ?? join(herdrConfigDir(), "herdr.sock");
	return IS_WIN && !p.startsWith("\\\\.\\pipe\\") ? `\\\\.\\pipe\\${p}` : p;
}

/** ttyd(網頁終端機) */
export function ttydBin(): string {
	const candidates = IS_WIN
		? [join(HOME, ".agent-steward", "bin", "ttyd.exe")]
		: ["/opt/homebrew/bin/ttyd", "/usr/local/bin/ttyd", join(HOME, ".agent-steward", "bin", "ttyd"), "/usr/bin/ttyd"];
	return candidates.find((p) => existsSync(p)) ?? (IS_WIN ? "ttyd.exe" : "ttyd");
}

/** 開機自動啟動的服務名稱(macOS launchd label / Linux systemd --user / Windows 工作排程器) */
export const SERVICE = { app: "agent-steward", terminal: "agent-steward-terminal" };
const LAUNCHD = { app: "com.agent-steward", terminal: "com.agent-steward.terminal" };
export function serviceHint(which: "app" | "terminal"): string {
	if (IS_WIN) return `工作排程器裡的「${SERVICE[which]}」`;
	if (process.platform === "darwin") return `launchctl print gui/$(id -u)/${LAUNCHD[which]}`;
	return `systemctl --user status ${SERVICE[which]}`;
}
