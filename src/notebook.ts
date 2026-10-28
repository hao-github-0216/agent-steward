// 程式碼頁的 Notebook 執行:每個 .ipynb 一個 Jupyter kernel(用 nbkernel.py 橋接),輸出用 SSE 即時送到網頁。
// kernel 跑在使用者選的 Python 環境(專案的 .venv 優先);沒有 ipykernel 時可以一鍵安裝。
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { which } from "./agents.ts";
import { inProject } from "./code.ts";
import { IS_WIN } from "./platform.ts";
import { DATA_DIR } from "./settings.ts";
import type { Project } from "./store.ts";

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "nbkernel.py");
/** 專案管家自己的 Jupyter 環境(使用者選「安裝」又沒有專案環境時建在這裡) */
const OWN_ENV = join(DATA_DIR, "jupyter", ".venv");
const pyIn = (venv: string) => (IS_WIN ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python"));

export interface PythonEnv { python: string; label: string; version?: string; ready: boolean; why?: string; own?: boolean }

function check(python: string): Promise<{ version?: string; ready: boolean; why?: string }> {
	return new Promise((ok) => {
		execFile(python, ["-c", "import sys;v=sys.version.split()[0]\ntry:\n import ipykernel, jupyter_client;print(v,'ok')\nexcept Exception as e:\n print(v,'missing')"], { timeout: 20_000 }, (err, out) => {
			if (err) return ok({ ready: false, why: "執行失敗" });
			const [version, state] = String(out).trim().split(/\s+/);
			ok({ version, ready: state === "ok", why: state === "ok" ? undefined : "沒有安裝 ipykernel" });
		});
	});
}

/** 這個 notebook 可以用的 Python:notebook 旁邊 / 專案裡的虛擬環境、專案管家自己的環境、系統的 python */
export async function pythonEnvs(p: Project, rel: string): Promise<PythonEnv[]> {
	const nbDir = dirname(inProject(p, rel));
	const root = inProject(p, "");
	const cands: { python: string; label: string; own?: boolean }[] = [];
	const dirs = [nbDir];
	for (let d = nbDir; d.startsWith(root) && d !== dirname(d); d = dirname(d)) { if (d !== nbDir) dirs.push(d); if (d === root) break; }
	for (const d of dirs) for (const v of [".venv", "venv", "env"]) {
		const py = pyIn(join(d, v));
		if (existsSync(py)) cands.push({ python: py, label: `${d === root ? "" : `${d.slice(root.length + 1)}/`}${v}(專案環境)` });
	}
	if (process.env.CONDA_PREFIX) cands.push({ python: pyIn(process.env.CONDA_PREFIX).replace(/Scripts[\\/]python\.exe$/, "python.exe"), label: "目前的 conda 環境" });
	cands.push({ python: pyIn(OWN_ENV), label: "專案管家的 Jupyter 環境", own: true });
	for (const name of IS_WIN ? ["python", "py"] : ["python3", "python"]) {
		const w = which(name);
		if (w) { cands.push({ python: w, label: `系統的 ${name}` }); break; }
	}
	const seen = new Set<string>();
	const out: PythonEnv[] = [];
	for (const c of cands) {
		if (!existsSync(c.python)) {
			if (c.own) out.push({ ...c, ready: false, why: "還沒建立" });
			continue;
		}
		let real = c.python;
		try { real = realpathSync(c.python); } catch { /* 用原路徑 */ }
		if (seen.has(real) && !c.own) continue;
		seen.add(real);
		out.push({ ...c, ...(await check(c.python)) });
	}
	return out;
}

function run(cmd: string, args: string[], cwd?: string): Promise<string> {
	return new Promise((ok, fail) => {
		execFile(cmd, args, { timeout: 10 * 60_000, cwd, maxBuffer: 20 * 1024 * 1024 }, (err, out, errOut) => (err ? fail(new Error(String(errOut || out || err.message).trim().split("\n").slice(-4).join(" ").slice(0, 600))) : ok(String(out))));
	});
}

/** 安裝 ipykernel:own = 建立專案管家自己的環境;否則裝進指定的 Python(使用者按了按鈕才會做) */
export async function installKernel(python: string, own: boolean): Promise<string> {
	const uv = which("uv");
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
	const r = await check(python);
	if (!r.ready) throw new Error("裝完還是不能用,請確認這個 Python 環境");
	return python;
}

// ---------- 執行中的 kernel ----------
interface Session { key: string; child: ChildProcess; python: string; state: string; idleTimer?: ReturnType<typeof setTimeout>; buf: string }
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
	return s ? { running: true, python: s.python, state: s.state } : { running: false };
}

export function startKernel(p: Project, rel: string, python: string): { python: string } {
	const key = keyOf(p, rel);
	const old = sessions.get(key);
	if (old && old.python === python) return { python };
	if (old) stopKernel(key);
	const cwd = dirname(inProject(p, rel));
	const child = spawn(python, ["-u", BRIDGE], { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYDEVD_DISABLE_FILE_VALIDATION: "1" } });
	const s: Session = { key, child, python, state: "starting", buf: "" };
	sessions.set(key, s);
	broadcast(key, { ev: "status", state: "starting", python });
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
	return { python };
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
