// 工作卡追問:完成/卡住的卡可以接著問做這張卡的 agent(同一個窗格:它記得剛剛做了什麼、也能看檔案或改檔)。
//   進行中的先排隊,這一輪做完(卡片回到完成/卡住)再送;窗格關掉了就開新的 agent,把卡片的紀錄帶過去。
//   agent 回答完(工作過、停下來一小段時間)就把它最後的回答放進對話,卡片回到完成。
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { herdrKindOf } from "./agents.ts";
import { pickWorkspace } from "./dispatch.ts";
import { herdrCli, type HerdrPane } from "./herdr.ts";
import type { Card, CardTurn, Project, Store } from "./store.ts";
import { offsetSince, paneExcerpt, readTranscriptDelta, resolveSession, transcriptPath, type Line } from "./transcripts.ts";

/** 可以追問的欄:完成、卡住;進行中的先排隊 */
export const ASKABLE = new Set(["done", "blocked", "running"]);
const MAX_QUESTION = 8000;
const MAX_REPLY = 20_000;
const MAX_TURNS = 40;
/** agent 停下來多久算回答完(比給管家整理用的 90 秒短,回覆才不會等太久) */
const REPLY_SETTLE_MS = Number(process.env.STEWARD_REPLY_SETTLE_MS ?? 15_000);
/** 送出後一直沒看到 agent 在工作(回得太快,兩次檢查之間就做完了):過了這麼久也去讀回覆 */
const NO_WORK_SEEN_MS = 60_000;

export class FollowUpError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export interface FollowUpHooks {
	/** 送出去了:讓監看把這個窗格算成在工作、開始超時提醒 */
	onSent?: (card: Card, paneId: string, terminalId?: string) => void;
}

/** 監看記下的窗格狀態:停下來的時間、最後一次看到在工作的時間 */
export interface PaneActivity {
	idleSince?: number;
	lastWorkAt?: number;
}

