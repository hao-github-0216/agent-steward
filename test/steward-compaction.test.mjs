// 管家整理:保守估算、最新訊息節錄、失敗保底與真實 Harness 掛鉤。
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { CompactionEntry, CompactionTask, createRegistry, defineExtension, Harness, hook } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { createCompactHook, fallbackSummary, isPreviousSummary, safeTokens, serialize, SUMMARY_SYSTEM, trimmedPrompt } from "../src/compaction.ts";

const user = (content) => ({ role: "user", content, timestamp: 0 });
const previous = (text) => user(`The conversation history before this point was compacted into the following summary:\n\n<summary>\n${text}\n</summary>`);
const state = {
	goal: "避免整理卡死",
	progress: "正在測試掛鉤",
	nextSteps: ["跑完整測試", "交回驗收"],
	blockers: ["模型可能失敗"],
	decisions: ["不改模型路由"],
	recent: [],
	updatedAt: "",
};
const project = { id: "test-project", name: "測試專案", root: "/tmp/steward-compaction-project", kind: "project", status: "active", private: false, state, createdAt: "" };
const largeMessages = () => Array.from({ length: 12 }, (_, i) => user(`訊息 ${i}:` + "中".repeat(2000)));
const compaction = (messages) => ({ reason: "manual", entries: [], messages, firstKept: "entry-42" });
const textOf = (message) => typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");

function fixture({ complete = async () => fauxAssistantMessage("模型摘要"), configured = true, model = { contextWindow: 8000, maxTokens: 1000 }, cache = new Map() } = {}) {
	const calls = [];
	const lookups = [];
	const fallbackProjects = [];
	const logs = [];
	const api = {
		conversationId: "test-conversation",
		models: {
			getModel: (...ref) => { lookups.push(ref); return model; },
			completeSimple: async (...args) => { calls.push(args); return complete(...args); },
		},
		memo: async (...args) => {
			const [key, candidate] = args;
			if (args.length === 3 && !cache.has(key)) cache.set(key, candidate);
			return cache.get(key);
		},
	};
	const compactHook = createCompactHook({
		projectOf: (id) => { assert.equal(id, api.conversationId); return project; },
		modelRefOf: (id) => { assert.equal(id, api.conversationId); return configured ? { provider: "current", modelId: "small" } : undefined; },
		fallbackRef: (p) => { fallbackProjects.push(p); return { provider: "fallback", modelId: "digest" }; },
		log: (message) => logs.push(message),
	});
	return { api, compactHook, calls, lookups, fallbackProjects, logs, cache };
}

test("safeTokens:中日韓逐字算,其他字元每三字進位", () => {
	assert.ok(safeTokens("中".repeat(1000)) >= 1000);
	assert.equal(safeTokens("a".repeat(3000)), 1000);
	assert.equal(safeTokens("a"), 1);
	assert.equal(safeTokens(""), 0);
	assert.equal(safeTokens("　、あア㐀中豈Ａ"), 8);
	assert.equal(safeTokens("中文abcd"), 4);
});

test("serialize:沿用對話格式,不放 system、thinking 與圖片", () => {
	const messages = [
		{ role: "system", content: "不該出現的系統訊息", timestamp: 0 },
		user([{ type: "text", text: "問題" }, { type: "image", data: "不該出現的圖片", mimeType: "image/png" }]),
		fauxAssistantMessage([{ type: "thinking", thinking: "不該出現的思考" }, { type: "text", text: "回答" }, { type: "text", text: "第二行" }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts", lines: 2 } }]),
		{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "工具結果" }], isError: false, timestamp: 0 },
	];
	assert.equal(serialize(messages), '[User]: 問題\n\n[Assistant]: 回答\n第二行\n\n[Assistant tool calls]: read(path="src/a.ts", lines=2)\n\n[Tool result]: 工具結果');
});

test("serialize:文字、工具參數與結果分別截長並回報省略字數", () => {
	assert.equal(serialize([user("中".repeat(6100))]), `[User]: ${"中".repeat(6000)}\n[…截斷 100 字]`);
	assert.equal(serialize([fauxAssistantMessage("a".repeat(6100))]), `[Assistant]: ${"a".repeat(6000)}\n[…截斷 100 字]`);
	const args = 'value="' + "x".repeat(1100) + '"';
	assert.equal(serialize([fauxAssistantMessage({ type: "toolCall", id: "call-1", name: "run", arguments: { value: "x".repeat(1100) } })]), `[Assistant tool calls]: run(${args.slice(0, 1000)}\n[…截斷 ${args.length - 1000} 字])`);
	assert.equal(serialize([{ role: "toolResult", content: [{ type: "text", text: "x".repeat(2100) }], toolCallId: "call-1", toolName: "run", isError: false, timestamp: 0 }]), `[Tool result]: ${"x".repeat(2000)}\n[…截斷 100 字]`);
});

