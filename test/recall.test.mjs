// 記憶搜尋:隔離暫存資料、假向量與 durable 掛鉤,不連外、不啟動伺服器。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";

const dataDir = mkdtempSync(join(tmpdir(), "steward-recall-"));
const previousDataDir = process.env.STEWARD_DATA_DIR;
process.env.STEWARD_DATA_DIR = dataDir;
after(() => {
	rmSync(dataDir, { recursive: true, force: true });
	if (previousDataDir === undefined) delete process.env.STEWARD_DATA_DIR;
	else process.env.STEWARD_DATA_DIR = previousDataDir;
});
const { DEFAULTS, ROLES, defaultRouting, settings, updateSettings } = await import("../src/settings.ts");
// 先寫入完整預設設定,避免第一次執行時偵測使用者的環境。
writeFileSync(join(dataDir, "settings.json"), JSON.stringify(DEFAULTS));
const { embeddingRef, fillEmptyRouting } = await import("../src/models.ts");
const { Recall, RecallStore, chunkText, messageText, keywordMatch, rrf, embedTexts, embedderFor, readEntriesFrom, createRecallHook } = await import("../src/recall.ts");

const project = (id = "p1", extra = {}) => ({
	id, name: `示範專案 ${id}`, root: join(dataDir, id), kind: "project", status: "active", private: false,
	conversationId: `conv-${id}`, createdAt: "2026-11-04T00:00:00.000Z",
	state: { goal: "", progress: "", nextSteps: [], decisions: [], blockers: [], recent: [], updatedAt: "" }, ...extra,
});
const p1 = project(), p2 = project("p2"), p3 = project("p3");
const oldText = "管家對話超過模型上限時,應該整理舊內容並保留原始歷史,提供關鍵字與向量搜尋。".repeat(2);
const row = (overrides = {}) => ({ project_id: p1.id, conv_id: p1.conversationId, entry_id: 1, part: 0, role: "user", at: 100, text: oldText, ...overrides });
function storeFor(t, path = ":memory:") {
	const store = new RecallStore(path);
	t.after(() => store.close());
	return store;
}
function fakeEmbedder(model = "fake/hash-64", onCall = () => {}) {
	return Object.assign(async (texts) => {
		onCall(texts);
		return texts.map((text) => {
			const vec = new Float32Array(64);
			for (const char of text) vec[char.codePointAt(0) % 64]++;
			const norm = Math.hypot(...vec);
			return Float32Array.from(vec, (n) => norm ? n / norm : 0);
		});
	}, { model });
}
function failingEmbedder(onCall = () => {}) {
	return Object.assign(async () => { onCall(); throw new Error("示範向量接口離線"); }, { model: "fake/down" });
}
function recallFor(store, overrides = {}) {
	return new Recall({ store, projects: () => [p1], readEntries: async () => [], embedder: () => undefined, ...overrides });
}
function freezeDeep(value) {
	if (value && typeof value === "object") {
		Object.freeze(value);
		for (const child of Object.values(value)) freezeDeep(child);
	}
	return value;
}

test("chunkText:預設長度、重疊、去空白與短段落", () => {
	const text = Array.from({ length: 2500 }, (_, i) => String.fromCharCode(65 + i % 26)).join("");
	const chunks = chunkText(`  ${text}  `);
	assert.deepEqual(chunks.map((chunk) => chunk.length), [1200, 1200, 400]);
	assert.equal(chunks[0].slice(-150), chunks[1].slice(0, 150));
	assert.equal(chunks[1].slice(-150), chunks[2].slice(0, 150));
	assert.deepEqual(chunkText("字".repeat(39)), []);
	assert.deepEqual(chunkText("   \n "), []);
	assert.deepEqual(chunkText("字".repeat(40)), ["字".repeat(40)]);
	assert.deepEqual(chunkText(text.slice(0, 240), 100, 20).map((chunk) => chunk.length), [100, 100, 80]);
	assert.throws(() => chunkText(text, 100, 100), RangeError);
});

