// 專案的「分支」總覽:列出專案所在 git repo 的所有 worktree(Claude Code 自己開的、管家支線、手動開的),
// 對回開它的 agent/session 與 herdr 窗格,並提供 跟它對話 / 看檔案 / 合併回主線 / 移除,以及 .gitignore 防呆。
//  - 資料一律以 `git worktree list --porcelain` 為準(不會漏);session 對應盡量找,找不到就標「不明」
//  - 專案可能只是 repo 的子資料夾(例如 course/hw1、course/hw2 同一個 repo):每個 worktree 都會列出,
//    但只有「改動碰到這個專案資料夾」或「從這個專案開的」才算進徽章(relevant)
//  - Claude Code 背景 session 換進 worktree 後,herdr 窗格的資料夾還是舊的,所以靠紀錄檔裡的 worktree-state 找 session ID,
//    再用窗格的 agent_session 對回窗格
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { DATA_DIR, HOME } from "./config.ts";
import type { HerdrPane } from "./herdr.ts";
import { pathInside } from "./platform.ts";
import type { Branch, Project, Store } from "./store.ts";

export class WorktreesError extends Error {
	status: number;
	code?: string;
	detail?: unknown;
	constructor(status: number, message: string, code?: string, detail?: unknown) {
		super(message);
		this.status = status;
		this.code = code;
		this.detail = detail;
	}
}

export type WorktreeSource = "main" | "claude" | "steward" | "manual";

export interface WorktreeSession {
	agent: string; // claude / pi / codex …
	id?: string; // session ID(claude / codex)或紀錄檔路徑(pi)
	/** 從哪裡看出來的:claude-transcript(紀錄檔 worktree-state)、steward-branch(管家支線紀錄)、pane-cwd(窗格資料夾在 worktree 裡) */
	via: "claude-transcript" | "steward-branch" | "pane-cwd";
	originalCwd?: string; // 開 worktree 之前所在的資料夾
	startedAt?: string;
	pane?: { paneId: string; tabId: string; workspaceId: string; terminalId?: string; agentStatus?: string };
	alive: boolean; // 窗格還開著
}

export interface WorktreeItem {
	id: string; // 穩定的短 ID(路徑雜湊),API 用它指定 worktree
	path: string; // worktree 根目錄
	cwd: string; // 這個專案資料夾在 worktree 裡的對應位置(看檔案、開 agent 用)
	exists: boolean;
	source: WorktreeSource;
	branch: string | null; // detached HEAD 時是 null
	head: string;
	locked?: string; // 被鎖住(Claude Code 執行中的 session 會鎖),內容是鎖的原因
	prunable?: string; // 資料夾已經不在
	ahead: number; // 比主資料夾目前的分支多幾個 commit
	behind: number;
	dirty: number; // 沒 commit 的改動檔案數
	changed: number; // 相對分岔點、在這個專案資料夾裡改到的檔案數(含沒 commit 的)
	relevant: boolean; // 算進這個專案的徽章
	lastModified?: string; // HEAD commit 或沒 commit 檔案的最後修改時間(取較新)
	nested: boolean; // 放在 repo 資料夾裡面
	ignored: boolean; // 放在 repo 裡時有沒有被 .gitignore 排除(不在 repo 裡一律 true)
	session?: WorktreeSession;
	stewardBranchId?: string;
}

export interface WorktreeList {
	repo: true;
	repoRoot: string;
	prefix: string; // 專案資料夾相對 repo 根目錄(空字串 = 專案就是 repo 根目錄)
	target: string | null; // 主資料夾目前的分支(合併的目標);detached 時 null
	items: WorktreeItem[]; // 第一個是主資料夾
	warnings: {
		/** 放在 repo 裡、沒被 .gitignore 排除的 worktree(一次全部加入就會被誤 commit) */
		unignored: { id: string; path: string; pattern: string }[];
		/** 已經被誤 commit 成子專案(gitlink,mode 160000)的路徑(相對 repo 根目錄) */
		gitlinks: string[];
	};
}

