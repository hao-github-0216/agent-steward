// 內建外掛:LaTeX 編譯、Notebook 執行、Office 編輯。
// 設定 → 外掛 打開時,需要的軟體自動下載到 ~/.agent-steward/tools(不需要管理員權限);
// 電腦上已經有的(MacTeX、裝了 ipykernel 的 Python)直接沿用。「移除」只刪專案管家自己下載的東西。
import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { which } from "./agents.ts";
import { IS_WIN } from "./platform.ts";
import { DATA_DIR, hasSystemJupyter, hasSystemTex, type PluginId, settings, updateSettings } from "./settings.ts";

export const TOOLS = join(DATA_DIR, "tools");
// 偵測電腦上的 TeX / Jupyter 要跑外部程式:結果快取 60 秒
const cache = new Map<string, { at: number; v: boolean }>();
const cached = (k: string, fn: () => boolean) => { const c = cache.get(k); if (c && Date.now() - c.at < 60_000) return c.v; const v = fn(); cache.set(k, { at: Date.now(), v }); return v; };
const sysTex = () => cached("tex", hasSystemTex);
const sysJupyter = () => cached("jupyter", hasSystemJupyter);
const ARCH = process.arch === "arm64" ? "arm64" : "x64";

// ---------- 下載與執行 ----------
type Log = (msg: string, progress?: number) => void;
async function download(url: string, to: string, log: Log, label: string): Promise<void> {
	const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30 * 60_000) });
	if (!r.ok || !r.body) throw new Error(`下載失敗(${r.status}):${url}`);
	const total = Number(r.headers.get("content-length")) || 0;
	mkdirSync(dirname(to), { recursive: true });
	const tmp = `${to}.part`;
	const out = createWriteStream(tmp);
	let got = 0, lastPct = -1;
	for await (const chunk of Readable.fromWeb(r.body as never)) {
		got += (chunk as Buffer).length;
		if (!out.write(chunk)) await new Promise((ok) => out.once("drain", ok));
		const pct = total ? Math.floor((got / total) * 100) : -1;
		if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; log(`下載${label}… ${pct}%(${Math.round(got / 1048576)} / ${Math.round(total / 1048576)} MB)`, pct); }
	}
	await new Promise<void>((ok, fail) => out.end((e?: Error) => (e ? fail(e) : ok())));
	renameSync(tmp, to);
}
function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
	return new Promise((ok, fail) => {
		execFile(cmd, args, { ...opts, timeout: 30 * 60_000, maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (err, out, errOut) => (err ? fail(new Error(String(errOut || out || err.message).trim().split("\n").slice(-6).join(" ").slice(0, 800))) : ok(String(out))));
	});
}
/** 解壓縮用的 tar:Windows 固定用內建的(裝了 Git 的電腦,PATH 裡的 tar 是 Git 的,會把 D:\ 當成遠端主機) */
function tarExe(): string {
	if (!IS_WIN) return "tar";
	const sys = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
	return existsSync(sys) ? sys : "tar";
}
async function latestTag(repo: string): Promise<string> {
	const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { "user-agent": "agent-steward", accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20_000) });
	if (!r.ok) throw new Error(`查不到 ${repo} 的最新版本(${r.status})`);
	return ((await r.json()) as { tag_name: string }).tag_name;
}