test("messageText:只保留 user/assistant 的文字,不收 thinking、toolCall 或圖片", () => {
	assert.equal(messageText({ role: "user", content: "使用者文字" }), "使用者文字");
	const content = [{ type: "thinking", thinking: "內部推理" }, { type: "text", text: "公開回答" }, { type: "toolCall", name: "tool", arguments: {} }, { type: "text", text: "第二段" }, { type: "image", data: "示範" }];
	assert.equal(messageText({ role: "assistant", content }), "公開回答\n第二段");
	assert.equal(messageText({ role: "toolResult", content }), "");
	assert.equal(messageText({ role: "system", content: "系統文字" }), "");
	assert.equal(messageText({ role: "user", content: null }), "");
});

test("keywordMatch:中文四字片段、末尾三字、英數路徑與提交代號", () => {
	assert.equal(keywordMatch("管家對話超過模型上限"), '"管家對話" OR "超過模型"');
	assert.equal(keywordMatch("管家對話索引庫"), '"管家對話" OR "索引庫"');
	const match = keywordMatch("SRC/code.ts a049a2b src/code.ts abc");
	assert.equal(match, '"src/code.ts" OR "a049a2b" OR "abc"');
	assert.equal(keywordMatch('abc"def "ghi"'), '"abc" OR "def" OR "ghi"');
	assert.equal(keywordMatch('" OR () * ab 中文'), undefined);
});

test("keywordMatch:去重、長詞優先,英數與中文各至多16且合計至多24", () => {
	const latin = Array.from({ length: 30 }, (_, i) => `token${String(i).padStart(3, "0")}`);
	const cjk = Array.from({ length: 20 }, (_, i) => String.fromCharCode(0x4e00 + i).repeat(4));
	const words = keywordMatch(`${latin.join(" ")} ${cjk.join("，")} longest-token-here token000`).split(" OR ");
	assert.equal(words.length, 24);
	assert.equal(new Set(words).size, 24);
	assert.equal(words[0], '"longest-token-here"');
	assert.equal(words.filter((word) => /[a-z]/.test(word)).length, 16);
	assert.equal(keywordMatch(cjk.join("，")).split(" OR ").length, 16);
});

test("RecallStore:FTS5 中文搜尋、時間界線、專案隔離與重複寫入", (t) => {
	const store = storeFor(t);
	const rows = [row(), row({ entry_id: 2, at: 200 }), row({ project_id: p2.id, conv_id: p2.conversationId, at: 50 })];
	assert.equal(store.addChunks(rows), 3);
	assert.equal(store.addChunks(rows), 0);
	assert.deepEqual(store.counts(), { total: 3, vectors: 0 });
	const match = keywordMatch("管家對話超過模型上限");
	const hits = store.keyword(p1.id, match, 150, 30);
	assert.equal(hits.length, 1);
	assert.equal(hits[0].entry_id, 1);
	assert.equal(hits[0].at, 100);
	assert.equal(hits[0].role, "user");
	assert.equal(hits[0].text, oldText);
	assert.equal(typeof hits[0].score, "number");
	assert.equal(store.keyword(p1.id, match, 100, 30).length, 0);
	assert.equal(store.keyword(p1.id, match, 1000, 30).length, 2);
	assert.equal(store.keyword(p2.id, match, 1000, 30).length, 1);
	assert.equal(store.keyword("missing", match, 1000, 30).length, 0);
	assert.equal(store.keyword(p1.id, keywordMatch('管家對話 " OR "'), 150, 30).length, 1);
});

test("RecallStore:批次失敗全部回滾,不留下 FTS 資料", (t) => {
	const store = storeFor(t);
	assert.throws(() => store.addChunks([row(), row({ entry_id: 2, text: undefined })]));
	assert.deepEqual(store.counts(), { total: 0, vectors: 0 });
	assert.equal(store.keyword(p1.id, keywordMatch("管家對話"), 1000, 30).length, 0);
});

