import { DatabaseSync } from "node:sqlite";
import type { GenerationHooks } from "@earendil-works/pi-durable";
import { compatInfo, embeddingRef } from "./models.ts";
import { settings } from "./settings.ts";
import type { Project } from "./store.ts";

export interface RecallChunk {
	project_id: string;
	conv_id: string;
	entry_id: number;
	part: number;
	role: string;
	at: number;
	text: string;
}
export interface StoredRecallChunk extends RecallChunk { id: number; model: string | null }
export interface RecallHit { text: string; at: number; role: string }
export type RecallEmbedder = ((texts: string[]) => Promise<Float32Array[]>) & { model: string };

export class RecallStore {
	private db: DatabaseSync;

	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`
			PRAGMA journal_mode=WAL;
			CREATE TABLE IF NOT EXISTS chunks (
				id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, conv_id TEXT NOT NULL,
				entry_id INTEGER NOT NULL, part INTEGER NOT NULL, role TEXT NOT NULL,
				at INTEGER NOT NULL, text TEXT NOT NULL, model TEXT, vec BLOB,
				UNIQUE(conv_id, entry_id, role, part)
			);
			CREATE INDEX IF NOT EXISTS chunks_by_project ON chunks(project_id, at);
			CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
				text, content='chunks', content_rowid='id', tokenize='trigram'
			);
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		`);
	}

	addChunks(rows: RecallChunk[]): number {
		const insert = this.db.prepare("INSERT OR IGNORE INTO chunks(project_id, conv_id, entry_id, part, role, at, text) VALUES (?, ?, ?, ?, ?, ?, ?)");
		const fts = this.db.prepare("INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)");
		let added = 0;
		this.db.exec("BEGIN");
		try {
			for (const row of rows) {
				const result = insert.run(row.project_id, row.conv_id, row.entry_id, row.part, row.role, row.at, row.text);
				if (Number(result.changes) > 0) {
					fts.run(result.lastInsertRowid, row.text);
					added++;
				}
			}
			this.db.exec("COMMIT");
			return added;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	lastEntryId(convId: string): number {
		const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(`entry:${convId}`);
		return row ? Number(row.value) : 0;
	}

	setLastEntryId(convId: string, entryId: number): void {
		this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`entry:${convId}`, String(entryId));
	}

	pendingVectors(limit: number, projectIds?: string[]): StoredRecallChunk[] {
		if (projectIds?.length === 0) return [];
		const filter = projectIds ? ` AND project_id IN (${projectIds.map(() => "?").join(",")})` : "";
		return this.db.prepare(`SELECT id, project_id, conv_id, entry_id, part, role, at, text, model FROM chunks WHERE vec IS NULL${filter} ORDER BY id LIMIT ?`)
			.all(...(projectIds ?? []), limit) as unknown as StoredRecallChunk[];
	}

	setVector(id: number, vec: Float32Array, model: string): void {
		this.db.prepare("UPDATE chunks SET vec = ?, model = ? WHERE id = ?").run(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), model, id);
	}

	keyword(projectId: string, match: string, before: number, limit: number): { id: number; text: string; at: number; role: string; entry_id: number; part: number; score: number }[] {
		return this.db.prepare(`SELECT c.id, c.text, c.at, c.role, c.entry_id, c.part, bm25(chunks_fts) AS score
			FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
			WHERE chunks_fts MATCH ? AND c.project_id = ? AND c.at < ? ORDER BY score ASC, c.id ASC LIMIT ?`)
			.all(match, projectId, before, limit) as unknown as ReturnType<RecallStore["keyword"]>;
	}

	vectors(projectId: string, model: string): { id: number; at: number; vec: Float32Array }[] {
		const rows = this.db.prepare("SELECT id, at, vec FROM chunks WHERE project_id = ? AND model = ? AND vec IS NOT NULL ORDER BY id").all(projectId, model);
		return rows.map((row) => ({ id: Number(row.id), at: Number(row.at), vec: new Float32Array((row.vec as Uint8Array).slice().buffer) }));
	}

	chunk(projectId: string, id: number): StoredRecallChunk | undefined {
		return this.db.prepare("SELECT id, project_id, conv_id, entry_id, part, role, at, text, model FROM chunks WHERE project_id = ? AND id = ?")
			.get(projectId, id) as unknown as StoredRecallChunk | undefined;
	}

	counts(): { total: number; vectors: number } {
		const row = this.db.prepare("SELECT count(*) AS total, count(vec) AS vectors FROM chunks").get()!;
		return { total: Number(row.total), vectors: Number(row.vectors) };
	}

	close(): void { this.db.close(); }
}

