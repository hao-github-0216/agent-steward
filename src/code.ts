// 「程式碼」模式的後端:專案內的檔案瀏覽/讀寫,以及 git 操作。
// 安全:所有路徑都限制在專案資料夾內(含 symlink 跳脫檢查);呼叫端必須先通過 Tailscale 身分檢查。
import { execFile } from "node:child_process";
import { trash as osTrash } from "./platform.ts";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { Project } from "./store.ts";
import { settings, onSettingsChange } from "./settings.ts";

export const EDIT_LIMIT = 5 * 1024 * 1024; // 5MB 以下正常編輯
export const VIEW_LIMIT = 50 * 1024 * 1024; // 50MB 以下唯讀(頭尾各 N 行)
const HEADTAIL_LINES = 2000;
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon", ".pdf": "application/pdf", ".ipynb": "application/json; charset=utf-8",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12", ".xls": "application/vnd.ms-excel", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".doc": "application/msword", ".ppt": "application/vnd.ms-powerpoint" };
/** Office 檔:網頁顯示 + 用 Office 編輯(word / excel / powerpoint) */
export const OFFICE: Record<string, "word" | "excel" | "powerpoint"> = { ".docx": "word", ".doc": "word", ".xlsx": "excel", ".xlsm": "excel", ".xls": "excel", ".pptx": "powerpoint", ".ppt": "powerpoint" };

export class CodeError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

// ---------- 路徑 ----------

/** 把相對路徑轉成專案內的絕對路徑;跳出專案(含 symlink)一律拒絕 */
export function inProject(p: Project, rel = ""): string {
	const root = realpathSync(p.root);
	const abs = resolve(root, rel.replace(/^\/+/, ""));
	if (abs !== root && !abs.startsWith(root + sep)) throw new CodeError(400, "路徑不在專案資料夾內");
	// 已存在的路徑:檢查 symlink 解析後仍在專案內;不存在的(新檔)檢查上層
	let probe = abs;
	while (!existsSync(probe) && probe !== root) probe = dirname(probe);
	const real = realpathSync(probe);
	if (real !== root && !real.startsWith(root + sep)) throw new CodeError(400, "路徑不在專案資料夾內");
	return abs;
}

const relOf = (p: Project, abs: string) => relative(realpathSync(p.root), abs).split(sep).join("/");
export const hashOf = (buf: Buffer | string) => createHash("sha1").update(buf).digest("hex");

// ---------- git ----------

