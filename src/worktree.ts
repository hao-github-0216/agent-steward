// 支線的 git worktree:放在 ~/.agent-steward/worktrees/<專案id>/<支線id>,分支 steward/branch-<支線id>。
//  - 主線還沒提交的改動(含沒追蹤的新檔)也帶過去,做成一個「支線起點」commit,支線看到的檔案跟主線一模一樣
//  - node_modules、.venv 這類不在 git 裡的大資料夾用連結指回主線(共用)
//  - 帶回主線用 `git diff <起點>`:只含支線自己的改動,不會把主線的未提交改動算進去
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config.ts";

/** 連回主線共用的資料夾(只看 repo 根目錄和主線所在的子資料夾) */
const SHARED = ["node_modules", ".venv", "venv"];
const MAX_FILE = 20 * 1024 * 1024; // 沒追蹤的檔案:單檔超過就不複製
const MAX_FILES = 2000;

export class WorktreeError extends Error {}

function git(cwd: string, args: string[], timeoutMs = 60_000): string {
	try {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
	} catch (e: any) {
		const msg = String(e?.stderr ?? e?.message ?? e).trim().split("\n").slice(-3).join(" ");
		throw new WorktreeError(`git ${args[0]} 失敗:${msg.slice(0, 300)}`);
	}
}

export interface WorktreeInfo {
	path: string; // worktree 根目錄
	cwd: string; // 支線 agent 的工作目錄(主線在 repo 的子資料夾時,對應到 worktree 裡同一個子資料夾)
	repoRoot: string;
	gitBranch: string;
	base: string; // 支線起點的 commit(含主線當時的未提交改動)
	shared: string[]; // 連回主線的資料夾(相對 worktree 根目錄)
	skipped: number; // 太大或太多沒複製的未追蹤檔案數
}

/** 能不能開 worktree;不能就回原因(非 git、沒有 commit) */
export function worktreeBlocker(cwd: string): string | undefined {
	let root: string;
	try {
		root = git(cwd, ["rev-parse", "--show-toplevel"], 10_000);
	} catch {
		return "不是 git 專案";
	}
	try {
		git(root, ["rev-parse", "--verify", "HEAD"], 10_000);
	} catch {
		return "這個 repo 還沒有任何 commit";
	}
	return undefined;
}

export function worktreePath(projectId: string, branchId: string): string {
	return join(DATA_DIR, "worktrees", projectId, branchId);
}

/** 從主線目前的狀態開一個 worktree */
export function createWorktree(mainCwd: string, projectId: string, branchId: string): WorktreeInfo {
	const repoRoot = git(mainCwd, ["rev-parse", "--show-toplevel"], 10_000);
	const sub = git(mainCwd, ["rev-parse", "--show-prefix"], 10_000).replace(/\/$/, "");
	const path = worktreePath(projectId, branchId);
	const gitBranch = `steward/branch-${branchId}`;
	mkdirSync(dirname(path), { recursive: true });

	// 快照主線:stash create 只產生物件、不動主線的檔案;沒有改動時是空字串
	const stash = git(repoRoot, ["stash", "create"]);
	const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
	git(repoRoot, ["worktree", "add", "-q", "-b", gitBranch, path, "HEAD"], 120_000);
	try {
		if (stash) git(path, ["stash", "apply", "-q", stash], 120_000);
		let copied = 0;
		let skipped = 0;
		for (const rel of untracked) {
			if (SHARED.includes(rel.split("/")[0])) continue;
			const src = join(repoRoot, rel);
			try {
				const st = statSync(src);
				if (!st.isFile() || st.size > MAX_FILE || copied >= MAX_FILES) {
					skipped++;
					continue;
				}
				mkdirSync(dirname(join(path, rel)), { recursive: true });
				copyFileSync(src, join(path, rel));
				copied++;
			} catch {
				skipped++;
			}
		}
		if (stash || copied) {
			git(path, ["add", "-A"], 120_000);
			git(path, ["-c", "user.name=agent-steward", "-c", "user.email=steward@localhost", "commit", "-q", "--no-verify", "--allow-empty", "-m", "支線起點:主線當時還沒提交的改動"], 120_000);
		}
		const base = git(path, ["rev-parse", "HEAD"]);
		// 起點 commit 之後才建連結,不會被提交進去
		const shared: string[] = [];
		for (const dir of [...new Set(["", sub])]) {
			for (const name of SHARED) {
				const src = join(repoRoot, dir, name);
				const rel = dir ? `${dir}/${name}` : name;
				const dst = join(path, rel);
				if (!existsSync(src) || existsSync(dst)) continue;
				mkdirSync(dirname(dst), { recursive: true });
				symlinkSync(src, dst, process.platform === "win32" ? "junction" : "dir");
				shared.push(rel);
			}
		}
		return { path, cwd: sub ? join(path, sub) : path, repoRoot, gitBranch, base, shared, skipped };
	} catch (e) {
		try {
			git(repoRoot, ["worktree", "remove", "--force", path]);
			git(repoRoot, ["branch", "-D", gitBranch]);
		} catch {
			/* 清不掉就留著,錯誤訊息照常回報 */
		}
		throw e;
	}
}

