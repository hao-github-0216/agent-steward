// 支線:在某個 agent 窗格旁邊開另一個 agent,接著主線的對話繼續(分叉),用來另外問問題或做事,不打擾主線。
//  - Claude Code / pi / Codex:真正分叉(--resume --fork-session / --fork / fork)
//  - 其他 agent,或找不到主線的 session:開同一種 agent 的新對話,第一則訊息帶主線的節錄(tab 名稱標「節錄」)
//  - 預設開在獨立的 git worktree(檔案跟主線分開,見 worktree.ts);非 git、隱私專案或使用者要求時開在同一個資料夾
//  - 「帶回主線」:管家把支線整理成結論(worktree 附上改動和套用方式),使用者確認後,等主線閒下來送進去
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { brief } from "./brief.ts";
import { herdrCli, listPanes, listWorkspaces, type HerdrPane } from "./herdr.ts";
import { resolveProject } from "./projects.ts";
import type { Steward } from "./steward.ts";
import type { Branch, Store } from "./store.ts";
import { codexForkOf, paneExcerpt, resolveSession, transcriptExcerpt, transcriptPath, transcriptSince } from "./transcripts.ts";
import { createWorktree, discardWorktree, removeWorktree, worktreeBlocker, worktreeChanges, type WorktreeInfo } from "./worktree.ts";

export class BranchError extends Error {}

const cwdOf = (p: HerdrPane) => p.foreground_cwd ?? p.cwd ?? "";
const tabLabel = (tabId: string) => (herdrCli(["tab", "get", tabId])?.result?.tab?.label as string | undefined) ?? tabId;

/**
 * 要分叉哪個窗格:
 *  - 指定的窗格有 agent → 就是它(在 Claude Code 裡打 `! steward branch` 時就是那個 Claude)
 *  - 否則看同一個 space:焦點所在的窗格有 agent 就用它;只有一個 agent 也用它;好幾個就請使用者指定
 */
export function pickMainPane(opts: { pane?: string; workspace?: string }, panes = listPanes() ?? []): HerdrPane {
	const given = opts.pane ? panes.find((p) => p.pane_id === opts.pane) : undefined;
	if (given?.agent) return given;
	// herdr 每個 space 各有一個焦點窗格:沒指定 space 時用 herdr 目前停著的 space
	const ws = given?.workspace_id ?? opts.workspace ?? listWorkspaces().find((w) => w.focused)?.workspace_id;
	const inWs = panes.filter((p) => p.workspace_id === ws && p.agent);
	const focused = inWs.find((p) => p.focused);
	if (focused) return focused;
	if (inWs.length === 1) return inWs[0];
	if (!inWs.length) throw new BranchError(opts.pane && !given ? `找不到窗格 ${opts.pane}` : "這個 space 裡沒有 agent 可以開支線");
	throw new BranchError(`這個 space 有好幾個 agent,請指定要從哪個開支線:\n${inWs.map((p) => `  ${p.pane_id}  ${p.agent}  「${tabLabel(p.tab_id)}」`).join("\n")}`);
}

/** 各 agent 的分叉參數;不支援或缺 session 就回 undefined */
function forkArgs(agent: string, session: { kind?: string; value?: string } | undefined, cwd: string): string[] | undefined {
	if (!session?.value) return undefined;
	// Claude / pi 換了資料夾照樣找得到 session(實測過);Codex 換資料夾會先問要用哪個目錄,用 -C 指定
	if (agent === "claude" && session.kind !== "path") return ["--resume", session.value, "--fork-session"];
	if (agent === "pi") return ["--fork", session.value];
	if (agent === "codex" && session.kind !== "path") return ["fork", "-C", cwd, session.value];
	return undefined;
}

/** 開在 worktree 時給支線 agent 的第一句話:工作目錄換了,舊對話裡主線的路徑要換成 worktree 的 */
function worktreeNote(w: WorktreeInfo, mainCwd: string): string {
	return [
		`【專案管家支線】你現在是支線 agent,工作目錄已換成獨立的 git worktree:${w.cwd}(分支 ${w.gitBranch}),檔案內容和主線開支線當下一樣,包含主線還沒提交的改動。`,
		`主線在 ${mainCwd}:之前對話裡提到主線資料夾的路徑,一律改用 worktree 裡對應的路徑,不要改主線資料夾的檔案。`,
		w.shared.length ? `${w.shared.join("、")} 是連回主線的共用資料夾,不要在裡面安裝或刪除東西。` : "",
	].join("");
}

