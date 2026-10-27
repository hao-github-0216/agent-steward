// 專案管家自己的訂閱登入(ChatGPT / Claude):存在 ~/.agent-steward/auth.json(只有自己能讀)。
// 沒有 pi 的人用這個;有 pi 的人也可以選擇不沿用 pi。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR } from "./settings.ts";

const FILE = join(DATA_DIR, "auth.json");
type Cred = { type: string; [k: string]: unknown };

function readAll(): Record<string, Cred> {
	try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return {}; }
}
function writeAll(all: Record<string, Cred>): void {
	mkdirSync(DATA_DIR, { recursive: true });
	const tmp = `${FILE}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(all, null, "\t")}\n`, { mode: 0o600 });
	renameSync(tmp, FILE);
	try { chmodSync(FILE, 0o600); } catch { /* Windows */ }
}

// 同一個程序裡依序寫入(token 更新和登入不會互相蓋掉)
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
	const next = chain.then(fn, fn);
	chain = next.catch(() => {});
	return next;
}

export const stewardAuth = {
	async read(id: string): Promise<Cred | undefined> {
		return readAll()[id];
	},
	has(id: string): boolean {
		return !!readAll()[id];
	},
	async modify(id: string, fn: (cur: Cred | undefined) => Promise<Cred | undefined>): Promise<Cred | undefined> {
		return serial(async () => {
			const all = readAll();
			const next = await fn(all[id]);
			if (next !== undefined) {
				all[id] = next;
				writeAll(all);
			}
			return all[id];
		});
	},
	async delete(id: string): Promise<void> {
		return serial(async () => {
			const all = readAll();
			if (!(id in all)) return;
			delete all[id];
			writeAll(all);
		});
	},
};

/** 這台安裝的固定代號(OpenAI 登入時要帶) */
export function deviceId(): string {
	const f = join(DATA_DIR, "device-id");
	if (existsSync(f)) return readFileSync(f, "utf8").trim();
	const id = randomUUID();
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(f, `${id}\n`, { mode: 0o600 });
	return id;
}