/** git pathspec:排除連回主線的資料夾 */
const excludes = (shared: string[]) => shared.map((s) => `:(exclude)${s}`);

/** 支線從起點之後的改動(含新檔案、含支線自己做的 commit) */
export function worktreeChanges(w: Pick<WorktreeInfo, "path" | "base" | "shared">): { files: string[]; stat: string; diff: string } {
	if (!existsSync(w.path)) return { files: [], stat: "", diff: "" };
	const spec = ["--", ".", ...excludes(w.shared)];
	// 新檔案先標成「之後要加入」,diff 才看得到(不會真的提交)。自己列出來再加,
	// 不用 pathspec 排除:連回主線的資料夾被 .gitignore 擋住時,git add 會直接報錯
	const isShared = (f: string) => w.shared.some((s) => f === s || f.startsWith(`${s}/`));
	const fresh = git(w.path, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter((f) => f && !isShared(f));
	for (let i = 0; i < fresh.length; i += 200) git(w.path, ["add", "-N", "--", ...fresh.slice(i, i + 200)]);
	const files = git(w.path, ["diff", "--name-only", w.base, ...spec]).split("\n").filter(Boolean);
	const stat = files.length ? git(w.path, ["diff", "--stat", w.base, ...spec]) : "";
	const diff = files.length ? git(w.path, ["diff", w.base, ...spec]) : "";
	return { files, stat, diff };
}

/** 移除 worktree:先把支線的改動提交到它的分支(分支保留,改動不會丟),再移除資料夾 */
export function removeWorktree(w: Pick<WorktreeInfo, "path" | "repoRoot" | "shared">): void {
	if (!existsSync(w.path)) return;
	for (const rel of w.shared) {
		const p = join(w.path, rel);
		try {
			if (lstatSync(p).isSymbolicLink()) unlinkSync(p);
		} catch {
			/* 已經不在 */
		}
	}
	git(w.path, ["add", "-A"], 120_000);
	if (git(w.path, ["status", "--porcelain"])) {
		git(w.path, ["-c", "user.name=agent-steward", "-c", "user.email=steward@localhost", "commit", "-q", "--no-verify", "-m", "支線結束時的改動"], 120_000);
	}
	// 改動都提交了,剩下的只會是被 .gitignore 忽略的產物
	git(w.repoRoot, ["worktree", "remove", "--force", w.path], 120_000);
}

/** 開支線失敗時:直接丟掉 worktree 和分支(裡面還沒有任何支線的工作) */
export function discardWorktree(w: Pick<WorktreeInfo, "path" | "repoRoot" | "gitBranch">): void {
	try {
		git(w.repoRoot, ["worktree", "remove", "--force", w.path], 120_000);
	} catch {
		/* 可能已經不在 */
	}
	try {
		git(w.repoRoot, ["branch", "-D", w.gitBranch]);
	} catch {
		/* 分支不在就算了 */
	}
}
