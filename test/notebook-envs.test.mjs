// Notebook 的核心偵測與路由都在隔離的子程序執行,不讀寫使用者的 Jupyter 與管家資料。
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const url = (name) => pathToFileURL(join(ROOT, "src", name)).href;

function isolated(t, source) {
	const home = mkdtempSync(join(tmpdir(), "steward-notebook-envs-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const env = {
		...process.env, HOME: home, USERPROFILE: home, APPDATA: home, PROGRAMDATA: join(home, "programdata"),
		XDG_DATA_HOME: join(home, "xdg"), XDG_CONFIG_HOME: home, STEWARD_DATA_DIR: home,
		STEWARD_APP_DIR: ROOT, STEWARD_HOSTS: "127.0.0.1", STEWARD_PORT: "0", STEWARD_TERMINAL_PORT: "0",
		JUPYTER_PATH: join(home, "jupyter-extra"), JUPYTER_CONFIG_DIR: join(home, "jupyter-config"),
		JUPYTER_DATA_DIR: join(home, "jupyter-data"), JUPYTER_RUNTIME_DIR: join(home, "jupyter-runtime"),
		PYENV_ROOT: join(home, ".pyenv"), PATH: join(home, "bin"),
		HERDR_SOCKET_PATH: join(home, "no-herdr.sock"),
	};
	for (const key of ["CONDA_PREFIX", "CONDA_EXE", "STEWARD_DESKTOP", "PYTHONPATH"]) delete env[key];
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "--eval", `
		import assert from "node:assert/strict";
		import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
		import { homedir } from "node:os";
		import { basename, delimiter, dirname, join, relative } from "node:path";
		import { createServer } from "node:net";
		import vm from "node:vm";
		const home = process.env.HOME;
		const win = process.platform === "win32";
		assert.equal(realpathSync(homedir()), realpathSync(home));
		for (const name of ["USERPROFILE", "APPDATA", "STEWARD_DATA_DIR"]) assert.equal(process.env[name], home);
		writeFileSync(join(home, "settings.json"), JSON.stringify({ version: 1, setupDone: true, aiDetected: true, access: { tailscale: { enabled: false } }, plugins: { notebook: { enabled: true, pythons: [] }, latex: { enabled: false }, office: { enabled: false } } }));
		const { DEFAULTS, settings, updateSettings } = await import(${JSON.stringify(url("settings.ts"))});
		const root = join(home, "project");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "demo.ipynb"), JSON.stringify({ nbformat: 4, nbformat_minor: 5, cells: [], metadata: { kernelspec: { name: "course-kernel" } } }));
		const p = { id: "notebook-test", root, name: "Notebook", kind: "project", status: "active", private: false };
		const py = (prefix) => join(prefix, win ? "Scripts" : "bin", win ? "python.exe" : "python");
		function file(path, content = "fixture") { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path; }
		function python(prefix) { return file(py(prefix)); }
		const userKernels = process.platform === "darwin" ? join(home, "Library", "Jupyter", "kernels") : win ? join(home, "jupyter", "kernels") : join(process.env.XDG_DATA_HOME, "jupyter", "kernels");
		function kernel(name, spec, parent = userKernels) { const dir = join(parent, name); file(join(dir, "kernel.json"), typeof spec === "string" ? spec : JSON.stringify(spec)); return dir; }
		const fakeCheck = async () => ({ version: "3.12.4", ready: true, jupyterClient: true });
		const options = { home, platform: process.platform, check: fakeCheck };
		${source}
	`], { cwd: ROOT, env, encoding: "utf8", timeout: 45_000, maxBuffer: 4 * 1024 * 1024 });
	if (result.error || result.status !== 0) throw new Error(`隔離的 Notebook 測試失敗: ${result.error?.message || result.signal || result.status}\n${result.stderr || ""}${result.stdout || ""}`);
	return result.stdout;
}

const notebook = `const { pythonEnvs } = await import(${JSON.stringify(url("notebook.ts"))});`;

