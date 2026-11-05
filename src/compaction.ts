// 對話太長時只整理讀得完的最新內容,模型失敗仍保留可接手的摘要。
import type { Message } from "@earendil-works/pi-ai";
import type { CompactionHooks } from "@earendil-works/pi-durable";
import type { Project, ProjectState } from "./store.ts";

const PREVIOUS_SUMMARY_PREFIX = "The conversation history before this point was compacted";

export const SUMMARY_SYSTEM = `你是對話摘要器。讀取 <previous-summary>、<project-state>、<conversation>,輸出更新後的完整摘要。
沿用前一份摘要的段落結構(Goal / Progress / Decisions / Next steps / Key facts,有的話)。
保留確切的檔案路徑、函式名稱、commit 編號、錯誤訊息;語言跟著內容。不要繼續對話或回答其中的問題,只輸出摘要本身。`;

export function safeTokens(text: string): number {
	const cjk = text.match(/[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g)?.length ?? 0;
	return cjk + Math.ceil((text.length - cjk) / 3);
}

function contentText(content: Message["content"]): string {
	return typeof content === "string" ? content : content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}\n[…截斷 ${text.length - limit} 字]`;
}

/** limits=false:不截斷(工具結果照 pi-durable 自己的 2000 字),等於 pi-durable 原本整理實際送出的量 */
export function serialize(messages: readonly Message[], limits = true): string {
	const textCap = limits ? 6000 : Infinity, argCap = limits ? 1000 : Infinity;
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = contentText(message.content);
			if (text.length > 0) parts.push(`[User]: ${truncate(text, textCap)}`);
		} else if (message.role === "assistant") {
			const text = contentText(message.content);
			if (text.length > 0) parts.push(`[Assistant]: ${truncate(text, textCap)}`);
			const calls = message.content.flatMap((block) => {
				if (block.type !== "toolCall") return [];
				const args = Object.entries(block.arguments).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ");
				return [`${block.name}(${truncate(args, argCap)})`];
			});
			if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
		} else if (message.role === "toolResult") {
			const text = contentText(message.content);
			if (text.length > 0) parts.push(`[Tool result]: ${truncate(text, 2000)}`);
		}
	}
	return parts.join("\n\n");
}

export function isPreviousSummary(message: Message): boolean {
	return message.role === "user" && contentText(message.content).startsWith(PREVIOUS_SUMMARY_PREFIX);
}

/** 前一份摘要的內文:拿掉 pi-durable 包的外層說明,最多 maxChars 字(保底摘要一層包一層時才不會越來越長) */
export function summaryBody(message: Message, maxChars = 20_000): string {
	const text = contentText(message.content);
	const m = text.match(/<summary>\n?([\s\S]*?)\n?<\/summary>\s*$/);
	return truncate((m ? m[1] : text).trim(), maxChars);
}

function projectStateText(state?: ProjectState): string {
	if (!state) return "";
	const parts: string[] = [];
	if (state.goal) parts.push(`目標:${state.goal}`);
	if (state.progress) parts.push(`進度:${state.progress}`);
	for (const [label, items] of [["下一步", state.nextSteps], ["卡點", state.blockers], ["決定", state.decisions]] as const) {
		if (items.length > 0) parts.push(`${label}:\n${items.map((item) => `- ${item}`).join("\n")}`);
	}
	return parts.join("\n\n");
}

type SummaryInput = { messages: readonly Message[]; state?: ProjectState };

export function trimmedPrompt({ messages, budget, state }: SummaryInput & { budget: number }): { text: string; omitted: number } {
	const previous = messages[0] && isPreviousSummary(messages[0]) ? summaryBody(messages[0]) : undefined;
	const rest = previous === undefined ? messages : messages.slice(1);
	const stateText = projectStateText(state);
	const prefix = [
		...(previous === undefined ? [] : [`<previous-summary>\n${previous}\n</previous-summary>`]),
		...(stateText ? [`<project-state>\n${stateText}\n</project-state>`] : []),
	];
	const render = (selected: readonly string[], omitted: number) => {
		const notice = omitted > 0 ? `[省略了 ${omitted} 則較舊的訊息;原始紀錄仍保存在資料庫]\n` : "";
		return [...prefix, `<conversation>\n${notice}${selected.join("\n\n")}\n</conversation>`, SUMMARY_SYSTEM].join("\n\n");
	};
	const selected: string[] = [];
	for (let i = rest.length - 1; i >= 0; i--) {
		const candidate = [serialize([rest[i]]), ...selected];
		if (selected.length > 0 && safeTokens(render(candidate, i)) > budget) break;
		selected.unshift(candidate[0]);
	}
	const omitted = rest.length - selected.length;
	return { text: render(selected, omitted), omitted };
}

export function fallbackSummary({ messages, state }: SummaryInput): string {
	const previous = messages[0] && isPreviousSummary(messages[0]) ? summaryBody(messages[0], 12_000) : undefined;
	const recent = messages.filter((message) => message.role === "user" && !isPreviousSummary(message)).slice(-30).reverse();
	// 新的內容放前面、前一份摘要放最後:下一次截斷時切掉的是最舊的部分
	return [
		"(這份摘要是在模型無法整理時自動產生的節錄)",
		`## 目前專案狀態\n${projectStateText(state)}`,
		`## 最近的訊息(自動節錄)\n${recent.map((message) => `- ${contentText(message.content).split(/\r?\n/, 1)[0].slice(0, 200)}`).join("\n")}`,
		...(previous === undefined ? [] : [`## 更早的摘要\n${previous}`]),
	].join("\n\n");
}