export function git(p: Project, args: string[], opts: { timeout?: number; input?: string; env?: Record<string, string> } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((res) => {
		const child = execFile("git", ["-C", p.root, ...args], { timeout: opts.timeout ?? 20_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...opts.env } }, (err, stdout, stderr) => {
			res({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
		});
		if (opts.input !== undefined) {
			child.stdin?.end(opts.input);
		}
	});
}

async function quietEnv(p: Project): Promise<Record<string, string>> {
	const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
	if (process.env.GIT_SSH_COMMAND === undefined && (await git(p, ["config", "--get", "core.sshCommand"])).code !== 0) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
	return env;
}

const autoFetchState = new Map<string, { at?: number; error?: string; authFailed?: string; running?: Promise<unknown> }>();
const AUTH_FAIL = /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|Host key verification failed|HTTP Basic: Access denied|Invalid username or password|Repository not found|returned error: 40[13]|access denied/i;

export function autoFetchInfo(top: string): { at?: number; error?: string; authFailed?: string } {
	const cur = autoFetchState.get(top);
	if (!cur) return {};
	const { running, ...info } = cur;
	return info;
}

let autoFetchMode = settings().code.autoFetch;
onSettingsChange((s) => {
	if (s.code.autoFetch === "on" && autoFetchMode !== "on") {
		for (const cur of autoFetchState.values()) delete cur.authFailed;
	}
	autoFetchMode = s.code.autoFetch;
});

async function gitOk(p: Project, args: string[], timeout?: number): Promise<string> {
	const r = await git(p, args, { timeout });
	if (r.code !== 0) throw new CodeError(400, (r.stderr || r.stdout).trim().split("\n").slice(-6).join("\n") || `git ${args[0]} 失敗`);
	return r.stdout;
}

export async function isRepo(p: Project): Promise<boolean> {
	return (await git(p, ["rev-parse", "--is-inside-work-tree"])).stdout.trim() === "true";
}

/**
 * 專案資料夾在 repo 裡的位置(例如一個 repo 底下有好幾個專案資料夾 course/hw1、course/hw2 時是 "hw1/";專案就是 repo 根目錄時是 "")。
 * git 面板只管這個資料夾:狀態、暫存、捨棄、diff、歷史都限定在這裡,路徑一律相對於專案資料夾。
 */
const prefixCache = new Map<string, { at: number; prefix: string; top: string }>();
export async function repoPrefix(p: Project): Promise<{ prefix: string; top: string }> {
	const hit = prefixCache.get(p.root);
	if (hit && Date.now() - hit.at < 60_000) return hit;
	const r = await git(p, ["rev-parse", "--show-prefix", "--show-toplevel"]);
	const [prefix = "", top = ""] = r.code === 0 ? r.stdout.split("\n") : [];
	const v = { at: Date.now(), prefix, top };
	prefixCache.set(p.root, v);
	return v;
}
const nestedCache = new Map<string, { at: number; repos: { rel: string; branch: string }[] }>();
export async function nestedRepos(p: Project): Promise<{ rel: string; branch: string }[]> {
	const hit = nestedCache.get(p.root);
	if (hit && Date.now() - hit.at < 60_000) return hit.repos;
	const root = realpathSync(p.root);
	const repos: { rel: string; branch: string }[] = [];
	let common = "", seen = 0;
	const own = await git(p, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	// 用 .native:Windows 的短檔名(RUNNER~1)會展開成長檔名,和 git 回的路徑一致
	if (own.code === 0) { try { common = realpathSync.native(own.stdout.trim()); } catch {} }
	const scan = async (dir: string, depth: number): Promise<void> => {
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (!e.isDirectory() || e.name.startsWith(".") || ["node_modules", "__pycache__", "venv"].includes(e.name)) continue;
			if (seen >= 5000) return;
			seen++;
			const d = join(dir, e.name);
			let candidate = false;
			try { const st = statSync(join(d, ".git")); candidate = st.isFile() || st.isDirectory(); } catch {}
			if (candidate) {
				const sub = { ...p, root: d };
				// 是不是 repo 最上層交給 git 判斷(prefix 是空的),不比對路徑字串
				const pre = await git(sub, ["rev-parse", "--show-prefix"]);
				if (pre.code !== 0 || pre.stdout.trim() !== "") continue;
				const shared = await git(sub, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
				if (shared.code !== 0) continue;
				try {
					if (common && realpathSync.native(shared.stdout.trim()) === common) continue; // 專案自己 repo 的 linked worktree
				} catch { continue; }
				const current = await git(sub, ["branch", "--show-current"]);
				let branch = current.code === 0 ? current.stdout.trim() : "";
				if (!branch) {
					const head = await git(sub, ["rev-parse", "--short", "HEAD"]);
					branch = head.code === 0 ? head.stdout.trim() : "";
				}
				repos.push({ rel: relative(root, d).split(sep).join("/"), branch });
			} else if (depth < 3) await scan(d, depth + 1);
		}
	};
	await scan(root, 1);
	repos.sort((a, b) => a.rel.localeCompare(b.rel));
	nestedCache.set(p.root, { at: Date.now(), repos });
	return repos;
}

export async function repoView(p: Project, repo: string) {
	if (!repo) return { p, toProj: (x: string) => x, fromProj: (x: string) => x, repo: "" };
	if (!(await nestedRepos(p)).some((x) => x.rel === repo)) throw new CodeError(400, "找不到這個 repo");
	return {
		p: { ...p, root: join(realpathSync(p.root), ...repo.split("/")) }, repo,
		toProj: (x: string) => `${repo}/${x}`,
		fromProj: (x: string) => {
			if (!x.startsWith(`${repo}/`)) throw new CodeError(400, "路徑不在這個 repo 裡");
			return x.slice(repo.length + 1);
		},
	};
}

/** repo 根目錄的相對路徑 → 專案資料夾的相對路徑;不在專案資料夾裡回 undefined */
const fromRoot = (prefix: string, path: string) => (!prefix ? path : path.startsWith(prefix) ? path.slice(prefix.length) : undefined);

/** 暫存區裡不在這個專案資料夾的檔案(repo 根目錄的相對路徑):commit 會把它們一起帶進去 */
export async function stagedOutside(p: Project): Promise<string[]> {
	const { prefix } = await repoPrefix(p);
	if (!prefix) return [];
	const r = await git(p, ["diff", "--cached", "--name-only", "-z", "--ignore-submodules=none"]);
	return r.stdout.split("\0").filter((x) => x && !x.startsWith(prefix));
}

/** git status:分支、上游、領先/落後、各組檔案(只列這個專案資料夾裡的) */
export async function status(p: Project) {
	const nested = await nestedRepos(p);
	if (!(await isRepo(p))) return { repo: false as const, nested };
	const empty = (await git(p, ["rev-parse", "--verify", "-q", "HEAD"])).code !== 0;
	const { prefix, top } = await repoPrefix(p);
	const out = (await gitOk(p, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--", "."])).split("\0");
	let branch = "", upstream = "", ahead = 0, behind = 0;
	const staged: { path: string; code: string; from?: string }[] = [];
	const unstaged: { path: string; code: string }[] = [];
	const untracked: { path: string }[] = [];
	const conflicted: { path: string }[] = [];
	for (let i = 0; i < out.length; i++) {
		const line = out[i];
		if (!line) continue;
		if (line.startsWith("# branch.head ")) branch = line.slice(14);
		else if (line.startsWith("# branch.upstream ")) upstream = line.slice(18);
		else if (line.startsWith("# branch.ab ")) {
			const m = line.match(/\+(\d+) -(\d+)/);
			if (m) [ahead, behind] = [Number(m[1]), Number(m[2])];
		} else if (line.startsWith("1 ") || line.startsWith("2 ")) {
			const parts = line.split(" ");
			const xy = parts[1];
			const path = fromRoot(prefix, line.startsWith("1 ") ? parts.slice(8).join(" ") : parts.slice(9).join(" "));
			const fromRaw = line.startsWith("2 ") ? out[++i] : undefined; // rename 的原檔名在下一段
			if (path === undefined) continue;
			const from = fromRaw === undefined ? undefined : (fromRoot(prefix, fromRaw) ?? `/${fromRaw}`);
			if (xy[0] !== ".") staged.push({ path, code: xy[0], from });
			if (xy[1] !== ".") unstaged.push({ path, code: xy[1] });
		} else if (line.startsWith("u ")) {
			const path = fromRoot(prefix, line.split(" ").slice(10).join(" "));
			if (path !== undefined) conflicted.push({ path });
		} else if (line.startsWith("? ")) {
			const path = fromRoot(prefix, line.slice(2));
			if (path !== undefined) untracked.push({ path });
		}
	}
	// 子資料夾專案:告訴網頁這個 repo 還有別的資料夾(分支、拉取/推送是整個 repo 共用的),以及暫存區裡有沒有別的資料夾的檔案
	const sub = prefix ? { prefix: prefix.replace(/\/$/, ""), repoName: basename(top), outsideStaged: await stagedOutside(p) } : {};
	return { repo: true as const, branch, upstream, ahead, behind, staged, unstaged, untracked, conflicted, nested, empty, autoFetch: autoFetchInfo(top), ...sub };
}

export async function statusIn(p: Project, repo: string) {
	if (!repo) return status(p);
	const v = await repoView(p, repo);
	const st = await status(v.p);
	if (!st.repo) return st;
	const { nested, ...rest } = st;
	return {
		...rest, repoRel: repo, repoName: basename(v.p.root),
		staged: st.staged.map((x) => ({ ...x, path: v.toProj(x.path), ...(x.from ? { from: v.toProj(x.from) } : {}) })),
		unstaged: st.unstaged.map((x) => ({ ...x, path: v.toProj(x.path) })),
		untracked: st.untracked.map((x) => ({ ...x, path: v.toProj(x.path) })),
		conflicted: st.conflicted.map((x) => ({ ...x, path: v.toProj(x.path) })),
	};
}

/** 差異檢視用:回傳左右兩邊的完整內容(Monaco diff 自己算差異) */
export async function diffSides(p: Project, rel: string, which: "staged" | "unstaged" | "untracked" | "commit", commit?: string) {
	inProject(p, rel);
	const show = async (spec: string) => {
		const r = await git(p, ["show", spec]);
		return r.code === 0 ? r.stdout : "";
	};
	const work = () => {
		const abs = inProject(p, rel);
		return existsSync(abs) ? readFileSync(abs, "utf8") : "";
	};
	// HEAD:./x 是相對於目前資料夾(專案資料夾);不加 ./ 會被當成 repo 根目錄的路徑
	if (which === "staged") return { original: await show(`HEAD:./${rel}`), modified: await show(`:./${rel}`) };
	if (which === "unstaged") return { original: await show(`:./${rel}`), modified: work() };
	if (which === "commit" && commit) {
		if (!/^[0-9a-f]{4,40}$/i.test(commit)) throw new CodeError(400, "commit 格式不對");
		return { original: await show(`${commit}^:./${rel}`), modified: await show(`${commit}:./${rel}`) };
	}
	return { original: "", modified: work() };
}

export async function diffIn(p: Project, repo: string, rel: string, which: "staged" | "unstaged" | "untracked" | "commit", commit?: string) {
	if (!repo) return diffSides(p, rel, which, commit);
	const v = await repoView(p, repo);
	return diffSides(v.p, v.fromProj(rel), which, commit);
}

export async function gitActionIn(p: Project, repo: string, action: string, b: Record<string, unknown>): Promise<unknown> {
	if (!repo) return gitAction(p, action, b);
	const v = await repoView(p, repo);
	const b2 = { ...b };
	if (Array.isArray(b2.paths)) b2.paths = b2.paths.map((x) => v.fromProj(String(x)));
	const out = await gitAction(v.p, action, b2);
	if (action === "show") {
		const shown = out as { files: { code: string; path: string }[] };
		return { ...shown, files: shown.files.map((x) => ({ ...x, path: v.toProj(x.path) })) };
	}
	return out;
}

const safePaths = (p: Project, paths: unknown): string[] => {
	if (!Array.isArray(paths) || !paths.length) throw new CodeError(400, "沒有指定檔案");
	return paths.map((x) => {
		inProject(p, String(x));
		return String(x);
	});
};

export async function gitAction(p: Project, action: string, b: Record<string, unknown>): Promise<unknown> {
	switch (action) {
		case "stage":
			// 「全部」= 這個專案資料夾裡的全部(不是整個 repo)
			return gitOk(p, b.all ? ["add", "-A", "--", "."] : ["add", "--", ...safePaths(p, b.paths)]);
		case "unstage":
			return gitOk(p, b.all ? ["reset", "-q", "--", "."] : ["reset", "-q", "--", ...safePaths(p, b.paths)]);
		case "discard": {
			// 追蹤中的檔案:還原成上次提交/暫存的內容;新檔案:移到垃圾桶(救得回來)
			const st = await status(p);
			if (!st.repo) throw new CodeError(400, "不是 git repo");
			const paths = safePaths(p, b.paths);
			const untracked = new Set(st.untracked.map((x) => x.path));
			const tracked = paths.filter((x) => !untracked.has(x));
			if (tracked.length) await gitOk(p, ["restore", "--worktree", "--", ...tracked]);
			for (const x of paths.filter((y) => untracked.has(y))) await trash(inProject(p, x));
			return "ok";
		}
		case "commit": {
			const msg = String(b.message ?? "").trim();
			if (!msg) throw new CodeError(400, "提交訊息不能是空的");
			// 暫存區有別的資料夾的檔案:先問(outside = "unstage" 先把它們取消暫存;"include" 一起提交)
			const outside = await stagedOutside(p);
			if (outside.length && b.outside === "unstage") {
				const { top } = await repoPrefix(p);
				await gitOk({ ...p, root: top }, ["reset", "-q", "--", ...outside]);
			} else if (outside.length && b.outside !== "include") {
				throw Object.assign(new CodeError(409, `暫存區裡有 ${outside.length} 個不在這個專案資料夾的檔案(同一個 repo 的其他資料夾),commit 會把它們一起帶進去:${outside.slice(0, 8).join("、")}${outside.length > 8 ? "…" : ""}`), { outside });
			}
			if (!(await git(p, ["diff", "--cached", "--quiet"])).code) throw new CodeError(400, "沒有已暫存的變更可以提交");
			return gitOk(p, ["commit", "-m", msg]);
		}
		case "branches": {
			const out = await gitOk(p, ["branch", "--all", "--format=%(HEAD)%09%(refname:short)%09%(upstream:short)"]);
			return out.trim().split("\n").filter(Boolean).map((l) => {
				const [head, name, up] = l.split("\t");
				return { current: head === "*", name, upstream: up || undefined, remote: name.startsWith("remotes/") || name.includes("/") && !up && !name.startsWith("refs") };
			});
		}
		case "checkout": {
			const name = String(b.branch ?? "");
			if (!/^[\w./-]+$/.test(name) || name.startsWith("-")) throw new CodeError(400, "分支名稱不合法");
			return gitOk(p, b.create ? ["switch", "-c", name] : ["switch", name]);
		}
		case "pull":
			return gitOk(p, ["pull", "--ff-only"], 120_000);
		case "push": {
			const st = await status(p);
			if (!st.repo) throw new CodeError(400, "不是 git repo");
			return gitOk(p, st.upstream ? ["push"] : ["push", "-u", "origin", st.branch], 120_000);
		}
		case "autofetch": {
			const prefs = settings().code;
			if (prefs.autoFetch !== "on") return { skipped: "off" };
			if (!(await isRepo(p))) return { skipped: "not-repo" };
			if (!(await git(p, ["remote"])).stdout.trim()) return { skipped: "no-remote" };
			const { top } = await repoPrefix(p);
			const cur = autoFetchState.get(top) ?? {};
			if (cur.authFailed) return { skipped: "auth", authFailed: cur.authFailed };
			if (cur.running) {
				await cur.running;
				return { skipped: "running", ...autoFetchInfo(top) };
			}
			if (cur.at && Date.now() - cur.at < prefs.autoFetchMinutes * 60000 - 5000) return { skipped: "recent", ...autoFetchInfo(top) };
			const running = (async () => {
				const r = await git(p, ["fetch", "--prune", "--no-recurse-submodules"], { timeout: 60000, env: await quietEnv(p) });
				const at = Date.now();
				if (r.code === 0) {
					autoFetchState.set(top, { at });
					return { fetched: true, at };
				}
				const msg = r.stderr.trim().split("\n").map((line) => line.trim()).filter(Boolean).pop()?.slice(0, 300) || "git fetch 失敗";
				if (AUTH_FAIL.test(r.stderr)) {
					autoFetchState.set(top, { at, authFailed: msg });
					return { fetched: false, authFailed: msg };
				}
				autoFetchState.set(top, { at, error: msg });
				return { fetched: false, error: msg };
			})();
			autoFetchState.set(top, { ...cur, running });
			return running;
		}
		case "fetch": {
			const out = await gitOk(p, ["fetch", "--prune"], 120_000);
			const { top } = await repoPrefix(p);
			autoFetchState.set(top, { at: Date.now() });
			return out;
		}
		case "log": {
			if ((await git(p, ["rev-parse", "--verify", "-q", "HEAD"])).code !== 0) return [];
			// 只列改到這個專案資料夾的 commit
			const out = await gitOk(p, ["log", "-n", "50", "--date=iso-strict", "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e", "--", "."]);
			return out.split("\x1e").map((x) => x.trim()).filter(Boolean).map((x) => {
				const [hash, short, author, date, subject] = x.split("\x1f");
				return { hash, short, author, date, subject };
			});
		}
		case "show": {
			const c = String(b.commit ?? "");
			if (!/^[0-9a-f]{4,40}$/i.test(c)) throw new CodeError(400, "commit 格式不對");
			// --relative:只列這個專案資料夾裡的檔案,路徑相對於專案資料夾
			const out = await gitOk(p, ["show", "--relative", "--name-status", "--format=%H%x1f%an%x1f%ad%x1f%B%x1e", "--date=iso-strict", c]);
			const [head, files] = out.split("\x1e");
			const [hash, author, date, body] = head.split("\x1f");
			return { hash, author, date, body: body?.trim(), files: (files ?? "").trim().split("\n").filter(Boolean).map((l) => { const [code, ...rest] = l.split("\t"); return { code, path: rest[rest.length - 1] }; }) };
		}
		case "diffText": {
			// 產生提交訊息用:已暫存的變更(沒有暫存就用全部變更),截斷避免太長
			let d = await gitOk(p, ["diff", "--cached", "--stat", "--patch", "--no-color"]);
			if (!d.trim()) d = await gitOk(p, ["diff", "--stat", "--patch", "--no-color", "--", "."]);
			return d.slice(0, 40_000);
		}
		default:
			throw new CodeError(400, `不支援的 git 動作:${action}`);
	}
}

// ---------- 檔案 ----------

export function trash(abs: string): Promise<void> {
	return osTrash(abs).catch((err) => { throw new CodeError(500, `移到垃圾桶失敗:${err.message}`); });
}

export const UPLOAD_LIMIT = 500 * 1024 * 1024;
/**
 * 從瀏覽器上傳檔案到專案裡(rel 可含子資料夾,上傳整個資料夾時用)。
 * 先串流寫到同資料夾的暫存檔,寫完才換上;同名檔案要 overwrite 才會覆蓋,舊檔先移到垃圾桶。
 */
export async function uploadFile(p: Project, rel: string, body: Readable, overwrite: boolean, declared = 0): Promise<{ rel: string; size: number; replaced: boolean }> {
	const abs = inProject(p, rel);
	const name = basename(abs);
	if (!name || name === "." || name === ".." || abs === realpathSync(p.root)) throw new CodeError(400, "檔名不合法");
	if (declared > UPLOAD_LIMIT) throw new CodeError(413, `檔案太大(上限 ${UPLOAD_LIMIT / 1024 / 1024} MB)`);
	const exists = existsSync(abs);
	if (exists && lstatSync(abs).isDirectory()) throw new CodeError(409, "已經有同名的資料夾");
	if (exists && !overwrite) throw Object.assign(new CodeError(409, "已經有同名的檔案"), { exists: true });
	mkdirSync(dirname(abs), { recursive: true });
	inProject(p, rel); // 建完上層資料夾再確認一次沒跳出專案
	const tmp = join(dirname(abs), `.${name}.upload-${process.pid}-${Date.now()}`);
	let size = 0;
	try {
		await new Promise<void>((ok, fail) => {
			const out = createWriteStream(tmp);
			body.on("data", (c: Buffer) => {
				size += c.length;
				if (size > UPLOAD_LIMIT) { body.destroy(); out.destroy(); fail(new CodeError(413, `檔案太大(上限 ${UPLOAD_LIMIT / 1024 / 1024} MB)`)); }
			});
			body.on("error", fail);
			body.on("aborted", () => fail(new CodeError(400, "上傳中斷")));
			out.on("error", fail);
			out.on("finish", ok);
			body.pipe(out);
		});
		if (exists) await trash(abs);
		renameSync(tmp, abs);
	} catch (e) {
		try { unlinkSync(tmp); } catch {}
		throw e;
	}
	return { rel: relOf(p, abs), size, replaced: exists };
}

/** 列出資料夾:檔案/資料夾、大小、是否被 .gitignore 忽略、git 狀態 */
export async function listDir(p: Project, rel: string, showHidden: boolean) {
	const abs = inProject(p, rel);
	if (!statSync(abs).isDirectory()) throw new CodeError(400, "不是資料夾");
	const entries = readdirSync(abs, { withFileTypes: true })
		.filter((d) => showHidden || !d.name.startsWith("."))
		.filter((d) => d.name !== ".git")
		.map((d) => {
			const full = join(abs, d.name);
			let size = 0;
			let type: "dir" | "file" = d.isDirectory() ? "dir" : "file";
			try {
				const st = statSync(full);
				size = st.size;
				type = st.isDirectory() ? "dir" : "file";
			} catch {
				/* 壞掉的 symlink */
			}
			return { name: d.name, rel: relOf(p, full), type, size };
		});
	const repo = await isRepo(p);
	const ignored = new Set<string>();
	const marks = new Map<string, string>();
	if (repo && entries.length) {
		const r = await git(p, ["check-ignore", "--stdin", "-z"], { input: entries.map((e) => (e.type === "dir" ? `${e.rel}/` : e.rel)).join("\0") + "\0" });
		for (const x of r.stdout.split("\0")) if (x) ignored.add(x.replace(/\/$/, ""));
		const st = await status(p);
		if (st.repo) {
			const mark = (path: string, m: string) => {
				// 檔案本身,以及它所在的每一層資料夾都標記(資料夾顯示「裡面有變更」)
				marks.set(path, m);
				let d = dirname(path);
				while (d && d !== ".") {
					if (!marks.has(d)) marks.set(d, "•");
					d = dirname(d);
				}
			};
			for (const x of st.untracked) mark(x.path, "U");
			for (const x of [...st.unstaged, ...st.staged]) mark(x.path, x.code === "D" ? "D" : x.code === "A" ? "A" : "M");
			for (const x of st.conflicted) mark(x.path, "!");
		}
	}
	return entries
		.map((e) => ({ ...e, ignored: ignored.has(e.rel), git: marks.get(e.rel) }))
		.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}

function looksBinary(buf: Buffer): boolean {
	const n = Math.min(buf.length, 8000);
	for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
	return false;
}

/** 讀檔:依大小與類型決定怎麼給(可編輯 / 頭尾唯讀 / 只給資訊 / 圖片 PDF 預覽) */
export function readFile(p: Project, rel: string, opts: { more?: number } = {}) {
	const abs = inProject(p, rel);
	const st = statSync(abs);
	if (st.isDirectory()) throw new CodeError(400, "這是資料夾");
	const ext = extname(abs).toLowerCase();
	const base = { path: rel, name: basename(abs), size: st.size, mtime: st.mtimeMs };
	if (IMAGE.has(ext)) return { ...base, kind: "image" as const };
	if (ext === ".pdf") return { ...base, kind: "pdf" as const, hash: officeStamp(st) };
	if (OFFICE[ext]) return { ...base, kind: "office" as const, app: OFFICE[ext], hash: officeStamp(st) };
	if (st.size > VIEW_LIMIT) return { ...base, kind: "toolarge" as const };
	const buf = readFileSync(abs);
	if (looksBinary(buf)) return { ...base, kind: "binary" as const };
	if (st.size <= EDIT_LIMIT) {
		const text = buf.toString("utf8");
		return { ...base, kind: "text" as const, content: text, hash: hashOf(buf), readonly: false };
	}
	// 5–50MB:唯讀,頭尾各 N 行(more 可以多載入)
	const lines = buf.toString("utf8").split("\n");
	const n = HEADTAIL_LINES + (opts.more ?? 0);
	if (lines.length <= n * 2) return { ...base, kind: "text" as const, content: lines.join("\n"), readonly: true, hash: hashOf(buf) };
	const content = [...lines.slice(0, n), "", `…… 中間省略 ${lines.length - n * 2} 行(檔案太大,只顯示開頭和結尾各 ${n} 行)……`, "", ...lines.slice(-n)].join("\n");
	return { ...base, kind: "text" as const, content, readonly: true, truncated: { total: lines.length, shown: n } };
}

export function rawFile(p: Project, rel: string): { buf: Buffer; type: string } {
	const abs = inProject(p, rel);
	const ext = extname(abs).toLowerCase();
	if (!MIME[ext]) throw new CodeError(400, "只支援圖片、PDF、Notebook 與 Office 預覽");
	if (statSync(abs).size > VIEW_LIMIT) throw new CodeError(413, "檔案太大");
	return { buf: readFileSync(abs), type: MIME[ext] };
}

/** 存檔:檔案在開啟後被別人改過(hash 不同)就回 409 和磁碟上的新內容,除非 force */
export function writeFile(p: Project, rel: string, content: string, baseHash: string | undefined, force: boolean) {
	const abs = inProject(p, rel);
	if (existsSync(abs)) {
		const st = lstatSync(abs);
		if (st.isDirectory()) throw new CodeError(400, "這是資料夾");
		if (st.size > EDIT_LIMIT) throw new CodeError(413, "大檔是唯讀的");
		const disk = readFileSync(abs);
		const diskHash = hashOf(disk);
		if (!force && baseHash && diskHash !== baseHash) {
			const e = new CodeError(409, "檔案在你開啟之後被改過了") as CodeError & { disk?: unknown };
			e.disk = { content: disk.toString("utf8"), hash: diskHash };
			throw e;
		}
	}
	writeFileSync(abs, content);
	const st = statSync(abs);
	return { hash: hashOf(readFileSync(abs)), mtime: st.mtimeMs, size: st.size };
}

/** 新增 / 改名 / 刪除(移到垃圾桶) */
export async function fsOp(p: Project, op: string, rel: string, to?: string) {
	const abs = inProject(p, rel);
	const nameOk = (n: string) => n && !n.includes("/") && n !== "." && n !== "..";
	switch (op) {
		case "mkfile":
		case "mkdir": {
			if (!nameOk(basename(abs))) throw new CodeError(400, "名稱不合法");
			if (existsSync(abs)) throw new CodeError(409, "已經有同名的檔案或資料夾");
			if (op === "mkdir") mkdirSync(abs, { recursive: true });
			else {
				mkdirSync(dirname(abs), { recursive: true });
				writeFileSync(abs, "");
			}
			return { rel: relOf(p, abs) };
		}
		case "rename": {
			if (!to) throw new CodeError(400, "缺少新名稱");
			const dest = inProject(p, to);
			if (existsSync(dest)) throw new CodeError(409, "已經有同名的檔案或資料夾");
			if (abs === realpathSync(p.root)) throw new CodeError(400, "不能改專案資料夾本身");
			renameSync(abs, dest);
			return { rel: relOf(p, dest) };
		}
		case "trash": {
			if (abs === realpathSync(p.root)) throw new CodeError(400, "不能刪除專案資料夾本身");
			await trash(abs);
			return { rel };
		}
		default:
			throw new CodeError(400, `不支援的操作:${op}`);
	}
}

/** 檔案在磁碟上的版本(給前端判斷要不要自動重新載入) */
export function fileStamps(p: Project, rels: string[]) {
	const out: Record<string, { hash?: string; gone?: boolean }> = {};
	for (const rel of rels.slice(0, 50)) {
		try {
			const abs = inProject(p, rel);
			if (!existsSync(abs)) {
				out[rel] = { gone: true };
				continue;
			}
			const st = statSync(abs);
			// Office 檔用大小 + 修改時間(檔案可能很大,不每次都讀整個檔)
			if (OFFICE[extname(abs).toLowerCase()] || extname(abs).toLowerCase() === ".pdf") { out[rel] = { hash: officeStamp(st) }; continue; }
			if (st.size > EDIT_LIMIT) continue;
			out[rel] = { hash: hashOf(readFileSync(abs)) };
		} catch {
			out[rel] = { gone: true };
		}
	}
	return out;
}

// ---------- 給「問管家」用 ----------
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "env", "__pycache__", ".next", "dist", "build", "target", ".cache", ".mypy_cache", ".pytest_cache", ".ipynb_checkpoints"]);
/** 在專案裡找檔名(浮動球「＋ 檔案」的搜尋框) */
export function findFiles(p: Project, q: string, limit = 30): string[] {
	const root = inProject(p, "");
	const needle = q.trim().toLowerCase();
	if (!needle) return [];
	const hits: { rel: string; score: number }[] = [];
	const stack = [root];
	let seen = 0;
	while (stack.length && seen < 30_000) {
		const dir = stack.pop()!;
		let names: string[];
		try { names = readdirSync(dir); } catch { continue; }
		for (const name of names) {
			const abs = join(dir, name);
			let st;
			try { st = lstatSync(abs); } catch { continue; }
			if (st.isSymbolicLink()) continue;
			if (st.isDirectory()) { if (!SKIP_DIRS.has(name) && !name.startsWith(".")) stack.push(abs); continue; }
			seen++;
			const rel = relative(root, abs).split(sep).join("/");
			const low = rel.toLowerCase();
			if (!low.includes(needle)) continue;
			// 檔名本身符合的排前面,路徑短的排前面
			hits.push({ rel, score: (name.toLowerCase().includes(needle) ? 0 : 1000) + rel.length });
		}
	}
	return hits.sort((a, b) => a.score - b.score).slice(0, limit).map((h) => h.rel);
}

export const CHAT_FILE_LIMIT = 100_000; // 單一檔案最多帶 100KB(超過只帶頭尾)
/** 把檔案內容整理成問管家用的文字;content 有給就用它(編輯器裡還沒存的版本) */
export function fileForChat(p: Project, rel: string, content?: string): { path: string; text?: string; note?: string } {
	let text = content;
	if (typeof text !== "string") {
		const f = readFile(p, rel);
		if (f.kind !== "text") return { path: rel, note: f.kind === "image" || f.kind === "pdf" ? "不是文字檔(圖片請用「＋ 圖片」)" : f.kind === "toolarge" ? "檔案太大" : "不是文字檔" };
		text = f.content;
	}
	if (/\.ipynb$/i.test(rel)) text = notebookAsText(text);
	if (text.length > CHAT_FILE_LIMIT) {
		const half = CHAT_FILE_LIMIT / 2;
		text = `${text.slice(0, half)}\n\n…(中間省略 ${text.length - CHAT_FILE_LIMIT} 字,檔案太長只帶開頭和結尾)…\n\n${text.slice(-half)}`;
	}
	return { path: rel, text };
}

/** Notebook 轉成好讀的文字:依序列出儲存格,文字輸出保留(太長截掉),圖片只標註 */
function notebookAsText(json: string): string {
	let nb: { cells?: { cell_type: string; source?: string | string[]; execution_count?: number | null; outputs?: Record<string, unknown>[] }[] };
	try { nb = JSON.parse(json); } catch { return json; }
	const t = (x: unknown) => (Array.isArray(x) ? x.join("") : typeof x === "string" ? x : "");
	const clip = (s: string, n = 2000) => (s.length > n ? `${s.slice(0, n)}…(省略 ${s.length - n} 字)` : s);
	const out: string[] = [];
	(nb.cells ?? []).forEach((c, i) => {
		const src = t(c.source);
		if (c.cell_type === "markdown") { out.push(`## [儲存格 ${i + 1}] Markdown\n${src}`); return; }
		if (c.cell_type !== "code") { out.push(`## [儲存格 ${i + 1}] ${c.cell_type}\n${src}`); return; }
		const parts = [`## [儲存格 ${i + 1}] 程式碼${c.execution_count != null ? `(執行編號 ${c.execution_count})` : "(沒執行過)"}\n${src}`];
		for (const o of c.outputs ?? []) {
			const d = (o.data ?? {}) as Record<string, unknown>;
			if (o.output_type === "stream") parts.push(`輸出:\n${clip(t(o.text))}`);
			else if (o.output_type === "error") parts.push(`錯誤:${o.ename}: ${o.evalue}`);
			else if (d["image/png"] || d["image/jpeg"] || d["image/svg+xml"]) parts.push("輸出:(一張圖)");
			else if (d["text/plain"]) parts.push(`輸出:\n${clip(t(d["text/plain"]))}`);
		}
		out.push(parts.join("\n"));
	});
	return out.join("\n\n");
}

/** Office 檔的版本識別:大小 + 修改時間 */
export function officeStamp(st: { size: number; mtimeMs: number }): string {
	return `o${st.size}-${Math.round(st.mtimeMs)}`;
}