test("使用者註冊的 kernelspec 使用 display_name,並回傳 metadata 可對應的 name", (t) => {
	isolated(t, `${notebook}
		const executable = python(join(home, "runtime"));
		const specDir = kernel("course-kernel", { argv: [executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"], display_name: "Course Kernel (uv)", language: "python" });
		const envs = await pythonEnvs(p, "demo.ipynb", options);
		const selected = envs.find((e) => e.name === "course-kernel");
		assert.ok(selected);
		assert.equal(selected.label, "Course Kernel (uv)");
		assert.equal(selected.displayName, "Course Kernel (uv)");
		assert.equal(selected.id, "ks:" + realpathSync(specDir));
		assert.equal(selected.kind, "kernelspec");
		assert.equal(selected.group, "kernel");
		assert.equal(selected.language, "python");
		assert.equal(selected.python, executable);
		assert.equal(selected.ready, true);
		assert.equal(selected.name, JSON.parse(readFileSync(join(root, "demo.ipynb"))).metadata.kernelspec.name);
	`);
});

test("只略過 Python 環境內的 python3 kernelspec,保留使用者註冊的同名核心", (t) => {
	isolated(t, `${notebook}
		const prefix = join(root, ".venv");
		const executable = python(prefix);
		kernel("python3", { argv: [executable], display_name: "環境內建", language: "python" }, join(prefix, "share", "jupyter", "kernels"));
		kernel("other", { argv: [executable], display_name: "環境註冊", language: "python" }, join(prefix, "share", "jupyter", "kernels"));
		kernel("python3", { argv: [executable], display_name: "使用者註冊", language: "python" });
		const envs = await pythonEnvs(p, "demo.ipynb", options);
		assert.equal(envs.some((e) => e.label === "環境內建"), false);
		assert.equal(envs.some((e) => e.label === "環境註冊"), true);
		assert.equal(envs.some((e) => e.label === "使用者註冊"), true);
	`);
});

test("向下找到第二層 .venv,略過 node_modules 和超過深度的環境", (t) => {
	isolated(t, `${notebook}
		const wanted = python(join(root, "sub", "inner", ".venv"));
		const hidden = python(join(root, "node_modules", "dependency", ".venv"));
		const deep = python(join(root, "a", "b", "c", ".venv"));
		const envs = await pythonEnvs(p, "demo.ipynb", options);
		const selected = envs.find((e) => e.id === "py:" + realpathSync(wanted));
		assert.equal(selected?.group, "project");
		assert.ok(selected.label.replaceAll("\\\\", "/").includes("sub/inner/.venv"));
		assert.equal(envs.some((e) => e.python === hidden), false);
		assert.equal(envs.some((e) => e.python === deep), false);
	`);
});

test("notebook 所在資料夾也向下搜尋,並保留向上找到的專案環境", (t) => {
	isolated(t, `${notebook}
		const upward = python(join(root, ".venv"));
		file(join(root, "a", "b", "c", "nested.ipynb"), "{}");
		const downward = python(join(root, "a", "b", "c", "sub", "inner", ".conda"));
		const envs = await pythonEnvs(p, "a/b/c/nested.ipynb", options);
		assert.equal(envs.some((e) => e.id === "py:" + realpathSync(upward)), true);
		assert.equal(envs.find((e) => e.id === "py:" + realpathSync(downward))?.group, "project");
	`);
});

test("conda 從 environments.txt 與 base/envs 發現環境,不執行 conda", (t) => {
	isolated(t, `${notebook}
		const named = join(home, "conda-environments", "course");
		const condaPython = (prefix) => win ? file(join(prefix, "python.exe")) : python(prefix);
		const listed = condaPython(named);
		file(join(home, ".conda", "environments.txt"), named + "\\n" + named + "\\n");
		const base = join(home, "miniconda3");
		const basePython = condaPython(base);
		const childPython = condaPython(join(base, "envs", "science"));
		const marker = join(home, "conda-was-executed");
		process.env.CONDA_EXE = file(join(base, win ? "Scripts" : "bin", win ? "conda.exe" : "conda"), "not an executable");
		process.env.CONDA_PREFIX = named;
		const envs = await pythonEnvs(p, "demo.ipynb", options);
		assert.equal(envs.find((e) => e.python === listed)?.group, "conda");
		assert.match(envs.find((e) => e.python === listed).label, /conda:.*course/);
		assert.equal(envs.find((e) => e.python === basePython)?.group, "conda");
		assert.equal(envs.find((e) => e.python === childPython)?.group, "conda");
		assert.equal(envs.filter((e) => e.python === listed).length, 1);
		assert.equal(existsSync(marker), false);
	`);
});