export function chunkText(text: string, size = 1200, overlap = 150): string[] {
	text = text.trim();
	if (text.length < 40) return [];
	if (size <= 0 || overlap < 0 || overlap >= size) throw new RangeError("無效的分段大小");
	const chunks: string[] = [];
	for (let start = 0; start < text.length; start += size - overlap) {
		const chunk = text.slice(start, start + size).trim();
		if (chunk) chunks.push(chunk);
		if (start + size >= text.length) break;
	}
	return chunks;
}

export interface RecallMessage { role: string; content: unknown; timestamp?: number }
export function messageText(message: RecallMessage): string {
	if (message.role !== "user" && message.role !== "assistant") return "";
	if (typeof message.content === "string") return message.role === "user" ? message.content : "";
	if (!Array.isArray(message.content)) return "";
	return message.content.filter((part): part is { type: "text"; text: string } =>
		!!part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text).join("\n");
}

export function keywordMatch(query: string): string | undefined {
	const latin = [...new Set((query.match(/[A-Za-z0-9_.\-\/]{3,}/g) ?? []).map((word) => word.toLowerCase()))]
		.sort((a, b) => b.length - a.length).slice(0, 16);
	const cjk = new Set<string>();
	for (const run of query.match(/[㐀-䶿一-鿿豈-﫿]{3,}/g) ?? []) {
		for (let i = 0; i < run.length; i += 4) {
			const word = run.slice(i, i + 4);
			if (word.length >= 3) cjk.add(word);
		}
	}
	const words = [...latin, ...[...cjk].slice(0, 16)].slice(0, 24);
	return words.length ? words.map((word) => `"${word.replace(/"/g, '""')}"`).join(" OR ") : undefined;
}

