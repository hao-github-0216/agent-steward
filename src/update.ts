// 檢查更新 / 一鍵更新:看 GitHub 上最新的 release,更新時在背景重跑安裝程式(install.sh / scripts/install-windows.ps1)。
// 安裝程式會換掉 ~/.agent-steward/app 並重啟服務,所以要用獨立的程序跑(不能是管家的子程序)。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "./agents.ts";
import { IS_WIN } from "./platform.ts";
import { DATA_DIR } from "./settings.ts";

export const REPO = process.env.STEWARD_REPO ?? "hao-github-0216/agent-steward";
const LOG = join(DATA_DIR, "logs", "update.log");

/** 目前裝的版本:release 標籤(v1.2.3)、main,或開發版的 commit */
export function currentVersion(): string {
	try { return readFileSync(join(APP_DIR, "REVISION"), "utf8").trim(); } catch { return "dev"; }
}
const isRelease = (v: string) => /^v\d+(\.\d+)*/.test(v);
function newer(a: string, b: string): boolean {
	const p = (v: string) => v.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
	const x = p(a), y = p(b);
	for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
	return false;
}

let cache: { at: number; latest: string; url: string; notes: string } | undefined;
export interface UpdateInfo { current: string; latest?: string; hasUpdate: boolean; dev: boolean; url?: string; notes?: string; error?: string; running: boolean }

export async function checkUpdate(force = false): Promise<UpdateInfo> {
	const current = currentVersion();
	const dev = !isRelease(current);
	try {
		if (force || !cache || Date.now() - cache.at > 3600_000) {
			const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "agent-steward" }, signal: AbortSignal.timeout(10_000) });
			if (r.status === 404) return { current, dev, hasUpdate: false, running: updating(), error: "還沒有發布任何版本" };
			if (!r.ok) throw new Error(`GitHub 回應 ${r.status}`);
			const j = (await r.json()) as { tag_name: string; html_url: string; body?: string };
			cache = { at: Date.now(), latest: j.tag_name, url: j.html_url, notes: (j.body ?? "").slice(0, 2000) };
		}
		return { current, dev, latest: cache.latest, url: cache.url, notes: cache.notes, hasUpdate: !dev && newer(cache.latest, current), running: updating() };
	} catch (e) {
		return { current, dev, hasUpdate: false, running: updating(), error: `查不到最新版本:${(e as Error).message}` };
	}
}

const LOCK = join(DATA_DIR, "update.lock");
function updating(): boolean {
	try { return Date.now() - Number(readFileSync(LOCK, "utf8")) < 10 * 60_000; } catch { return false; }
}

/** 下載安裝程式、在背景執行;回傳後管家大約十幾秒內會被重啟 */
export async function applyUpdate(tag: string): Promise<void> {
	if (!/^v[\w.-]+$/.test(tag)) throw new Error("版本格式不對");
	if (updating()) throw new Error("已經在更新了");
	const dir = join(DATA_DIR, "update");
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(DATA_DIR, "logs"), { recursive: true });
	const file = join(dir, IS_WIN ? "install-windows.ps1" : "install.sh");
	const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${tag}/${IS_WIN ? "scripts/install-windows.ps1" : "install.sh"}`, { signal: AbortSignal.timeout(30_000) });
	if (!r.ok) throw new Error(`下載安裝程式失敗(${r.status})`);
	// Windows PowerShell 5.1 讀沒有 BOM 的 .ps1 會把中文當成亂碼
	const text = await r.text();
	writeFileSync(file, IS_WIN && !text.startsWith("\uFEFF") ? `\uFEFF${text}` : text);
	writeFileSync(LOCK, String(Date.now()));
	const out = openSync(LOG, "a");
	writeFileSync(LOG, `\n===== ${new Date().toISOString()} 更新到 ${tag} =====\n`, { flag: "a" });
	let cmd: string, args: string[];
	if (IS_WIN) {
		cmd = "powershell.exe";
		args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, "-Version", tag, "-NoOpen"];
	} else if (process.platform === "linux" && existsSync("/usr/bin/systemd-run")) {
		// systemd 會把服務底下的程序一起停掉,改由 systemd 另外跑
		cmd = "systemd-run";
		args = ["--user", "--collect", "--quiet", "/bin/sh", file, "--version", tag, "--no-open"];
	} else {
		cmd = "/bin/sh";
		args = [file, "--version", tag, "--no-open"];
	}
	const child = spawn(cmd, args, { detached: true, stdio: ["ignore", out, out], windowsHide: true, env: { ...process.env, STEWARD_REPO: REPO } });
	child.unref();
}

/** 更新紀錄最後幾行(給設定頁看進度) */
export function updateLog(): string {
	try { return readFileSync(LOG, "utf8").split("\n").slice(-30).join("\n"); } catch { return ""; }
}