/** 節錄模式的第一則訊息:主線最近的對話 +(沒有 SessionStart hook 的 agent 再加專案簡報) */
function excerptPrompt(store: Store, main: HerdrPane, mainLabel: string): string {
	const project = resolveProject(store, cwdOf(main));
	const ref = resolveSession(main);
	const path = ref ? transcriptPath(ref) : undefined;
	const ex = (path ? transcriptExcerpt(ref!, Math.max(0, statSync(path).size - 120_000)) : undefined) ?? paneExcerpt(main.pane_id);
	const hasHook = main.agent === "claude" || main.agent === "codex"; // 這兩個開場時管家 hook 已經給了簡報
	return [
		`【專案管家支線】你是從主線「${mainLabel}」(${main.agent},herdr 窗格 ${main.pane_id})開出來的支線 agent,使用者要在這裡另外問問題或做事,不會打擾主線。`,
		"你沒有主線的完整對話,只有下面的節錄;不確定主線做過什麼時,先看檔案或直接問使用者,不要猜。",
		!hasHook && project.kind === "project" ? `\n【專案狀態】\n${brief(store, project)}` : "",
		`\n【主線最近的對話節錄】\n${ex?.text.trim() || "(讀不到主線的內容)"}`,
	]
		.filter(Boolean)
		.join("\n");
}

