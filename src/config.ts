import { readFileSync, realpathSync } from "node:fs";
import { herdrSocket, pathInside } from "./platform.ts";
import { homedir, tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
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

/** 暫存、快取、套件與家目錄的工具設定資料夾不列為候選專案。 */
export function isThrowawayPath(p: string, opts: { platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv; tempDir?: string } = {}): boolean {
	if (!p) return false;
	const windows = (opts.platform ?? process.platform) === "win32";
	const env = opts.env ?? process.env;
	const normalize = (path: string, real = true): string => {
		if (real) {
			try { path = realpathSync(path); } catch { /* 不存在或無法解析時用原路徑 */ }
		}
		path = (windows ? win32 : posix).normalize(path.replace(/\\/g, "/")).replace(/\\/g, "/");
		if (windows) path = path.toLowerCase();
		return path.replace(/\/+$/, "") || "/";
	};
	const home = normalize(opts.home ?? HOME);
	const homes = [normalize(opts.home ?? HOME, false), home];
	const path = normalize(p);
	const isRoot = (x: string) => x === "/" || /^[a-z]:$/i.test(x);
	if (homes.includes(path) || isRoot(path)) return false;
	const inside = (base: string, child = path) => child === base || child.startsWith(`${base}/`);
	const pathHome = homes.find((base) => inside(base));
	const bases = [
		"/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", opts.tempDir ?? tmpdir(),
		env.TMPDIR, env.TEMP, env.TMP, "/var/folders", "/private/var/folders", "/run", env.XDG_RUNTIME_DIR,
		`${home}/Library/Caches`, `${home}/.cache`, env.XDG_CACHE_HOME,
	];
	if (windows) {
		// LocalAppData 也可能放 Programs 或使用者的專案,只排除 Temp 與 Packages,不排除整棵目錄。
		const local = env.LOCALAPPDATA || `${home}/AppData/Local`;
		bases.push(`${local}/Temp`, `${local}/Packages`, "C:/Windows/Temp");
	}
	if (bases.some((base) => {
		if (!base) return false;
		const normalized = [normalize(base, false), normalize(base)];
		// CI、容器與測試的 HOME 可能位在暫存或快取區;該 base 不排除 HOME 內的路徑,其餘規則照常判斷。
		if (pathHome && normalized.some((b) => homes.some((h) => inside(b, h)))) return false;
		return normalized.some((b) => !isRoot(b) && inside(b));
	})) return true;

	const parts = path.split("/");
	const packages = new Set(["node_modules", "site-packages", ".venv", "venv", ".npm", ".pnpm-store", ".cargo", ".rustup"]);
	if (parts.some((part, i) => packages.has(part) || (part === "go" && parts[i + 1] === "pkg" && parts[i + 2] === "mod"))) return true;
	// 家目錄下所有 dot 資料夾都排除,包含 .config 與 .claude/jobs/*/tmp。
	if (pathHome && path.slice(pathHome.length + 1).split("/")[0].startsWith(".")) return true;
	try {
		return readFileSync(join(p, "CACHEDIR.TAG"), "utf8").startsWith("Signature: 8a477f597d28d172789f06886806bc55");
	} catch {
		return false;
	}
}

export const isAgentTempPath = isThrowawayPath;

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
