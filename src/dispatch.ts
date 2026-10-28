// 派工:使用者核准工作卡後,在專案對應的 herdr space 開新 tab、啟動指定 agent、送出指示。
import { herdrKindOf } from "./agents.ts";
import { herdrCli, listPanes, listWorkspaces, type HerdrPane } from "./herdr.ts";
import { ownerOf } from "./projects.ts";
import { boundSpace, ensureSpace } from "./spaces.ts";
import type { Card, Project, Store } from "./store.ts";
import { brief } from "./brief.ts";
import type { Watcher } from "./watcher.ts";


/**
 * 找出「屬於這個專案」的窗格,排好優先順序。窗格只算給最貼近它的專案(ownerOf),
 * 所以上層專案不會把子專案的窗格搶走。順序:正在工作的 agent > 其他 agent > 一般 shell,
 * 同等級時最近回報過的優先。
 */
export function projectPanes(store: Store, project: Project): HerdrPane[] {
	const panes = (listPanes() ?? []).filter((p) => ownerOf(store, p.foreground_cwd ?? p.cwd ?? "")?.id === project.id);
	const lastReport = (p: HerdrPane) => {
		const path = p.agent_session?.value;
		const at = path ? (store.cursor(`t:${path}`)?.lastReportAt ?? "") : "";
		return at;
	};
	const rank = (p: HerdrPane) => (p.agent ? (p.agent_status === "working" || p.agent_status === "blocked" ? 0 : 1) : 2);
	return panes.sort((a, b) => rank(a) - rank(b) || lastReport(b).localeCompare(lastReport(a)));
}

/** 派工用的 space:一律用專案綁定的 space,沒有就沿用同名的或新建(一對一) */
export function pickWorkspace(store: Store, project: Project): string {
	return ensureSpace(store, project).space.workspace_id;
}

/**
 * 跳到這個專案:
 *  - 有綁定的 space:優先跳到 space 裡這個專案的窗格;沒有窗格就切到那個 space
 *  - 沒綁定、但有窗格(還沒整理):跳到窗格,並提示去「整理 spaces」
 *  - 沒綁定也沒窗格:建一個 space 再切過去
 */
export function focusProject(store: Store, project: Project, opts: { create?: boolean } = {}): { ok: boolean; where?: string; reason?: string; hint?: string; needCreate?: boolean } {
	const panes = projectPanes(store, project);
	const bound = boundSpace(store, project);
	const tabName = (pane: HerdrPane) => (herdrCli(["tab", "get", pane.tab_id])?.result?.tab?.label as string | undefined) ?? pane.tab_id;
	const go = (pane: HerdrPane) => (pane.agent ? herdrCli(["agent", "focus", pane.pane_id]) : herdrCli(["tab", "focus", pane.tab_id]));
	const spaceName = (id: string) => listWorkspaces().find((w) => w.workspace_id === id)?.label ?? id;
	if (bound) {
		const inside = panes.find((x) => x.workspace_id === bound.workspace_id);
		const res = inside ? go(inside) : herdrCli(["workspace", "focus", bound.workspace_id]);
		if (res?.error) return { ok: false, reason: String(res.error.message ?? "herdr 拒絕切換") };
		const strays = panes.filter((x) => x.workspace_id !== bound.workspace_id).length;
		return { ok: true, where: inside ? `${bound.label} › ${tabName(inside)}` : `${bound.label}`, hint: strays ? `另有 ${strays} 個窗格在別的 space` : undefined };
	}
	if (panes[0]) {
		const res = go(panes[0]);
		if (res?.error) return { ok: false, reason: String(res.error.message ?? "herdr 拒絕切換") };
		return { ok: true, where: `${spaceName(panes[0].workspace_id)} › ${tabName(panes[0])}`, hint: "這個專案還沒有自己的 space,可以用「整理 spaces」" };
	}
	// 自動跳轉不新建 space(使用者按「建立並跳過去」才建)
	if (opts.create === false) return { ok: false, needCreate: true, reason: "這個專案還沒有 herdr space" };
	const { space, created } = ensureSpace(store, project);
	herdrCli(["workspace", "focus", space.workspace_id]);
	return { ok: true, where: `${space.label}${created ? "(新建)" : ""}` };
}

export interface PreviousAttempt {
	column: string; // 上次結束在哪一欄(blocked / done)
	note?: string;
	paneId?: string;
}

function prompt(card: Card, project: Project, previous: PreviousAttempt | undefined, current: string): string {
	const retry = previous
		? [
				"",
				`這是第 ${card.attempts ?? 2} 次派工。上一次${previous.column === "blocked" ? "卡住了" : "被標成完成,但使用者要求重做"}${previous.paneId ? `(在 herdr 窗格 ${previous.paneId})` : ""}。`,
				previous.note ? `上次的結果/卡點:${previous.note}` : "",
				"先確認上次留下的狀態,避免重複做或覆蓋掉已完成的部分。",
			].filter(Boolean)
		: [];
	return [
		`【專案管家派工 #${card.id}】${card.title}`,
		`專案:${project.name}(${project.root})`,
		...retry,
		"",
		card.instructions,
		"",
		`完成標準:${card.doneCriteria}`,
		"做完後簡短說明結果;做不下去就說明卡在哪裡。管家會自動讀取你的對話記錄,不需要另外回報。",
		"",
		"【派工當下的專案狀態】以下是管家目前記錄的最新進度。跟上面的說明有衝突時,以這裡為準,並在回覆裡指出哪裡衝突:",
		current.length > 6000 ? `${current.slice(0, 6000)}\n…(後面省略)` : current,
	].join("\n");
}

export async function dispatchCard(store: Store, watcher: Watcher, input: Card, previous?: PreviousAttempt): Promise<Card> {
	const project = store.project(input.projectId);
	if (!project) throw new Error("找不到專案");
	const attempts = (input.attempts ?? 0) + 1;
	const card = store.updateCard(input.id, { attempts });
	// 看板上的 agent 名稱 → herdr agent start --kind(設定頁「Agent」列的都支援)
	const kind = herdrKindOf(card.agent) ?? "pi";
	const ws = pickWorkspace(store, project);
	const label = `#${card.id}${attempts > 1 ? `(${attempts})` : ""} ${card.title}`.slice(0, 40);
	const created = herdrCli(["tab", "create", ...(ws ? ["--workspace", ws] : []), "--cwd", project.root, "--label", label, "--no-focus"]);
	const paneId: string | undefined = created?.result?.root_pane?.pane_id;
	const terminalId: string | undefined = created?.result?.root_pane?.terminal_id;
	if (!paneId) return store.updateCard(card.id, { column: "blocked", note: `開 tab 失敗:${JSON.stringify(created?.error ?? created).slice(0, 200)}` });

	const started = herdrCli(["agent", "start", `steward-${card.id}-${attempts}`, "--kind", kind, "--pane", paneId, "--timeout", "60000"], 70_000);
	if (started?.error) return store.updateCard(card.id, { column: "blocked", paneId, note: `啟動 ${kind} 失敗:${String(started.error.message ?? "").slice(0, 200)}` });

	watcher.expectWork.add(paneId);
	const sent = herdrCli(["agent", "prompt", paneId, prompt(card, project, previous, brief(store, project))], 20_000);
	if (sent?.error) return store.updateCard(card.id, { column: "blocked", paneId, note: `送出指示失敗:${String(sent.error.message ?? "").slice(0, 200)}` });
	return store.updateCard(card.id, { column: "running", paneId, terminalId, note: `已派給 ${kind}(${paneId})` });
}
