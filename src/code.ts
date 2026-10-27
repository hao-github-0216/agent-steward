// 「程式碼」模式的後端:專案內的檔案瀏覽/讀寫,以及 git 操作。
// 安全:所有路徑都限制在專案資料夾內(含 symlink 跳脫檢查);呼叫端必須先通過 Tailscale 身分檢查。
import { execFile } from "node:child_process";
import { trash as osTrash } from "./platform.ts";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { Project } from "./store.ts";

export const EDIT_LIMIT = 5 * 1024 * 1024; // 5MB 以下正常編輯
export const VIEW_LIMIT = 50 * 1024 * 1024; // 50MB 以下唯讀(頭尾各 N 行)
const HEADTAIL_LINES = 2000;
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon", ".pdf": "application/pdf" };

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

export function git(p: Project, args: string[], opts: { timeout?: number; input?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((res) => {
		const child = execFile("git", ["-C", p.root, ...args], { timeout: opts.timeout ?? 20_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } }, (err, stdout, stderr) => {
			res({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
		});
		if (opts.input !== undefined) {
			child.stdin?.end(opts.input);
		}
	});
}

async function gitOk(p: Project, args: string[], timeout?: number): Promise<string> {
	const r = await git(p, args, { timeout });
	if (r.code !== 0) throw new CodeError(400, (r.stderr || r.stdout).trim().split("\n").slice(-6).join("\n") || `git ${args[0]} 失敗`);
	return r.stdout;
}

export async function isRepo(p: Project): Promise<boolean> {
	return (await git(p, ["rev-parse", "--is-inside-work-tree"])).stdout.trim() === "true";
}

/** git status:分支、上游、領先/落後、各組檔案 */
export async function status(p: Project) {
	if (!(await isRepo(p))) return { repo: false as const };
	const out = (await gitOk(p, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])).split("\0");
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
			const path = line.startsWith("1 ") ? parts.slice(8).join(" ") : parts.slice(9).join(" ");
			const from = line.startsWith("2 ") ? out[++i] : undefined; // rename 的原檔名在下一段
			if (xy[0] !== ".") staged.push({ path, code: xy[0], from });
			if (xy[1] !== ".") unstaged.push({ path, code: xy[1] });
		} else if (line.startsWith("u ")) conflicted.push({ path: line.split(" ").slice(10).join(" ") });
		else if (line.startsWith("? ")) untracked.push({ path: line.slice(2) });
	}
	return { repo: true as const, branch, upstream, ahead, behind, staged, unstaged, untracked, conflicted };
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
	if (which === "staged") return { original: await show(`HEAD:${rel}`), modified: await show(`:${rel}`) };
	if (which === "unstaged") return { original: await show(`:${rel}`), modified: work() };
	if (which === "commit" && commit) {
		if (!/^[0-9a-f]{4,40}$/i.test(commit)) throw new CodeError(400, "commit 格式不對");
		return { original: await show(`${commit}^:${rel}`), modified: await show(`${commit}:${rel}`) };
	}
	return { original: "", modified: work() };
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
			return gitOk(p, b.all ? ["add", "-A"] : ["add", "--", ...safePaths(p, b.paths)]);
		case "unstage":
			return gitOk(p, b.all ? ["reset", "-q"] : ["reset", "-q", "--", ...safePaths(p, b.paths)]);
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
		case "fetch":
			return gitOk(p, ["fetch", "--prune"], 120_000);
		case "log": {
			const out = await gitOk(p, ["log", "-n", "50", "--date=iso-strict", "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e"]);
			return out.split("\x1e").map((x) => x.trim()).filter(Boolean).map((x) => {
				const [hash, short, author, date, subject] = x.split("\x1f");
				return { hash, short, author, date, subject };
			});
		}
		case "show": {
			const c = String(b.commit ?? "");
			if (!/^[0-9a-f]{4,40}$/i.test(c)) throw new CodeError(400, "commit 格式不對");
			const out = await gitOk(p, ["show", "--name-status", "--format=%H%x1f%an%x1f%ad%x1f%B%x1e", "--date=iso-strict", c]);
			const [head, files] = out.split("\x1e");
			const [hash, author, date, body] = head.split("\x1f");
			return { hash, author, date, body: body?.trim(), files: (files ?? "").trim().split("\n").filter(Boolean).map((l) => { const [code, ...rest] = l.split("\t"); return { code, path: rest[rest.length - 1] }; }) };
		}
		case "diffText": {
			// 產生提交訊息用:已暫存的變更(沒有暫存就用全部變更),截斷避免太長
			let d = await gitOk(p, ["diff", "--cached", "--stat", "--patch", "--no-color"]);
			if (!d.trim()) d = await gitOk(p, ["diff", "--stat", "--patch", "--no-color"]);
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
	if (ext === ".pdf") return { ...base, kind: "pdf" as const };
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
	if (!MIME[ext]) throw new CodeError(400, "只支援圖片與 PDF 預覽");
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
			if (statSync(abs).size > EDIT_LIMIT) continue;
			out[rel] = { hash: hashOf(readFileSync(abs)) };
		} catch {
			out[rel] = { gone: true };
		}
	}
	return out;
}
