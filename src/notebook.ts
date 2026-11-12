// 程式碼頁的 Notebook 執行:每個 .ipynb 一個 Jupyter kernel(用 nbkernel.py 橋接),輸出用 SSE 即時送到網頁。
// 可選已註冊的 kernelspec 或偵測到的 Python 環境;缺少橋接套件時可以一鍵安裝。
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { which } from "./agents.ts";
import { OWN_JUPYTER, uvPath } from "./plugins.ts";
import { inProject } from "./code.ts";
import { IS_WIN } from "./platform.ts";
import { settings } from "./settings.ts";
import type { Project } from "./store.ts";

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "nbkernel.py");
/** 專案管家自己的 Jupyter 環境(使用者選「安裝」又沒有專案環境時建在這裡) */
const OWN_ENV = OWN_JUPYTER;
const pyIn = (venv: string) => (IS_WIN ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python"));

export interface PythonEnv {
	id: string;
	kind: "python" | "kernelspec";
	group: "kernel" | "project" | "conda" | "pyenv" | "custom" | "own" | "system";
	python: string;
	label: string;
	version?: string;
	ready: boolean;
	why?: string;
	own?: boolean;
	name?: string;
	displayName?: string;
	language?: string;
	specDir?: string;
	bridge?: string;
}
export interface PythonCheck { version?: string; ready: boolean; why?: string; jupyterClient?: boolean }
type Checker = (python: string) => Promise<PythonCheck>;
const checkCaches = new Map<Checker, Map<string, { at: number; value: Promise<PythonCheck> }>>();
const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };
/** 一個 Python 的身分。虛擬環境裡的 python 通常連到同一個基底 Python(例如 uv 管的 cpython),
 *  所以在虛擬環境裡改用環境資料夾當身分,不同的虛擬環境才不會被當成同一個。 */
const pyKey = (python: string) => {
	const dir = dirname(python);
	const prefix = /^(bin|Scripts)$/i.test(basename(dir)) ? dirname(dir) : dir;
	return isFile(join(prefix, "pyvenv.cfg")) ? `${real(prefix)}${sep}` : real(python);
};
/** 選單用的環境 id(伺服器回傳新加入或剛安裝的環境時也用這個) */
export const pyId = (python: string) => `py:${pyKey(python)}`;

function clearChecks(): void { checkCaches.clear(); }
function cachedCheck(python: string, checker: Checker): Promise<PythonCheck> {
	let mtime: number;
	try { mtime = statSync(python).mtimeMs; } catch { return Promise.resolve({ ready: false, why: "找不到 Python 程式" }); }
	const key = `${pyKey(python)}:${mtime}`;
	let cache = checkCaches.get(checker);
	if (!cache) checkCaches.set(checker, (cache = new Map()));
	const old = cache.get(key);
	if (old && Date.now() - old.at < 5 * 60_000) return old.value;
	const value = Promise.resolve().then(() => checker(python)).catch(() => ({ ready: false, why: "執行失敗" }));
	cache.set(key, { at: Date.now(), value });
	return value;
}

const probePython: Checker = (python) => new Promise((ok) => {
	const script = `import sys,json
v=sys.version.split()[0]
def has(name):
 try:
  __import__(name);return True
 except Exception:
  return False
print(json.dumps({"version":v,"ipykernel":has("ipykernel"),"jupyterClient":has("jupyter_client")}))`;
	execFile(python, ["-c", script], { timeout: 20_000, windowsHide: true }, (err, out) => {
		if (err) return ok({ ready: false, why: "執行失敗" });
		try {
			const result = JSON.parse(String(out).trim().split("\n").at(-1)!);
			if (typeof result.version !== "string" || !/^\d+\.\d+\.\d+[a-zA-Z0-9.+-]*$/.test(result.version)) throw new Error("version");
			const jupyterClient = result.jupyterClient === true;
			const ready = result.ipykernel === true && jupyterClient;
			ok({ version: result.version, ready, jupyterClient, why: ready ? undefined : !jupyterClient ? "沒有安裝 jupyter_client" : "沒有安裝 ipykernel" });
		} catch { ok({ ready: false, why: "無法確認 Python 版本" }); }
	});
});
/** 分別檢查 jupyter_client 與 Python kernel 能力;手動加入時還必須有可信的 version。 */
export const check: Checker = (python) => cachedCheck(python, probePython);

