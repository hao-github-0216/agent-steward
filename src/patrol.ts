// 定期巡檢:收集 repo 訊號、判斷巡檢時機,並提供唯讀的查證工具。
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tr } from "./i18n.ts";
import { pathInside } from "./platform.ts";
import type { Settings } from "./settings.ts";
import type { Project } from "./store.ts";

export interface PatrolSignals {
	isGit: boolean;
	head?: string;
	newCommits: string[];
	docs: { file: string; lastChanged: string; behind: number; subjects: string[] }[];
	untracked: { path: string; kind: "untracked" | "modified"; days: number }[];
	ci: { name: string; conclusion: string; branch: string; at: string; url: string }[];
}

const DAY_MS = 24 * 3_600_000;

export function collectSignals(root: string, opts: { since?: string; checks: Settings["patrol"]["checks"]; now?: number }): PatrolSignals {
	const run = (command: string, args: string[]): string | undefined => {
		try {
			return execFileSync(command, args, { cwd: root, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
		} catch { return undefined; }
	};
	const git = (...args: string[]) => run("git", args);
	const lines = (text?: string) => (text ?? "").trim().split("\n").filter(Boolean);
	const signals: PatrolSignals = { isGit: false, newCommits: [], docs: [], untracked: [], ci: [] };
	if (git("rev-parse", "--is-inside-work-tree")?.trim() !== "true") return signals;
	signals.isGit = true;
	signals.head = git("rev-parse", "HEAD")?.trim() || undefined;
	if (opts.since) signals.newCommits = lines(git("log", `--since=${opts.since}`, "--format=%h %s", "-n", "30"));
	if (opts.checks.docs) {
		const files = (git("ls-files", "-z") ?? "").split("\0").filter((f) => /^README[^/]*\.md$/.test(f) || /^docs\/[^/]+\.md$/.test(f));
		for (const file of files) {
			const last = git("log", "-1", "--format=%H|%cI", "--", file)?.trim();
			if (!last) continue;
			const [hash, lastChanged] = last.split("|");
			const commits = lines(git("log", `${hash}..HEAD`, "--format=%h %s", "--", ".", ":(exclude)*.md", ":(exclude)docs"));
			if (commits.length >= 5) signals.docs.push({ file, lastChanged, behind: commits.length, subjects: commits.slice(0, 15) });
		}
	}
	if (opts.checks.untracked) {
		const entries = (git("status", "--porcelain=v1", "-z") ?? "").split("\0");
		for (let i = 0; i < entries.length && signals.untracked.length < 20; i++) {
			const entry = entries[i];
			if (entry.length < 4) continue;
			const status = entry.slice(0, 2), path = entry.slice(3);
			// -z 格式的重新命名與複製有第二個路徑,不把舊名稱當成另一筆。
			if (/[RC]/.test(status)) i++;
			if (path === ".DS_Store" || path.endsWith("/.DS_Store")) continue;
			try {
				const days = Math.floor(((opts.now ?? Date.now()) - statSync(join(root, path)).mtimeMs) / DAY_MS);
				if (days >= 3) signals.untracked.push({ path, kind: status === "??" ? "untracked" : "modified", days });
			} catch { /* 檔案可能已被移走 */ }
		}
	}
	if (opts.checks.ci && git("remote", "get-url", "origin")?.includes("github.com") && run("gh", ["--version"]) !== undefined) {
		try {
			const runs = JSON.parse(run("gh", ["run", "list", "-L", "10", "--json", "name,conclusion,headBranch,createdAt,url"]) ?? "[]");
			if (Array.isArray(runs)) signals.ci = runs.filter((r) => r.conclusion === "failure" || r.conclusion === "timed_out").slice(0, 5).map((r) => ({
				name: String(r.name ?? ""), conclusion: r.conclusion, branch: String(r.headBranch ?? ""), at: String(r.createdAt ?? ""), url: String(r.url ?? ""),
			}));
		} catch { /* gh 不可用時略過 CI */ }
	}
	return signals;
}

export function patrolDue(p: Project, head: string | undefined, cfg: Settings["patrol"], now: number, rootExists: boolean): { due: boolean; reason: string } {
	if (!cfg.enabled) return { due: false, reason: tr("定期巡檢已關閉") };
	if (p.kind !== "project") return { due: false, reason: tr("雜務與總覽不巡檢") };
	if (p.status !== "active") return { due: false, reason: tr("專案未啟用") };
	if (p.private) return { due: false, reason: tr("隱私專案不巡檢") };
	if (!rootExists) return { due: false, reason: tr("找不到專案資料夾") };
	if (!p.lastPatrol) return { due: true, reason: tr("還沒有巡檢紀錄") };
	const elapsed = now - Date.parse(p.lastPatrol.at);
	if (elapsed < cfg.everyHours * 3_600_000) return { due: false, reason: tr("還沒到巡檢時間") };
	if (elapsed > 7 * DAY_MS) return { due: true, reason: tr("距離上次巡檢已超過 7 天") };
	if (head !== p.lastPatrol.head || (p.lastActivityAt && Date.parse(p.lastActivityAt) > Date.parse(p.lastPatrol.at))) return { due: true, reason: tr("上次巡檢後有新變化") };
	return { due: false, reason: tr("上次巡檢後沒有變化") };
}

export function patrolMessage(p: Project, s: PatrolSignals, cfg: Settings["patrol"], rejectedTitles: string[], openProposed: number): string {
	const parts = [`【巡檢】定期檢查「${p.name}」(${p.root})有沒有該做但還沒人提起的事。`];
	if (s.newCommits.length) parts.push(`新 commit:\n${s.newCommits.map((c) => `- ${c}`).join("\n")}`);
	if (s.docs.length) parts.push(`文件可能落後:\n${s.docs.map((d) => `- ${d.file}:最後在 ${d.lastChanged} 修改,之後有 ${d.behind} 個改程式的 commit\n${d.subjects.map((c) => `  - ${c}`).join("\n")}`).join("\n")}`);
	if (s.untracked.length) parts.push(`超過 3 天沒進版控或沒 commit 的檔案:\n${s.untracked.map((f) => `- ${f.path} (${f.kind === "untracked" ? "沒進版控" : "還沒 commit"},${f.days} 天)`).join("\n")}`);
	if (s.ci.length) parts.push(`CI 失敗:\n${s.ci.map((c) => `- ${c.name} (${c.branch},${c.conclusion},${c.at}):${c.url}`).join("\n")}`);
	if (cfg.checks.state) parts.push("請對照 repo 檢查專案狀態的卡點與下一步有沒有已經過時;過時的就用 update_project_state 更新(只改卡點與下一步,其他欄位不要動)。");
	if (cfg.extra.trim()) parts.push(`使用者另外要你注意:${cfg.extra}`);
	if (rejectedTitles.length) parts.push(`下面這些是使用者最近拒絕過的提案,不要再提一樣或類似的:\n${rejectedTitles.map((t) => `- ${t}`).join("\n")}`);
	parts.push(`規則:
- 訊號只是線索,提案前用 repo_list、repo_read、repo_git 查證;每個發現都要寫出證據(檔案路徑、commit 編號)。
- 一個發現值得開卡,條件是:明確、可以獨立交給一個 agent 完成、完成條件可驗證。
- ${openProposed >= 3 ? `專案已經有 ${openProposed} 張還沒處理的提案,這次不要開新卡,只回報發現。` : `最多提案 ${cfg.maxCards} 張,先看 list_cards 避免重複。`}
- 只開提案卡,不改任何檔案,不更新既有卡片。
- 什麼都沒發現就只回「無」。
- 最後一行用「總結:」開頭,一兩句話說這次看到什麼。`);
	return parts.join("\n\n");
}

function resolveInside(root: string, rel: string): string {
	if (isAbsolute(rel)) throw new Error(tr("巡檢不接受絕對路徑"));
	try {
		const base = realpathSync(root), path = realpathSync(join(base, rel));
		if (!pathInside(path, base)) throw new Error(tr("巡檢只能讀取專案內的路徑"));
		return path;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(tr("找不到路徑:{path}", { path: rel }));
		throw e;
	}
}

export function repoList(root: string, dir = "."): string {
	return readdirSync(resolveInside(root, dir), { withFileTypes: true })
		.filter((e) => e.name !== ".git" && e.name !== "node_modules").slice(0, 300)
		.map((e) => e.name + (e.isDirectory() ? "/" : "")).join("\n");
}

export function repoRead(root: string, path: string, offset = 0, limit = 400): string {
	const file = resolveInside(root, path);
	if (statSync(file).size > 2 * 1024 * 1024) throw new Error(tr("巡檢不能讀取超過 2MB 的檔案"));
	const data = readFileSync(file);
	if (data.includes(0)) throw new Error(tr("巡檢不能讀取二進位檔案"));
	const start = Math.max(0, Math.floor(offset)), count = Math.max(0, Math.min(800, Math.floor(limit)));
	return data.toString("utf8").split(/\r?\n/).slice(start, start + count).map((line, i) => `${start + i + 1}: ${line}`).join("\n");
}

export function repoGit(root: string, args: string[]): string {
	if (!["log", "show", "diff", "status", "ls-files", "blame", "shortlog"].includes(args[0])) throw new Error(tr("巡檢不允許這個 git 指令"));
	if (args.some((a) => ["-c", "--exec", "--output", "-o"].some((prefix) => a.startsWith(prefix)) || a === "--ext-diff" || a === "--textconv" || a === "--no-index")) throw new Error(tr("巡檢不允許這個 git 參數"));
	const output = execFileSync("git", ["--no-pager", "-c", "core.pager=cat", "-c", "diff.external=", ...args], {
		cwd: root, timeout: 15_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
		env: { ...process.env, GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "" }, maxBuffer: 16 * 1024 * 1024,
	});
	return output.length > 60_000 ? output.slice(0, 60_000) + "\n" + tr("(輸出超過 60,000 字,已截斷)") : output;
}
