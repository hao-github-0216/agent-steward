// 程式碼模式的「工作階段」:每個專案開了哪些分頁、怎麼分割、游標在哪、檔案樹展開哪些資料夾。
// 存在伺服器上,換專案再切回來、或換一台電腦打開,都能還原。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodeError } from "./code.ts";
import { DATA_DIR } from "./config.ts";

const FILE = join(DATA_DIR, "code-sessions.json");
const MAX_BYTES = 512 * 1024; // 單一專案的版面上限(游標/捲動狀態也在裡面)

type Current = { project: string; source: string; at: string };
type Sessions = { last?: string; current?: Current; projects: Record<string, { layout: unknown; updatedAt: string }> };

let cache: Sessions | null = null;
function load(): Sessions {
	if (cache) return cache;
	try {
		cache = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as Sessions) : { projects: {} };
		if (!cache.projects || typeof cache.projects !== "object") cache = { projects: {} };
	} catch {
		cache = { projects: {} };
	}
	return cache;
}
function persist(s: Sessions): void {
	mkdirSync(DATA_DIR, { recursive: true });
	const tmp = `${FILE}.tmp`;
	writeFileSync(tmp, JSON.stringify(s));
	renameSync(tmp, FILE);
}

export function getSession(pid: string): { layout: unknown; updatedAt: string } | null {
	return load().projects[pid] ?? null;
}

export function putSession(pid: string, layout: unknown): { updatedAt: string } {
	if (!layout || typeof layout !== "object") throw new CodeError(400, "版面格式不對");
	if (JSON.stringify(layout).length > MAX_BYTES) throw new CodeError(413, "版面資料太大");
	const s = load();
	const updatedAt = new Date().toISOString();
	s.projects[pid] = { layout, updatedAt };
	s.last = pid;
	persist(s);
	return { updatedAt };
}

/** 看板/程式碼/終端機共用的「目前專案」(最後在哪一頁選的),跨裝置同步 */
export function getCurrent(): Current | null {
	return load().current ?? null;
}
export function putCurrent(project: string, source: string): Current {
	const s = load();
	s.current = { project, source: source.slice(0, 20), at: new Date().toISOString() };
	persist(s);
	return s.current;
}