test("pyenv、自訂與 PATH 的多個 Python 依群組列出", (t) => {
	isolated(t, `${notebook}
		const versioned = win ? file(join(process.env.PYENV_ROOT, "versions", "3.12.4", "python.exe")) : python(join(process.env.PYENV_ROOT, "versions", "3.12.4"));
		const custom = python(join(home, "custom"));
		updateSettings({ plugins: { notebook: { pythons: [custom] } } });
		const first = file(join(home, "bin", win ? "python.exe" : "python3"));
		const second = file(join(home, "bin2", win ? "python.exe" : "python3"));
		process.env.PATH = dirname(first) + delimiter + dirname(second);
		const envs = await pythonEnvs(p, "demo.ipynb", options);
		assert.equal(envs.find((e) => e.python === versioned)?.group, "pyenv");
		assert.equal(envs.find((e) => e.python === versioned)?.label, "pyenv: 3.12.4");
		assert.equal(envs.find((e) => e.python === custom)?.group, "custom");
		assert.equal(envs.find((e) => e.python === first)?.group, "system");
		assert.equal(envs.find((e) => e.python === second)?.group, "system");
	`);
});

test("同一個 Python 實際路徑跨來源只列一次,專案環境最多三十個", (t) => {
	isolated(t, `${notebook}
		const prefix = join(root, ".venv");
		const executable = python(prefix);
		updateSettings({ plugins: { notebook: { pythons: [executable] } } });
		file(join(home, ".conda", "environments.txt"), prefix + "\\n");
		for (let i = 0; i < 40; i++) python(join(root, "p" + String(i).padStart(2, "0"), ".venv"));
		const envs = await pythonEnvs(p, "demo.ipynb", options);
		const ids = envs.filter((e) => e.kind === "python").map((e) => e.id);
		assert.equal(new Set(ids).size, ids.length);
		assert.equal(envs.filter((e) => e.id === "py:" + realpathSync(executable)).length, 1);
		assert.equal(envs.filter((e) => e.group === "project").length, 30);
	`);
});

test("壞掉的 kernel.json 與無效 argv 會略過", (t) => {
	isolated(t, `${notebook}
		for (const [name, spec] of Object.entries({ broken: "{", empty: { argv: [] }, nonString: { argv: [1] }, blank: { argv: [""] }, wrong: { argv: "python" }, nullSpec: "null" })) kernel(name, spec);
		const envs = await pythonEnvs(p, "demo.ipynb", options);
		assert.equal(envs.some((e) => ["broken", "empty", "nonString", "blank", "wrong", "nullSpec"].includes(e.name)), false);
	`);
});

test("核心程式絕對路徑不存在時不可用,裸名稱不會被誤判不存在", (t) => {
	isolated(t, `${notebook}
		python(join(root, ".venv"));
		kernel("missing", { argv: [join(home, "missing", "python")], display_name: "遺失", language: "python" });
		kernel("path-python", { argv: ["python3"], display_name: "PATH Python", language: "python" });
		const envs = await pythonEnvs(p, "demo.ipynb", options);
		assert.equal(envs.find((e) => e.name === "missing")?.ready, false);
		assert.equal(envs.find((e) => e.name === "missing")?.why, "核心指定的程式不存在");
		assert.equal(envs.find((e) => e.name === "path-python")?.ready, true);
	`);
});

