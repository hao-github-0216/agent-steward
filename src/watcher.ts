// 監看 herdr:每 10 秒讀一次窗格清單,agent 從「工作中」變成「閒置」且持續一段時間後,
// 讀它的新對話內容送給管家消化。也負責把派出去的工作卡和窗格對上。
import { statSync } from "node:fs";
import { pathInside, samePath } from "./platform.ts";
import { listPanes, type HerdrPane } from "./herdr.ts";
import { resolveProject } from "./projects.ts";
import { syncClosedSpaces, type SpaceSnapshot } from "./spaces.ts";
import type { Steward } from "./steward.ts";
import type { Project, Store } from "./store.ts";
import { deliverHandoffs } from "./branch.ts";
import { offsetSince, paneExcerpt, resolveSession, transcriptExcerpt, transcriptPath, type AgentSessionRef } from "./transcripts.ts";

const POLL_MS = 10_000;
const SETTLE_MS = Number(process.env.STEWARD_SETTLE_MS ?? 90_000); // 閒置多久才算「告一段落」
const FIRST_LOOK_BYTES = 150_000; // 第一次看到某個 session,只回溯這麼多
const PROPOSAL_EVERY_MS = 6 * 3_600_000;

interface PaneTrack {
	status: string;
	workedSinceReport: boolean; // 上次回報後有沒有工作過
	idleSince?: number;
	reporting?: boolean;
}

function sessionRef(pane: HerdrPane): AgentSessionRef | undefined {
	return resolveSession(pane);
}

export class Watcher {
	private tracks = new Map<string, PaneTrack>();
	private timer?: NodeJS.Timeout;
	lastPollAt?: string;
	lastError?: string;
	/** 上一輪看到的 herdr space(id → 名稱):用來發現 space 被關掉 */
	private spaces?: SpaceSnapshot;
	/** 派工後的窗格:agent 一啟動就算在工作,不用等狀態先變 working */
	expectWork = new Set<string>();

	private readonly store: Store;
	private readonly steward: Steward;
	constructor(store: Store, steward: Steward) {
		this.store = store;
		this.steward = steward;
	}