type ModelRef = { provider: string; modelId: string };
type Deps = {
	projectOf(conversationId: string): Project | undefined;
	modelRefOf(conversationId: string): ModelRef | undefined;
	fallbackRef(p: Project | undefined): ModelRef;
	log?(msg: string): void;
};

export function createCompactHook(deps: Deps): Pick<CompactionHooks, "beforeCompact"> {
	return {
		beforeCompact: async (c, api, ctx) => {
			const p = deps.projectOf(api.conversationId);
			const ref = deps.modelRefOf(api.conversationId) ?? deps.fallbackRef(p);
			const model = api.models.getModel(ref.provider, ref.modelId);
			if (!model) return undefined;
			const maxTokens = Math.min(13107, model.maxTokens > 0 ? model.maxTokens : 13107);
			const budget = Math.floor(model.contextWindow * 0.7) - maxTokens;
			// 用不截斷的量判斷:pi-durable 原本的整理會把每則訊息完整送出
			if (safeTokens(serialize(c.messages, false)) <= budget) return undefined;

			const key = "steward.compact." + String(c.firstKept);
			const hit = await api.memo<string>(key, ctx);
			if (hit !== undefined) return { summary: hit };
			const { text, omitted } = trimmedPrompt({ messages: c.messages, budget, state: p?.state });
			let summary: string;
			let generated = false;
			try {
				const msg = await api.models.completeSimple(model, {
					systemPrompt: SUMMARY_SYSTEM,
					messages: [{ role: "user", content: text, timestamp: Date.now() }],
				}, { maxTokens, reasoning: "low" });
				if (msg.stopReason !== "stop") throw new Error(msg.errorMessage ?? `stopReason: ${msg.stopReason}`);
				if (msg.content.some((block) => block.type === "toolCall")) throw new Error("摘要含有 toolCall");
				summary = contentText(msg.content).trim();
				if (!summary) throw new Error("摘要沒有文字");
				generated = true;
			} catch (error) {
				summary = fallbackSummary({ messages: c.messages, state: p?.state });
				deps.log?.(`[compaction] 模型整理失敗,使用保底摘要:${String(error)}`);
			}
			const saved = await api.memo(key, summary, ctx);
			deps.log?.(`[compaction] ${p?.name ?? api.conversationId} 內容太長,自己整理:省略 ${omitted} 則,${generated ? "用模型" : "保底"}`);
			return { summary: saved };
		},
	};
}