const newId = () => randomUUID().slice(0, 8);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(後面省略)` : s);
const keepLast = (thread: CardTurn[]) => (thread.length > MAX_TURNS ? thread.slice(-MAX_TURNS) : thread);
const firstLine = (s: string) => (s.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 120);

/** 加一個問題(先排隊,送出交給 deliverFollowUps) */
export function askCard(store: Store, cardId: string, text: string): Card {
	const card = store.card(cardId);
	if (!card) throw new FollowUpError(404, "找不到這張卡");
	if (!ASKABLE.has(card.column)) throw new FollowUpError(409, "這張卡還沒做過,不能追問");
	const q = text.trim().slice(0, MAX_QUESTION);
	if (!q) throw new FollowUpError(400, "請輸入問題");
	const turn: CardTurn = { id: newId(), role: "user", text: q, at: new Date().toISOString(), status: "queued" };
	return store.updateCard(card.id, { thread: keepLast([...(card.thread ?? []), turn]) });
}

/** 取消還沒送出的問題(排隊中、送不出去的) */
export function cancelQuestion(store: Store, cardId: string, id: string): Card {
	const card = store.card(cardId);
	if (!card) throw new FollowUpError(404, "找不到這張卡");
	const t = card.thread?.find((x) => x.id === id && x.role === "user");
	if (!t) throw new FollowUpError(404, "找不到這個問題");
	if (t.status !== "queued" && t.status !== "failed") throw new FollowUpError(409, "已經送出去了,不能取消");
	return store.updateCard(card.id, { thread: card.thread!.filter((x) => x.id !== id) });
}

/** 送不出去的問題再排一次 */
export function retryQuestion(store: Store, cardId: string, id: string): Card {
	const card = store.card(cardId);
	if (!card) throw new FollowUpError(404, "找不到這張卡");
	const t = card.thread?.find((x) => x.id === id && x.role === "user");
	if (!t || t.status !== "failed") throw new FollowUpError(409, "這個問題不需要重送");
	return store.updateCard(card.id, { thread: card.thread!.map((x) => (x.id === id ? { ...x, status: "queued" as const, note: undefined } : x)) });
}

/** 這張卡的窗格:有終端機 ID 就只用它找(窗格搬過 space 也找得到,也不會認錯成重用同一個 ID 的別的窗格) */
function paneOf(card: Card, panes: HerdrPane[]): HerdrPane | undefined {
	if (card.terminalId) return panes.find((p) => p.terminal_id === card.terminalId);
	return card.paneId ? panes.find((p) => p.pane_id === card.paneId) : undefined;
}

/** 每輪監看、使用者問完都叫:能送的問題就送出去 */
export function deliverFollowUps(store: Store, panes: HerdrPane[], hooks: FollowUpHooks = {}): void {
	for (const card of store.cards()) {
		if (!card.thread?.length) continue;
		// 等回覆中的問題,卡片卻已經不在進行中(超時被改成卡住、被手動移走):算沒回答到,下一題才送得出去
		const stale = card.column !== "running" && card.thread.find((t) => t.status === "sent");
		if (stale) {
			store.updateCard(card.id, { thread: card.thread.map((t) => (t.id === stale.id ? { ...t, status: "failed" as const, note: "沒有收到回覆" } : t)) });
			continue;
		}
		const q = card.thread.find((t) => t.role === "user" && t.status === "queued");
		if (!q) continue;
		// 這一輪還沒做完(進行中、派工中)就先等,做完卡片回到完成/卡住再送
		if (card.column !== "done" && card.column !== "blocked") continue;
		const pane = paneOf(card, panes);
		try {
			if (pane?.agent) {
				// agent 正在做別的事(使用者自己在用)或在等核准:先等
				const st = pane.agent_status ?? "unknown";
				if (st === "working" || st === "blocked") continue;
				const c = withOriginal(store, card, pane);
				send(store, c, q, pane.pane_id, pane.terminal_id, continuePrompt(c, q), hooks);
			} else {
				restart(store, withOriginal(store, card, undefined), q, pane, hooks);
			}
		} catch (e) {
			markFailed(store, card.id, q.id, `送不出去:${String((e as Error)?.message ?? e).slice(0, 200)}`);
		}
	}
}

/** 第一次追問:先把「原本的結果」記在對話最上面(agent 那一輪最後的回答;讀不到就用當時的最新狀態) */
function withOriginal(store: Store, card: Card, pane: HerdrPane | undefined): Card {
	if (card.thread?.some((t) => t.role === "agent")) return card;
	const text = (pane ? lastRoundReply(pane) : "") || card.note || "";
	if (!text.trim()) return card;
	const original: CardTurn = { id: newId(), role: "agent", text: clip(text, MAX_REPLY), at: card.updatedAt, original: true };
	return store.updateCard(card.id, { thread: [original, ...(card.thread ?? [])] });
}

function send(store: Store, card: Card, q: CardTurn, paneId: string, terminalId: string | undefined, text: string, hooks: FollowUpHooks): void {
	const r = herdrCli(["agent", "prompt", paneId, text], 20_000);
	if (r?.error) return markFailed(store, card.id, q.id, `送不出去:${String(r.error.message ?? "").slice(0, 200)}`);
	const now = new Date().toISOString();
	const thread = card.thread!.map((t) => (t.id === q.id ? { ...t, status: "sent" as const, sentAt: now, note: undefined } : t));
	const c = store.updateCard(card.id, { thread, column: "running", paneId, ...(terminalId ? { terminalId } : {}), note: "追問中,等 agent 回覆…" });
	hooks.onSent?.(c, paneId, terminalId);
}

/** 窗格關掉了(或 agent 已經結束):開新的 agent(同一種),把卡片的紀錄和這次的問題帶過去 */
function restart(store: Store, card: Card, q: CardTurn, pane: HerdrPane | undefined, hooks: FollowUpHooks): void {
	const project = store.project(card.projectId);
	if (!project) return markFailed(store, card.id, q.id, "找不到這張卡的專案");
	const kind = herdrKindOf(card.agent) ?? "pi";
	let paneId = pane?.pane_id;
	let terminalId = pane?.terminal_id;
	if (!paneId) {
		const ws = pickWorkspace(store, project);
		const created = herdrCli(["tab", "create", "--workspace", ws, "--cwd", project.root, "--label", `#${card.id} 追問 ${card.title}`.slice(0, 40), "--no-focus"]);
		paneId = created?.result?.root_pane?.pane_id;
		terminalId = created?.result?.root_pane?.terminal_id;
		if (!paneId) return markFailed(store, card.id, q.id, `開 tab 失敗:${JSON.stringify(created?.error ?? created).slice(0, 200)}`);
	}
	const n = (card.thread ?? []).filter((t) => t.role === "user" && (t.status === "sent" || t.status === "answered")).length + 1;
	const started = herdrCli(["agent", "start", `steward-${card.id}-q${n}`, "--kind", kind, "--pane", paneId, "--timeout", "60000"], 70_000);
	if (started?.error) return markFailed(store, card.id, q.id, `啟動 ${kind} 失敗:${String(started.error.message ?? "").slice(0, 200)}`);
	send(store, store.card(card.id) ?? card, q, paneId, terminalId, historyPrompt(card, project, q), hooks);
}

function markFailed(store: Store, cardId: string, turnId: string, note: string): void {
	const card = store.card(cardId);
	if (!card?.thread) return;
	store.updateCard(cardId, { thread: card.thread.map((t) => (t.id === turnId ? { ...t, status: "failed" as const, note } : t)) });
}

const TAIL = "回答完就停下來;如果因此改了檔案,說明改了什麼。";

/** 送給同一個 agent:它記得剛剛做了什麼,只要說問題 */
export function continuePrompt(card: Card, q: CardTurn): string {
	return [`【專案管家追問 #${card.id}】${card.title}`, "使用者對這張工作卡接著問:", "", q.text, "", TAIL].join("\n");
}