	start(): void {
		const tick = () => {
			this.poll()
				.catch((e) => (this.lastError = String(e)))
				.finally(() => (this.timer = setTimeout(tick, POLL_MS)));
		};
		tick();
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer);
	}

	private async poll(): Promise<void> {
		const panes = listPanes();
		if (!panes) {
			this.lastError = "讀不到 herdr 窗格清單";
			return;
		}
		this.lastPollAt = new Date().toISOString();
		this.lastError = undefined;
		// herdr 關掉 space → 綁定的專案收起來
		try { this.spaces = syncClosedSpaces(this.store, this.spaces, panes); } catch (e) { console.error("[spaces] 同步失敗", e); }
		const seen = new Set<string>();
		const now = Date.now();
		// 窗格被搬到別的 space(不論是管家或使用者搬的)後 ID 會變:用終端機 ID 校正派工中的卡片
		for (const c of this.store.cards()) {
			if (!c.terminalId || (c.column !== "running" && c.column !== "blocked")) continue;
			const p = panes.find((x) => x.terminal_id === c.terminalId);
			if (p && p.pane_id !== c.paneId) this.store.updateCard(c.id, { paneId: p.pane_id });
		}
		for (const pane of panes) {
			if (!pane.agent) continue;
			seen.add(pane.pane_id);
			const status = pane.agent_status ?? "unknown";
			let t = this.tracks.get(pane.pane_id);
			if (!t) {
				t = { status, workedSinceReport: this.expectWork.has(pane.pane_id) };
				this.tracks.set(pane.pane_id, t);
				this.initCursor(pane);
			}
			if (status === "working" || status === "blocked") {
				t.workedSinceReport = true;
				t.idleSince = undefined;
				this.expectWork.delete(pane.pane_id);
			} else if (status === "idle" || status === "done") {
				if (t.idleSince === undefined) t.idleSince = now;
				if (t.workedSinceReport && !t.reporting && now - t.idleSince >= SETTLE_MS) {
					const track = t;
					track.reporting = true;
					this.report(pane)
						.then(() => (track.workedSinceReport = false))
						.catch((e) => {
							// 失敗時讀取進度沒推進;再等一個 SETTLE 週期重試
							this.lastError = `回報失敗 ${pane.pane_id}: ${e}`;
							track.idleSince = Date.now();
						})
						.finally(() => (track.reporting = false));
				}
			}
			t.status = status;
		}
		for (const id of this.tracks.keys()) if (!seen.has(id)) this.tracks.delete(id);
		// 支線「帶回主線」:主線閒下來就送;送出後主線會開始工作,照派工一樣算進回報
		deliverHandoffs(this.store, panes, (paneId) => this.expectWork.add(paneId));
	}

	/**
	 * 第一次讀某個紀錄檔從哪裡開始:一般從最近 150KB;支線的紀錄檔複製了主線的歷史,
	 * 從支線建立的那一刻開始,才不會把主線的舊內容當成新進度。
	 */
	private firstOffset(pane: HerdrPane, path: string): number {
		const branch = this.store.branchOfPane(pane);
		if (branch) return offsetSince(path, Date.parse(branch.createdAt));
		return Math.max(0, statSync(path).size - FIRST_LOOK_BYTES);
	}

	/** 第一次看到某個 session:從最近一段開始讀,不要把整份歷史倒給管家 */
	private initCursor(pane: HerdrPane): void {
		const ref = sessionRef(pane);
		const path = ref ? transcriptPath(ref) : undefined;
		if (!path) return;
		const key = `t:${path}`;
		if (this.store.cursor(key)) return;
		this.store.setCursor(key, { offset: this.firstOffset(pane, path) });
	}

	/** 讀這個窗格上次之後的新內容,交給管家 */
	async report(pane: HerdrPane): Promise<string | undefined> {
		const cwd = pane.foreground_cwd ?? pane.cwd ?? "";
		const project = resolveProject(this.store, cwd);
		const ref = sessionRef(pane);
		const path = ref ? transcriptPath(ref) : undefined;
		// 紀錄檔晚於第一次看到窗格才出現(例如分叉後第一則訊息才建檔):這裡補定起點
		let excerpt = ref && path ? transcriptExcerpt(ref, this.store.cursor(`t:${path}`)?.offset ?? this.firstOffset(pane, path)) : undefined;
		if (!excerpt) excerpt = paneExcerpt(pane.pane_id);
		if (!excerpt) return undefined;
		const found = excerpt;
		const commit = () => this.store.setCursor(found.key, { offset: found.nextOffset, lastReportAt: new Date().toISOString() });
		if (!found.text.trim()) {
			commit();
			return undefined;
		}
		const card = this.store.cards().find((c) => c.paneId === pane.pane_id && (c.column === "running" || c.column === "blocked"));
		const header = [
			`【回報】agent=${pane.agent} 窗格=${pane.pane_id} 目錄=${cwd} 來源=${found.source === "transcript" ? "對話記錄" : "窗格畫面"}`,
			card ? `這個窗格正在執行工作卡 [${card.id}]「${card.title}」,完成標準:${card.doneCriteria}。請判斷是否完成並用 update_card 更新(完成→done,做不下去→blocked 並寫原因)。` : "",
		]
			.filter(Boolean)
			.join("\n");
		const before = JSON.stringify(project.state.nextSteps);
		const answer = await this.steward.send(project, `${header}\n\n${found.text}`, { role: "digest" });
		commit();
		this.store.updateProject(project.id, { lastActivityAt: new Date().toISOString() });
		const after = this.store.project(project.id)!;
		if (JSON.stringify(after.state.nextSteps) !== before) void this.proposalCheck(after);
		return answer;
	}

	/**
	 * 補建:新登記(拆出來)的專案,從「上層專案的現有狀態」+「目前開在這個資料夾的 agent 最近的對話記錄」
	 * 整理出初始狀態。讀對話記錄不推進讀取進度(那段已經記在上層,這裡只是重讀)。
	 */
	async bootstrap(projectId: string): Promise<string> {
		const p = this.store.project(projectId);
		if (!p || p.kind !== "project") throw new Error("unknown project");
		const inside = (dir?: string) => !!dir && pathInside(dir, p.root);
		const parent = this.store
			.projects()
			.filter((x) => x.id !== p.id && x.kind === "project" && x.state.updatedAt && pathInside(p.root, x.root) && !samePath(p.root, x.root))
			.sort((a, b) => b.root.length - a.root.length)[0];
		const parts: string[] = [];
		if (parent) {
			const s = parent.state;
			parts.push(
				`【上層專案「${parent.name}」(${parent.root})的現有狀態】只挑跟「${p.name}」這個子資料夾有關的部分,其他子資料夾的事不要寫進來:`,
				`目標:${s.goal}\n進度:${s.progress}\n下一步:\n${s.nextSteps.map((x) => `- ${x}`).join("\n")}\n卡點:\n${s.blockers.map((x) => `- ${x}`).join("\n")}\n決定:\n${s.decisions.map((x) => `- ${x}`).join("\n")}`,
				`最近的工作:\n${s.recent.map((r) => `- ${r.at} ${r.agent}:${r.summary}`).join("\n")}`,
			);
		}
		for (const pane of listPanes() ?? []) {
			if (!pane.agent || !inside(pane.foreground_cwd ?? pane.cwd)) continue;
			const ref = sessionRef(pane);
			const path = ref ? transcriptPath(ref) : undefined;
			const excerpt = ref && path ? transcriptExcerpt(ref, Math.max(0, statSync(path).size - FIRST_LOOK_BYTES)) : paneExcerpt(pane.pane_id);
			if (excerpt?.text.trim()) parts.push(`【${pane.agent} 窗格 ${pane.pane_id} 最近的對話記錄】\n${excerpt.text}`);
		}
		if (!parts.length) return "找不到可以補建的資料:上層專案沒有紀錄,這個資料夾裡也沒有開著的 agent。";
		const msg = `【回報】這是剛從上層專案拆出來的新專案「${p.name}」(${p.root}),請用下面的資料建立它的初始狀態(呼叫 update_project_state,goal 也要填)。session_summary 寫「從現有記錄補建」。\n\n${parts.join("\n\n")}`;
		const answer = await this.steward.send(p, msg, { role: "digest" });
		this.store.updateProject(p.id, { lastActivityAt: new Date().toISOString() });
		return answer;
	}

	/** 下一步有變時,讓 gpt 看一次要不要提案;同一專案 6 小時最多一次,隱私/雜務不做 */
	private async proposalCheck(p: Project): Promise<void> {
		if (p.kind !== "project" || p.private) return;
		if (p.lastProposalCheckAt && Date.now() - Date.parse(p.lastProposalCheckAt) < PROPOSAL_EVERY_MS) return;
		this.store.updateProject(p.id, { lastProposalCheckAt: new Date().toISOString() });
		try {
			await this.steward.send(p, "【提案檢查】專案狀態剛更新。看有沒有現在就能派給 agent、而且不碰任何等待放行事項的工作;有就提案一張,沒有就回「無」。", { role: "judge" });
		} catch (e) {
			this.lastError = `提案檢查失敗 ${p.name}: ${e}`;
		}
	}

	status() {
		return {
			lastPollAt: this.lastPollAt,
			lastError: this.lastError,
			panes: [...this.tracks.entries()].map(([id, t]) => ({ id, ...t })),
		};
	}
}