test("RecallStore:讀取進度、向量位元組、模型隔離與檔案持久化", async (t) => {
	const path = join(dataDir, "persistent-recall.sqlite");
	const store = new RecallStore(path);
	try {
		assert.equal(store.lastEntryId(p1.conversationId), 0);
		store.setLastEntryId(p1.conversationId, 20);
		store.setLastEntryId(p1.conversationId, 21);
		store.addChunks([row(), row({ project_id: p2.id, conv_id: p2.conversationId })]);
		assert.equal(store.pendingVectors(10, [p1.id]).length, 1);
		assert.equal(store.pendingVectors(10, []).length, 0);
		const [pending] = store.pendingVectors(1);
		const [vec] = await fakeEmbedder()([oldText]);
		store.setVector(pending.id, vec, "fake/hash-64");
		assert.deepEqual(store.vectors(p1.id, "fake/hash-64")[0].vec, vec);
		assert.deepEqual(store.vectors(p2.id, "fake/hash-64"), []);
		assert.deepEqual(store.vectors(p1.id, "fake/other"), []);
	} finally { store.close(); }
	const reopened = storeFor(t, path);
	assert.equal(reopened.lastEntryId(p1.conversationId), 21);
	assert.deepEqual(reopened.counts(), { total: 2, vectors: 1 });
	assert.equal(reopened.pendingVectors(10).length, 1);
	assert.equal(reopened.keyword(p1.id, keywordMatch("管家對話"), 1000, 30).length, 1);
});

test("rrf:合併兩個排名,忽略同一份排名中的重複 ID", () => {
	assert.deepEqual(rrf([[1, 2, 3], [3, 1, 4]]), [1, 3, 2, 4]);
	assert.deepEqual(rrf([[1, 1, 2], [2]]), [2, 1]);
	assert.deepEqual(rrf([[], [5, 4]]), [5, 4]);
	assert.deepEqual(rrf([]), []);
});

test("syncHistory:每頁 PAGE 筆、只收原始 user/assistant、推進進度且不重複", async (t) => {
	const store = storeFor(t), calls = [];
	const entries = Array.from({ length: 201 }, (_, i) => {
		const id = i + 1, role = id % 2 ? "user" : "assistant";
		return { id, kind: id === 2 ? "pi.compaction" : id === 3 ? "pi.tool" : `pi.${role}`, messages: [{ role, timestamp: id * 100, content: [{ type: "thinking", thinking: "不可索引的推理".repeat(20) }, { type: "text", text: `${oldText} 第${id}則` }] }] };
	});
	const recall = recallFor(store, {
		projects: () => [p1, project("without-conversation", { conversationId: undefined })],
		readEntries: async (convId, afterId, limit) => {
			calls.push([convId, afterId, limit]);
			return entries.filter((entry) => entry.id > afterId).slice(0, limit);
		},
	});
	await recall.syncHistory();
	assert.deepEqual(calls, [0, 50, 100, 150, 200].map((after) => [p1.conversationId, after, 50]));
	assert.equal(store.lastEntryId(p1.conversationId), 201);
	assert.equal(store.counts().total, 199);
	assert.equal(store.pendingVectors(1)[0].at, 100);
	assert.ok(store.pendingVectors(300).every((chunk) => !chunk.text.includes("不可索引")));
	await recall.syncHistory();
	assert.deepEqual(calls.at(-1), [p1.conversationId, 201, 50]);
	assert.equal(store.counts().total, 199);
});

test("syncHistory:同時間只讀取一次", async (t) => {
	const store = storeFor(t);
	let release, calls = 0;
	const waiting = new Promise((resolve) => { release = resolve; });
	const recall = recallFor(store, { readEntries: async () => { calls++; await waiting; return []; } });
	const first = recall.syncHistory();
	await recall.syncHistory();
	assert.equal(calls, 1);
	release();
	await first;
});