// ---------- LaTeX:TinyTeX ----------
const TINYTEX = join(TOOLS, "TinyTeX");
/** 專案管家裝的 TinyTeX 的 bin 資料夾(裡面有 latexmk、xelatex、tlmgr) */
export function tinytexBin(): string | undefined {
	const base = join(TINYTEX, "bin");
	if (!existsSync(base)) return undefined;
	for (const d of readdirSync(base)) {
		const dir = join(base, d);
		if (existsSync(join(dir, IS_WIN ? "latexmk.exe" : "latexmk"))) return dir;
	}
	return undefined;
}
async function installLatex(log: Log): Promise<void> {
	const tag = await latestTag("rstudio/tinytex-releases");
	const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : `linux-${ARCH === "arm64" ? "arm64" : "x86_64"}`;
	const name = process.platform === "win32" ? `TinyTeX-1-windows-${tag}.exe` : `TinyTeX-1-${os}-${tag}.tar.xz`;
	const file = join(TOOLS, ".downloads", name);
	await download(`https://github.com/rstudio/tinytex-releases/releases/download/${tag}/${name}`, file, log, " TinyTeX");
	log("解壓縮 TinyTeX…");
	rmSync(TINYTEX, { recursive: true, force: true });
	mkdirSync(TOOLS, { recursive: true });
	// Windows 版是自解壓檔(7-Zip),其他是 tar.xz
	if (process.platform === "win32") await run(file, ["-y", `-o${TOOLS}`]);
	else await run(tarExe(), ["-xJf", file, "-C", TOOLS]);
	// Linux 版解壓出來是隱藏資料夾 .TinyTeX
	if (!existsSync(TINYTEX) && existsSync(join(TOOLS, ".TinyTeX"))) renameSync(join(TOOLS, ".TinyTeX"), TINYTEX);
	rmSync(file, { force: true });
	const bin = tinytexBin();
	if (!bin) {
		// 有些版本沒有附 latexmk:用 tlmgr 補
		const anyBin = join(TINYTEX, "bin", readdirSync(join(TINYTEX, "bin"))[0] ?? "");
		await run(join(anyBin, IS_WIN ? "tlmgr.bat" : "tlmgr"), ["install", "latexmk"]);
	}
	const b = tinytexBin();
	if (!b) throw new Error("TinyTeX 安裝完成但找不到 latexmk");
	// 中文常用:xeCJK + Fandol 字型(其他缺的套件編譯時自動補)
	const tl = join(b, IS_WIN ? "tlmgr.bat" : "tlmgr");
	// TinyTeX 打包的 tlmgr 常比線上套件庫舊,要先更新它自己才能裝套件
	log("更新 TeX 套件管理工具…");
	await run(tl, ["update", "--self"]).catch((e) => log(`更新 tlmgr 失敗:${e.message}`));
	log("安裝中文支援(xeCJK、Fandol 字型)…");
	const err = await run(tl, ["install", "xecjk", "fandol", "ctex", "zhnumber"]).then(() => null, (e) => e as Error);
	// tlmgr 最後重建格式檔時常報錯,但套件其實裝好了:用 kpsewhich 確認
	const ok = await run(join(b, IS_WIN ? "kpsewhich.exe" : "kpsewhich"), ["xeCJK.sty"]).then((x) => !!x.trim(), () => false);
	log(ok ? "中文支援已安裝" : `中文支援沒裝成功(編譯時會再自動補):${err?.message ?? ""}`);
}

// ---------- Notebook:uv + Python + Jupyter ----------
const UV_DIR = join(TOOLS, "uv");
export const OWN_JUPYTER = join(DATA_DIR, "jupyter", ".venv");
export const ownJupyterPython = () => (IS_WIN ? join(OWN_JUPYTER, "Scripts", "python.exe") : join(OWN_JUPYTER, "bin", "python"));
/** uv:電腦上的優先,沒有就用專案管家下載的 */
export function uvPath(): string | undefined {
	const own = join(UV_DIR, IS_WIN ? "uv.exe" : "uv");
	return which("uv") ?? (existsSync(own) ? own : undefined);
}
async function installNotebook(log: Log): Promise<void> {
	let uv = uvPath();
	if (!uv) {
		const triple = process.platform === "darwin" ? `${ARCH === "arm64" ? "aarch64" : "x86_64"}-apple-darwin` : process.platform === "win32" ? "x86_64-pc-windows-msvc" : `${ARCH === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`;
		const name = `uv-${triple}${IS_WIN ? ".zip" : ".tar.gz"}`;
		const file = join(TOOLS, ".downloads", name);
		await download(`https://github.com/astral-sh/uv/releases/latest/download/${name}`, file, log, " uv");
		log("解壓縮 uv…");
		rmSync(UV_DIR, { recursive: true, force: true });
		mkdirSync(UV_DIR, { recursive: true });
		// Windows 10 以上內建 tar(可以解 zip);tar.gz 裡有一層資料夾
		await run(tarExe(), IS_WIN ? ["-xf", file, "-C", UV_DIR] : ["-xzf", file, "-C", UV_DIR, "--strip-components", "1"]);
		rmSync(file, { force: true });
		uv = uvPath();
		if (!uv) throw new Error("uv 解壓縮後找不到執行檔");
	}
	// Python 也由 uv 下載(放在 tools/python,不影響電腦上的 Python)
	const env = { ...process.env, UV_PYTHON_INSTALL_DIR: join(TOOLS, "python"), UV_CACHE_DIR: join(TOOLS, ".uv-cache") };
	log("建立 Python 3.12 環境…");
	if (!existsSync(ownJupyterPython())) await run(uv, ["venv", "--python", "3.12", "--seed", OWN_JUPYTER], { env });
	log("安裝 Jupyter kernel 與常用套件(numpy、pandas、matplotlib)…");
	await run(uv, ["pip", "install", "--python", ownJupyterPython(), "ipykernel", "jupyter_client", "numpy", "pandas", "matplotlib"], { env });
}

/** 測試用:直接執行安裝 */
export const INSTALLERS = { latex: installLatex, notebook: installNotebook };

