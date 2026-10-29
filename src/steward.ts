// 管家主體:一個 pi durable Harness,每個專案一條對話(加上「雜務」與「總覽」)。
// 管家只有「改專案狀態 / 提工作卡 / 更新工作卡」三類工具,不能碰檔案或跑指令。
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, defineExtension, defineTask, defineTool, Harness, section } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DB_PATH } from "./config.ts";
import { settings } from "./settings.ts";
import { herdrCli, listPanes } from "./herdr.ts";
import { buildModels, hasFallback, routeFor } from "./models.ts";
import { isCliKind, runCli } from "./agent-cli.ts";
import { brief } from "./brief.ts";
import { recentChat } from "./chat-log.ts";
import { notify } from "./notify.ts";
import { ensureSpecial, OVERVIEW_ROOT } from "./projects.ts";
import type { Card, Project, Store } from "./store.ts";

// 派工超時提醒的節奏(可用環境變數調,測試用)
const WATCH_EVERY_MS = Number(process.env.STEWARD_WATCH_EVERY_MS ?? 15 * 60_000); // 多久醒來檢查一次
const IDLE_LIMIT_MS = Number(process.env.STEWARD_WATCH_IDLE_MS ?? 30 * 60_000); // agent 停下多久還沒完成就算卡住
const HARD_LIMIT_MS = Number(process.env.STEWARD_WATCH_HARD_MS ?? 8 * 3_600_000); // 最長允許做多久

type WatchInput = { cardId: string; paneId: string; startedAt: number; terminalId?: string };
type WatchState = { phase: "check"; idleSince: number | null; askedUser: boolean };

const MAX_RECENT = 12;

const PERSONA = () => `你是「專案管家」,負責追蹤使用者${settings().user.name ? `(${settings().user.name})` : ""}所有專案的進度,讓任何 AI agent(pi、Claude Code、Codex、opencode、Hermes…)換了 session 也能馬上接手。
全程使用繁體中文。

你會收到三種訊息:
1. 【回報】某個 agent 在這個專案剛做完一段工作的對話節錄。請判斷這段工作改變了什麼,然後呼叫 update_project_state 更新專案狀態:
   - progress 寫「現在做到哪」的完整現況(會覆蓋舊值),不是只寫這次做了什麼。
   - nextSteps、decisions、blockers 給完整的新清單(會覆蓋舊值);已完成的下一步要拿掉,過時的卡點要移除。
   - 一定要附 session_summary(一兩句話,寫這段工作做了什麼)。
   - 節錄只是片段,沒把握的事不要寫成事實;純閒聊、沒有實質進展就只附 session_summary。
   - 節錄裡的提問是使用者和那個 agent 之間的對話,不是問你的;不要回答它們,只負責記錄。
2. 【提問】agent 或使用者問專案的事。根據你知道的狀態與歷史回答;不知道就說不知道,不要編。
3. 【工作卡更新】派出去的工作有了結果。用 update_card 更新卡片欄位與說明,並同步更新專案狀態。
4. 【提案檢查】看目前狀態有沒有能立刻派出去的工作。有就 propose_card,沒有就只回「無」。
5. 【派工前更新】使用者剛核准一張較早提出的卡,在那之後專案又有新進展。對照你知道的最新狀態與歷史,呼叫一次 revise_card:
   - 背景、前提、限制過時了就改寫 instructions(要完整、讓沒背景的 agent 也能開工),必要時改標題與完成條件;
   - 卡片已經完成、被取代、或做了會跟最新決定衝突,就 withdraw=true 並說明原因;
   - 還是完全正確就只帶 id 和 reason 說「不用改」。

提案前必須逐條核對專案狀態的「卡點」與「重要決定」:只要工作會碰到任何還在等人放行的事(例如寫檔、改程式、commit、花算力),就不能提案,不管檔案在不在 repo 裡。

提案規則(propose_card):
- 只有在出現「明確、可以獨立交給一個 agent 完成」的下一步時才提案,一次最多一張,並先看 list_cards 避免重複。
- 提案只是建議,使用者核准後才會被派出去;你自己絕對不執行工作。
- instructions 要讓一個完全沒背景的 agent 也能開工;done_criteria 要可驗證。
- 「雜務」與「總覽」對話不提案。

回答要精簡,不要客套。`;