test("readEntriesFrom:呼叫 durable 分頁 API 並轉換 id/model", async () => {
	const calls = [], context = { marker: "示範 context" };
	const read = readEntriesFrom(() => ({ conversation: async (...args) => {
		calls.push(args);
		return { entries: async (...entryArgs) => {
			calls.push(entryArgs);
			return { items: [{ id: "8", kind: "pi.user", model: [{ role: "user", content: oldText }] }, { id: 9, kind: "pi.note" }] };
		} };
	} }), context);
	assert.deepEqual(await read("conv", 7, 200), [{ id: 8, kind: "pi.user", messages: [{ role: "user", content: oldText }] }, { id: 9, kind: "pi.note", messages: [] }]);
	assert.deepEqual(calls, [["conv", context], [{ minEntryId: 8, order: "ascending" }, 200, undefined, context]]);
	assert.deepEqual(await readEntriesFrom(() => ({ conversation: async () => undefined }), context)("missing", 0, 200), []);
});

test("fillVectors/search:混合搜尋、專案與時間隔離、快取追加及模型切換", async (t) => {
	const store = storeFor(t);
	store.addChunks([row(), row({ entry_id: 2, at: 300 }), row({ project_id: p2.id, conv_id: p2.conversationId, text: `${oldText}另一專案` }), row({ project_id: p3.id, conv_id: p3.conversationId })]);
	let embedder = fakeEmbedder(), cacheLoads = 0, keywordCalls = 0;
	const vectors = store.vectors.bind(store), keyword = store.keyword.bind(store);
	t.mock.method(store, "vectors", (...args) => { cacheLoads++; return vectors(...args); });
	t.mock.method(store, "keyword", (...args) => { keywordCalls++; return keyword(...args); });
	const recall = recallFor(store, { projects: () => [p1, p2, p3], embedder: (p) => p.id === p3.id ? undefined : embedder });
	await recall.fillVectors();
	assert.deepEqual(store.counts(), { total: 4, vectors: 3 });
	assert.equal(cacheLoads, 0);
	assert.deepEqual(await recall.search(p1, oldText, 200), [{ text: oldText, at: 100, role: "user" }]);
	assert.equal(keywordCalls, 1);
	assert.equal(cacheLoads, 1);
	await recall.search(p1, oldText, 200);
	assert.equal(cacheLoads, 1);
	const semanticText = "界".repeat(60);
	store.addChunks([row({ entry_id: 3, at: 110, text: semanticText })]);
	await recall.fillVectors();
	const keywordCallsBefore = keywordCalls;
	assert.deepEqual(await recall.search(p1, "界", 200), [{ text: semanticText, at: 110, role: "user" }]);
	assert.equal(keywordCalls, keywordCallsBefore);
	assert.equal(cacheLoads, 1);
	embedder = fakeEmbedder("fake/other");
	assert.deepEqual(await recall.search(p1, "界", 200), []);
	assert.equal(cacheLoads, 2);
	assert.equal((await recall.search(p1, oldText, 200)).length, 1);
});

test("fillVectors:每批至多32、沒有 embedder 不阻塞其他專案、批次間讓出事件迴圈", async (t) => {
	const store = storeFor(t), batches = [];
	store.addChunks([row({ project_id: p3.id, conv_id: p3.conversationId }), ...Array.from({ length: 65 }, (_, i) => row({ entry_id: i + 1 }))]);
	let yielded = false;
	const embedder = fakeEmbedder("fake/hash-64", (texts) => { batches.push(texts.length); if (batches.length > 1) assert.equal(yielded, true); });
	const recall = recallFor(store, { projects: () => [p1, p3], embedder: (p) => p.id === p1.id ? embedder : undefined });
	setImmediate(() => { yielded = true; });
	await recall.fillVectors();
	assert.deepEqual(batches, [32, 32, 1]);
	assert.deepEqual(store.counts(), { total: 66, vectors: 65 });
});