test("isPreviousSummary:只認 user 的摘要前綴", () => {
	assert.equal(isPreviousSummary(previous("舊摘要")), true);
	assert.equal(isPreviousSummary(user([{ type: "text", text: previous("舊摘要").content }])), true);
	assert.equal(isPreviousSummary(user("一般問題")), false);
	assert.equal(isPreviousSummary(fauxAssistantMessage(previous("舊摘要").content)), false);
});

test("trimmedPrompt:保留前份摘要與狀態,從最新往回加入並正確計數", () => {
	const prior = previous("## Goal\n保留原始目標");
	const messages = [prior, ...Array.from({ length: 6 }, (_, i) => user(`第 ${i} 則:` + "新".repeat(400)))];
	const lastTwo = trimmedPrompt({ messages: [prior, ...messages.slice(-2)], budget: 100_000, state });
	const budget = safeTokens(lastTwo.text) + 100;
	const result = trimmedPrompt({ messages, budget, state });
	assert.equal(result.omitted, 4);
	assert.ok(result.text.includes("<previous-summary>\n## Goal\n保留原始目標\n</previous-summary>"));
	assert.match(result.text, /<project-state>\n目標:避免整理卡死/);
	for (const value of [state.progress, ...state.nextSteps, ...state.blockers, ...state.decisions]) assert.ok(result.text.includes(value));
	assert.match(result.text, /<conversation>\n\[省略了 4 則較舊的訊息;原始紀錄仍保存在資料庫\]/);
	assert.doesNotMatch(result.text, /第 3 則/);
	assert.ok(result.text.indexOf("第 4 則") < result.text.indexOf("第 5 則"));
	assert.ok(result.text.indexOf("</previous-summary>") < result.text.indexOf("<project-state>"));
	assert.ok(result.text.indexOf("</project-state>") < result.text.indexOf("<conversation>"));
	assert.ok(result.text.endsWith(SUMMARY_SYSTEM));
	assert.ok(safeTokens(result.text) <= budget);
});

test("trimmedPrompt:前份摘要保留內文(拿掉外層說明),即使超出預算仍保留最新一則", () => {
	const prior = previous("舊".repeat(7000));
	const result = trimmedPrompt({ messages: [prior, user("舊問題"), user("新".repeat(20_000))], budget: 1000 });
	assert.ok(result.text.includes(`<previous-summary>\n${"舊".repeat(7000)}\n</previous-summary>`));
	assert.doesNotMatch(result.text, /The conversation history before this point/);
	assert.equal(result.omitted, 1);
	assert.doesNotMatch(result.text, /舊問題/);
	assert.ok(result.text.includes("新".repeat(6000) + "\n[…截斷 14000 字]"));
	assert.ok(!result.text.includes("新".repeat(6001)));
});

test("trimmedPrompt:空欄位略過,沒有摘要也能整理", () => {
	const result = trimmedPrompt({ messages: [user("最新訊息")], budget: 1000, state: { ...state, goal: "", progress: "", nextSteps: [], blockers: [], decisions: [] } });
	assert.equal(result.omitted, 0);
	assert.doesNotMatch(result.text, /<\/previous-summary>|<\/project-state>|省略了/);
	assert.match(result.text, /\[User\]: 最新訊息/);
});