export interface PythonEnvOptions { check?: Checker; home?: string; platform?: NodeJS.Platform; refresh?: boolean }
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "env", "__pycache__", ".next", "dist", "build", "target", ".cache", ".mypy_cache", ".pytest_cache", ".ipynb_checkpoints"]);
const ENV_DIRS = new Set([".venv", "venv", "env", ".conda"]);
const PYTHON_NAME = /^python(\d+(\.\d+)*)?(\.exe)?$/i;
function entries(dir: string) { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } }

/** 偵測已註冊核心與可用的 Python;只以 realpath 去重,啟動時保留環境原始路徑。 */
export async function pythonEnvs(p: Project, rel: string, options: PythonEnvOptions = {}): Promise<PythonEnv[]> {
	if (options.refresh) clearChecks();
	const platform = options.platform ?? process.platform;
	const win = platform === "win32";
	const home = options.home ?? ((win && process.env.USERPROFILE) || homedir());
	const envPython = (prefix: string) => win ? join(prefix, "Scripts", "python.exe") : join(prefix, "bin", "python");
	const condaPython = (prefix: string) => win ? join(prefix, "python.exe") : envPython(prefix);
	const inspect = (python: string) => options.check ? cachedCheck(python, options.check) : check(python);
	const pathDirs = (process.env.PATH ?? "").split(win ? ";" : ":").filter(Boolean).map((d) => d.replace(/^"|"$/g, ""));
	const findOnPath = (names: string[]) => pathDirs.flatMap((d) => names.map((n) => join(d, n))).filter(isFile);
	const root = inProject(p, "");
	const nbDir = rel ? dirname(inProject(p, rel)) : root;
	type Candidate = Pick<PythonEnv, "python" | "label" | "group" | "own">;
	const cands: Candidate[] = [];
	const projectSeen = new Set<string>();
	const addProject = (dir: string) => {
		const python = win && basename(dir) === ".conda" ? condaPython(dir) : envPython(dir);
		if (projectSeen.size >= 30 || !isFile(python) || projectSeen.has(pyKey(python))) return;
		projectSeen.add(pyKey(python));
		cands.push({ python, group: "project", label: `${relative(root, dir).split(sep).join("/")}（專案環境）` });
	};
	for (let d = nbDir; ; d = dirname(d)) {
		for (const name of [".venv", "venv", "env"]) addProject(join(d, name));
		if (d === root || d === dirname(d)) break;
	}
	const walked = new Map<string, number>();
	let folders = 0;
	const walk = (dir: string, depth: number) => {
		if (depth >= 3 || folders >= 2000 || projectSeen.size >= 30 || (walked.get(dir) ?? Infinity) <= depth) return;
		walked.set(dir, depth);
		for (const entry of entries(dir)) {
			if (folders >= 2000 || projectSeen.size >= 30) break;
			const abs = join(dir, entry.name);
			// 目標環境可以是 symlink,但一般目錄 symlink 絕不遞迴。
			if (ENV_DIRS.has(entry.name)) { folders++; addProject(abs); continue; }
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			folders++;
			if (!SKIP_DIRS.has(entry.name)) walk(abs, depth + 1);
		}
	};
	walk(root, 0);
	if (nbDir !== root) walk(nbDir, 0);

	const condaBases = new Set<string>();
	const addConda = (prefix: string, name = basename(prefix)) => {
		const python = condaPython(prefix);
		if (!isFile(python)) return;
		const previous = cands.find((c) => c.group === "conda" && pyKey(c.python) === pyKey(python));
		if (previous) { if (name === "base") previous.label = "conda: base"; }
		else cands.push({ python, group: "conda", label: `conda: ${name}` });
	};
	if (process.env.CONDA_PREFIX) addConda(process.env.CONDA_PREFIX);
	try { for (const prefix of readFileSync(join(home, ".conda", "environments.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) addConda(prefix); } catch { /* 沒有環境清單 */ }
	const condaExes = [...(process.env.CONDA_EXE ? [process.env.CONDA_EXE] : []), ...findOnPath(win ? ["conda.exe", "conda.bat", "conda.cmd"] : ["conda"])];
	for (const exe of condaExes) for (const path of [exe, real(exe)]) {
		const dir = dirname(path);
		condaBases.add(/^(bin|Scripts|condabin)$/i.test(basename(dir)) ? dirname(dir) : dir);
	}
	for (const name of ["miniconda3", "miniforge3", "anaconda3", "mambaforge"]) condaBases.add(join(home, name));
	if (!win) for (const dir of ["/opt/homebrew/Caskroom/miniconda/base", "/opt/miniconda3", "/opt/anaconda3"]) condaBases.add(dir);
	for (const base of condaBases) {
		addConda(base, "base");
		for (const entry of entries(join(base, "envs"))) addConda(join(base, "envs", entry.name));
	}
	const pyenvRoot = process.env.PYENV_ROOT || (win ? join(home, ".pyenv", "pyenv-win") : join(home, ".pyenv"));
	for (const entry of entries(join(pyenvRoot, "versions"))) {
		const python = envPython(join(pyenvRoot, "versions", entry.name));
		// pyenv-win 的 python.exe 在版本根目錄,不是 Scripts。
		const path = win ? join(pyenvRoot, "versions", entry.name, "python.exe") : python;
		if (isFile(path)) cands.push({ python: path, group: "pyenv", label: `pyenv: ${entry.name}` });
	}
	// 設定也可能被直接改過,列出前再檢查一次:只收絕對路徑、檔名像 Python 的檔案。
	for (const python of settings().plugins.notebook.pythons) if (isAbsolute(python) && PYTHON_NAME.test(basename(python)) && isFile(python)) cands.push({ python, group: "custom", label: python });
	cands.push({ python: envPython(OWN_ENV), group: "own", label: "專案管家的 Jupyter 環境", own: true });
	const systemSeen = new Set(cands.filter((c) => isFile(c.python)).map((c) => pyKey(c.python)));
	let systemCount = 0;
	for (const python of findOnPath(win ? ["python.exe", "py.exe"] : ["python3", "python"])) {
		if (systemCount >= 5) break;
		if (systemSeen.has(pyKey(python))) continue;
		systemSeen.add(pyKey(python)); systemCount++;
		cands.push({ python, group: "system", label: `系統的 ${basename(python)} (${python})` });
	}
	const seen = new Set<string>();
	const unique = cands.filter((c) => {
		if ((!isFile(c.python) && !c.own) || seen.has(pyKey(c.python))) return false;
		seen.add(pyKey(c.python)); return true;
	});
	const pythons = await Promise.all(unique.map(async (c): Promise<PythonEnv> => {
		const result: PythonCheck = isFile(c.python) ? await inspect(c.python) : { ready: false, why: "還沒建立" };
		return { ...c, id: pyId(c.python), kind: "python", version: result.version, ready: result.ready, why: result.why };
	}));

	const specRoots: { dir: string; environment?: boolean }[] = [];
	if (platform === "darwin") specRoots.push({ dir: join(home, "Library", "Jupyter", "kernels") });
	else if (win) specRoots.push({ dir: join(process.env.APPDATA || join(home, "AppData", "Roaming"), "jupyter", "kernels") });
	else specRoots.push({ dir: join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "jupyter", "kernels") });
	for (const dir of (process.env.JUPYTER_PATH ?? "").split(win ? ";" : ":").filter(Boolean)) specRoots.push({ dir: join(dir, "kernels") });
	if (win) { if (process.env.PROGRAMDATA) specRoots.push({ dir: join(process.env.PROGRAMDATA, "jupyter", "kernels") }); }
	else for (const dir of ["/usr/local/share/jupyter/kernels", "/usr/share/jupyter/kernels", "/opt/homebrew/share/jupyter/kernels"]) specRoots.push({ dir });
	for (const c of cands) {
		const dir = dirname(c.python);
		const prefix = /^(bin|Scripts)$/i.test(basename(dir)) ? dirname(dir) : dir;
		specRoots.push({ dir: join(prefix, "share", "jupyter", "kernels"), environment: true });
	}
	const specs: { specDir: string; name: string; displayName: string; language?: string; program: string }[] = [];
	const specSeen = new Set<string>();
	for (const { dir, environment } of specRoots) for (const entry of entries(dir)) {
		if (environment && entry.name === "python3") continue;
		const specDir = join(dir, entry.name);
		if (specSeen.has(real(specDir))) continue;
		try {
			const spec = JSON.parse(readFileSync(join(specDir, "kernel.json"), "utf8"));
			if (!spec || typeof spec !== "object" || Array.isArray(spec) || !Array.isArray(spec.argv) || !spec.argv.length || !spec.argv.every((s: unknown) => typeof s === "string" && s.trim().length > 0)) continue;
			specSeen.add(real(specDir));
			specs.push({ specDir, name: entry.name, displayName: typeof spec.display_name === "string" ? spec.display_name : entry.name, language: typeof spec.language === "string" ? spec.language : undefined, program: spec.argv[0] });
		} catch { /* 壞掉或不是 kernelspec 的資料夾 */ }
	}
	const fallback = pythons.find((e) => e.own && e.ready) ?? pythons.find((e) => e.ready);
	const kernels = await Promise.all(specs.map(async ({ specDir, name, displayName, language, program }): Promise<PythonEnv> => {
		let bridge: string | undefined;
		const missing = isAbsolute(program) && !existsSync(program);
		if (!missing && PYTHON_NAME.test(basename(program))) {
			const names = win && !/\.exe$/i.test(program) ? [`${program}.exe`, program] : [program];
			const python = isAbsolute(program) ? program : !/[\\/]/.test(program) ? findOnPath(names)[0] : undefined;
			if (python && (await inspect(python)).jupyterClient) bridge = python;
		}
		bridge ??= fallback?.python;
		return { id: `ks:${real(specDir)}`, kind: "kernelspec", group: "kernel", python: program, label: displayName, name, displayName, language, specDir, bridge,
			ready: !missing && !!bridge, why: missing ? "核心指定的程式不存在" : bridge ? undefined : "需要一個有 jupyter_client 的 Python 才能啟動這個核心" };
	}));
	return [...kernels, ...pythons];
}

function run(cmd: string, args: string[], cwd?: string): Promise<string> {
	return new Promise((ok, fail) => {
		execFile(cmd, args, { timeout: 10 * 60_000, cwd, maxBuffer: 20 * 1024 * 1024 }, (err, out, errOut) => (err ? fail(new Error(String(errOut || out || err.message).trim().split("\n").slice(-4).join(" ").slice(0, 600))) : ok(String(out))));
	});
}

/** 安裝 ipykernel:own = 建立專案管家自己的環境;否則裝進指定的 Python(使用者按了按鈕才會做) */
export async function installKernel(python: string, own: boolean): Promise<string> {
	const uv = uvPath();
	const pkgs = ["ipykernel", "jupyter_client"];
	if (own) {
		const py = pyIn(OWN_ENV);
		if (!existsSync(py)) {
			if (uv) await run(uv, ["venv", "--seed", OWN_ENV]);
			else {
				const sys = which(IS_WIN ? "python" : "python3") ?? which("python");
				if (!sys) throw new Error("這台電腦找不到 Python,請先安裝 Python 3");
				await run(sys, ["-m", "venv", OWN_ENV]);
			}
		}
		python = py;
	}
	// 先用 pip;沒有 pip(uv 建的環境)就用 uv
	try { await run(python, ["-m", "pip", "install", "--quiet", ...pkgs]); }
	catch (e) {
		if (!uv) throw e;
		await run(uv, ["pip", "install", "--quiet", "--python", python, ...pkgs]);
	}
	clearChecks();
	const r = await check(python);
	if (!r.ready) throw new Error("裝完還是不能用,請確認這個 Python 環境");
	return python;
}

// ---------- 執行中的 kernel ----------
interface Session { key: string; child: ChildProcess; id: string; python: string; state: string; idleTimer?: ReturnType<typeof setTimeout>; buf: string }
const sessions = new Map<string, Session>();
/** 正在看這個 notebook 的網頁(SSE);跟 kernel 分開存,kernel 還沒啟動也能先訂閱 */
const listeners = new Map<string, Set<ServerResponse>>();
const keyOf = (p: Project, rel: string) => `${p.id}:${rel}`;

function broadcast(key: string, ev: unknown) {
	const line = `data: ${JSON.stringify(ev)}\n\n`;
	for (const c of listeners.get(key) ?? []) c.write(line);
}
/** 沒有網頁在看 30 分鐘就關掉 kernel */
function armIdle(key: string) {
	const s = sessions.get(key);
	if (!s) return;
	clearTimeout(s.idleTimer);
	if (listeners.get(key)?.size) return;
	s.idleTimer = setTimeout(() => stopKernel(key), 30 * 60_000);
}

export function kernelInfo(p: Project, rel: string) {
	const s = sessions.get(keyOf(p, rel));
	return s ? { running: true, id: s.id, python: s.python, state: s.state } : { running: false };
}

export function startKernel(p: Project, rel: string, env: PythonEnv): { id: string; python: string } {
	const { id, python } = env;
	const key = keyOf(p, rel);
	const old = sessions.get(key);
	if (old && old.id === id) return { id, python };
	if (old) stopKernel(key);
	const cwd = dirname(inProject(p, rel));
	const executable = env.kind === "kernelspec" ? env.bridge : python;
	if (!executable || (env.kind === "kernelspec" && !env.specDir)) throw new Error("找不到核心的 Python 橋接環境");
	const args = ["-u", BRIDGE, ...(env.kind === "kernelspec" ? ["--spec-dir", env.specDir!] : [])];
	const child = spawn(executable, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYDEVD_DISABLE_FILE_VALIDATION: "1" } });
	const s: Session = { key, child, id, python, state: "starting", buf: "" };
	sessions.set(key, s);
	broadcast(key, { ev: "status", state: "starting", kernelId: id, python });
	child.stdout!.setEncoding("utf8");
	child.stdout!.on("data", (d: string) => {
		s.buf += d;
		let i: number;
		while ((i = s.buf.indexOf("\n")) >= 0) {
			const line = s.buf.slice(0, i); s.buf = s.buf.slice(i + 1);
			if (!line.trim()) continue;
			let ev: { ev?: string; state?: string };
			try { ev = JSON.parse(line); } catch { continue; }
			if (ev.ev === "ready") s.state = "idle";
			if (ev.ev === "status" && ev.state) s.state = ev.state;
			if (sessions.get(key) === s) broadcast(key, ev);
		}
	});
	let errTail = "";
	child.stderr!.on("data", (d) => { errTail = (errTail + d).slice(-2000); });
	child.on("error", (e) => { errTail += String(e.message); });
	child.on("exit", (code) => {
		if (sessions.get(key) !== s) return;
		sessions.delete(key);
		clearTimeout(s.idleTimer);
		const why = errTail.split("\n").map((l) => l.trim()).filter((l) => l && !/without encryption|WARNING/.test(l)).slice(-2).join(" ");
		broadcast(key, { ev: "exit", code, message: code ? why.slice(0, 400) : undefined });
	});
	armIdle(key);
	return { id, python };
}

export function sendKernel(p: Project, rel: string, cmd: Record<string, unknown>): boolean {
	const s = sessions.get(keyOf(p, rel));
	if (!s?.child.stdin?.writable) return false;
	s.child.stdin.write(`${JSON.stringify(cmd)}\n`);
	return true;
}

export function stopKernel(key: string): void {
	const s = sessions.get(key);
	if (!s) return;
	sessions.delete(key);
	clearTimeout(s.idleTimer);
	try { s.child.stdin?.write('{"op":"shutdown"}\n'); s.child.stdin?.end(); } catch { /* 已經結束 */ }
	setTimeout(() => { if (s.child.exitCode === null) s.child.kill(); }, 5000);
	broadcast(key, { ev: "exit", code: 0 });
}
export const stopKernelFor = (p: Project, rel: string) => stopKernel(keyOf(p, rel));

/** 網頁訂閱這個 notebook 的 kernel 事件(SSE) */
export function subscribe(p: Project, rel: string, res: ServerResponse): void {
	const key = keyOf(p, rel);
	res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
	res.write(`data: ${JSON.stringify({ ev: "hello", ...kernelInfo(p, rel) })}\n\n`);
	let set = listeners.get(key);
	if (!set) listeners.set(key, (set = new Set()));
	set.add(res);
	clearTimeout(sessions.get(key)?.idleTimer);
	const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
	res.on("close", () => {
		clearInterval(ping);
		set!.delete(res);
		if (!set!.size) listeners.delete(key);
		armIdle(key);
	});
}

/** 管家結束時關掉所有 kernel */
export function stopAllKernels(): void {
	for (const key of [...sessions.keys()]) stopKernel(key);
}
