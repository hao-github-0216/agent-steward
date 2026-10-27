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
			tools: [updateState, listCards, proposeCard, updateCard],
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