test("fallbackSummary:保留摘要與狀態,只取最新 30 則 user 第一行、新的在前", () => {
	const prior = previous("舊摘要內文與 src/a.ts");
	const messages = [prior, ...Array.from({ length: 35 }, (_, i) => user(`訊息 ${i}:` + "長".repeat(220) + "\n第二行不應出現")), fauxAssistantMessage("不是 user 訊息")];
	const summary = fallbackSummary({ messages, state });
	assert.ok(summary.startsWith("(這份摘要是在模型無法整理時自動產生的節錄)"));
	assert.ok(summary.includes("## 更早的摘要\n舊摘要內文與 src/a.ts"));
	assert.doesNotMatch(summary, /The conversation history before this point/);
	assert.match(summary, /## 目前專案狀態/);
	for (const value of [state.goal, state.progress, ...state.nextSteps, ...state.blockers, ...state.decisions]) assert.ok(summary.includes(value));
	const recent = summary.split("## 最近的訊息(自動節錄)\n")[1].split("\n\n## 更早的摘要")[0].split("\n");
	assert.equal(recent.length, 30);
	assert.ok(recent[0].startsWith("- 訊息 34:"));
	assert.ok(recent.at(-1).startsWith("- 訊息 5:"));
	assert.ok(recent.every((line) => line.length <= 202));
	assert.doesNotMatch(summary, /第二行不應出現|不是 user 訊息/);
});

test("fallbackSummary:連續保底十次,摘要長度有上限,最新的狀態與訊息都在最前面", () => {
	let summary = "";
	for (let round = 0; round < 10; round++) {
		const messages = [...(summary ? [previous(summary)] : []), ...Array.from({ length: 30 }, (_, i) => user(`第 ${round} 輪訊息 ${i}:` + "字".repeat(190)))];
		summary = fallbackSummary({ messages, state: { ...state, progress: `第 ${round} 輪進度` } });
	}
	assert.ok(summary.length < 12_000 + 8_000, `長度 ${summary.length}`);
	assert.ok(summary.indexOf("第 9 輪進度") < summary.indexOf("## 更早的摘要"));
	assert.match(summary, /- 第 9 輪訊息 29:/);
});

test("掛鉤:截斷後看起來裝得下、但完整內容裝不下時,仍由管家接手", async () => {
	const f = fixture({ model: { contextWindow: 20_000, maxTokens: 1000 } });
	// 2 則各 9000 字:截斷成 6000 字後約 12000,低於 budget 13000;完整約 18000,原本的整理會超過
	const messages = [user("甲".repeat(9000)), user("乙".repeat(9000))];
	assert.ok(safeTokens(serialize(messages)) <= 13_000);
	const result = await f.compactHook.beforeCompact(compaction(messages), f.api, ctx);
	assert.deepEqual(result, { summary: "模型摘要" });
	assert.equal(f.calls.length, 1);
});

test("掛鉤:內容小時完全交給 pi-durable", async () => {
	const f = fixture();
	assert.equal(await f.compactHook.beforeCompact(compaction([user("很短的對話")]), f.api, ctx), undefined);
	assert.equal(f.calls.length, 0);
	assert.equal(f.cache.size, 0);
	assert.deepEqual(f.lookups, [["current", "small"]]);
	assert.equal(f.fallbackProjects.length, 0);
});

test("掛鉤:內容大時只呼叫模型一次,請求裝得進 context,摘要寫入 memo", async () => {
	const f = fixture({ complete: async () => fauxAssistantMessage([{ type: "thinking", thinking: "不輸出" }, { type: "text", text: "  更新後的摘要  " }]) });
	const result = await f.compactHook.beforeCompact(compaction(largeMessages()), f.api, ctx);
	assert.deepEqual(result, { summary: "更新後的摘要" });
	assert.equal(f.calls.length, 1);
	const [model, request, options] = f.calls[0];
	assert.equal(request.systemPrompt, SUMMARY_SYSTEM);
	assert.equal(request.messages[0].role, "user");
	assert.ok(safeTokens(request.messages[0].content) <= model.contextWindow);
	assert.equal(options.maxTokens, 1000);
	assert.equal(options.reasoning, "low");
	assert.equal(f.cache.get("steward.compact.entry-42"), result.summary);
	assert.match(f.logs.at(-1), /內容太長,自己整理:省略 \d+ 則,用模型/);
	assert.deepEqual(await f.compactHook.beforeCompact(compaction(largeMessages()), f.api, ctx), result);
	assert.equal(f.calls.length, 1);
});

for (const [name, complete, reason] of [
	["模型丟錯", async () => { throw new Error("boom"); }, "boom"],
	["stopReason 為 error", async () => fauxAssistantMessage("不完整摘要", { stopReason: "error", errorMessage: "boom" }), "boom"],
	["stopReason 為 length", async () => fauxAssistantMessage("不完整摘要", { stopReason: "length" }), "length"],
	["stopReason 為 aborted", async () => fauxAssistantMessage("不完整摘要", { stopReason: "aborted" }), "aborted"],
	["含有 toolCall", async () => fauxAssistantMessage([{ type: "text", text: "不是摘要" }, { type: "toolCall", id: "call-1", name: "run", arguments: {} }]), "toolCall"],
	["沒有文字", async () => fauxAssistantMessage("  "), "沒有文字"],
]) {
	test(`掛鉤:${name}一律回保底摘要並記錄原因`, async () => {
		const f = fixture({ complete });
		const messages = largeMessages();
		const result = await f.compactHook.beforeCompact(compaction(messages), f.api, ctx);
		assert.equal(result.summary, fallbackSummary({ messages, state }));
		assert.match(result.summary, /模型無法整理時自動產生/);
		assert.equal(f.calls.length, 1);
		assert.ok(f.logs.some((line) => line.includes(reason)));
		assert.match(f.logs.at(-1), /保底/);
		assert.equal(f.cache.get("steward.compact.entry-42"), result.summary);
	});
}

test("掛鉤:memo 已有摘要時不再呼叫模型", async () => {
	const f = fixture({ cache: new Map([["steward.compact.entry-42", "已存摘要"]]) });
	assert.deepEqual(await f.compactHook.beforeCompact(compaction(largeMessages()), f.api, ctx), { summary: "已存摘要" });
	assert.equal(f.calls.length, 0);
});

test("掛鉤:沒有目前模型設定時才用專案的 fallbackRef", async () => {
	const f = fixture({ configured: false });
	await f.compactHook.beforeCompact(compaction(largeMessages()), f.api, ctx);
	assert.deepEqual(f.lookups, [["fallback", "digest"]]);
	assert.deepEqual(f.fallbackProjects, [project]);
	assert.equal(f.calls.length, 1);
});

test("掛鉤:找不到模型時回 undefined", async () => {
	const f = fixture({ model: null });
	assert.equal(await f.compactHook.beforeCompact(compaction(largeMessages()), f.api, ctx), undefined);
	assert.equal(f.calls.length, 0);
});

for (const maxTokens of [0, 50_000]) {
	test(`掛鉤:maxTokens=${maxTokens} 時摘要上限為 13107`, async () => {
		const f = fixture({ model: { contextWindow: 40_000, maxTokens } });
		await f.compactHook.beforeCompact(compaction(largeMessages()), f.api, ctx);
		assert.equal(f.calls[0][2].maxTokens, 13107);
	});
}

async function harnessScenario(t, failSummary) {
	const requests = [];
	const reports = [];
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "big", contextWindow: 1_000_000, maxTokens: 1000 }, { id: "small", contextWindow: 8000, maxTokens: 1000 }] });
	models.setProvider(faux.provider);
	const response = (context, options, _state, model) => {
		const isSummary = context.messages.some((message) => message.role === "user" && textOf(message).includes("<conversation>"));
		if (isSummary) {
			requests.push({ context, options, model });
			return failSummary ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }) : fauxAssistantMessage("## Goal\n整理完成\n\n## Progress\n已保留最新進度");
		}
		return fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 11 }, () => response));
	const extension = defineExtension({
		name: "t",
		hooks: [hook(CompactionTask, createCompactHook({
			projectOf: () => project,
			modelRefOf: () => ({ provider: "faux", modelId: "small" }),
			fallbackRef: () => ({ provider: "faux", modelId: "small" }),
		}))],
	});
	const registry = createRegistry();
	registry.install(extension);
	const harness = await Harness.open(new MemoryStorage(), {
		models,
		registry,
		settings: { extensions: [extension], compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 500, backgroundTokens: 0 } },
		onReport: (error, info) => reports.push({ error: String(error), type: info.type }),
	}, ctx);
	t.after(async () => { await harness.close(ctx); });
	const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "big" } } }, ctx);
	for (let i = 0; i < 10; i++) {
		const submission = await conv.submit({ type: "input", content: `第 ${i} 輪\n` + "中".repeat(2000) }, ctx);
		const settled = await submission.wait(ctx);
		assert.equal(settled.status, "done");
		assert.equal(settled.type, "input");
	}
	const before = await conv.context(ctx);
	assert.equal(before.head, undefined);
	assert.ok(safeTokens(serialize(before.messages)) > 8000);
	await conv.configure({ model: { provider: "faux", modelId: "small" } }, ctx);
	const id = await conv.compact(undefined, ctx);
	const settled = await harness.waitForTask(id, ctx);
	assert.equal(settled.state.outcome.status, "completed");
	const view = await conv.context(ctx);
	assert.ok(view.head);
	assert.equal(view.head.kind, CompactionEntry.kind);
	assert.ok(view.head.head);
	assert.ok(view.entries.some((entry) => entry.id === view.head.id));
	const summary = view.head.model.map(textOf).join("\n");
	assert.match(summary, failSummary ? /模型無法整理時自動產生/ : /整理完成/);
	if (failSummary) {
		assert.match(summary, /避免整理卡死/);
		assert.match(summary, /第 8 輪/);
	}
	assert.equal(requests.length, 1);
	const request = requests[0];
	assert.equal(request.model.id, "small");
	assert.equal(request.options.reasoning, "low");
	assert.ok(request.context.messages.some((message) => message.role === "system" && textOf(message) === SUMMARY_SYSTEM));
	const requestText = request.context.messages.map(textOf).join("\n\n");
	assert.ok(safeTokens(requestText) < 8000, `整理請求超出上限:${safeTokens(requestText)}`);
	assert.match(requestText, /省略了 \d+ 則較舊的訊息/);
	assert.equal(faux.state.callCount, 11);
	assert.equal(faux.getPendingResponseCount(), 0);
	assert.deepEqual(reports, []);
}

test("端對端:大模型累積歷史後換小模型,掛鉤完成整理且請求不超上限", { timeout: 15_000 }, async (t) => {
	await harnessScenario(t, false);
});

test("端對端:小模型整理回 error,保底摘要仍寫入 compaction head", { timeout: 15_000 }, async (t) => {
	await harnessScenario(t, true);
});