test("非 Python 核心優先使用管家橋接環境,沒有 bridge 時說明安裝需求", (t) => {
	isolated(t, `${notebook}
		python(join(root, ".venv"));
		const own = python(join(home, "jupyter", ".venv"));
		kernel("ir", { argv: ["R", "--slave"], display_name: "R", language: "R" });
		let envs = await pythonEnvs(p, "demo.ipynb", options);
		assert.equal(envs.find((e) => e.name === "ir")?.bridge, own);
		assert.equal(envs.find((e) => e.name === "ir")?.ready, true);
		envs = await pythonEnvs(p, "demo.ipynb", { ...options, refresh: true, check: async () => ({ version: "3.12.4", ready: false }) });
		assert.equal(envs.find((e) => e.name === "ir")?.ready, false);
		assert.equal(envs.find((e) => e.name === "ir")?.why, "需要一個有 jupyter_client 的 Python 才能啟動這個核心");
	`);
});

test("JUPYTER_PATH 底下的 kernelspec 可被找到", (t) => {
	isolated(t, `${notebook}
		python(join(root, ".venv"));
		const specDir = kernel("julia", { argv: ["julia"], display_name: "Julia", language: "julia" }, join(process.env.JUPYTER_PATH, "kernels"));
		const envs = await pythonEnvs(p, "demo.ipynb", options);
		assert.equal(envs.find((e) => e.id === "ks:" + realpathSync(specDir))?.label, "Julia");
	`);
});

test("Python 檢查平行執行", (t) => {
	isolated(t, `${notebook}
		python(join(root, ".venv")); python(join(root, "sub", ".venv")); python(join(root, "other", ".venv"));
		let active = 0, peak = 0;
		await pythonEnvs(p, "demo.ipynb", { ...options, check: async () => { active++; peak = Math.max(peak, active); await new Promise((done) => setImmediate(done)); active--; return { ready: true, version: "3.12.4" }; } });
		assert.ok(peak >= 3, "候選 Python 應一起檢查");
	`);
});

test("檢查結果依實際路徑與 mtime 快取五分鐘,重新整理會清除", (t) => {
	isolated(t, `${notebook}
		const executable = python(join(root, ".venv"));
		let calls = 0;
		const checker = async (path) => { if (realpathSync(path) === realpathSync(executable)) calls++; return { ready: true, jupyterClient: true, version: "3.12.4" }; };
		const opts = { ...options, check: checker };
		await pythonEnvs(p, "demo.ipynb", opts); await pythonEnvs(p, "demo.ipynb", opts);
		assert.equal(calls, 1);
		const later = new Date(Date.now() + 10_000); utimesSync(executable, later, later);
		await pythonEnvs(p, "demo.ipynb", opts); assert.equal(calls, 2);
		await pythonEnvs(p, "demo.ipynb", { ...opts, refresh: true }); assert.equal(calls, 3);
		const now = Date.now(); Date.now = () => now + 5 * 60_000 + 1;
		await pythonEnvs(p, "demo.ipynb", opts); assert.equal(calls, 4);
	`);
});

test("環境 symlink 依實際路徑去重,一般目錄 symlink 不向下搜尋", (t) => {
	isolated(t, `${notebook}
		const prefix = join(root, ".venv"); const executable = python(prefix);
		mkdirSync(join(root, "sub")); symlinkSync(prefix, join(root, "sub", ".venv"), win ? "junction" : "dir");
		const outside = join(home, "outside"); const hidden = python(join(outside, ".venv"));
		symlinkSync(outside, join(root, "alias"), win ? "junction" : "dir");
		const envs = await pythonEnvs(p, "demo.ipynb", options);
		assert.equal(envs.filter((e) => e.id === "py:" + realpathSync(executable)).length, 1);
		assert.equal(envs.some((e) => e.id === "py:" + realpathSync(hidden)), false);
	`);
});

test("kernelspec 指定的 Python 只需 jupyter_client 就能當 bridge", (t) => {
	isolated(t, `${notebook}
		const executable = python(join(home, "client-only"));
		kernel("client-only", { argv: [executable], display_name: "Client only", language: "python" });
		const envs = await pythonEnvs(p, "demo.ipynb", { ...options, check: async () => ({ ready: false, jupyterClient: true, version: "3.12.4" }) });
		assert.equal(envs.find((e) => e.name === "client-only")?.bridge, executable);
		assert.equal(envs.find((e) => e.name === "client-only")?.ready, true);
	`);
});

