// 分支總覽的樹狀圖資料:一次給「資料夾樹」和「分岔圖」要的東西。
//  - 資料夾樹:repo → 作業資料夾(已登記的專案)→ worktree / agent 留下的分支。歸屬依序看:從哪個資料夾開的 → 主要改哪個資料夾 → 放「其他」(folder = "")
//  - 分岔圖:主線(目前分支的 first-parent 鏈)只取分岔點、合併點、最新的 commit;每條分支記它從哪個點分出去、有沒有合回、合在哪裡
//  - agent 留下的分支 = worktree 已經移除、但分支還在的 worktree-* / steward/branch-*;一般手動分支不畫
import { join, relative, sep } from "node:path";
import type { Project, Store } from "./store.ts";
import { claudeSessionOfWorktree, listWorktrees, real, run, SAVED_ON_REMOVE, type WorktreeDeps, type WorktreeItem, type WorktreeSession } from "./worktrees.ts";
import { pathInside } from "./platform.ts";
import { HOME } from "./config.ts";

export interface TreeFolder {
	path: string; // 相對 repo 根目錄,例如 "hw1"
	projectId?: string; // 已登記的專案
	name: string;
	current: boolean; // 正在看的專案
}

/** agent 留下、worktree 已經不在的分支 */
export interface LeftoverBranch {
	branch: string;
	head: string;
	source: "claude" | "steward";
	folder: string;
	ahead: number; // 分岔後多了幾個 commit
	merged: boolean;
	/** 移除 worktree 時另存的未提交改動(分支頂端的「移除前保留」commit);判斷有沒有合併時不算它們 */
	savedOnRemove?: { commits: number; files: string[] };
	session?: Pick<WorktreeSession, "agent" | "id" | "originalCwd">;
	lastModified?: string;
}

export interface GraphNode {
	hash: string;
	short: string;
	subject: string;
	date: string;
	gapBefore: number; // 和前一個畫出來的點之間省略了幾個 commit
}
export interface GraphBranch {
	key: string; // worktree 的 id 或 "branch:<名稱>"
	branch: string | null;
	forkAt: number; // nodes 的索引(從哪個點分出去)
	mergedAt?: number; // 合回主線的那個點(nodes 的索引);沒合併就沒有
	ahead: number;
	savedOnRemove?: { commits: number; files: string[] };
}

export interface WorktreeTree {
	repo: true;
	repoRoot: string;
	repoName: string;
	target: string | null;
	currentFolder: string; // 正在看的專案在 repo 裡的位置("" = repo 根目錄)
	folders: TreeFolder[];
	items: (WorktreeItem & { folder: string })[]; // 和 /worktrees 的 items 一樣,多一個 folder;第一個是主資料夾
	leftovers: LeftoverBranch[];
	graph: { nodes: GraphNode[]; branches: GraphBranch[]; truncated: boolean };
	warnings: { unignored: { id: string; path: string; pattern: string }[]; gitlinks: string[] }; // 和 GET worktrees 一樣
}

const MAX_CHAIN = 5000;
const rel = (root: string, path: string) => relative(real(root), real(path)).split(sep).join("/");

/** path 落在哪個已知資料夾(取最深的);都不是就取第一層資料夾 */
function folderOfPath(relPath: string, known: string[]): string {
	const hit = known.filter((f) => relPath === f || relPath.startsWith(`${f}/`)).sort((a, b) => b.length - a.length)[0];
	if (hit !== undefined) return hit;
	const top = relPath.split("/")[0];
	return relPath.includes("/") ? top : "";
}
/** 一組改動的檔案主要落在哪個資料夾(已知資料夾優先,否則用第一層資料夾;只改根目錄的檔案就是 "") */
function majorityFolder(files: string[], known: string[]): string {
	const count = new Map<string, number>();
	for (const f of files) {
		if (f.startsWith(".claude/")) continue; // 誤 commit 的 worktree 之類,不算
		const k = known.filter((x) => f.startsWith(`${x}/`)).sort((a, b) => b.length - a.length)[0] ?? (f.includes("/") ? f.split("/")[0] : undefined);
		if (k) count.set(k, (count.get(k) ?? 0) + 1);
	}
	return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
}

const lines = (s: string) => s.split("\n").filter(Boolean);

/**
 * 分支頂端如果是管家移除 worktree 時另存的 commit(作者 agent-steward、訊息固定),往回跳過它們,
 * 用真正的工作內容判斷有沒有合併;另存的 commit 數和檔案另外回報
 */