/** 管家對話裡的工作:digest=整理回報、judge=提案檢查/agent 提問(唯一能開卡)、chat=聊天室問答。用哪個模型看設定頁的「路由」 */
export type Role = "digest" | "judge" | "chat";

export class StewardUnanswered extends Error {
	constructor(why: string) {
		super(`管家沒有回答:${why}`);
	}
}

export interface StewardDeps {
	store: Store;
	onCardProposed?: (card: Card, project: Project) => void;
}

export class Steward {
	harness!: Harness;
	private proposeTool: unknown;
	private cardWatch: unknown;
	private models?: Awaited<ReturnType<typeof buildModels>>;
	private configured = new Map<string, string>(); // 對話目前的模型設定,避免每次重設
	private projectByConversation = new Map<string, string>();
	private queue = new Map<string, Promise<unknown>>(); // 同一專案的請求串行

	private readonly deps: StewardDeps;
	constructor(deps: StewardDeps) {
		this.deps = deps;
	}

	async open(): Promise<void> {
		const { store } = this.deps;
		const projectOf = (conversationId: string): Project => {
			const id = this.projectByConversation.get(conversationId);
			const p = id ? store.project(id) : undefined;
			if (!p) throw new Error("這條對話沒有對應的專案");
			return p;
		};

		const updateState = defineTool({
			name: "update_project_state",
			description: "更新這個專案的進度狀態。給的欄位會整個覆蓋舊值;沒給的欄位保持不變。",
			parameters: Type.Object({
				goal: Type.Optional(Type.String({ description: "專案目標(很少需要改)" })),
				progress: Type.Optional(Type.String({ description: "現在做到哪的完整現況" })),
				nextSteps: Type.Optional(Type.Array(Type.String(), { description: "完整的下一步清單" })),
				decisions: Type.Optional(Type.Array(Type.String(), { description: "完整的重要決定清單" })),
				blockers: Type.Optional(Type.Array(Type.String(), { description: "完整的卡點清單" })),
				session_summary: Type.Optional(Type.String({ description: "這段工作做了什麼(一兩句)" })),
				agent: Type.Optional(Type.String({ description: "做這段工作的 agent" })),
			}),
			replay: "safe",
			execute: async (args, api) => {
				const p = projectOf(api.conversationId);
				const { session_summary, agent, ...patch } = args;
				const recent = session_summary
					? [{ at: new Date().toISOString(), agent: agent ?? "?", summary: session_summary }, ...p.state.recent].slice(0, MAX_RECENT)
					: p.state.recent;
				store.updateState(p.id, { ...patch, recent });
				store.updateProject(p.id, { lastActivityAt: new Date().toISOString() });
				return { output: [{ type: "text", text: "已更新" }] };
			},
		});

		const listCards = defineTool({
			name: "list_cards",
			description: "列出這個專案的工作卡(含欄位)",
			parameters: Type.Object({}),
			replay: "safe",
			execute: async (_args, api) => {
				const p = projectOf(api.conversationId);
				const cards = store.cards(p.id).filter((c) => c.column !== "rejected");
				const text = cards.length
					? cards.map((c) => `- [${c.id}] (${c.column}) ${c.title} → ${c.agent}${c.note ? `|${c.note}` : ""}`).join("\n")
					: "(沒有工作卡)";
				return { output: [{ type: "text", text }] };
			},
		});

		const proposeCard = defineTool({
			name: "propose_card",
			description: "提出一張工作單,等使用者核准後才會派給 agent。",
			parameters: Type.Object({
				title: Type.String(),
				agent: Type.String({ description: "建議交給誰:pi / claude / codex / opencode" }),
				instructions: Type.String({ description: "給 agent 的完整指示" }),
				done_criteria: Type.String({ description: "可驗證的完成標準" }),
			}),
			execute: async (args, api) => {
				const p = projectOf(api.conversationId);
				if (p.kind !== "project") return { output: [{ type: "text", text: "雜務/總覽不提案" }] };
				const card = store.addCard({ projectId: p.id, title: args.title, agent: args.agent, instructions: args.instructions, doneCriteria: args.done_criteria });
				this.deps.onCardProposed?.(card, p);
				return { output: [{ type: "text", text: `已提案 ${card.id},等待核准` }] };
			},
		});

		this.proposeTool = proposeCard;

		/**
		 * 派工超時提醒:每張派出去的卡一個 pi durable 任務,睡到時間才醒來檢查,管家重啟後接著等。
		 * 卡片不在進行中(完成、被手動改、重新派工換了窗格)就結束;卡住時改成 blocked(main.ts 會推播)。
		 */
		const CardWatch = defineTask<WatchInput, WatchState, null>({
			name: "steward.cardWatch",
			version: 1,
			initial: () => ({ phase: "check", idleSince: null, askedUser: false }),
			phases: {
				check: async (task, runtime, context) => {
					const done = () => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
					const sleep = (patch: Partial<WatchState> = {}) =>
						runtime.sleepUntil(runtime.now() + WATCH_EVERY_MS, { ...task.state.checkpoint, ...patch, phase: "check" }, context);
					const { cardId, paneId, startedAt, terminalId } = task.input;
					const card = store.card(cardId);
					// 用終端機 ID 比對:窗格被搬到別的 space 時 paneId 會變,終端機 ID 不會
					const same = terminalId ? card?.terminalId === terminalId : card?.paneId === paneId;
					if (!card || card.column !== "running" || !same) return done();
					const blocked = (note: string) => {
						store.updateCard(cardId, { column: "blocked", note });
						return done();
					};
					const now = runtime.now();
					const pane = (terminalId
						? (listPanes() ?? []).find((x) => (x as { terminal_id?: string }).terminal_id === terminalId)
						: herdrCli(["pane", "get", paneId])?.result?.pane) as { agent?: string; agent_status?: string } | undefined;
					if (!pane) return blocked("派工的 tab 已經關掉,工作沒有完成。要繼續就拖回「已核准」重新派工。");
					if (now - startedAt > HARD_LIMIT_MS) return blocked(`已經做了超過 ${Math.round(HARD_LIMIT_MS / 3_600_000)} 小時還沒結束,請去看一下 ${card.paneId ?? paneId}。`);
					const status = pane.agent_status ?? "unknown";
					if (status === "working") return sleep({ idleSince: null });
					if (status === "blocked") {
						// agent 在等使用者核准某個操作:提醒一次,繼續等
						if (!task.state.checkpoint.askedUser) {
							const p = store.project(card.projectId);
							void notify(`⏸ 派出去的工作在等你回應(${p?.name ?? "?"})\n「${card.title}」\nherdr 窗格 ${card.paneId ?? paneId}`);
						}
						return sleep({ askedUser: true, idleSince: null });
					}
					// 閒置 / 已結束 / 偵測不到 agent:停下夠久還沒被判定完成,就算卡住
					const idleSince = task.state.checkpoint.idleSince ?? now;
					if (now - idleSince >= IDLE_LIMIT_MS) {
						const mins = Math.round((now - idleSince) / 60_000);
						return blocked(`agent 已經停下${mins >= 1 ? ` ${mins} 分鐘` : "一段時間"},管家沒有判定完成:可能在等你回覆,或做到一半停了(${card.paneId ?? paneId})。`);
					}
					return sleep({ idleSince });
				},
			},
			abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
		});
		this.cardWatch = CardWatch;

		/** 派工前更新:管家依專案最新狀態改寫舊卡(只能改「正在派工前更新」的卡) */
		const reviseCard = defineTool({
			name: "revise_card",
			description: "派工前更新工作卡:依專案目前的狀態改寫標題、工作說明、完成條件;如果這張卡已經不需要做(或做了會出問題),設 withdraw=true 並說明原因,卡片會退回「提案」不派工。只能用在【派工前更新】的卡。",
			parameters: Type.Object({
				id: Type.String(),
				title: Type.Optional(Type.String()),
				instructions: Type.Optional(Type.String({ description: "完整的新工作說明(會整個取代舊的)" })),
				done_criteria: Type.Optional(Type.String()),
				withdraw: Type.Optional(Type.Boolean({ description: "true = 這張卡不該派出去" })),
				reason: Type.Optional(Type.String({ description: "改了什麼 / 為什麼不派工,給使用者看" })),
			}),
			replay: "safe",
			execute: async (args, api) => {
				const p = projectOf(api.conversationId);
				const card = store.card(args.id);
				if (!card || card.projectId !== p.id) return { output: [{ type: "text", text: "找不到這張卡" }] };
				if (!card.refreshing) return { output: [{ type: "text", text: "這張卡不在派工前更新中,不能改寫" }] };
				if (args.withdraw) {
					store.updateCard(card.id, { column: "proposed", refreshing: false, note: `管家建議先不要派工:${args.reason ?? "依最新進度,這張卡已經不需要或不適合現在做"}` });
					return { output: [{ type: "text", text: "已退回提案" }] };
				}
				store.updateCard(card.id, {
					...(args.title ? { title: args.title } : {}),
					...(args.instructions ? { instructions: args.instructions } : {}),
					...(args.done_criteria ? { doneCriteria: args.done_criteria } : {}),
					revisedAt: new Date().toISOString(),
					note: `已依最新進度更新${args.reason ? `:${args.reason}` : ""},派工中…`,
				});
				return { output: [{ type: "text", text: "已改寫,接著會派工" }] };
			},
		});

		const updateCard = defineTool({
			name: "update_card",
			description: "更新工作卡的狀態(running / blocked / done)與說明。不能核准卡片。",
			parameters: Type.Object({
				id: Type.String(),
				column: Type.Optional(Type.Union([Type.Literal("running"), Type.Literal("blocked"), Type.Literal("done")])),
				note: Type.Optional(Type.String()),
			}),
			replay: "safe",
			execute: async (args, api) => {
				const p = projectOf(api.conversationId);
				const card = store.card(args.id);
				if (!card || card.projectId !== p.id) return { output: [{ type: "text", text: "找不到這張卡" }] };
				if (card.column === "proposed" || card.column === "rejected") return { output: [{ type: "text", text: "未核准的卡不能更新" }] };
				store.updateCard(card.id, { ...(args.column ? { column: args.column } : {}), ...(args.note ? { note: args.note } : {}) });
				return { output: [{ type: "text", text: "已更新" }] };
			},
		});

		const StewardExt = defineExtension({
			name: "steward",
			sections: [
				section("persona", () => PERSONA(), { tag: false }),
				section("project", (input) => {
					const id = input.conversationId ? this.projectByConversation.get(input.conversationId) : undefined;
					const p = id ? store.project(id) : undefined;
					return p ? `專案:${p.name}\n路徑:${p.root}\n類型:${p.kind}` : undefined;
				}),
			],
			tools: [updateState, listCards, proposeCard, updateCard, reviseCard],
			tasks: [CardWatch],
		});

		const registry = createRegistry();
		registry.install(StewardExt);
		const models = await buildModels();
		this.models = models;
		this.harness = await Harness.open(await openNodeSqliteStorage(DB_PATH), {
			models,
			registry,
			settings: {
				extensions: [StewardExt],
				retry: { enabled: true, maxRetries: 6, baseDelayMs: 3000 },
				afterFailedRun: "continue",
				compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 },
			},
			identity: { attribution: { name: "agent-steward", url: "http://localhost" } },
			onReport: (error, info) => console.error("[steward] report", info.type, String(error).slice(0, 300)),
		}, ctx);
		for (const p of store.projects()) if (p.conversationId) this.projectByConversation.set(p.conversationId, p.id);
		this.harness.resume();
	}

	/**
	 * 每項工作用哪個模型:設定頁「路由」(主要/備用)。隱私專案只用「隱私專案」那個模型、不提案。
	 * 只有提案檢查(judge)能開卡;聊天室是純問答。
	 */
	private modelFor(p: Project, role: Role = "judge", fallback = false) {
		const canPropose = !p.private && role === "judge" && p.kind === "project";
		return {
			model: routeFor(role, { private: p.private, fallback }),
			thinkingLevel: "medium" as const,
			modelTools: canPropose ? null : { remove: [this.proposeTool as never] },
		};
	}

	private async ensureConfigured(p: Project, conv: { id: string; configure: (c: never, x: typeof ctx) => Promise<void> }, role: Role, fallback = false) {
		const change = this.modelFor(p, role, fallback);
		const key = `${change.model.provider}/${change.model.modelId}/${change.modelTools ? "noprop" : "prop"}`;
		if (this.configured.get(conv.id) === key) return;
		await conv.configure(change as never, ctx);
		this.configured.set(conv.id, key);
	}

	/** 取得(必要時建立)專案的對話 */
	async conversation(p: Project) {
		const { store } = this.deps;
		if (p.conversationId) {
			const existing = await this.harness.conversation(p.conversationId as never, ctx);
			if (existing) return existing;
		}
		const conv = await this.harness.createConversation({ ownership: { kind: "ownerless" }, agent: this.modelFor(p) as never }, ctx);
		store.updateProject(p.id, { conversationId: conv.id });
		this.projectByConversation.set(conv.id, p.id);
		return conv;
	}

	/** 設定頁改了接口或路由:所有對話下次送訊息時重新選模型 */
	resetModels(): void {
		this.configured.clear();
	}

	/** 隱私設定改變時(例如使用者在看板切換):下次送訊息時重新設定模型 */
	async syncModel(p: Project): Promise<void> {
		if (p.conversationId) this.configured.delete(p.conversationId);
	}

	private serial<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.queue.get(projectId) ?? Promise.resolve();
		const next = prev.catch(() => undefined).then(fn);
		this.queue.set(projectId, next);
		return next;
	}

	/** 送一則訊息給專案對話,等回答,回傳文字。模型失敗會丟 StewardUnanswered。 */
	async send(p: Project, content: string, opts: { role?: Role; requestId?: string; timeoutMs?: number; fallback?: boolean } = {}): Promise<string> {
		const role = opts.role ?? "judge";
		try {
			return await this.sendOnce(p, content, opts);
		} catch (e) {
			// 背景工作(整理回報、提案檢查):主要模型失敗就自動改用備用;聊天室由使用者決定(按「改用備用模型」)
			if (role === "chat" || opts.fallback || p.private || !hasFallback(role)) throw e;
			console.error(new Date().toISOString(), "[steward] 主要模型失敗,改用備用", p.name, role, String((e as Error).message ?? e).slice(0, 200));
			return this.sendOnce(p, content, { ...opts, fallback: true });
		}
	}

	private async sendOnce(p: Project, content: string, opts: { role?: Role; requestId?: string; timeoutMs?: number; fallback?: boolean }): Promise<string> {
		const { role = "judge", requestId, timeoutMs, fallback = false } = opts;
		// 聊天室用的是電腦上的 agent CLI:不經過管家的對話,給它專案簡報和最近的問答
		if (role === "chat") {
			const ref = routeFor("chat", { private: p.private, fallback });
			const cli = this.cliOf(ref.provider);
			if (cli) return runCli(cli, ref.modelId, this.chatSystem(p), content, timeoutMs ?? 180_000).catch((e) => { throw new StewardUnanswered(String((e as Error).message ?? e)); });
		}
		return this.serial(p.id, async () => {
			const conv = await this.conversation(p);
			await this.ensureConfigured(p, conv as never, role, fallback);
			const submission = await conv.submit({ type: "input", content, ...(requestId ? { requestId } : {}) }, ctx);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timedOut = timeoutMs
				? new Promise<"timeout">((ok) => { timer = setTimeout(() => ok("timeout"), timeoutMs); })
				: new Promise<never>(() => {});
			const settled = await Promise.race([submission.wait(ctx), timedOut]).finally(() => clearTimeout(timer));
			if (settled === "timeout") {
				// 模型卡住:中止這一題,後面的問題才不會被擋住
				await (conv as unknown as { abort(c: typeof ctx): Promise<void> }).abort(ctx).catch(() => undefined);
				throw new StewardUnanswered(`等了 ${Math.round(timeoutMs! / 1000)} 秒沒有回應`);
			}
			if (settled.status !== "done" || settled.type !== "input") {
				const why = "reason" in settled ? `${settled.reason} ${JSON.stringify((settled as { detail?: unknown }).detail ?? "").slice(0, 400)}` : settled.status;
				console.error(new Date().toISOString(), "[steward] 沒有回答", p.name, why);
				throw new StewardUnanswered(why);
			}
			const answer = await conv.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
			const msg = answer?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined;
			return (msg?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
		});
	}

	/**
	 * 單次問模型(不寫進任何專案對話):建議問題、產生提交訊息。用路由設定,主要失敗自動改用備用。
	 */
	async oneShot(system: string, user: string, role: "suggest" | "commitmsg" = "commitmsg"): Promise<string> {
		try {
			return await this.oneShotWith(system, user, routeFor(role));
		} catch (e) {
			if (!hasFallback(role)) throw e;
			return this.oneShotWith(system, user, routeFor(role, { fallback: true }));
		}
	}

	/** 用指定的模型問一次(設定頁「測試連線」也用這個) */
	async oneShotWith(system: string, user: string, ref: { provider: string; modelId: string }, maxTokens = 2000): Promise<string> {
		const cli = this.cliOf(ref.provider);
		if (cli) return runCli(cli, ref.modelId, system, user);
		if (!this.models) throw new Error("管家還沒準備好");
		const model = (this.models as unknown as { getModel(p: string, id: string): unknown }).getModel(ref.provider, ref.modelId);
		if (!model) throw new Error(`找不到模型 ${ref.provider}/${ref.modelId}(到設定 → AI 接口確認)`);
		const msg = await (this.models as unknown as { completeSimple(m: unknown, c: unknown, o?: unknown): Promise<{ content?: { type: string; text?: string }[]; errorMessage?: string }> }).completeSimple(
			model,
			{ systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
			{ reasoning: "low", maxTokens },
		);
		if (msg.errorMessage) throw new Error(msg.errorMessage);
		return (msg.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
	}

	/**
	 * 派工前更新:在專案的長期對話(記得完整脈絡)請管家改寫舊卡,等它呼叫 revise_card。
	 * 回傳 "revised" / "withdrawn" / "unchanged"(模型沒呼叫工具或失敗也算 unchanged,照原卡派工)。
	 */
	async refreshCard(p: Project, card: Card): Promise<"revised" | "withdrawn" | "unchanged"> {
		const since = card.revisedAt ?? card.createdAt;
		const msg = `【派工前更新】卡 #${card.id}「${card.title}」(交給 ${card.agent})是 ${since} 寫的,使用者剛核准要派工;在那之後專案已經有新進展。
目前的工作說明:
${card.instructions}

完成條件:${card.doneCriteria}

請依目前的專案狀態呼叫一次 revise_card(id=${card.id})。`;
		try { await this.send(p, msg, { role: "judge", timeoutMs: 180_000 }); } catch { return "unchanged"; }
		const now = this.deps.store.card(card.id);
		if (!now) return "unchanged";
		if (now.column === "proposed") return "withdrawn";
		return now.revisedAt && now.revisedAt > since ? "revised" : "unchanged";
	}

	/**
	 * 支線「帶回主線」:把支線的對話整理成要送回主線 agent 的結論。單次問模型,不寫進專案對話。
	 * 用「整理 agent 回報」的模型(隱私專案用隱私模型),主要失敗自動改用備用。
	 */
	async handoffDraft(p: Project, info: { label: string; mainLabel: string }, content: string): Promise<string> {
		const system = `${PERSONA()}

以下是這個專案目前的狀態:

${brief(this.deps.store, p, { recent: 5 })}

使用者在主線 agent(「${info.mainLabel}」)之外開了一條支線 agent(「${info.label}」)另外問問題或做事。現在要把支線的結論送回主線。規則:
- 寫給主線 agent 看,3 到 8 句或條列,繁體中文。
- 包含:支線問了什麼、得到什麼結論、做了哪些決定、改了哪些檔案(只寫路徑)、還有什麼沒解決。
- 只寫支線裡真的出現過的內容,不要編造;支線沒做任何事就直說。
- 不要開場白、不要客套,直接輸出要送出的內容。`;
		const user = `【支線的對話】\n${content.slice(-60_000)}`;
		const ask = (fallback: boolean) => this.oneShotWith(system, user, routeFor("digest", { private: p.private, fallback }), 2000);
		try {
			return await ask(false);
		} catch (e) {
			if (p.private || !hasFallback("digest")) throw e;
			return ask(true);
		}
	}

	/** 不經過管家對話回答提問時用的系統提示:管家身分 + 專案簡報 + 最近的問答 */
	private chatSystem(p: Project, dropLast = true): string {
		const history = recentChat(p.id, 8).slice(0, dropLast ? -1 : undefined).map((e) => `${e.role === "me" ? "使用者" : "管家"}:${e.text.slice(0, 1500)}`).join("\n");
		return `${PERSONA()}\n\n你現在只負責回答【提問】,沒有任何工具可用。以下是這個專案目前的狀態:\n\n${brief(this.deps.store, p, { recent: 8 })}${history ? `\n\n最近的問答:\n${history}` : ""}`;
	}

	/**
	 * 浮動球「開工作卡」:根據專案狀態、最近的問答、附加的檔案路徑和使用者的指示擬一張草稿。
	 * 用「提案檢查」的模型(隱私專案用隱私模型);previous 有給就是依指示修改那張草稿。
	 */
	async draftCard(p: Project, opts: { instruction: string; files: string[]; agents: string[]; previous?: { title: string; agent: string; instructions: string; doneCriteria: string } }): Promise<{ title: string; agent: string; instructions: string; doneCriteria: string }> {
		const system = `${this.chatSystem(p)}

現在使用者要你擬一張「工作卡」,之後會交給一個 AI agent 去做。規則:
- 標題簡短具體(30 字以內)。
- instructions 要讓一個完全沒背景的 agent 也能開工:寫清楚專案位置(${p.root})、要做什麼、要先讀哪些檔案(只寫路徑,不要貼檔案內容)、有什麼限制;遵守專案狀態裡的重要決定與卡點。
- done_criteria 要可驗證。
- agent 從這些裡面選最適合的一個:${opts.agents.join(" / ") || "pi"}。
- 只輸出一個 JSON 物件:{"title": "…", "agent": "…", "instructions": "…", "done_criteria": "…"},不要其他文字。`;
		const user = [
			opts.previous ? `目前的草稿:\n${JSON.stringify(opts.previous, null, 1)}\n\n請依照使用者的意見修改:${opts.instruction || "(沒有說明,請讓它更清楚完整)"}` : `使用者的指示:${opts.instruction || "(沒有特別說明,請根據最近的問答判斷要做什麼)"}`,
			opts.files.length ? `使用者附上的檔案(請在 instructions 裡要 agent 先讀):\n${opts.files.map((f) => `- ${f}`).join("\n")}` : "",
		].filter(Boolean).join("\n\n");
		const tryRef = async (fallback: boolean) => {
			const ref = routeFor("judge", { private: p.private, fallback });
			const text = await this.oneShotWith(system, user, ref, 4000);
			const m = text.match(/\{[\s\S]*\}/);
			if (!m) throw new Error("模型沒有給出草稿");
			const j = JSON.parse(m[0]) as Record<string, unknown>;
			const str = (k: string) => String(j[k] ?? "").trim();
			if (!str("title") || !str("instructions")) throw new Error("草稿缺少標題或指示");
			const agent = opts.agents.includes(str("agent")) ? str("agent") : (opts.agents[0] ?? "pi");
			return { title: str("title").slice(0, 80), agent, instructions: str("instructions"), doneCriteria: str("done_criteria") || "完成上述要求並說明改了什麼" };
		};
		try { return await tryRef(false); }
		catch (e) {
			if (p.private || !hasFallback("judge")) throw e;
			return tryRef(true);
		}
	}

	/**
	 * 別的專案的 agent 問這個專案的事:用這個專案的簡報、最近問答單次回答,不寫進這個專案的管家對話。
	 * askerPrivate = 發問的專案是隱私專案(問題可能帶有隱私內容)→ 用隱私模型。
	 */
	async askAbout(target: Project, question: string, askerPrivate: boolean): Promise<string> {
		const system = `${this.chatSystem(target, false)}\n\n(這個問題是從另一個專案的 agent 問的,只回答「${target.name}」這個專案的事;需要細節時告訴它專案位置(${target.root}),請它自己去讀檔案。)`;
		const ref = routeFor("chat", { private: askerPrivate });
		const cli = this.cliOf(ref.provider);
		if (cli) return runCli(cli, ref.modelId, system, question);
		return this.oneShotWith(system, question, ref, 4000);
	}

	/** 有圖片的提問:用看得懂圖片的模型單次回答(不寫進管家的對話) */
	async askWithImages(p: Project, content: string, images: { data: string; mimeType: string }[], ref: { provider: string; modelId: string }, timeoutMs = 180_000): Promise<string> {
		if (!this.models) throw new StewardUnanswered("管家還沒準備好");
		const model = (this.models as unknown as { getModel(p: string, id: string): unknown }).getModel(ref.provider, ref.modelId);
		if (!model) throw new StewardUnanswered(`找不到模型 ${ref.provider}/${ref.modelId}`);
		const ask = (this.models as unknown as { completeSimple(m: unknown, c: unknown, o?: unknown): Promise<{ content?: { type: string; text?: string }[]; errorMessage?: string }> }).completeSimple(
			model,
			{ systemPrompt: this.chatSystem(p), messages: [{ role: "user", content: [{ type: "text", text: content }, ...images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }))], timestamp: Date.now() }] },
			{ reasoning: "low", maxTokens: 4000 },
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const msg = await Promise.race([ask, new Promise<never>((_, no) => { timer = setTimeout(() => no(new StewardUnanswered(`等了 ${Math.round(timeoutMs / 1000)} 秒沒有回應`)), timeoutMs); })]).finally(() => clearTimeout(timer));
		if (msg.errorMessage) throw new StewardUnanswered(msg.errorMessage);
		const text = (msg.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
		if (!text) throw new StewardUnanswered("模型沒有回答");
		return text;
	}

	/** 這個接口是不是電腦上的 agent CLI(是的話回傳是哪一個) */
	private cliOf(providerId: string) {
		const c = settings().providers.find((x) => x.id === providerId && x.type === "agent-cli");
		return c && isCliKind(c.cli) ? c.cli : undefined;
	}

	/** 各模型累計 token 用量(整個管家) */
	async usage(): Promise<Record<string, { input: number; output: number; totalTokens: number }>> {
		const u = (await this.harness.usage(ctx)) as { models: Record<string, { input: number; output: number; totalTokens: number }> };
		return Object.fromEntries(Object.entries(u.models).map(([k, v]) => [k, { input: v.input, output: v.output, totalTokens: v.totalTokens }]));
	}

	/** 派工成功後呼叫:建立一個超時提醒任務(掛在「總覽」對話,背景執行不佔住對話) */
	async watchCard(cardId: string, paneId: string, terminalId?: string): Promise<void> {
		const overview = ensureSpecial(this.deps.store, OVERVIEW_ROOT);
		const conv = await this.conversation(overview);
		await conv.commit(
			(tx) => tx.createTask(this.cardWatch as never, { cardId, paneId, terminalId, startedAt: Date.now() } as never, { ownership: { kind: "conversation" }, background: true }),
			ctx,
		);
	}

	/** 目前還在等的派工(給 health 看) */
	async watchedCards(): Promise<number> {
		const g = await this.harness.taskGraph(ctx);
		const value = (g as { value?: { tasks?: Record<string, { kind?: string }> } }).value ?? (g as unknown as { tasks?: Record<string, { kind?: string }> });
		const n = Object.values(value.tasks ?? {}).filter((t) => t.kind === "steward.cardWatch").length;
		(g as { dispose?: () => void }).dispose?.();
		return n;
	}

	async close(): Promise<void> {
		await this.harness.close(ctx);
	}
}