test("fillVectors/search:接口失敗仍回關鍵字,十分鐘內不再嘗試向量", async (t) => {
	const store = storeFor(t), logs = [];
	store.addChunks([row()]);
	let calls = 0;
	const recall = recallFor(store, { embedder: () => failingEmbedder(() => calls++), log: (msg) => logs.push(msg) });
	await recall.fillVectors();
	assert.equal(calls, 1);
	assert.deepEqual(await recall.search(p1, "管家對話超過模型上限", 200), [{ text: oldText, at: 100, role: "user" }]);
	await recall.search(p1, oldText, 200);
	await recall.fillVectors();
	assert.equal(calls, 1);
	assert.ok(logs.some((msg) => msg.includes("十分鐘")));
	const future = Date.now() + 10 * 60 * 1000 + 1;
	t.mock.method(Date, "now", () => future);
	await recall.fillVectors();
	assert.equal(calls, 2);
});

test("search:查詢向量失敗也會冷卻並保留關鍵字結果", async (t) => {
	const store = storeFor(t);
	store.addChunks([row()]);
	let calls = 0;
	const recall = recallFor(store, { embedder: () => failingEmbedder(() => calls++) });
	assert.equal((await recall.search(p1, oldText, 200)).length, 1);
	assert.equal((await recall.search(p1, oldText, 200)).length, 1);
	assert.equal(calls, 1);
});

test("search:相鄰分段合併、不混入其他對話,總文字至多5000", async (t) => {
	const store = storeFor(t);
	store.addChunks([
		row({ text: `${oldText} 第一段` }), row({ part: 1, text: `${oldText} 第二段` }),
		row({ conv_id: "another-conversation", text: `${oldText} 不同對話` }),
	]);
	const hits = await recallFor(store).search(p1, "管家對話", 200, 4);
	assert.equal(hits.length, 2);
	assert.ok(hits.some((hit) => hit.text.includes("第一段") && hit.text.includes("第二段") && !hit.text.includes("不同對話")));
	assert.ok(hits.some((hit) => hit.text.endsWith("不同對話") && !hit.text.includes("第一段")));
	store.addChunks([row({ entry_id: 2, text: `${oldText}${"長".repeat(6000)}` })]);
	const capped = await recallFor(store).search(p1, "管家對話", 200, 10);
	assert.equal(capped.reduce((sum, hit) => sum + hit.text.length, 0), 5000);
	assert.deepEqual(await recallFor(store).search(p1, "管家對話", 200, 0), []);
});

test("start/stop:非阻塞啟動、記錄段數、停止後不再索引", async (t) => {
	const store = storeFor(t), logs = [];
	let reads = 0, indexed;
	const finished = new Promise((resolve) => { indexed = resolve; });
	const recall = recallFor(store, { readEntries: async () => { reads++; indexed(); return []; }, log: (msg) => logs.push(msg) });
	t.after(() => recall.stop());
	recall.start();
	assert.equal(reads, 0);
	assert.ok(logs.some((msg) => msg.includes("0 段舊紀錄")));
	await finished;
	recall.stop();
	await recall.syncHistory();
	assert.equal(reads, 1);
});

test("start:背景失敗會記錄,logger 丟錯也不會讓程序崩潰", async (t) => {
	const store = storeFor(t), logs = [];
	let reported;
	const finished = new Promise((resolve) => { reported = resolve; });
	const recall = recallFor(store, { readEntries: async () => { throw new Error("示範歷史讀取失敗"); }, log: (msg) => { logs.push(msg); if (msg.includes("背景索引失敗")) reported(); throw new Error("示範 logger 失敗"); } });
	t.after(() => recall.stop());
	recall.start();
	await finished;
	recall.stop();
	assert.ok(logs.some((msg) => msg.includes("示範歷史讀取失敗")));
});