export function rrf(lists: number[][], k = 60): number[] {
	const scores = new Map<number, number>();
	for (const list of lists) {
		for (const [rank, id] of [...new Set(list)].entries()) scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
	}
	return [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export async function embedTexts(config: { baseUrl: string; apiKey?: string; model: string }, texts: string[], timeoutMs = 10000): Promise<Float32Array[]> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (config.apiKey && config.apiKey !== "local") headers.authorization = `Bearer ${config.apiKey}`;
	const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/embeddings`, {
		method: "POST", headers, body: JSON.stringify({ model: config.model, input: texts }), signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new Error(`向量接口回應 ${response.status}`);
	const body: unknown = await response.json();
	if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data) || body.data.length !== texts.length) throw new Error("向量回應格式錯誤");
	const vectors: Float32Array[] = new Array(texts.length);
	let dimensions: number | undefined;
	for (const item of body.data) {
		if (!item || typeof item !== "object" || !Number.isInteger(item.index) || item.index < 0 || item.index >= texts.length || vectors[item.index]
			|| !Array.isArray(item.embedding) || !item.embedding.length || !item.embedding.every((n: unknown) => typeof n === "number" && Number.isFinite(n))) throw new Error("向量回應資料錯誤");
		if (dimensions !== undefined && dimensions !== item.embedding.length) throw new Error("向量維度不一致");
		dimensions = item.embedding.length;
		const values: number[] = item.embedding;
		const scale = values.reduce((max, n) => Math.max(max, Math.abs(n)), 0);
		if (scale === 0) throw new Error("向量長度無效");
		const norm = Math.sqrt(values.reduce((sum, n) => sum + (n / scale) ** 2, 0));
		vectors[item.index] = Float32Array.from(values, (n) => (n / scale) / norm);
	}
	return vectors;
}

export function embedderFor(p: Project): RecallEmbedder | undefined {
	const ref = embeddingRef();
	if (!ref) return undefined;
	const c = settings().providers.find((provider) => provider.id === ref.provider);
	if (!c) return undefined;
	// 目前相容接口都視為本地或自架。
	const local = c.local || (c.type !== "builtin" && c.type !== "agent-cli");
	if (p.private && !local) return undefined;
	if (c.type !== "openai-compatible" && c.type !== "pi-models") return undefined;
	const info = compatInfo(c);
	if (!info?.baseUrl) return undefined;
	return Object.assign((texts: string[]) => embedTexts({ baseUrl: info.baseUrl, apiKey: info.apiKey, model: ref.modelId }, texts), { model: `${ref.provider}/${ref.modelId}` });
}

export type RecallDeps = {
	store: RecallStore;
	projects(): Project[];
	readEntries(convId: string, afterEntryId: number, limit: number): Promise<{ id: number; kind: string; messages: RecallMessage[] }[]>;
	embedder(p: Project): RecallEmbedder | undefined;
	log?(msg: string): void;
};

type VectorCache = { model: string; ids: number[]; at: number[]; vecs: Float32Array[] };
// 每次讀幾筆歷史:第一次建索引時資料很多,分小塊寫入全文索引,才不會卡住管家
export const PAGE = 50;
const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("記憶搜尋逾時")), ms); })]);
	} finally { clearTimeout(timer); }
}

export class Recall {
	private deps: RecallDeps;
	private syncing = false;
	private filling = false;
	private downUntil = 0;
	private cache = new Map<string, VectorCache>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private active = false;
	private stopped = false;

	constructor(deps: RecallDeps) { this.deps = deps; }

	async syncHistory(): Promise<void> {
		if (this.syncing || this.stopped) return;
		this.syncing = true;
		try {
			for (const p of this.deps.projects()) {
				if (!p.conversationId || this.stopped) continue;
				let after = this.deps.store.lastEntryId(p.conversationId);
				while (!this.stopped) {
					const entries = await this.deps.readEntries(p.conversationId, after, PAGE);
					if (!entries.length || this.stopped) break;
					const rows: RecallChunk[] = [];
					for (const entry of entries) {
						if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") continue;
						const parts = new Map<string, number>();
						for (const message of entry.messages) {
							for (const text of chunkText(messageText(message))) {
								const part = parts.get(message.role) ?? 0;
								rows.push({ project_id: p.id, conv_id: p.conversationId, entry_id: entry.id, part, role: message.role, at: message.timestamp ?? Date.now(), text });
								parts.set(message.role, part + 1);
							}
						}
					}
					this.deps.store.addChunks(rows);
					const next = Math.max(...entries.map((entry) => entry.id));
					if (next <= after) break;
					this.deps.store.setLastEntryId(p.conversationId, next);
					after = next;
					if (entries.length < PAGE) break;
					await yieldLoop();
				}
			}
		} finally { this.syncing = false; }
	}

	private log(message: string): void {
		try { this.deps.log?.(message); } catch { /* 記錄失敗不能中斷背景索引。 */ }
	}

	private cooldown(error: unknown): void {
		this.downUntil = Date.now() + 10 * 60 * 1000;
		this.log(`[recall] 向量搜尋暫停十分鐘: ${String(error)}`);
	}

	async fillVectors(): Promise<void> {
		if (this.filling || this.stopped || Date.now() < this.downUntil) return;
		this.filling = true;
		try {
			while (!this.stopped && Date.now() >= this.downUntil) {
				const embedders = new Map<string, RecallEmbedder>();
				for (const p of this.deps.projects()) {
					const embedder = this.deps.embedder(p);
					if (embedder) embedders.set(p.id, embedder);
				}
				const rows = this.deps.store.pendingVectors(32, [...embedders.keys()]);
				if (!rows.length) break;
				const groups = new Map<string, StoredRecallChunk[]>();
				for (const row of rows) {
					const group = groups.get(row.project_id) ?? [];
					group.push(row);
					groups.set(row.project_id, group);
				}
				for (const [projectId, group] of groups) {
					if (this.stopped || Date.now() < this.downUntil) return;
					const embedder = embedders.get(projectId)!;
					const vectors = await embedder(group.map((row) => row.text));
					if (this.stopped) return;
					if (vectors.length !== group.length) throw new Error("向量回應數量錯誤");
					for (const [i, row] of group.entries()) {
						this.deps.store.setVector(row.id, vectors[i], embedder.model);
						const cache = this.cache.get(projectId);
						if (cache?.model === embedder.model) {
							cache.ids.push(row.id);
							cache.at.push(row.at);
							cache.vecs.push(vectors[i]);
						}
					}
				}
				await yieldLoop();
			}
		} catch (error) { this.cooldown(error); }
		finally { this.filling = false; }
	}

	async search(p: Project, query: string, before: number, limit = 4): Promise<RecallHit[]> {
		const match = keywordMatch(query);
		const keywords = match ? this.deps.store.keyword(p.id, match, before, 30).map((row) => row.id) : [];
		let vectorIds: number[] = [];
		if (Date.now() >= this.downUntil) {
			try {
				const embedder = this.deps.embedder(p);
				if (embedder) {
					const [queryVector] = await withTimeout(Promise.resolve().then(() => embedder([query.slice(0, 2000)])), 4000);
					if (!queryVector?.length) throw new Error("查詢向量無效");
					let cache = this.cache.get(p.id);
					if (!cache || cache.model !== embedder.model) {
						const rows = this.deps.store.vectors(p.id, embedder.model);
						cache = { model: embedder.model, ids: rows.map((row) => row.id), at: rows.map((row) => row.at), vecs: rows.map((row) => row.vec) };
						this.cache.set(p.id, cache);
					}
					const scored: { id: number; score: number }[] = [];
					for (let i = 0; i < cache.ids.length; i++) {
						const vec = cache.vecs[i];
						if (cache.at[i] >= before || vec.length !== queryVector.length) continue;
						let score = 0;
						for (let d = 0; d < vec.length; d++) score += vec[d] * queryVector[d];
						if (score >= 0.5) scored.push({ id: cache.ids[i], score });
					}
					vectorIds = scored.sort((a, b) => b.score - a.score).slice(0, 30).map((row) => row.id);
				}
			} catch (error) { this.cooldown(error); }
		}
		const ids = vectorIds.length && keywords.length ? rrf([vectorIds, keywords]) : vectorIds.length ? vectorIds : keywords;
		const selected = ids.slice(0, Math.max(0, limit)).map((id) => this.deps.store.chunk(p.id, id)).filter((row): row is StoredRecallChunk => !!row && row.at < before);
		const used = new Set<number>();
		const hits: RecallHit[] = [];
		let remaining = 5000;
		for (const row of selected) {
			if (used.has(row.id) || remaining <= 0) continue;
			const siblings = selected.filter((other) => other.conv_id === row.conv_id && other.entry_id === row.entry_id && other.role === row.role).sort((a, b) => a.part - b.part);
			let start = siblings.findIndex((other) => other.id === row.id), end = start;
			while (start > 0 && siblings[start - 1].part + 1 === siblings[start].part) start--;
			while (end + 1 < siblings.length && siblings[end].part + 1 === siblings[end + 1].part) end++;
			const group = siblings.slice(start, end + 1);
			for (const part of group) used.add(part.id);
			const text = group.map((part) => part.text).join("\n").slice(0, remaining);
			hits.push({ text, at: group[0].at, role: row.role });
			remaining -= text.length;
		}
		return hits;
	}

	start(): void {
		if (this.active) return;
		this.active = true;
		this.stopped = false;
		try {
			const counts = this.deps.store.counts();
			this.log(`[recall] ${counts.total} 段舊紀錄,${counts.vectors} 段有向量`);
		} catch (error) { this.log(`[recall] 啟動索引失敗: ${String(error)}`); }
		const run = async () => {
			try {
				await this.syncHistory();
				if (this.active) await this.fillVectors();
			} catch (error) { this.log(`[recall] 背景索引失敗: ${String(error)}`); }
			finally { if (this.active) this.timer = setTimeout(() => { void run(); }, 2 * 60 * 1000); }
		};
		this.timer = setTimeout(() => { void run(); }, 0);
	}

	stop(): void {
		this.active = false;
		this.stopped = true;
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}

export function readEntriesFrom(getHarness: () => { conversation(id: never, ctx: never): Promise<unknown> }, ctx: unknown): RecallDeps["readEntries"] {
	// 僅使用讀取歷史所需的結構,不依賴 durable 的品牌型別。
	type HistoryConversation = {
		entries(query: { minEntryId: number; order: "ascending" }, limit: number, cursor: undefined, ctx: unknown): Promise<{ items: { id: unknown; kind: string; model?: RecallMessage[] }[] }>;
	};
	return async (convId, afterEntryId, limit) => {
		const conv = await getHarness().conversation(convId as never, ctx as never) as HistoryConversation | undefined;
		if (!conv) return [];
		const page = await conv.entries({ minEntryId: afterEntryId + 1, order: "ascending" }, limit, undefined, ctx);
		return page.items.map((entry) => ({ id: Number(entry.id), kind: entry.kind, messages: entry.model ?? [] }));
	};
}

export function createRecallHook(options: {
	recall(): { search(p: Project, query: string, before: number, limit?: number): Promise<RecallHit[]> } | undefined;
	projectOf(conversationId: string): Project | undefined;
	log?(msg: string): void;
	timeoutMs?: number;
}) {
	// 回傳 hooks 處理器物件,也可用精簡訊息測試。
	const beforeRequest = async <M extends RecallMessage>(request: { readonly messages: readonly M[] }, api: { readonly conversationId: string | number }, _ctx?: unknown): Promise<{ messages: M[] } | undefined> => {
		try {
			return await withTimeout(Promise.resolve().then(async () => {
				// 品牌數字 ID 僅轉接型別,保留原值供既有 Map 查找。
				const p = options.projectOf(api.conversationId as string), recall = options.recall();
				if (!p || !recall) return undefined;
				const messages = request.messages;
				let lastUser = -1;
				for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { lastUser = i; break; }
				if (lastUser < 0) return undefined;
				const query = messageText(messages[lastUser]);
				if (!query.trim()) return undefined;
				// 系統訊息的時間可能是對話剛建立時,不能拿來判斷;前一份摘要也不算
				const timestamps = messages.filter((message) => message.role !== "system" && message.timestamp !== undefined && !messageText(message).startsWith("The conversation history before this point was compacted"))
					.map((message) => message.timestamp!);
				if (!timestamps.length) return undefined;
				const hits = await recall.search(p, query.slice(0, 2000), Math.min(...timestamps));
				if (!hits.length) return undefined;
				const lines = hits.map((hit) => {
					const date = new Date(hit.at), pad = (n: number) => String(n).padStart(2, "0");
					const at = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
					return `[${at} · ${hit.role === "user" ? "使用者" : "管家"}] ${hit.text}`;
				});
				const prefix = `【可能相關的舊紀錄】(從這個專案已整理掉的對話自動找出,僅供參考,可能已過時)\n${lines.join("\n")}\n---\n`;
				const original = messages[lastUser];
				const content = typeof original.content === "string" ? prefix + original.content : [{ type: "text", text: prefix }, ...(Array.isArray(original.content) ? original.content : [])];
				const copy = [...messages];
				copy[lastUser] = { ...original, content };
				options.log?.(`[recall] ${p.name} 帶入 ${hits.length} 段舊紀錄`);
				return { messages: copy };
			}), options.timeoutMs ?? 5000);
		} catch { return undefined; }
	};
	return { beforeRequest } satisfies Pick<GenerationHooks, "beforeRequest">;
}
