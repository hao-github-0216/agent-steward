// 「問管家」的對話紀錄:每個專案一個 JSONL 檔(~/.agent-steward/chats/<專案>.jsonl),全部保留不設上限。
// 網頁分段讀:先拿最近的一段,往上捲再拿更早的。清除 = 把檔案改名保存,不真的刪。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "./config.ts";

const DIR = join(DATA_DIR, "chats");

export interface ChatQuote {
	path?: string;
	from?: number;
	to?: number;
	text: string;
}
export interface ChatEntry {
	id: string; // 時間排序用:毫秒時間戳 + 亂數
	role: "me" | "bot";
	text: string;
	quote?: ChatQuote;
	/** 這個問題帶了哪些檔案(只記路徑,不存內容) */
	files?: string[];
	at: string;
	error?: boolean;
	cloud?: boolean; // (舊)使用者按「改用雲端回答這一題」得到的回答
	alt?: string; // 使用者按「改用備用模型」得到的回答:用的是哪個模型
	retryable?: boolean; // 本地模型失敗,可以改用雲端重問
}

const safe = (pid: string) => pid.replace(/[^A-Za-z0-9_-]/g, "_");
const file = (pid: string) => join(DIR, `${safe(pid)}.jsonl`);

export function appendChat(pid: string, e: Omit<ChatEntry, "id" | "at">): ChatEntry {
	mkdirSync(DIR, { recursive: true });
	const entry: ChatEntry = { id: `${Date.now().toString(36).padStart(9, "0")}-${randomBytes(3).toString("hex")}`, at: new Date().toISOString(), ...e };
	appendFileSync(file(pid), `${JSON.stringify(entry)}\n`);
	return entry;
}

function readAll(pid: string): ChatEntry[] {
	const f = file(pid);
	if (!existsSync(f)) return [];
	const out: ChatEntry[] = [];
	for (const line of readFileSync(f, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// 寫到一半的行(不太可能):略過
		}
	}
	return out;
}

/** 讀一段:before 給了就拿它之前的 limit 則,沒給就拿最後 limit 則 */
export function readChat(pid: string, before: string | undefined, limit = 30): { items: ChatEntry[]; more: boolean; total: number } {
	const all = readAll(pid);
	let end = all.length;
	if (before) {
		const i = all.findIndex((e) => e.id === before);
		end = i >= 0 ? i : all.length;
	}
	const start = Math.max(0, end - Math.max(1, Math.min(200, limit)));
	return { items: all.slice(start, end), more: start > 0, total: all.length };
}

/** 清除畫面上的紀錄:改名保存(不影響管家記得的專案進度) */
export function clearChat(pid: string): void {
	const f = file(pid);
	if (existsSync(f)) renameSync(f, `${f}.cleared-${Date.now()}`);
}

/** 最近幾則問答(產生建議問題用) */
export function recentChat(pid: string, n = 6): ChatEntry[] {
	return readAll(pid).filter((e) => !e.error).slice(-n);
}

// ---------- 建議問題:每個專案一組三個 ----------
const sfile = (pid: string) => join(DIR, `${safe(pid)}.suggest.json`);
export function getSuggestions(pid: string): { items: string[]; at: string } | null {
	try {
		return JSON.parse(readFileSync(sfile(pid), "utf8"));
	} catch {
		return null;
	}
}
export function putSuggestions(pid: string, items: string[]): { items: string[]; at: string } {
	mkdirSync(DIR, { recursive: true });
	const v = { items: items.slice(0, 3), at: new Date().toISOString() };
	writeFileSync(sfile(pid), JSON.stringify(v));
	return v;
}