async function effectiveHead(repoRoot: string, head: string): Promise<{ head: string; saved?: { commits: number; files: string[] } }> {
	let cur = head;
	let n = 0;
	for (; n < 20; n++) {
		const [an, subj, parent] = (await run(repoRoot, ["show", "-s", "--format=%an%x1f%s%x1f%P", cur])).out.trim().split("\x1f");
		if (an !== "agent-steward" || subj !== SAVED_ON_REMOVE || !parent || parent.includes(" ")) break;
		cur = parent;
	}
	if (!n) return { head };
	return { head: cur, saved: { commits: n, files: lines((await run(repoRoot, ["diff", "--name-only", cur, head])).out) } };
}

export async function worktreeTree(store: Store, p: Project, deps: WorktreeDeps = {}): Promise<WorktreeTree | { repo: false }> {
	const list = await listWorktrees(store, p, deps);
	if (!list.repo) return list;
	const { repoRoot, target } = list;
	const projectsDir = deps.claudeProjectsDir ?? join(HOME, ".claude", "projects");

	// 已登記、在這個 repo 裡的專案 = 資料夾樹的第二層
	const regs = store.projects().filter((x) => x.kind === "project" && (x.status === "active" || x.status === "closed") && pathInside(real(x.root), real(repoRoot)) && real(x.root) !== real(repoRoot));
	const known = regs.map((x) => rel(repoRoot, x.root));
	const currentFolder = list.prefix;

	const changedFiles = async (from: string, to: string) => lines((await run(repoRoot, ["diff", "--name-only", `${from}...${to}`])).out);

	// worktree 的歸屬
	const items = await Promise.all(
		list.items.map(async (x) => {
			if (x.source === "main") return { ...x, folder: "" };
			const b = x.stewardBranchId ? store.branches().find((y) => y.id === x.stewardBranchId) : undefined;
			const from = b ? store.project(b.projectId)?.root : x.session?.originalCwd;
			if (from && pathInside(real(from), real(repoRoot))) {
				const f = folderOfPath(rel(repoRoot, from), known);
				if (f) return { ...x, folder: f };
			}
			let files: string[] = [];
			if (target && x.head) files = await changedFiles(target, x.head);
			if (x.exists) files.push(...lines((await run(x.path, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"])).out).map((l) => l.slice(3)));
			return { ...x, folder: majorityFolder(files, known) };
		}),
	);

	// agent 留下的分支(worktree 不在了)
	const withWt = new Set(items.map((x) => x.branch).filter(Boolean));
	const refs = lines((await run(repoRoot, ["for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)", "refs/heads/worktree-*", "refs/heads/steward/branch-*"])).out);
	const leftovers: LeftoverBranch[] = [];
	for (const l of refs) {
		const [branch, head, date] = l.split("\t");
		if (withWt.has(branch) || branch === target) continue;
		const source = branch.startsWith("steward/") ? "steward" : "claude";
		let session: LeftoverBranch["session"];
		let folder = "";
		if (source === "claude") {
			const cs = claudeSessionOfWorktree(join(repoRoot, ".claude", "worktrees", branch.slice("worktree-".length)), projectsDir);
			if (cs) session = { agent: "claude", id: cs.sessionId, originalCwd: cs.originalCwd };
			if (cs?.originalCwd && pathInside(real(cs.originalCwd), real(repoRoot))) folder = folderOfPath(rel(repoRoot, cs.originalCwd), known);
		} else {
			const sb = store.branches().find((y) => y.worktree?.gitBranch === branch);
			const proot = sb ? store.project(sb.projectId)?.root : undefined;
			if (sb) session = { agent: sb.agent, id: sb.transcript ?? sb.mainSession };
			if (proot && pathInside(real(proot), real(repoRoot))) folder = folderOfPath(rel(repoRoot, proot), known);
		}
		let merged = false;
		let savedOnRemove: LeftoverBranch["savedOnRemove"];
		if (target) {
			const eff = await effectiveHead(repoRoot, head);
			savedOnRemove = eff.saved;
			merged = (await run(repoRoot, ["merge-base", "--is-ancestor", eff.head, target])).code === 0;
			// 合併了:target...head 是空的,改看分支自己的 commit 改了哪裡
			if (!folder) folder = majorityFolder(merged ? lines((await run(repoRoot, ["diff-tree", "-r", "--name-only", "--no-commit-id", "--root", head])).out) : await changedFiles(target, head), known);
		}
		leftovers.push({ branch, head, source, folder, ahead: 0, merged, savedOnRemove, session, lastModified: date || undefined });
	}

	// 資料夾:已登記的,加上有東西歸進去但沒登記的
	const used = new Set([...items.map((x) => x.folder), ...leftovers.map((x) => x.folder)].filter(Boolean));
	const folders: TreeFolder[] = [
		...regs.map((x) => ({ path: rel(repoRoot, x.root), projectId: x.id, name: x.name, current: x.id === p.id })),
		...[...used].filter((f) => !known.includes(f)).map((f) => ({ path: f, name: f, current: f === currentFolder })),
	].sort((a, b) => a.path.localeCompare(b.path));

	const graph = target ? await branchGraph(repoRoot, target, [
		...items.filter((x) => x.source !== "main" && x.head).map((x) => ({ key: x.id, branch: x.branch, head: x.head })),
		...leftovers.map((x) => ({ key: `branch:${x.branch}`, branch: x.branch, head: x.head })),
	]) : { nodes: [], branches: [], truncated: false };
	for (const l of leftovers) l.ahead = graph.branches.find((g) => g.key === `branch:${l.branch}`)?.ahead ?? 0;

	return { repo: true, warnings: list.warnings, repoRoot, repoName: repoRoot.split(/[\\/]/).pop() ?? repoRoot, target, currentFolder, folders, items, leftovers, graph };
}

/**
 * 分岔圖:主線 = target 的 first-parent 鏈(新到舊),在鏈上找每條分支的分岔點與合併點,
 * 只把這些點和最新的 commit 畫出來,中間省略的 commit 數記在 gapBefore。
 * 「最早一個含有 X 的主線 commit」沿著鏈是單調的(含有 X 之後越新的都含有),所以用二分搜尋,每條分支只要幾次 git 呼叫。
 */
async function branchGraph(repoRoot: string, target: string, branches: { key: string; branch: string | null; head: string }[]) {
	const chainOut = lines((await run(repoRoot, ["rev-list", "--first-parent", `--max-count=${MAX_CHAIN}`, "--format=%H%x1f%h%x1f%cI%x1f%s", target])).out).filter((l) => !l.startsWith("commit "));
	const chain = chainOut.map((l) => {
		const [hash, short, date, ...s] = l.split("\x1f");
		return { hash, short, date, subject: s.join("\x1f") };
	}).reverse(); // 舊到新
	const truncated = chain.length >= MAX_CHAIN;
	const isAnc = async (a: string, b: string) => (await run(repoRoot, ["merge-base", "--is-ancestor", a, b])).code === 0;
	/** 主線上最早一個含有 commit 的位置;都不含回 -1 */
	const firstContaining = async (commit: string) => {
		if (!chain.length || !(await isAnc(commit, chain[chain.length - 1].hash))) return -1;
		let lo = 0, hi = chain.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (await isAnc(commit, chain[mid].hash)) hi = mid;
			else lo = mid + 1;
		}
		return lo;
	};
	const raw: { key: string; branch: string | null; fork: number; merged?: number; ahead: number; savedOnRemove?: { commits: number; files: string[] } }[] = [];
	for (const b0 of branches) {
		const eff = await effectiveHead(repoRoot, b0.head);
		const b = { ...b0, head: eff.head };
		// 先看有沒有合回主線:主線上最早含有分支頂端的位置,而且那個 commit 不是分支頂端本身(是的話代表分支就在主線上,沒有自己的 commit)
		const at = await firstContaining(b.head);
		const merged = at >= 0 && chain[at].hash !== b.head ? at : undefined;
		// 分岔點:沒合併 = merge-base(主線, 分支);合併了 = merge-base(合併前一個主線 commit, 分支)
		const against = merged !== undefined ? (merged > 0 ? chain[merged - 1].hash : undefined) : target;
		const base = against ? (await run(repoRoot, ["merge-base", against, b.head])).out.trim() : "";
		const ahead = base ? Number((await run(repoRoot, ["rev-list", "--count", `${base}..${b.head}`])).out.trim()) || 0 : 0;
		let fork = at >= 0 && merged === undefined ? at : base ? await firstContaining(base) : -1;
		if (fork < 0) fork = 0; // 分岔點比畫得到的主線還舊:接在最舊的點
		raw.push({ key: b.key, branch: b.branch, fork, merged, ahead, savedOnRemove: eff.saved });
	}
	// 只留關鍵點:分岔點、合併點、最新
	const keep = [...new Set([...raw.flatMap((x) => [x.fork, ...(x.merged !== undefined ? [x.merged] : [])]), chain.length - 1])].filter((i) => i >= 0).sort((a, b) => a - b);
	const index = new Map(keep.map((ci, i) => [ci, i]));
	const nodes: GraphNode[] = keep.map((ci, i) => ({ ...chain[ci], gapBefore: i === 0 ? ci : ci - keep[i - 1] - 1 }));
	return {
		nodes,
		branches: raw.map((x) => ({ key: x.key, branch: x.branch, forkAt: index.get(x.fork)!, mergedAt: x.merged !== undefined ? index.get(x.merged) : undefined, ahead: x.ahead, ...(x.savedOnRemove ? { savedOnRemove: x.savedOnRemove } : {}) })),
		truncated,
	};
}