test("embeddingRef/embedderFor:設定預設、compat 可用、builtin/CLI/未設定不可用", () => {
	const original = structuredClone(settings());
	try {
		assert.equal(DEFAULTS.routing.embedding, "");
		assert.equal(defaultRouting([], () => undefined).embedding, "");
		assert.equal(ROLES.includes("embedding"), false);
		const compat = { id: "compat", name: "示範相容接口", type: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", apiKey: "local", models: ["bge-m3"], local: false };
		updateSettings({ providers: [compat], routing: { embedding: "compat/bge-m3" } });
		assert.deepEqual(embeddingRef(), { provider: "compat", modelId: "bge-m3" });
		assert.equal(embedderFor(p1).model, "compat/bge-m3");
		assert.equal(embedderFor(project("private", { private: true })).model, "compat/bge-m3");
		fillEmptyRouting();
		assert.equal(settings().routing.embedding, "compat/bge-m3");
		for (const provider of [{ id: "cloud", name: "示範內建接口", type: "builtin", builtin: "openai", local: true }, { id: "cli", name: "示範 CLI", type: "agent-cli", cli: "claude", local: true }]) {
			updateSettings({ providers: [provider], routing: { embedding: `${provider.id}/m` } });
			assert.equal(embedderFor(p1), undefined);
			assert.equal(embedderFor(project("private", { private: true })), undefined);
		}
		updateSettings({ providers: [], routing: { embedding: "missing/m" } });
		assert.equal(embedderFor(p1), undefined);
		updateSettings({ routing: { embedding: "" } });
		assert.equal(embeddingRef(), undefined);
		assert.equal(embedderFor(p1), undefined);
	} finally { updateSettings(original); }
});

test("embedTexts:假 fetch 驗證請求、index 排序、正規化與 local 不送金鑰", async (t) => {
	const requests = [];
	t.mock.method(globalThis, "fetch", async (url, init) => {
		requests.push({ url, init });
		return Response.json({ data: [{ index: 1, embedding: [0, 4] }, { index: 0, embedding: [3, 4] }] });
	});
	const config = { baseUrl: "http://127.0.0.1:1/v1/", apiKey: "demo-key", model: "bge-m3" };
	const vectors = await embedTexts(config, ["甲", "乙"], 1234);
	assert.equal(requests[0].url, "http://127.0.0.1:1/v1/embeddings");
	assert.equal(requests[0].init.method, "POST");
	assert.equal(requests[0].init.headers["content-type"], "application/json");
	assert.equal(requests[0].init.headers.authorization, "Bearer demo-key");
	assert.deepEqual(JSON.parse(requests[0].init.body), { model: "bge-m3", input: ["甲", "乙"] });
	assert.ok(requests[0].init.signal instanceof AbortSignal);
	assert.ok(vectors.every((vec) => vec instanceof Float32Array && Math.abs(Math.hypot(...vec) - 1) < 1e-6));
	assert.ok(Math.abs(vectors[0][0] - 0.6) < 1e-6);
	assert.deepEqual([...vectors[1]], [0, 1]);
	await embedTexts({ ...config, apiKey: "local" }, ["甲", "乙"]);
	await embedTexts({ ...config, apiKey: "" }, ["甲", "乙"]);
	assert.equal(requests[1].init.headers.authorization, undefined);
	assert.equal(requests[2].init.headers.authorization, undefined);
});

test("embedTexts:拒絕錯誤格式、重複 index、維度不一、非數字與零向量", async (t) => {
	let body;
	t.mock.method(globalThis, "fetch", async () => Response.json(body));
	for (body of [{}, { data: [] }, { data: [{ index: 1, embedding: [1] }] }, { data: [{ index: 0, embedding: [] }] }, { data: [{ index: 0, embedding: ["1"] }] }, { data: [{ index: 0, embedding: [null] }] }, { data: [{ index: 0, embedding: [0, 0] }] }]) {
		await assert.rejects(embedTexts({ baseUrl: "http://127.0.0.1:1", model: "m" }, ["甲"]));
	}
	for (body of [{ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [1] }] }, { data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [1, 2] }] }]) {
		await assert.rejects(embedTexts({ baseUrl: "http://127.0.0.1:1", model: "m" }, ["甲", "乙"]));
	}
});