test("注入平台時能讀 Linux 與 Windows 的核心及環境配置", (t) => {
	isolated(t, `${notebook}
		const projectPython = file(join(root, ".venv", "Scripts", "python.exe"));
		const condaPython = file(join(home, "miniconda3", "python.exe"));
		const pyenvPython = file(join(process.env.PYENV_ROOT, "versions", "3.13", "python.exe"));
		kernel("win-r", { argv: ["R"], display_name: "Windows R", language: "R" }, join(process.env.APPDATA, "jupyter", "kernels"));
		let envs = await pythonEnvs(p, "demo.ipynb", { ...options, platform: "win32" });
		assert.equal(envs.find((e) => e.id === "py:" + realpathSync(projectPython))?.group, "project");
		assert.equal(envs.find((e) => e.id === "py:" + realpathSync(condaPython))?.group, "conda");
		assert.equal(envs.find((e) => e.id === "py:" + realpathSync(pyenvPython))?.group, "pyenv");
		assert.equal(envs.find((e) => e.name === "win-r")?.label, "Windows R");
		python(join(root, ".venv"));
		kernel("linux-r", { argv: ["R"], display_name: "Linux R", language: "R" }, join(process.env.XDG_DATA_HOME, "jupyter", "kernels"));
		envs = await pythonEnvs(p, "demo.ipynb", { ...options, platform: "linux", refresh: true });
		assert.equal(envs.find((e) => e.name === "linux-r")?.label, "Linux R");
	`);
});

test("notebook.pythons 預設空陣列、絕對路徑去重,拒絕錯誤型別與超過二十項", (t) => {
	isolated(t, `
		assert.deepEqual(DEFAULTS.plugins.notebook.pythons, []);
		assert.deepEqual(settings().plugins.notebook.pythons, []);
		for (const value of ["/python", null, {}, [1], ["relative/python"], Array.from({ length: 21 }, (_, i) => join(home, "env" + i, "python"))]) {
			assert.throws(() => updateSettings({ plugins: { notebook: { pythons: value } } }));
		}
		const executable = python(join(home, "custom"));
		updateSettings({ plugins: { notebook: { pythons: [executable, executable] } } });
		assert.deepEqual(settings().plugins.notebook.pythons, [executable]);
	`);
});

test("nb/start 拒絕清單外 id,add/remove 沿用外掛與登入檢查", { timeout: 60_000 }, (t) => {
	isolated(t, `
		const netServer = createServer();
		await new Promise((done, fail) => { netServer.once("error", fail); netServer.listen(0, "127.0.0.1", done); });
		const port = netServer.address().port;
		assert.ok(![8791, 8792, 8793, 8797, 8807].includes(port));
		await new Promise((done) => netServer.close(done));
		process.env.STEWARD_PORT = String(port);
		const { Store } = await import(${JSON.stringify(url("store.ts"))});
		const { startServer } = await import(${JSON.stringify(url("server.ts"))});
		const store = new Store(join(home, "state.json"));
		const project = store.addProject({ name: "Notebook", root, kind: "project", status: "active", private: false });
		const close = startServer(store, {}, {});
		await new Promise((done) => setImmediate(done));
		const base = "http://127.0.0.1:" + port + "/api/code/" + project.id + "/nb/";
		const post = async (op, body) => {
			const response = await fetch(base + op, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
			return { status: response.status, data: await response.json() };
		};
		try {
			for (const body of [{ path: "demo.ipynb", id: "ks:/not-detected", python: process.execPath }, { path: "demo.ipynb", id: "py:/not-detected" }, { path: "demo.ipynb", python: process.execPath }]) {
				const result = await post("start", body);
				assert.equal(result.status, 400, JSON.stringify(result));
			}
			assert.equal((await post("install", { path: "demo.ipynb", id: "ks:/not-detected" })).status, 400);
			assert.equal((await post("add-python", { path: process.execPath })).status, 400);
			assert.equal((await post("add-python", { path: "relative/python" })).status, 400);
			assert.equal((await post("add-python", { path: join(home, "missing", "python") })).status, 400);
			updateSettings({ plugins: { notebook: { enabled: false } } });
			assert.equal((await post("add-python", { path: process.execPath })).status, 403);
			assert.equal((await post("remove-python", { path: process.execPath })).status, 403);
			updateSettings({ plugins: { notebook: { enabled: true } }, access: { passwordHash: "fixture-requires-login" } });
			assert.equal((await post("add-python", { path: process.execPath })).status, 401);
			assert.equal((await post("remove-python", { path: process.execPath })).status, 401);
		} finally { await close(); }
		process.exit(0);
	`);
});

