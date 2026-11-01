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
export interface CardDraft { title: string; agent: string; instructions: string; doneCriteria: string; status: "draft" | "proposed" | "dispatched"; cardId?: string }
export interface ChatEntry {
	id: string; // 時間排序用:毫秒時間戳 + 亂數
	role: "me" | "bot";
	text: string;
	quote?: ChatQuote;
	/** 這個問題帶了哪些檔案(只記路徑,不存內容) */
	files?: string[];
	/** 從哪裡問的(例如 herdr 裡 A 專案的 Claude Code 問了 B 專案) */
	via?: string;
	/** 附的圖片縮圖(data URL;原圖不存) */
	images?: string[];
	/** 管家擬的工作卡草稿:status draft=還沒決定、proposed=放進提案、dispatched=直接派工 */
	draft?: CardDraft;
	at: string;
	error?: boolean;
	cloud?: boolean; // (舊)使用者按「改用雲端回答這一題」得到的回答
	alt?: string; // 使用者按「改用備用模型」得到的回答:用的是哪個模型
	retryable?: boolean; // 本地模型失敗,可以改用雲端重問
	shared?: boolean; // 看圖單獨回答的問答,已經補給管家的持續對話
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

/** 改一則紀錄(工作卡草稿的欄位、狀態) */
export function updateChat(pid: string, id: string, patch: Partial<ChatEntry>): ChatEntry | undefined {
	const all = readAll(pid);
	const i = all.findIndex((e) => e.id === id);
	if (i < 0) return undefined;
	all[i] = { ...all[i], ...patch, id: all[i].id, at: all[i].at };
	const f = file(pid);
	writeFileSync(`${f}.tmp`, all.map((e) => JSON.stringify(e)).join("\n") + "\n");
	renameSync(`${f}.tmp`, f);
	return all[i];
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

/**
 * 管家的持續對話沒看過的問答:附圖的問題(圈選、貼圖)是另外找看得懂圖的模型單獨回答,
 * 不會進管家的對話。下一次一般提問時把這幾題(問題、圈到的內容、回答)補給管家,它才接得上;
 * 補過的在回答上記 shared,之後不再重複。只看最近 30 則、最多 max 組。exceptId:正在問的這一則
 */
export function unseenImageTurns(pid: string, exceptId?: string, max = 4): { text: string; ids: string[] } {
	const items = readAll(pid).filter((e) => e.id !== exceptId).slice(-30);
	const turns: string[] = [], ids: string[] = [];
	for (let i = items.length - 1; i >= 0 && turns.length < max; i--) {
		const me = items[i], bot = items[i + 1];
		if (me.role !== "me" || !me.images?.length || bot?.role !== "bot" || bot.error || bot.shared) continue;
		const where = `${me.quote?.path ?? ""}${me.quote?.from ? ` 第 ${me.quote.from}${me.quote.to && me.quote.to !== me.quote.from ? `–${me.quote.to}` : ""} 行` : ""}`;
		const q = me.quote?.text ? `\n${me.via === "圈選" ? "圈到的內容" : "引用"}(${where}):\n${me.quote.text.slice(0, 3000)}` : "";
		turns.unshift(`使用者${me.via === "圈選" ? "(圈選畫面,附截圖)" : "(附圖片)"}:${me.text}${q}\n管家:${bot.text.slice(0, 3000)}`);
		ids.push(bot.id);
	}
	return { text: turns.length ? `【補充:你之前沒看到的問答】使用者在你看不到的地方(附圖片、圈選畫面)問過以下問題,由看得懂圖片的模型回答。接下來的問題可能接著這些:\n${turns.join("\n---\n")}\n\n` : "", ids };
}
/** 補給管家之後記下來,不再重複補 */
export function markShared(pid: string, ids: string[]): void {
	for (const id of ids) updateChat(pid, id, { shared: true });
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