test("embedTexts:HTTP 失敗與 AbortSignal 逾時都會丟錯", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response("示範故障", { status: 503 }));
	await assert.rejects(embedTexts({ baseUrl: "http://127.0.0.1:1", model: "m" }, ["甲"]), /503/);
	t.mock.method(globalThis, "fetch", async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
	// AbortSignal.timeout 的計時器不保持程序存活,測試另保留一個短時計時器。
	const keepAlive = setTimeout(() => {}, 1000);
	try { await assert.rejects(embedTexts({ baseUrl: "http://127.0.0.1:1", model: "m" }, ["甲"], 10), { name: "TimeoutError" }); }
	finally { clearTimeout(keepAlive); }
});

test("createRecallHook:排除系統訊息與摘要取最舊時間、前置舊紀錄、原物件與圖片都不變", async () => {
	const messages = freezeDeep([
		{ role: "system", content: "系統提示(對話剛建立時的時間)", timestamp: 0 },
		{ role: "user", content: "The conversation history before this point was compacted: 示範摘要", timestamp: 1 },
		{ role: "user", content: "前一個問題", timestamp: 300 },
		{ role: "assistant", content: [{ type: "text", text: "目前回答" }], timestamp: 200 },
		{ role: "user", content: [{ type: "text", text: "這次的問題" }, { type: "image", mimeType: "image/png", data: "demo" }], timestamp: 400 },
	]);
	const original = structuredClone(messages), calls = [], logs = [];
	const hooks = createRecallHook({ recall: () => ({ search: async (...args) => { calls.push(args); return [{ text: "曾經的決定", at: new Date(2026, 10, 4, 13, 20).getTime(), role: "user" }, { text: "管家的舊回答", at: new Date(2026, 10, 3, 9, 10).getTime(), role: "assistant" }]; } }), projectOf: () => p1, log: (msg) => logs.push(msg) });
	const result = await hooks.beforeRequest({ messages }, { conversationId: p1.conversationId }, ctx);
	assert.deepEqual(calls, [[p1, "這次的問題", 200]]);
	assert.deepEqual(messages, original);
	assert.notEqual(result.messages, messages);
	assert.equal(result.messages[0], messages[0]);
	assert.equal(result.messages[1], messages[1]);
	assert.notEqual(result.messages.at(-1), messages.at(-1));
	assert.equal(result.messages.at(-1).content[1], messages.at(-1).content[0]);
	assert.equal(result.messages.at(-1).content[2], messages.at(-1).content[1]);
	const prefix = result.messages.at(-1).content[0].text;
	assert.match(prefix, /^【可能相關的舊紀錄】/);
	assert.ok(prefix.includes("[2026-11-04 13:20 · 使用者] 曾經的決定"));
	assert.ok(prefix.includes("[2026-11-03 09:10 · 管家] 管家的舊回答"));
	assert.ok(prefix.endsWith("\n---\n"));
	assert.ok(logs[0].includes("帶入 2 段舊紀錄"));
});

test("createRecallHook:字串內容直接相接,查詢最多2000字", async () => {
	const query = "問".repeat(2100), messages = freezeDeep([{ role: "user", content: query, timestamp: 100 }]);
	let searched;
	const hooks = createRecallHook({ projectOf: () => p1, recall: () => ({ search: async (_p, text) => { searched = text; return [{ text: "舊文字", at: 1, role: "user" }]; } }) });
	const result = await hooks.beforeRequest({ messages }, { conversationId: p1.conversationId });
	assert.equal(searched.length, 2000);
	assert.equal(typeof result.messages[0].content, "string");
	assert.ok(result.messages[0].content.endsWith(query));
	assert.equal(messages[0].content, query);
});