/** 開一條支線:在主線同一個 space 開新 tab,預設開在獨立的 git worktree;分叉或帶節錄啟動同一種 agent */
export function openBranch(store: Store, mainPaneId: string, opts: { here?: boolean } = {}): Branch {
	const panes = listPanes() ?? [];
	const main = panes.find((p) => p.pane_id === mainPaneId);
	if (!main) throw new BranchError(`找不到窗格 ${mainPaneId}`);
	if (!main.agent) throw new BranchError("這個窗格沒有在跑 agent");
	const agent = main.agent;
	const mainCwd = cwdOf(main);
	const project = resolveProject(store, mainCwd);
	const session = resolveSession(main);
	const id = store.newBranchId();

	// 開在哪裡:預設 worktree;使用者要求、隱私專案(worktree 不在隱私路徑底下,pi 會改走雲端模型)、非 git 就同資料夾
	const hereReason = opts.here ? "使用者選擇同資料夾開" : project.private ? "隱私專案不開 worktree" : worktreeBlocker(mainCwd);
	let wt: WorktreeInfo | undefined;
	if (!hereReason) {
		try {
			wt = createWorktree(mainCwd, project.id, id);
		} catch (e) {
			throw new BranchError(`建立 worktree 失敗:${(e as Error).message}(可以改用「同資料夾開」)`);
		}
	}
	const cwd = wt?.cwd ?? mainCwd;
	const cleanup = () => {
		if (wt) discardWorktree(wt);
	};

	const args = forkArgs(agent, session, cwd);
	const mode: Branch["mode"] = args ? "fork" : "excerpt";
	// 從支線再開支線:沿用最原始的主線名稱,tab 名稱才不會越疊越長
	const parent = store.branchOfPane(main);
	const mainLabel = parent?.mainLabel ?? tabLabel(main.tab_id);
	const n = store.branches().filter((b) => (main.terminal_id ? b.mainTerminalId === main.terminal_id : b.mainPaneId === main.pane_id)).length + 1;
	const tags = [mode === "excerpt" ? "節錄" : "", wt ? "" : "同資料夾"].filter(Boolean);
	const label = `支線${tags.length ? `(${tags.join("·")})` : ""}:${mainLabel} #${n}`.slice(0, 48);

	const created = herdrCli(["tab", "create", "--workspace", main.workspace_id, "--cwd", cwd, "--label", label]);
	const pane = created?.result?.root_pane as HerdrPane | undefined;
	if (!pane?.pane_id) {
		cleanup();
		throw new BranchError(`開 tab 失敗:${JSON.stringify(created?.error ?? created).slice(0, 200)}`);
	}
	const createdAt = new Date().toISOString();
	// 節錄模式:Claude Code / Codex 把節錄當啟動參數帶進去(Claude 不帶參數啟動可能先進 session 清單,不是對話);
	// 其他 agent 啟動後再送
	// 節錄可能很長、有換行和各種符號,直接當參數或打字送出都不可靠:存成檔案,只送一句短訊息請它去讀
	let intro: string | undefined;
	if (mode === "excerpt") {
		const dir = join(DATA_DIR, "branches");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, `${Date.now().toString(36)}.md`);
		writeFileSync(file, `${excerptPrompt(store, main, mainLabel)}${wt ? `\n\n${worktreeNote(wt, mainCwd)}` : ""}`);
		intro = `【專案管家支線】你是從主線「${mainLabel.replace(/["'`$\\]/g, "")}」開出來的支線 agent${wt ? `,工作目錄是獨立的 git worktree ${wt.cwd}` : ""}。請先讀 ${file} (主線最近的對話節錄與說明),讀完只回覆「已了解主線脈絡,請問要問什麼?」,先不要動手做任何事。`;
	} else if (wt) {
		// 分叉到 worktree:舊對話以為自己還在主線資料夾,開場就提醒(只一行,當啟動參數送)
		intro = `${worktreeNote(wt, mainCwd)}讀完只回覆「已切換到支線 worktree,請問要問什麼?」,先不要動手做任何事。`;
	}
	// Claude Code / Codex / pi 都能把第一句話當啟動參數;其他 agent 啟動後再送
	const introAsArg = !!intro && (agent === "claude" || agent === "codex" || (agent === "pi" && mode === "fork"));
	const agentArgs = [...(args ?? []), ...(introAsArg ? [intro!] : [])];
	const started = herdrCli(["agent", "start", `branch-${Date.now().toString(36)}`, "--kind", agent, "--pane", pane.pane_id, "--timeout", "60000", ...(agentArgs.length ? ["--", ...agentArgs] : [])], 70_000);
	// agent 啟動時停在確認畫面(例如 Claude Code 問要不要用專案的 MCP 伺服器):支線留著,請使用者去那個 tab 確認;
	// 開場訊息已經在啟動參數裡,確認後會照常送出
	const waitingUser = started?.error?.code === "agent_not_ready" && /blocked/i.test(String(started.error.message ?? ""));
	if (started?.error && !waitingUser) {
		herdrCli(["tab", "close", pane.tab_id]);
		cleanup();
		throw new BranchError(`啟動 ${agent} 失敗:${String(started.error.message ?? "").slice(0, 300)}`);
	}
	if (intro && !introAsArg && !waitingUser) {
		const sent = herdrCli(["agent", "prompt", pane.pane_id, intro], 20_000);
		if (sent?.error) console.error("[branch] 送節錄失敗", String(sent.error.message ?? "").slice(0, 200));
	}
	herdrCli(["agent", "focus", pane.pane_id]);
	return store.addBranch({
		id,
		projectId: project.id,
		placement: wt ? "worktree" : "here",
		hereReason,
		worktree: wt ? { path: wt.path, cwd: wt.cwd, repoRoot: wt.repoRoot, gitBranch: wt.gitBranch, base: wt.base, shared: wt.shared } : undefined,
		n,
		agent,
		mode,
		label,
		mainLabel,
		mainPaneId: main.pane_id,
		mainTerminalId: main.terminal_id,
		mainSession: session?.value,
		paneId: pane.pane_id,
		terminalId: pane.terminal_id,
		tabId: pane.tab_id,
		startupNote: waitingUser ? `${agent} 啟動時停在確認畫面(例如要不要使用專案的 MCP 伺服器),請到「${label}」那個 tab 確認` : undefined,
		createdAt,
	});
}

/** 支線自己的紀錄檔(分叉後才會建立,找到就記下來) */
export function branchTranscript(store: Store, b: Branch, pane?: HerdrPane): string | undefined {
	if (b.transcript) return b.transcript;
	let path: string | undefined;
	if (pane) {
		const ref = resolveSession(pane);
		path = ref ? transcriptPath(ref) : undefined;
	}
	if (!path && b.agent === "codex" && b.mode === "fork" && b.mainSession) path = codexForkOf(b.mainSession, Date.parse(b.createdAt));
	if (path) store.updateBranch(b.id, { transcript: path });
	return path;
}

/** 支線開出來之後的內容(不含從主線複製過來的歷史) */
export function branchContent(store: Store, b: Branch): string {
	const pane = (listPanes() ?? []).find((p) => (b.terminalId ? p.terminal_id === b.terminalId : p.pane_id === b.paneId));
	const path = branchTranscript(store, b, pane);
	if (path) {
		try {
			const text = transcriptSince(path, Date.parse(b.createdAt));
			if (text.trim()) return text;
		} catch {
			/* 讀不到就退回窗格畫面 */
		}
	}
	if (pane) return paneExcerpt(pane.pane_id)?.text ?? "";
	return "";
}

/** 擬「帶回主線」的草稿 */
export async function draftHandoff(store: Store, steward: Steward, id: string): Promise<string> {
	const b = store.branch(id);
	if (!b) throw new BranchError("找不到這條支線");
	const project = store.project(b.projectId);
	if (!project) throw new BranchError("找不到專案");
	const content = branchContent(store, b);
	const changes = b.worktree && !b.worktree.removed ? worktreeChanges(b.worktree) : undefined;
	if (!content.trim() && !changes?.files.length) throw new BranchError("支線裡還沒有任何內容可以帶回");
	const changeText = changes?.files.length ? `\n\n【支線在 worktree 改的檔案(相對於開支線時)】\n${changes.stat}\n\n${changes.diff.slice(0, 20_000)}` : "";
	const summary = await steward.handoffDraft(project, { label: b.label, mainLabel: b.mainLabel }, `${content}${changeText}`);
	const draft = `${summary}${b.worktree ? `\n\n${worktreeFooter(b, changes?.files ?? [])}` : ""}`;
	store.updateBranch(id, { draft });
	return draft;
}

/** worktree 支線的結論附註:改了什麼、怎麼套回主線(固定格式,不交給模型寫,指令才不會錯) */
function worktreeFooter(b: Branch, files: string[]): string {
	const w = b.worktree!;
	if (!files.length) return `(支線開在 git worktree ${w.path},分支 ${w.gitBranch},沒有改任何檔案。)`;
	const ex = w.shared.length ? ` -- . ${w.shared.map((x) => `':(exclude)${x}'`).join(" ")}` : "";
	const list = files.slice(0, 30).map((f) => `- ${f}`).join("\n") + (files.length > 30 ? `\n- …另外 ${files.length - 30} 個` : "");
	return [
		`支線的改動在 git worktree ${w.path}(分支 ${w.gitBranch}),改了 ${files.length} 個檔案:`,
		list,
		`要套到主線:在主線的 repo 根目錄 ${w.repoRoot} 執行 \`git -C "${w.path}" diff ${w.base.slice(0, 12)}${ex} | git apply\`。要不要套用、什麼時候套,先問使用者;套之前先看過內容,有衝突就逐檔處理。`,
		`worktree 移除後改用 \`git diff ${w.base.slice(0, 12)} ${w.gitBranch}${ex} | git apply\`。`,
	].join("\n");
}