/** 送給新的 agent:帶上這張卡的紀錄 */
export function historyPrompt(card: Card, project: Project, q: CardTurn): string {
	const past = (card.thread ?? []).filter((t) => t.id !== q.id && (t.role === "agent" || t.status === "answered"));
	const original = past.find((t) => t.original);
	const rest = past.filter((t) => !t.original);
	return [
		`【專案管家追問 #${card.id}】${card.title}`,
		`專案:${project.name}(${project.root})`,
		"這張工作卡之前由另一個 agent 做過(那個窗格已經關掉),下面是紀錄。先看懂,再回答使用者的新問題。",
		"",
		"【原本的指示】",
		clip(card.instructions || "(沒有)", 4000),
		`【完成標準】${card.doneCriteria}`,
		...(original || card.note ? ["", "【上次的結果】", clip(original?.text ?? card.note ?? "", 4000)] : []),
		...(rest.length ? ["", "【之前的追問】", ...rest.map((t) => `${t.role === "user" ? "問" : "答"}:${clip(t.text, 2000)}`)] : []),
		"",
		"【這次的問題】",
		q.text,
		"",
		TAIL,
	].join("\n");
}

/** agent 這一輪最後的回答:最後一次動作(工具)之後說的話;沒有的話就是這一輪最後一段話 */
export function finalReply(lines: Line[]): string {
	let start = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].role === "user") {
			start = i + 1;
			break;
		}
	}
	const round = lines.slice(start);
	let lastTool = -1;
	round.forEach((l, i) => {
		if (l.role === "tool") lastTool = i;
	});
	const said = (ls: Line[]) => ls.filter((l) => l.role === "assistant").map((l) => l.text.trim()).filter(Boolean);
	const after = said(round.slice(lastTool + 1));
	if (after.length) return after.join("\n\n");
	return said(round).at(-1) ?? "";
}

/** 窗格的對話紀錄檔(找不到就 undefined) */
function transcriptOf(pane: HerdrPane): string | undefined {
	const ref = resolveSession(pane);
	return ref ? transcriptPath(ref) : undefined;
}

/** 剛做完那一輪的回答(第一次追問時記下原本的結果用) */
function lastRoundReply(pane: HerdrPane): string {
	const path = transcriptOf(pane);
	if (!path) return "";
	try {
		const size = statSync(path).size;
		return finalReply(readTranscriptDelta(path, Math.max(0, size - 300_000)).lines);
	} catch {
		return "";
	}
}

/**
 * agent 停下來了:有在等回覆的追問就把回覆放進對話、卡片回到完成。
 * 有對話紀錄的 agent 要讀到回答才算(還沒寫進紀錄就下一輪再看);沒有紀錄的用窗格畫面。
 * 回傳這一輪回答到的卡。
 */
export function collectReplies(store: Store, panes: HerdrPane[], activity: (paneId: string) => PaneActivity | undefined, now = Date.now()): Card[] {
	const answered: Card[] = [];
	for (const card of store.cards()) {
		if (card.column !== "running") continue;
		const q = card.thread?.find((t) => t.status === "sent");
		if (!q?.sentAt) continue;
		const pane = paneOf(card, panes);
		if (!pane?.agent) continue;
		const st = pane.agent_status ?? "unknown";
		if (st === "working" || st === "blocked") continue;
		const a = activity(pane.pane_id);
		const sentAt = Date.parse(q.sentAt);
		const idleSince = Math.max(a?.idleSince ?? now, sentAt);
		if (now - idleSince < REPLY_SETTLE_MS) continue;
		// 送出後要看到 agent 工作過才算回答完;回得太快沒看到的話,等久一點再讀
		if (!((a?.lastWorkAt ?? 0) > sentAt) && now - sentAt < NO_WORK_SEEN_MS) continue;
		const path = transcriptOf(pane);
		let reply = "";
		if (path) {
			reply = finalReply(readTranscriptDelta(path, offsetSince(path, sentAt - 2000)).lines);
			if (!reply.trim()) continue; // 紀錄裡還沒有回答:下一輪再看(一直沒有的話,超時提醒會改成卡住)
		} else {
			reply = paneExcerpt(pane.pane_id)?.text.slice(-4000) ?? "";
		}
		const text = reply.trim() ? clip(reply.trim(), MAX_REPLY) : "(讀不到 agent 的回覆,請到終端機看這個窗格)";
		const thread = keepLast([...card.thread!.map((t) => (t.id === q.id ? { ...t, status: "answered" as const } : t)), { id: newId(), role: "agent" as const, text, at: new Date(now).toISOString() }]);
		answered.push(store.updateCard(card.id, { thread, column: "done", note: `追問有回覆:${firstLine(text)}` }));
	}
	return answered;
}

/** 這張卡最近剛回答完追問(推播、給管家的說明用) */
export function justAnswered(card: Card, now = Date.now(), withinMs = 10 * 60_000): boolean {
	const last = card.thread?.at(-1);
	return !!last && last.role === "agent" && !last.original && now - Date.parse(last.at) < withinMs;
}
