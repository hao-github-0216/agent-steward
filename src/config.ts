import { readFileSync, realpathSync } from "node:fs";
import { herdrSocket, pathInside } from "./platform.ts";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { DATA_DIR, expandHome, settings } from "./settings.ts";

export { DATA_DIR };
export const HOME = homedir();
export const DB_PATH = join(DATA_DIR, "steward.sqlite");
export const STORE_PATH = join(DATA_DIR, "state.json");
// 環境變數優先(測試用),否則讀設定檔
export const PORT = Number(process.env.STEWARD_PORT ?? settings().server.port);
export const TERMINAL_PORT = Number(process.env.STEWARD_TERMINAL_PORT ?? settings().server.terminalPort); // ttyd,只綁 127.0.0.1
export const HOSTS = (process.env.STEWARD_HOSTS ? process.env.STEWARD_HOSTS.split(",") : settings().server.hosts).filter(Boolean);
export const HERDR_SOCKET = herdrSocket();

/** 給人點的網址(推播、從 http 轉 https) */
export function publicUrl(): string {
	return process.env.STEWARD_PUBLIC_URL ?? (settings().server.publicUrl || `http://127.0.0.1:${PORT}/`);
}

// 不算「專案」的資料夾:在這些地方工作歸入雜務
export const MISC_ROOTS = [HOME, "/", "/tmp", join(HOME, "Desktop"), join(HOME, "Downloads")];

// agent 的暫存資料夾不是使用者的專案
export function isAgentTempPath(p: string): boolean {
	const bases = ["/tmp", "/private/tmp", tmpdir()];
	try {
		bases.push(realpathSync(tmpdir()));
	} catch {
		/* 無法解析就略過 */
	}
	for (const base of new Set(bases.map((b) => b.replace(/[\\/]+$/, "")))) {
		if (pathInside(p, base) && /^claude-\d+$/.test(relative(base, p).split(sep)[0])) return true;
	}
	const jobs = join(HOME, ".claude", "jobs");
	return pathInside(p, jobs) && relative(jobs, p).split(sep)[1] === "tmp";
}

/** 隱私路徑:設定頁填的 + (勾選時)pi privacy-guard 的同一份清單 */
export function privacyPaths(): string[] {
	const s = settings();
	const out = s.paths.privacy.map(expandHome);
	if (s.paths.usePiPrivacy) {
		try {
			const cfg = JSON.parse(readFileSync(join(HOME, ".pi", "agent", "privacy-paths.json"), "utf8"));
			out.push(...(cfg.paths as string[]).map(expandHome));
		} catch {
			/* 沒有 pi 的清單 */
		}
	}
	return out;
}

export function isPrivatePath(path: string): boolean {
	return privacyPaths().some((p) => pathInside(path, p));
}