test("網頁依核心 id、記憶、metadata 與 ready 順序選擇,只有手動選 kernelspec 才修改 metadata", (t) => {
	isolated(t, `
		const source = readFileSync(${JSON.stringify(join(ROOT, "web", "code.js"))}, "utf8");
		const from = source.indexOf("\\tfunction nbSetKernel(");
		const to = source.indexOf("\\tconst KSTATE", from);
		assert.ok(from > 0 && to > from);
		const pyEnv = { id: "py:/python", python: "/python", kind: "python", group: "project", ready: true };
		const ksEnv = { id: "ks:/spec", python: "R", kind: "kernelspec", group: "kernel", name: "ir", displayName: "R Kernel", language: "R", ready: true };
		const savedEnv = { id: "py:/saved", python: "/saved", kind: "python", group: "custom", ready: false };
		let reply = { envs: [pyEnv, ksEnv, savedEnv], kernel: { running: false } };
		const memory = new Map(); let dirty = 0, stopped = 0;
		const context = vm.createContext({
			cm: { pid: "pid" }, api: async () => reply,
			localStorage: { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) },
			nbToolbar: () => {}, nbMarkDirty: () => dirty++, nbColor: () => {}, nbText: (value) => value,
			nbApi: async () => { stopped++; return {}; }, nbFinishRun: () => {}, toast: () => {},
		});
		vm.runInContext(source.slice(from, to) + "\\nglobalThis.load = nbLoadPythons; globalThis.select = nbSelectKernel;", context);
		const tab = () => ({ path: "demo.ipynb", kernelId: undefined, kstate: "off", runs: new Map(), nb: { cells: [], metadata: { kernelspec: { name: "ir" }, language_info: { name: "python", version: "keep" } } } });
		let t = tab(); await context.load(t); assert.equal(t.kernelId, ksEnv.id); assert.equal(dirty, 0);
		memory.set("steward.nbPy:pid:demo.ipynb", savedEnv.python);
		t = tab(); await context.load(t); assert.equal(t.kernelId, savedEnv.id);
		memory.set("steward.nbKernel:pid:demo.ipynb", pyEnv.id);
		t = tab(); await context.load(t); assert.equal(t.kernelId, pyEnv.id);
		reply.kernel = { running: true, id: ksEnv.id, state: "idle" };
		t = tab(); await context.load(t); assert.equal(t.kernelId, ksEnv.id); assert.equal(t.kstate, "idle");
		reply.kernel = { running: false }; memory.clear();
		t = tab(); t.nb.metadata.kernelspec.name = "unknown"; await context.load(t); assert.equal(t.kernelId, pyEnv.id);
		await context.select(t, ksEnv); assert.equal(dirty, 1); assert.equal(t.nb.metadata.kernelspec.display_name, "R Kernel"); assert.equal(t.nb.metadata.language_info.name, "R"); assert.equal(t.nb.metadata.language_info.version, "keep");
		await context.select(t, ksEnv); assert.equal(dirty, 1);
		await context.select(t, pyEnv); assert.equal(dirty, 1); assert.equal(t.nb.metadata.kernelspec.name, "ir");
		t.readonly = true; t.nb.metadata.kernelspec.name = "unchanged"; await context.select(t, ksEnv); assert.equal(dirty, 1); assert.equal(t.nb.metadata.kernelspec.name, "unchanged");
		t.readonly = false; t.kstate = "idle"; await context.select(t, pyEnv); assert.equal(stopped, 1); assert.equal(t.kstate, "off");
	`);
});