export interface WorktreeDeps {
	panes?: HerdrPane[];
	claudeProjectsDir?: string; // 預設 ~/.claude/projects(測試用)
	stewardWorktreesDir?: string; // 預設 DATA_DIR/worktrees
}

// ---------- git ----------

export function run(cwd: string, args: string[], timeout = 20_000): Promise<{ code: number; out: string; err: string }> {
	return new Promise((res) => {
		execFile("git", ["-C", cwd, ...args], { timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } }, (e, out, err) => {
			res({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: String(out), err: String(err) });
		});
	});
}
async function ok(cwd: string, args: string[], timeout?: number): Promise<string> {
	const r = await run(cwd, args, timeout);
	if (r.code !== 0) throw new WorktreesError(400, (r.err || r.out).trim().split("\n").slice(-6).join("\n") || `git ${args[0]} 失敗`);
	return r.out;
}

export const real = (p: string) => {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
};
export const worktreeId = (path: string) => createHash("sha1").update(real(path)).digest("hex").slice(0, 10);

/** `git worktree list --porcelain` */
export function parsePorcelain(out: string): { path: string; head: string; branch: string | null; bare?: boolean; locked?: string; prunable?: string }[] {
	const items: ReturnType<typeof parsePorcelain> = [];
	for (const block of out.split(/\n\n+/)) {
		const lines = block.split("\n").filter(Boolean);
		if (!lines[0]?.startsWith("worktree ")) continue;
		const it: (typeof items)[number] = { path: lines[0].slice(9), head: "", branch: null };
		for (const l of lines.slice(1)) {
			if (l.startsWith("HEAD ")) it.head = l.slice(5);
			else if (l.startsWith("branch ")) it.branch = l.slice(7).replace(/^refs\/heads\//, "");
			else if (l === "bare") it.bare = true;
			else if (l === "locked" || l.startsWith("locked ")) it.locked = l.slice(7) || "locked";
			else if (l === "prunable" || l.startsWith("prunable ")) it.prunable = l.slice(9) || "prunable";
		}
		items.push(it);
	}
	return items;
}

// ---------- 對回 session ----------

/** Claude Code 把資料夾換成紀錄檔資料夾名稱的方式:非英數一律換成 - */
export const claudeSlug = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

interface ClaudeWtState {
	sessionId: string;
	worktreePath: string;
	originalCwd?: string;
	file: string;
	mtime: number;
}
const stateCache = new Map<string, { offset: number; rest: string; dec: StringDecoder; states: ClaudeWtState[] }>();

/** 一個紀錄檔裡所有 worktree-state:只讀上次之後新增的部分(背景 session 會一直往後寫,整份重讀太貴) */
function statesOfFile(file: string): ClaudeWtState[] {
	let size: number, mtime: number;
	try {
		const st = statSync(file);
		size = st.size;
		mtime = st.mtimeMs;
	} catch {
		return [];
	}
	let c = stateCache.get(file);
	if (!c || size < c.offset) c = { offset: 0, rest: "", dec: new StringDecoder("utf8"), states: [] }; // 新檔或被截短:從頭讀
	if (size > c.offset) {
		const fd = openSync(file, "r");
		try {
			for (let pos = c.offset; pos < size; ) {
				const buf = Buffer.alloc(Math.min(4 * 1024 * 1024, size - pos));
				const n = readSync(fd, buf, 0, buf.length, pos);
				if (n <= 0) break;
				pos += n;
				c.offset = pos;
				const lines = (c.rest + c.dec.write(buf.subarray(0, n))).split("\n"); // decoder 會把切在兩段之間的中文字留到下一段
				c.rest = lines.pop() ?? ""; // 最後一行可能還沒寫完
				for (const line of lines) {
					if (!line.includes('"worktree-state"')) continue;
					try {
						const d = JSON.parse(line);
						const w = d?.worktreeSession;
						if (d?.type === "worktree-state" && w?.worktreePath) c.states.push({ sessionId: w.sessionId ?? d.sessionId ?? basename(file, ".jsonl"), worktreePath: w.worktreePath, originalCwd: w.originalCwd, file, mtime });
					} catch {
						/* 壞掉的行跳過 */
					}
				}
			}
		} finally {
			closeSync(fd);
		}
	}
	for (const x of c.states) x.mtime = mtime;
	stateCache.set(file, c);
	return c.states;
}

/**
 * 哪個 Claude Code session 開了這個 worktree:
 * 換進 worktree 後紀錄檔改放在「worktree 路徑」對應的資料夾,所以先看那裡;每個檔案取最後一筆 worktree-state(session 可能換過 worktree)。
 * 好幾個 session 都進過同一個 worktree 時取最近有動的。
 */
export function claudeSessionOfWorktree(wtPath: string, projectsDir = join(HOME, ".claude", "projects")): ClaudeWtState | undefined {
	const want = real(wtPath);
	const dirs = new Set<string>();
	const direct = join(projectsDir, claudeSlug(wtPath));
	if (existsSync(direct)) dirs.add(direct);
	const directReal = join(projectsDir, claudeSlug(want));
	if (existsSync(directReal)) dirs.add(directReal);
	let best: ClaudeWtState | undefined;
	for (const dir of dirs) {
		let names: string[] = [];
		try {
			names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const n of names) {
			const states = statesOfFile(join(dir, n));
			const last = states[states.length - 1];
			if (!last || real(last.worktreePath) !== want) continue;
			if (!best || last.mtime > best.mtime) best = last;
		}
	}
	return best;
}

const paneCwd = (p: HerdrPane) => p.foreground_cwd || p.cwd || "";
const paneInfo = (p: HerdrPane): WorktreeSession["pane"] => ({ paneId: p.pane_id, tabId: p.tab_id, workspaceId: p.workspace_id, terminalId: p.terminal_id, agentStatus: p.agent_status });

function sessionFor(path: string, source: WorktreeSource, b: Branch | undefined, panes: HerdrPane[], projectsDir: string): WorktreeSession | undefined {
	if (source === "main") return undefined;
	// 1. 管家支線:紀錄裡有窗格與 agent
	if (b) {
		const pane = panes.find((p) => (b.terminalId && p.terminal_id ? p.terminal_id === b.terminalId : p.pane_id === b.paneId));
		const id = pane?.agent_session?.value ?? b.transcript;
		return { agent: b.agent, id, via: "steward-branch", startedAt: b.createdAt, pane: pane ? paneInfo(pane) : undefined, alive: !!pane };
	}
	// 2. Claude Code 紀錄檔的 worktree-state
	const cs = claudeSessionOfWorktree(path, projectsDir);
	if (cs) {
		const pane = panes.find((p) => p.agent === "claude" && p.agent_session?.value === cs.sessionId);
		return { agent: "claude", id: cs.sessionId, via: "claude-transcript", originalCwd: cs.originalCwd, startedAt: new Date(cs.mtime).toISOString(), pane: pane ? paneInfo(pane) : undefined, alive: !!pane };
	}
	// 3. 窗格的資料夾就在 worktree 裡(手動開、pi、codex…)
	const pane = panes.filter((p) => p.agent && pathInside(real(paneCwd(p)), real(path)))[0];
	if (pane) return { agent: pane.agent!, id: pane.agent_session?.value ?? undefined, via: "pane-cwd", pane: paneInfo(pane), alive: true };
	return undefined;
}

// ---------- 列表 ----------

export interface RepoInfo {
	repoRoot: string; // 主資料夾(main worktree)的根目錄
	prefix: string;
}

/** 專案資料夾屬於哪個 repo(專案在 linked worktree 裡也對回主資料夾) */
export async function repoOf(root: string): Promise<RepoInfo | undefined> {
	const r = await run(root, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel", "--show-prefix"]);
	if (r.code !== 0) return undefined;
	const [common, top, prefix = ""] = r.out.split("\n");
	if (!common || !top) return undefined;
	// 主資料夾 = 共用 .git 的上一層;bare repo 等特殊情況就用 toplevel
	const repoRoot = basename(common) === ".git" ? dirname(common) : top;
	return { repoRoot, prefix: prefix.replace(/\/$/, "") };
}

function sourceOf(path: string, isMain: boolean, repoRoot: string, branches: Branch[], stewardDir: string): { source: WorktreeSource; b?: Branch } {
	if (isMain) return { source: "main" };
	const p = real(path);
	const b = branches.find((x) => x.worktree && !x.worktree.removed && real(x.worktree.path) === p);
	if (b || pathInside(p, real(stewardDir))) return { source: "steward", b };
	if (pathInside(p, join(real(repoRoot), ".claude", "worktrees"))) return { source: "claude" };
	return { source: "manual" };
}

/** 檔案最後修改時間(只看沒 commit 的那些;太多就只看前 200 個) */
function newestMtime(dir: string, files: string[]): number {
	let t = 0;
	for (const f of files.slice(0, 200)) {
		try {
			t = Math.max(t, statSync(join(dir, f)).mtimeMs);
		} catch {
			/* 刪掉的檔案 */
		}
	}
	return t;
}

export async function listWorktrees(store: Store, p: Project, deps: WorktreeDeps = {}): Promise<WorktreeList | { repo: false }> {
	const info = await repoOf(p.root);
	if (!info) return { repo: false };
	const { repoRoot, prefix } = info;
	const panes = deps.panes ?? [];
	const projectsDir = deps.claudeProjectsDir ?? join(HOME, ".claude", "projects");
	const stewardDir = deps.stewardWorktreesDir ?? join(DATA_DIR, "worktrees");
	const raw = parsePorcelain(await ok(repoRoot, ["worktree", "list", "--porcelain"])).filter((x) => !x.bare);
	const mainRaw = raw.find((x) => real(x.path) === real(repoRoot)) ?? raw[0];
	const target = mainRaw?.branch ?? null;
	const branches = store.branches().filter((b) => b.worktree);
	const spec = prefix ? ["--", prefix] : [];

	const items = await Promise.all(
		raw.map(async (w): Promise<WorktreeItem> => {
			const isMain = w === mainRaw;
			const exists = existsSync(w.path) && !w.prunable;
			const { source, b } = sourceOf(w.path, isMain, repoRoot, branches, stewardDir);
			const cwd = prefix ? join(w.path, prefix) : w.path;
			let ahead = 0, behind = 0, dirty = 0, changed = 0, last = 0;
			if (exists) {
				const st = await run(w.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
				const dirtyFiles = st.out.split("\0").filter(Boolean).filter((l) => /^.. /.test(l)).map((l) => l.slice(3));
				dirty = dirtyFiles.length;
				last = newestMtime(w.path, dirtyFiles);
				const inPrefix = dirtyFiles.filter((f) => !prefix || f === prefix || f.startsWith(`${prefix}/`));
				let committed: string[] = [];
				if (!isMain && target && w.head) {
					const ab = await run(repoRoot, ["rev-list", "--left-right", "--count", `${target}...${w.head}`]);
					const m = ab.out.trim().match(/^(\d+)\s+(\d+)$/);
					if (m) [behind, ahead] = [Number(m[1]), Number(m[2])];
					if (ahead) committed = (await run(repoRoot, ["diff", "--name-only", `${target}...${w.head}`, ...spec])).out.split("\n").filter(Boolean);
				}
				changed = new Set([...committed, ...inPrefix]).size;
			}
			if (w.head) {
				const ct = await run(repoRoot, ["show", "-s", "--format=%ct", w.head]);
				const t = Number(ct.out.trim()) * 1000;
				if (t) last = Math.max(last, t);
			}
			const session = sessionFor(w.path, source, b, panes, projectsDir);
			const nested = !isMain && pathInside(real(w.path), real(repoRoot));
			let ignored = true;
			if (nested) ignored = (await run(repoRoot, ["check-ignore", "-q", "--no-index", relative(real(repoRoot), real(w.path)).split(sep).join("/") + "/"])).code === 0;
			const fromHere = !!(b ? b.projectId === p.id : session?.originalCwd && pathInside(real(session.originalCwd), real(p.root)));
			return {
				id: worktreeId(w.path),
				path: w.path,
				cwd,
				exists,
				source,
				branch: w.branch,
				head: w.head,
				locked: w.locked,
				prunable: w.prunable,
				ahead,
				behind,
				dirty,
				changed,
				relevant: !isMain && (changed > 0 || fromHere),
				lastModified: last ? new Date(last).toISOString() : undefined,
				nested,
				ignored,
				session,
				stewardBranchId: b?.id,
			};
		}),
	);
	// 主資料夾放第一個,其他照最後修改時間新到舊
	items.sort((a, b) => Number(b.source === "main") - Number(a.source === "main") || (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));

	const unignored = items.filter((x) => x.nested && !x.ignored).map((x) => ({ id: x.id, path: x.path, pattern: ignorePattern(repoRoot, x) }));
	const gitlinks = (await run(repoRoot, ["ls-files", "-s", "-z"])).out
		.split("\0")
		.filter((l) => l.startsWith("160000 "))
		.map((l) => l.split("\t")[1])
		.filter((rel) => !!rel && (rel.startsWith(".claude/worktrees/") || items.some((x) => x.source !== "main" && real(x.path) === real(join(repoRoot, rel)))));
	return { repo: true, repoRoot, prefix, target, items, warnings: { unignored, gitlinks } };
}

/** 要加進 .gitignore 的那一行:Claude Code 的整個 .claude/worktrees/,其他就是那個資料夾 */
function ignorePattern(repoRoot: string, x: WorktreeItem): string {
	if (x.source === "claude") return ".claude/worktrees/";
	return `/${relative(real(repoRoot), real(x.path)).split(sep).join("/")}/`;
}

/** 專案欄徽章:每個專案有幾個相關的 worktree(快取 20 秒;同一個 repo 只列一次) */
const countCache = new Map<string, { at: number; n: number }>();
export async function worktreeCounts(store: Store, projects: Project[], deps: WorktreeDeps = {}): Promise<Record<string, number>> {
	const out: Record<string, number> = {};
	await Promise.all(
		projects.map(async (p) => {
			const hit = countCache.get(p.id);
			if (hit && Date.now() - hit.at < 20_000) return void (out[p.id] = hit.n);
			try {
				const l = await listWorktrees(store, p, deps);
				const n = l.repo ? l.items.filter((x) => x.relevant).length : 0;
				countCache.set(p.id, { at: Date.now(), n });
				out[p.id] = n;
			} catch {
				out[p.id] = 0;
			}
		}),
	);
	return out;
}
export const clearWorktreeCounts = () => {
	countCache.clear();
	viewCache.clear();
};

// ---------- 操作 ----------

/** 程式碼頁「看 worktree 的檔案」用的輕量對照:只跑 git worktree list(每個檔案請求都會呼叫,不能跑完整列表) */
const viewCache = new Map<string, { at: number; v: { path: string; cwd: string; exists: boolean } }>();
export async function worktreeView(p: Project, id: string): Promise<{ path: string; cwd: string; exists: boolean }> {
	const key = `${p.id}@${id}`;
	const hit = viewCache.get(key);
	if (hit && Date.now() - hit.at < 10_000) return hit.v;
	const info = await repoOf(p.root);
	if (!info) throw new WorktreesError(400, "這個專案不是 git repo");
	const w = parsePorcelain(await ok(info.repoRoot, ["worktree", "list", "--porcelain"])).find((x) => !x.bare && worktreeId(x.path) === id);
	if (!w) throw new WorktreesError(404, "找不到這個 worktree(可能已經移除),請重新整理");
	const cwd = info.prefix ? join(w.path, info.prefix) : w.path;
	const v = { path: w.path, cwd, exists: existsSync(w.path) && !w.prunable };
	viewCache.set(key, { at: Date.now(), v });
	return v;
}

export async function findWorktree(store: Store, p: Project, id: string, deps: WorktreeDeps = {}): Promise<{ list: WorktreeList; item: WorktreeItem }> {
	const list = await listWorktrees(store, p, deps);
	if (!list.repo) throw new WorktreesError(400, "這個專案不是 git repo");
	const item = list.items.find((x) => x.id === id);
	if (!item) throw new WorktreesError(404, "找不到這個 worktree(可能已經移除),請重新整理");
	return { list, item };
}

/** 合併前預覽:改了哪些檔案、diff、會不會被擋 */
export async function mergePreview(store: Store, p: Project, id: string, deps: WorktreeDeps = {}) {
	const { list, item } = await findWorktree(store, p, id, deps);
	if (item.source === "main") throw new WorktreesError(400, "這是主資料夾,不能合併到自己");
	if (!item.branch) throw new WorktreesError(400, "這個 worktree 不在任何分支上(detached HEAD),請先讓 agent 建一條分支");
	if (!list.target) throw new WorktreesError(400, "主資料夾目前不在任何分支上(detached HEAD),沒有合併的目標");
	const range = `${list.target}...${item.branch}`;
	const stat = (await ok(list.repoRoot, ["diff", "--stat", range])).trimEnd();
	const files = (await ok(list.repoRoot, ["diff", "--name-status", range])).split("\n").filter(Boolean).map((l) => {
		const [status, ...rest] = l.split("\t");
		return { status, path: rest[rest.length - 1] };
	});
	const diff = await ok(list.repoRoot, ["diff", range]);
	const commits = (await ok(list.repoRoot, ["log", "--format=%h\t%s", `${list.target}..${item.branch}`])).split("\n").filter(Boolean).map((l) => {
		const [hash, ...s] = l.split("\t");
		return { hash, subject: s.join("\t") };
	});
	return { target: list.target, branch: item.branch, commits, files, stat, diff: diff.length > 400_000 ? `${diff.slice(0, 400_000)}\n…(太長,只顯示前面一部分)` : diff, blocker: await mergeBlocker(list), uncommitted: item.dirty };
}

/** 主資料夾有沒 commit 的改動(不算沒追蹤的新檔、不算誤 commit 的子專案)就不合併 */
async function mergeBlocker(list: WorktreeList): Promise<string | undefined> {
	const st = (await ok(list.repoRoot, ["status", "--porcelain=v1", "--ignore-submodules=all", "--untracked-files=no"])).split("\n").filter(Boolean);
	if (st.length) return `主資料夾(${list.target})還有 ${st.length} 個沒 commit 的改動:${st.slice(0, 5).map((l) => l.slice(3)).join("、")}${st.length > 5 ? "…" : ""}。請先 commit 或收起來再合併`;
	const merging = (await run(list.repoRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0;
	if (merging) return "主資料夾正在合併中(有還沒完成的合併),請先處理完";
	return undefined;
}

export async function mergeWorktree(store: Store, p: Project, id: string, deps: WorktreeDeps = {}): Promise<{ merged: true; target: string; branch: string; commit: string } > {
	const { list, item } = await findWorktree(store, p, id, deps);
	if (item.source === "main") throw new WorktreesError(400, "這是主資料夾,不能合併到自己");
	if (!item.branch || !list.target) throw new WorktreesError(400, "沒有分支可以合併(detached HEAD)");
	const blocker = await mergeBlocker(list);
	if (blocker) throw new WorktreesError(409, blocker, "main-dirty");
	if (!item.ahead) throw new WorktreesError(400, `「${item.branch}」沒有比 ${list.target} 多的 commit,不需要合併${item.dirty ? "(worktree 裡的改動還沒 commit)" : ""}`, "nothing");
	const r = await run(list.repoRoot, ["merge", "--no-ff", "--no-edit", item.branch], 120_000);
	if (r.code !== 0) {
		const conflicts = (await run(list.repoRoot, ["diff", "--name-only", "--diff-filter=U"])).out.split("\n").filter(Boolean);
		await run(list.repoRoot, ["merge", "--abort"]);
		if (conflicts.length) throw new WorktreesError(409, `有衝突,已取消合併,主資料夾沒有變動。衝突的檔案:${conflicts.join("、")}。可以請 agent 在 worktree 裡先合併 ${list.target} 解好衝突再試`, "conflict", { conflicts });
		throw new WorktreesError(400, `合併失敗:${(r.err || r.out).trim().split("\n").slice(-4).join(" ")}`);
	}
	clearWorktreeCounts();
	return { merged: true, target: list.target, branch: item.branch, commit: (await ok(list.repoRoot, ["rev-parse", "--short", "HEAD"])).trim() };
}

/**
 * 移除 worktree 資料夾,分支保留:
 *  - 還有沒 commit 的改動:沒確認就回 409(dirty),確認後先 commit 到它的分支再移除(改動不會丟)
 *  - 被鎖住(Claude Code session 鎖的):沒確認就回 409(locked),確認後先解鎖
 *  - 窗格還開著:沒確認就回 409(alive)
 */
/** 移除 worktree 前保留未提交改動時用的 commit 訊息(樹狀圖靠它認出「只多了這種 commit」的分支其實已經合併) */
export const SAVED_ON_REMOVE = "移除 worktree 前保留的未提交改動";

/**
 * 移除 worktree 資料夾,分支保留:
 *  - 窗格還開著、被鎖住(Claude Code 的 session 鎖的):沒確認就回 409(alive / locked)
 *  - 還有沒 commit 的改動:沒確認就回 409(dirty),detail 帶檔案清單和建議;
 *    confirm.dirty = "commit" 先 commit 到它的分支再移除(改動不會丟,但分支會多一個 commit),"discard" 直接丟掉
 *    (舊版的 true 當成 "commit")。分支已經合併過時建議 discard:存進去會讓它看起來又沒合併
 */
export async function removeWorktreeItem(store: Store, p: Project, id: string, confirm: { dirty?: boolean | "commit" | "discard"; locked?: boolean; alive?: boolean } = {}, deps: WorktreeDeps = {}) {
	const { list, item } = await findWorktree(store, p, id, deps);
	if (item.source === "main") throw new WorktreesError(400, "主資料夾不能移除");
	if (item.session?.alive && !confirm.alive) throw new WorktreesError(409, `開它的 ${item.session.agent} 窗格還開著,移除後它就沒有資料夾可以用了。確定要移除嗎?`, "alive");
	if (item.locked && !confirm.locked) throw new WorktreesError(409, `這個 worktree 被鎖住了(${item.locked})。通常是 Claude Code 的 session 還在用它;確定要解鎖並移除嗎?`, "locked");
	const dirtyMode = confirm.dirty === true ? "commit" : confirm.dirty || undefined;
	if (item.exists && item.dirty && !dirtyMode) {
		const files = (await run(item.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"])).out.split("\0").filter(Boolean).filter((l) => /^.. /.test(l)).map((l) => l.slice(3));
		const merged = !!item.branch && !!list.target && (await run(list.repoRoot, ["merge-base", "--is-ancestor", item.head, list.target])).code === 0;
		const msg = merged
			? `還有 ${item.dirty} 個沒 commit 的改動。這條分支已經合併回 ${list.target},建議「捨棄」;存進分支會讓它多一個 commit、看起來又沒合併。`
			: `還有 ${item.dirty} 個沒 commit 的改動。「存進分支」會先 commit 到「${item.branch ?? "(無分支)"}」再移除,改動不會丟;「捨棄」會直接丟掉。`;
		throw new WorktreesError(409, msg, "dirty", { files: files.slice(0, 200), total: files.length, merged, suggest: merged ? "discard" : "commit", canCommit: !!item.branch });
	}
	if (item.exists && item.dirty && dirtyMode === "commit") {
		if (!item.branch) throw new WorktreesError(400, "這個 worktree 不在分支上,沒 commit 的改動沒地方存;要移除請選「捨棄」");
		await ok(item.path, ["add", "-A"], 120_000);
		await ok(item.path, ["-c", "user.name=agent-steward", "-c", "user.email=steward@localhost", "commit", "-q", "--no-verify", "-m", SAVED_ON_REMOVE], 120_000);
	}
	if (item.locked) await ok(list.repoRoot, ["worktree", "unlock", item.path]);
	if (item.exists) await ok(list.repoRoot, ["worktree", "remove", "--force", item.path], 120_000);
	else await ok(list.repoRoot, ["worktree", "prune"]);
	if (item.stewardBranchId) {
		const b = store.branches().find((x) => x.id === item.stewardBranchId);
		if (b?.worktree) store.updateBranch(b.id, { worktree: { ...b.worktree, removed: true } });
	}
	clearWorktreeCounts();
	return { removed: true, branch: item.branch };
}

/** 把沒被排除的 worktree 加進 .gitignore(只加還沒有的那幾行;不 commit) */
export async function ignoreWorktrees(store: Store, p: Project, deps: WorktreeDeps = {}, extra: string[] = []) {
	const list = await listWorktrees(store, p, deps);
	if (!list.repo) throw new WorktreesError(400, "這個專案不是 git repo");
	const patterns = [...new Set([...list.warnings.unignored.map((x) => x.pattern), ...extra])];
	if (!patterns.length) return { added: [] as string[], file: join(list.repoRoot, ".gitignore") };
	const file = join(list.repoRoot, ".gitignore");
	const before = existsSync(file) ? readFileSync(file, "utf8") : "";
	const have = new Set(before.split(/\r?\n/).map((l) => l.trim()));
	const add = patterns.filter((x) => !have.has(x));
	if (add.length) appendFileSync(file, `${before && !before.endsWith("\n") ? "\n" : ""}# agent 的 git worktree(專案管家加的)\n${add.join("\n")}\n`);
	clearWorktreeCounts();
	return { added: add, file };
}

/** 被誤 commit 成子專案的 worktree:從版本控制拿掉(git rm --cached,檔案不刪、不 commit),並順便加進 .gitignore */
export async function untrackGitlinks(store: Store, p: Project, deps: WorktreeDeps = {}) {
	const list = await listWorktrees(store, p, deps);
	if (!list.repo) throw new WorktreesError(400, "這個專案不是 git repo");
	const links = list.warnings.gitlinks;
	if (links.length) await ok(list.repoRoot, ["rm", "--cached", "-q", "--", ...links]);
	// Claude Code 之後還會在 .claude/worktrees/ 開新的:就算那個 worktree 已經不在,也一起排除
	const ig = await ignoreWorktrees(store, p, deps, links.some((l) => l.startsWith(".claude/worktrees/")) ? [".claude/worktrees/"] : []);
	if (ig.added.length) await ok(list.repoRoot, ["add", "--", ".gitignore"]);
	return { untracked: links, ignoreAdded: ig.added, note: "已經放進暫存區,還沒 commit;到程式碼頁的 git 區塊 commit 就完成了" };
}

// ---------- 跟它對話 ----------

/** 接回 session 的啟動參數;不支援就回 undefined(改開新的 agent) */
export function resumeArgs(agent: string, id: string | undefined, cwd: string): string[] | undefined {
	if (!id) return undefined;
	if (agent === "claude" && !id.includes("/")) return ["--resume", id];
	if (agent === "pi") return ["--session", id];
	if (agent === "codex" && !id.includes("/")) return ["resume", "-C", cwd, id];
	return undefined;
}

export interface ChatPlan {
	kind: "focus" | "resume" | "new";
	paneId?: string;
	agent: string;
	cwd: string;
	args?: string[];
}

/** 決定「跟它對話」要做什麼:窗格開著就跳過去;關了就接回 session;都沒有就開新的 agent */
export function chatPlan(item: WorktreeItem, fallbackAgent = "claude"): ChatPlan {
	const s = item.session;
	// Claude Code 是在 worktree 根目錄找 session 的,接回時從 worktree 根目錄開;其他 agent 用專案在 worktree 裡的資料夾
	const cwd = existsSync(item.cwd) ? item.cwd : item.path;
	if (s?.alive && s.pane) return { kind: "focus", paneId: s.pane.paneId, agent: s.agent, cwd };
	const args = s ? resumeArgs(s.agent, s.id, cwd) : undefined;
	if (s && args) return { kind: "resume", agent: s.agent, cwd: s.agent === "claude" ? item.path : cwd, args };
	return { kind: "new", agent: s?.agent ?? fallbackAgent, cwd };
}
