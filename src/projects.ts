// 從工作目錄判斷屬於哪個專案:git 根目錄 > 已登記的資料夾 > 雜務。
import { execFileSync } from "node:child_process";
import { fromGit, pathInside } from "./platform.ts";
import { basename, dirname, join, relative } from "node:path";
import { isAgentTempPath, isPrivatePath, MISC_ROOTS } from "./config.ts";
import type { Project, Store } from "./store.ts";

export const MISC_ROOT = "(雜務)";
export const OVERVIEW_ROOT = "(總覽)";

export function gitRoot(cwd: string): string | undefined {
	try {
		return fromGit(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		}).trim()) || undefined;
	} catch {
		return undefined;
	}
}

export function ensureSpecial(store: Store, root: typeof MISC_ROOT | typeof OVERVIEW_ROOT): Project {
	return (
		store.projectByRoot(root) ??
		store.addProject({
			root,
			name: root === MISC_ROOT ? "雜務" : "總覽",
			kind: root === MISC_ROOT ? "misc" : "overview",
			status: "active",
			private: false,
		})
	);
}

/**
 * 找出 cwd 所屬的專案。非 git、也沒登記過的資料夾會建立一筆 pending,
 * 在看板上問使用者要不要登記;決定前先歸到雜務。
 */
/**
 * 支線的 worktree 放在 ~/.agent-steward/worktrees/ 底下(不在專案資料夾裡),要對回開它的專案。
 * 必須在其他判斷之前:不然 worktree 會被當成一個新的 git 專案自動登記。
 */
function worktreeOwner(store: Store, cwd: string): Project | undefined {
	if (!cwd) return undefined;
	const b = store.branches().find((x) => x.worktree && !x.worktree.removed && pathInside(cwd, x.worktree.path));
	return b ? store.project(b.projectId) : undefined;
}

/**
 * 在 git 的 linked worktree 裡(Claude Code 的 .claude/worktrees/、手動 git worktree add)→ 主資料夾裡對應的位置;不是就回 undefined。
 * 不然 worktree 會被當成新的 git 專案自動登記,agent 在裡面做的事也記不到原本的專案。結果快取一分鐘(窗格輪詢會一直問)。
 */
const linkedCache = new Map<string, { at: number; main?: string }>();
export function linkedWorktreeMain(cwd: string): string | undefined {
	const hit = linkedCache.get(cwd);
	if (hit && Date.now() - hit.at < 60_000) return hit.main;
	let main: string | undefined;
	try {
		const [common, top] = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim().split("\n");
		const c = fromGit(common), t = fromGit(top), here = fromGit(cwd);
		if (c && t && basename(c) === ".git" && dirname(c) !== t) main = join(dirname(c), relative(t, here));
	} catch {
		/* 不是 git 或資料夾不在 */
	}
	linkedCache.set(cwd, { at: Date.now(), main });
	return main;
}

export function resolveProject(store: Store, cwd: string): Project {
	const wt = worktreeOwner(store, cwd);
	if (wt) return active(store, wt);
	const linked = cwd ? linkedWorktreeMain(cwd) : undefined;
	if (linked) return resolveProject(store, linked);
	if (!cwd || MISC_ROOTS.includes(cwd.replace(/\/$/, ""))) return ensureSpecial(store, MISC_ROOT);
	if (isAgentTempPath(cwd)) return ensureSpecial(store, MISC_ROOT);

	// 已登記的資料夾(含它的子資料夾),取最長的那個
	const registered = store
		.projects()
		.filter((p) => p.kind === "project" && (p.status === "active" || p.status === "closed") && pathInside(cwd, p.root))
		.sort((a, b) => b.root.length - a.root.length)[0];

	const root = gitRoot(cwd);
	if (root && !MISC_ROOTS.includes(root)) {
		if (registered && registered.root.length >= root.length) return active(store, registered);
		const own = store.projectByRoot(root);
		// 巢狀 repo 被停止追蹤:裡面的工作算到包住它的已登記專案,不丟到雜務
		if (own?.status === "ignored" && registered) return active(store, registered);
		return active(store, own ?? store.addProject({ root, name: basename(root), kind: "project", status: "active", private: isPrivatePath(root) }));
	}
	if (registered) return active(store, registered);

	// 非 git、沒登記:記一筆 pending(同一個資料夾只問一次),目前先歸雜務
	if (!store.projectByRoot(cwd)) {
		store.addProject({ root: cwd, name: basename(cwd), kind: "project", status: "pending", private: isPrivatePath(cwd) });
	}
	return ensureSpecial(store, MISC_ROOT);
}

/**
 * 這個資料夾「最貼近」的追蹤中專案(不建立任何紀錄,給跳轉/計數用)。
 * 子專案(拆出來的資料夾、巢狀 git repo)優先於上層,所以 course/hw2 的窗格不會算到 course。
 */
export function ownerOf(store: Store, cwd: string): Project | undefined {
	const wt = worktreeOwner(store, cwd);
	if (wt) return wt.kind === "project" && wt.status === "active" ? wt : undefined;
	const linked = cwd ? linkedWorktreeMain(cwd) : undefined;
	if (linked) return ownerOf(store, linked);
	return store
		.projects()
		.filter((p) => p.kind === "project" && p.status === "active" && pathInside(cwd, p.root))
		.sort((a, b) => b.root.length - a.root.length)[0];
}

function active(store: Store, p: Project): Project {
	// 收起來的專案:又有 agent 在裡面做事 → 自動恢復追蹤(space 由跳轉 / 派工 / 整理 spaces 重新綁)
	if (p.status === "closed") return store.updateProject(p.id, { status: "active", closedAt: undefined });
	if (p.status === "ignored") return ensureSpecial(store, MISC_ROOT);
	if (p.status === "pending") return ensureSpecial(store, MISC_ROOT);
	return p;
}