// ---------- 外掛清單 ----------
type Status = "ready" | "system" | "installed" | "missing";
interface PluginDef {
	id: PluginId; name: string; description: string; size: string;
	/** ready = 不用裝東西;system = 沿用電腦上的;installed = 專案管家裝的;missing = 還沒裝 */
	status(): Status;
	detail(): string;
	install?(log: Log): Promise<void>;
	remove?(): void;
}
const PLUGINS: PluginDef[] = [
	{
		id: "latex", name: "LaTeX 編譯", size: "約 250 MB(TinyTeX)",
		description: "程式碼頁打開 .tex 時可以編譯,錯誤會列出來並跳到那一行,PDF 在旁邊自動更新。缺少的 LaTeX 套件會在編譯時自動安裝。",
		status: () => (tinytexBin() ? "installed" : sysTex() ? "system" : "missing"),
		detail: () => (tinytexBin() ? `TinyTeX(${TINYTEX})` : sysTex() ? "沿用電腦上的 TeX(MacTeX / TeX Live)" : "還沒安裝"),
		install: installLatex,
		remove: () => rmSync(TINYTEX, { recursive: true, force: true }),
	},
	{
		id: "notebook", name: "Notebook 執行", size: "約 300 MB(Python + Jupyter + numpy / pandas / matplotlib)",
		description: "程式碼頁的 .ipynb 可以直接執行儲存格。會優先用專案裡的 .venv;沒有的話用專案管家的 Jupyter 環境。",
		status: () => (existsSync(ownJupyterPython()) ? "installed" : sysJupyter() ? "system" : "missing"),
		detail: () => (existsSync(ownJupyterPython()) ? `專案管家的 Jupyter 環境(${OWN_JUPYTER})` : sysJupyter() ? "沿用電腦上已經裝了 ipykernel 的 Python" : "還沒安裝(專案自己的 .venv 有 ipykernel 的話也能用)"),
		install: installNotebook,
		remove: () => { rmSync(join(DATA_DIR, "jupyter"), { recursive: true, force: true }); rmSync(join(TOOLS, "python"), { recursive: true, force: true }); rmSync(UV_DIR, { recursive: true, force: true }); rmSync(join(TOOLS, ".uv-cache"), { recursive: true, force: true }); },
	},
	{
		id: "office", name: "Office 編輯", size: "不用下載",
		description: "程式碼頁的 Word / Excel / PowerPoint 檔多一個「用 Office 編輯」:在你當下用的那台電腦打開,存檔直接寫回。關閉時這個連線(WebDAV)也會停用。",
		status: () => "ready",
		detail: () => "不需要安裝(Office 在你自己的電腦上)",
	},
];

// ---------- 安裝工作 ----------
interface Job { running: boolean; message: string; progress: number; log: string[]; error?: string }
const jobs = new Map<PluginId, Job>();

export function pluginEnabled(id: PluginId): boolean {
	return !!settings().plugins?.[id]?.enabled;
}
export function pluginList() {
	return PLUGINS.map((p) => {
		// 偵測(要跑 python / which)只在列表時做
		const status = jobs.get(p.id)?.running ? "installing" : p.status();
		return { id: p.id, name: p.name, description: p.description, size: p.size, enabled: pluginEnabled(p.id), status, detail: p.detail(), removable: status === "installed" && !!p.remove, job: jobs.get(p.id) ?? null };
	});
}
function setEnabled(id: PluginId, enabled: boolean) {
	updateSettings({ plugins: { ...settings().plugins, [id]: { enabled } } });
}
/** 開關:打開時還沒裝就先在背景安裝,裝好才算開啟 */
export function togglePlugin(id: PluginId, on: boolean): { started?: boolean } {
	const def = PLUGINS.find((p) => p.id === id);
	if (!def) throw new Error("沒有這個外掛");
	if (!on) { setEnabled(id, false); return {}; }
	if (def.status() !== "missing" || !def.install) { setEnabled(id, true); return {}; }
	const cur = jobs.get(id);
	if (cur?.running) return { started: false };
	const job: Job = { running: true, message: "準備安裝…", progress: 0, log: [] };
	jobs.set(id, job);
	const log: Log = (msg, progress) => { job.message = msg; if (progress !== undefined) job.progress = progress; job.log.push(`${new Date().toLocaleTimeString("zh-TW", { hour12: false })} ${msg}`); if (job.log.length > 200) job.log.shift(); };
	def.install(log).then(
		() => { cache.clear(); job.running = false; job.message = "安裝完成"; job.progress = 100; log("安裝完成"); setEnabled(id, true); },
		(e) => { job.running = false; job.error = String((e as Error).message ?? e); job.message = `安裝失敗:${job.error}`; log(job.message); },
	);
	return { started: true };
}
export function removePluginFiles(id: PluginId): void {
	const def = PLUGINS.find((p) => p.id === id);
	if (!def?.remove) throw new Error("這個外掛沒有下載任何東西");
	if (jobs.get(id)?.running) throw new Error("正在安裝,等裝完再移除");
	def.remove();
	jobs.delete(id);
	// 移除後如果電腦上也沒有,就關掉
	if (def.status() === "missing") setEnabled(id, false);
}