const mainPaneOf = (b: Branch, panes: HerdrPane[]) => panes.find((p) => (b.mainTerminalId ? p.terminal_id === b.mainTerminalId : p.pane_id === b.mainPaneId));
export const mainAlive = (b: Branch, panes: HerdrPane[]) => !!mainPaneOf(b, panes)?.agent;

/** 排入「帶回主線」:主線閒著就馬上送,在忙就等 watcher 下一輪 */
export function queueHandoff(store: Store, id: string, text: string, onSent?: (paneId: string) => void): Branch {
	const b = store.branch(id);
	if (!b) throw new BranchError("找不到這條支線");
	if (!text.trim()) throw new BranchError("內容不能空白");
	store.updateBranch(id, { handoff: { text: text.trim(), status: "queued", at: new Date().toISOString() } });
	deliverHandoffs(store, listPanes() ?? [], onSent);
	return store.branch(id)!;
}

/** watcher 每輪呼叫:把排隊中的結論送給已經閒下來的主線 */
export function deliverHandoffs(store: Store, panes: HerdrPane[], onSent?: (paneId: string) => void): void {
	for (const b of store.branches()) {
		if (b.handoff?.status !== "queued") continue;
		const main = mainPaneOf(b, panes);
		if (!main?.agent) {
			store.updateBranch(b.id, { handoff: { ...b.handoff, status: "failed", note: "主線已經關閉" } });
			continue;
		}
		if (main.agent_status !== "idle" && main.agent_status !== "done") continue;
		const text = `【支線結論】來自支線「${b.label}」:\n${b.handoff.text}`;
		const sent = herdrCli(["agent", "prompt", main.pane_id, text], 20_000);
		if (sent?.error) {
			store.updateBranch(b.id, { handoff: { ...b.handoff, status: "failed", note: String(sent.error.message ?? "送出失敗").slice(0, 200) } });
			continue;
		}
		store.updateBranch(b.id, { handoff: { ...b.handoff, status: "sent", sentAt: new Date().toISOString() } });
		onSent?.(main.pane_id);
	}
}

/** 關掉支線的 tab;removeWorktree 時一併移除 worktree(改動先提交到支線分支,分支保留) */
export function closeBranch(store: Store, id: string, opts: { removeWorktree?: boolean } = {}): void {
	const b = store.branch(id);
	if (!b) throw new BranchError("找不到這條支線");
	const pane = (listPanes() ?? []).find((p) => (b.terminalId ? p.terminal_id === b.terminalId : p.pane_id === b.paneId));
	if (pane) {
		const res = herdrCli(["tab", "close", pane.tab_id]);
		if (res?.error) throw new BranchError(String(res.error.message ?? "關閉失敗"));
	}
	if (opts.removeWorktree && b.worktree && !b.worktree.removed) {
		try {
			removeWorktree(b.worktree);
		} catch (e) {
			throw new BranchError(`支線已關閉,但 worktree 沒移除:${(e as Error).message}`);
		}
		store.updateBranch(id, { worktree: { ...b.worktree, removed: true } });
	}
}