test("createRecallHook:無專案/索引/問題/時間/結果、搜尋丟錯時回 undefined", async () => {
	const normal = [{ role: "user", content: "問題", timestamp: 100 }];
	const base = { projectOf: () => p1, recall: () => ({ search: async () => [] }) };
	for (const [options, messages] of [[{}, normal], [{ projectOf: () => undefined }, normal], [{ recall: () => undefined }, normal], [{}, []], [{}, [{ role: "user", content: "  ", timestamp: 100 }]], [{}, [{ role: "user", content: "問題" }]], [{ recall: () => ({ search: async () => { throw new Error("示範錯誤"); } }) }, normal]]) {
		assert.equal(await createRecallHook({ ...base, ...options }).beforeRequest({ messages }, { conversationId: p1.conversationId }), undefined);
	}
});

test("createRecallHook:慢搜尋在指定逾時內回 undefined", async () => {
	const hooks = createRecallHook({ projectOf: () => p1, recall: () => ({ search: () => new Promise(() => {}) }), timeoutMs: 10 });
	assert.equal(await hooks.beforeRequest({ messages: [{ role: "user", content: "問題", timestamp: 100 }] }, { conversationId: p1.conversationId }), undefined);
});

test("端對端:真正 durable beforeRequest 收到舊紀錄,對話只保存原始輸入", { timeout: 15000 }, async (t) => {
	const store = storeFor(t);
	store.addChunks([row({ at: Date.now() - 60000 })]);
	const recall = recallFor(store), received = [], reports = [];
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 100000, maxTokens: 1000 }] });
	faux.setResponses([(context) => { received.push(structuredClone(context.messages)); return fauxAssistantMessage("已查到舊紀錄"); }]);
	const models = createModels();
	models.setProvider(faux.provider);
	const extension = defineExtension({ name: "t", hooks: [hook(GenerationTask, createRecallHook({ recall: () => recall, projectOf: () => p1 }))] });
	const registry = createRegistry();
	registry.install(extension);
	const harness = await Harness.open(new MemoryStorage(), {
		models, registry, identity: { attribution: null },
		settings: { extensions: [extension], retry: { enabled: false }, compaction: { enabled: false } },
		onReport: (error, info) => reports.push({ error: String(error), type: info.type }),
	}, ctx);
	t.after(() => harness.close(ctx));
	const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "m" } } }, ctx);
	const input = "管家對話超過模型上限怎麼辦";
	const submission = await conv.submit({ type: "input", content: input }, ctx);
	const settled = await submission.wait(ctx);
	await conv.waitForIdle(ctx);
	assert.equal(settled.status, "done", JSON.stringify(reports));
	assert.deepEqual(reports, []);
	assert.equal(received.length, 1);
	const sentUser = received[0].findLast((message) => message.role === "user");
	assert.ok(messageText(sentUser).includes("【可能相關的舊紀錄】"));
	assert.ok(messageText(sentUser).includes(oldText));
	assert.ok(messageText(sentUser).endsWith(input));
	const view = await conv.context(ctx);
	assert.equal(view.messages.filter((message) => message.role === "user").length, 1);
	assert.equal(messageText(view.messages.find((message) => message.role === "user")), input);
	assert.ok(view.messages.every((message) => !messageText(message).includes("【可能相關的舊紀錄】")));
	const entries = await readEntriesFrom(() => harness, ctx)(conv.id, 0, 200);
	const users = entries.filter((entry) => entry.kind === "pi.user");
	assert.equal(users.length, 1);
	assert.equal(messageText(users[0].messages[0]), input);
});
