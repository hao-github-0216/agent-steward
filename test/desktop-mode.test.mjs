import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WIN = process.platform === "win32";
const HOME = mkdtempSync(join(tmpdir(), "steward-desktop-mode-"));
Object.assign(process.env, { HOME, USERPROFILE: HOME, XDG_CONFIG_HOME: HOME, APPDATA: HOME, STEWARD_DATA_DIR: HOME, STEWARD_APP_DIR: ROOT });
delete process.env.STEWARD_DESKTOP;
writeFileSync(join(HOME, "settings.json"), JSON.stringify({ version: 1, access: { tailscale: { enabled: false } }, plugins: {}, setupDone: true, aiDetected: true }));
after(() => rmSync(HOME, { recursive: true, force: true }));
const { DEFAULTS, settings } = await import("../src/settings.ts");
const { applyUpdate, checkUpdate, REPO } = await import("../src/update.ts");

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function within(promise, ms) {
	let timer;
	try { return await Promise.race([promise, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`Timed out after ${ms} ms`)), ms); })]); }
	finally { clearTimeout(timer); }
}
async function waitFor(check, ms = 15_000) {
	const until = Date.now() + ms;
	let lastError;
	while (Date.now() < until) {
		try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
		await delay(40);
	}
	throw new Error("Timed out waiting for condition", { cause: lastError });
}
async function unusedPort() {
	const server = createServer();
	await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
	const port = server.address().port;
	await new Promise((done) => server.close(done));
	assert.ok(![8791, 8792, 8793].includes(port));
	return port;
}
function fixture(desktop, { password = false } = {}) {
	const home = mkdtempSync(join(HOME, "child-"));
	const data = join(home, "data");
	mkdirSync(data);
	const config = structuredClone(DEFAULTS);
	config.aiDetected = true;
	config.setupDone = true;
	if (password) config.access.passwordHash = "test-password-is-set";
	writeFileSync(join(data, "settings.json"), JSON.stringify(config));
	const herdr = join(home, WIN ? "herdr.cmd" : "herdr");
	writeFileSync(herdr, WIN ? "@echo off\r\necho {}\r\n" : "#!/bin/sh\nprintf '{}\\n'\n", { mode: 0o755 });
	const env = {
		...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, APPDATA: home,
		STEWARD_DATA_DIR: data, STEWARD_APP_DIR: ROOT, STEWARD_NODE: process.execPath,
		STEWARD_HOSTS: "127.0.0.1", STEWARD_PUBLIC_URL: "", HERDR_BIN_PATH: herdr, HERDR_SOCKET_PATH: join(home, "no-herdr.sock"),
	};
	if (desktop) env.STEWARD_DESKTOP = "1"; else delete env.STEWARD_DESKTOP;
	if (WIN) {
		const preload = join(home, "isolate-powershell.mjs");
		writeFileSync(preload, `
			import cp from "node:child_process";
			import { syncBuiltinESMExports } from "node:module";
			const original = cp.execFileSync;
			cp.execFileSync = (command, ...args) => command === "powershell.exe" ? Buffer.alloc(0) : original(command, ...args);
			syncBuiltinESMExports();
		`);
		env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`;
	}
	return { home, data, env };
}
function launch(t, script, env) {
	const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ROOT, "src", script)], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { output += chunk; });
	const exited = new Promise((done, fail) => { child.once("error", fail); child.once("close", (code, signal) => done({ code, signal })); });
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await within(exited, 2000);
	});
	return { child, exited, output: () => output };
}
async function main(t, desktop, options) {
	const f = fixture(desktop, options);
	f.env.STEWARD_PORT = String(await unusedPort());
	f.env.STEWARD_TERMINAL_PORT = String(await unusedPort());
	const proc = launch(t, "main.ts", f.env);
	const base = `http://127.0.0.1:${f.env.STEWARD_PORT}`;
	const health = await waitFor(async () => {
		if (proc.child.exitCode !== null) throw new Error(proc.output());
		const response = await fetch(base + "/api/health", { signal: AbortSignal.timeout(500), headers: { connection: "close" } });
		return response.ok ? response.json() : undefined;
	}).catch((error) => { throw new Error(proc.output(), { cause: error }); });
	return { ...f, ...proc, base, health };
}
async function put(base, patch) {
	const response = await fetch(base + "/api/settings", { method: "PUT", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify({ settings: patch }) });
	const data = await response.json();
	assert.equal(response.status, 200, JSON.stringify(data));
	return data;
}

test("desktop main reports its mode, applies settings signals/setup, and exits within 5 seconds of stdin EOF", { timeout: 30_000 }, async (t) => {
	const f = await main(t, true);
	assert.equal(f.health.ok, true);
	assert.equal(f.health.mode, "desktop");
	const response = await fetch(f.base + "/api/settings", { headers: { connection: "close" } });
	const body = await response.json();
	assert.equal(body.desktop, true);
	assert.equal(typeof body.platform, "string");
	assert.ok(body.detected);
	assert.deepEqual(body.settings.desktop, { herdrCli: true, herdrConfig: true, autostart: true });
	await put(f.base, { ui: { lang: "en" }, desktop: { autostart: false, herdrCli: false, herdrConfig: false } });
	const log = join(f.data, "logs", "desktop-setup.log");
	await waitFor(() => existsSync(log) && readFileSync(log, "utf8").includes('"cmd":"setup","ok":true'));
	await put(f.base, { ui: { lang: "en" }, desktop: { autostart: false, herdrCli: false, herdrConfig: false } });
	const signals = f.output().split(/\r?\n/).filter((line) => line.startsWith("@@desktop ")).map((line) => JSON.parse(line.slice(10)));
	assert.deepEqual(signals, [{ cmd: "autostart", on: false }, { cmd: "lang", lang: "en" }]);
	assert.equal(readFileSync(log, "utf8").split('"cmd":"setup"').length - 1, 1, "unchanged settings do not rerun setup");
	assert.equal(existsSync(join(f.home, ".local", "bin", WIN ? "steward.cmd" : "steward")), true);
	assert.equal(existsSync(join(f.home, "herdr", "config.toml")), false);
	const start = Date.now();
	f.child.stdin.end();
	assert.deepEqual(await within(f.exited, 5000), { code: 0, signal: null });
	assert.ok(Date.now() - start < 5000);
	await assert.rejects(fetch(f.base + "/api/health", { signal: AbortSignal.timeout(500) }));
});

test("service main reports service mode, emits no desktop signals, and ignores stdin EOF", { timeout: 30_000 }, async (t) => {
	const f = await main(t, false);
	assert.equal(f.health.mode, "service");
	const response = await fetch(f.base + "/api/settings", { headers: { connection: "close" } });
	assert.equal((await response.json()).desktop, false);
	await put(f.base, { ui: { lang: "en" }, desktop: { autostart: false, herdrCli: false, herdrConfig: false } });
	f.child.stdin.end();
	await delay(200);
	assert.equal(f.child.exitCode, null);
	assert.equal(f.child.signalCode, null);
	assert.doesNotMatch(f.output(), /@@desktop /);
	assert.equal(existsSync(join(f.data, "logs", "desktop-setup.log")), false);
	f.child.kill("SIGTERM");
	assert.deepEqual(await within(f.exited, 5000), { code: 0, signal: null });
});

test("health exposes only ok and mode when not authenticated", { timeout: 30_000 }, async (t) => {
	const f = await main(t, true, { password: true });
	assert.deepEqual(f.health, { ok: true, mode: "desktop" });
	const response = await fetch(f.base + "/api/settings", { headers: { connection: "close" } });
	assert.equal(response.status, 401);
	f.child.stdin.end();
	assert.equal((await within(f.exited, 5000)).code, 0);
});

for (const stubborn of [false, true]) test(`desktop terminal records ttyd and reaps it on stdin EOF${stubborn ? " with SIGKILL escalation" : ""}`, { skip: WIN, timeout: 15_000 }, async (t) => {
	const f = fixture(true);
	const ttyd = join(f.home, "fake-ttyd");
	const ready = join(f.home, "ttyd-ready");
	writeFileSync(ttyd, `#!/bin/sh\n${stubborn ? "trap '' TERM\n" : ""}touch "${ready}"\nexec sleep 60\n`, { mode: 0o755 });
	f.env.STEWARD_TTYD_BIN = ttyd;
	f.env.STEWARD_TERMINAL_PORT = String(await unusedPort());
	const proc = launch(t, "terminal-runner.ts", f.env);
	const pidFile = join(f.data, "run", "ttyd.pid");
	let pid;
	t.after(() => { if (pid) { try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } } });
	const record = await waitFor(() => existsSync(pidFile) && JSON.parse(readFileSync(pidFile, "utf8")));
	pid = record.pid;
	assert.equal(record.exe, ttyd);
	assert.equal(Number.isInteger(pid), true);
	process.kill(pid, 0);
	await waitFor(() => existsSync(ready));
	const start = Date.now();
	proc.child.stdin.end();
	assert.deepEqual(await within(proc.exited, 5000), { code: 0, signal: null });
	assert.ok(Date.now() - start < 5000);
	assert.equal(existsSync(pidFile), false);
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	pid = undefined;
});

for (const signal of ["SIGTERM", "SIGINT"]) test(`service terminal preserves ${signal} forwarding and ignores stdin EOF`, { skip: WIN, timeout: 15_000 }, async (t) => {
	const f = fixture(false);
	const ttyd = join(f.home, "fake-ttyd");
	writeFileSync(ttyd, "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
	f.env.STEWARD_TTYD_BIN = ttyd;
	f.env.STEWARD_TERMINAL_PORT = String(await unusedPort());
	const proc = launch(t, "terminal-runner.ts", f.env);
	const pidFile = join(f.data, "run", "ttyd.pid");
	let pid;
	t.after(() => { if (pid) { try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } } });
	pid = (await waitFor(() => existsSync(pidFile) && JSON.parse(readFileSync(pidFile, "utf8")))).pid;
	proc.child.stdin.end();
	await delay(200);
	assert.equal(proc.child.exitCode, null);
	proc.child.kill(signal);
	assert.deepEqual(await within(proc.exited, 5000), { code: 1, signal: null });
	assert.equal(existsSync(pidFile), false);
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	pid = undefined;
});

test("desktop update checks return mode/download URL offline and never apply an installer", async (t) => {
	process.env.STEWARD_DESKTOP = "1";
	t.after(() => { delete process.env.STEWARD_DESKTOP; });
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(JSON.stringify({ tag_name: "v9.9.9", html_url: "https://example.invalid/release", body: "test" })); });
	await assert.rejects(applyUpdate("v9.9.9"), { message: "App 版請到 GitHub 下載新版 App" });
	assert.equal(calls, 0);
	assert.equal(existsSync(join(HOME, "update")), false);
	const info = await checkUpdate(true);
	assert.equal(info.desktop, true);
	assert.equal(info.downloadUrl, `https://github.com/${REPO}/releases/latest`);
	t.mock.method(globalThis, "fetch", async () => new Response("Not Found", { status: 404 }));
	assert.equal((await checkUpdate(true)).desktop, true);
	t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
	assert.equal((await checkUpdate(true)).downloadUrl, info.downloadUrl);
	delete process.env.STEWARD_DESKTOP;
	assert.equal((await checkUpdate(true)).desktop, false);
});

test("desktopSignal emits newline-terminated single-line JSON only in desktop mode", () => {
	const module = new URL("../src/settings.ts", import.meta.url).href;
	const source = `const { desktopSignal } = await import(${JSON.stringify(module)}); desktopSignal({ cmd: "autostart", on: true }); desktopSignal({ cmd: "lang", lang: "en" });`;
	for (const mode of [undefined, "0", "1"]) {
		const env = { ...process.env };
		if (mode === undefined) delete env.STEWARD_DESKTOP; else env.STEWARD_DESKTOP = mode;
		const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "--eval", source], { env, encoding: "utf8", timeout: 5000 });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, mode === "1" ? '@@desktop {"cmd":"autostart","on":true}\n@@desktop {"cmd":"lang","lang":"en"}\n' : "");
	}
	assert.deepEqual(settings().desktop, { herdrCli: true, herdrConfig: true, autostart: true });
});

function uiFixture(desktop) {
	const html = readFileSync(join(ROOT, "web", "index.html"), "utf8");
	const nodes = new Map();
	const modal = {
		markup: "", fields: [],
		set innerHTML(value) {
			this.markup = value;
			nodes.clear();
			this.fields = [...value.matchAll(/<input\b[^>]*data-k="([^"]+)"[^>]*>/g)].map(([tag, key]) => ({ type: "checkbox", checked: /\schecked(?:\s|>)/.test(tag), dataset: { k: key }, hasAttribute: () => false }));
		},
		get innerHTML() { return this.markup; },
		querySelectorAll(selector) { return selector === "[data-k]" ? this.fields : []; },
	};
	const element = (id) => {
		if (id === "setModal") return modal;
		if (!modal.innerHTML.includes(`id="${id}"`)) return null;
		if (!nodes.has(id)) nodes.set(id, { addEventListener() {} });
		return nodes.get(id);
	};
	const context = vm.createContext({
		$: element, fixtureSettings: structuredClone(DEFAULTS), window: {}, pref: () => "", clearInterval,
		aiPane: () => "", agentsPane: () => "", routingPane: () => "", saveSettings: async () => true,
		setModels: {},
	});
	const run = (source) => vm.runInContext(source, context);
	const settingsSource = html.slice(html.indexOf("let setState = null;"), html.indexOf("// ---- 訂閱登入 ----"));
	const render = html.slice(html.indexOf("function renderSettings()"), html.indexOf("/** 把畫面上的值收回"));
	const collect = html.slice(html.indexOf("function collectSettings()"), html.indexOf("async function saveSettings("));
	run(html.match(/^const esc = .*;$/m)[0] + "\n" + settingsSource + "\n" + render + "\n" + collect);
	run(`setState = { s: fixtureSettings, detected: {}, platform: "darwin", desktop: ${desktop}, tab: "general" }; setAgents = []; setPlugins = []; setUpdate = { current: "v1.0.0", latest: "v1.1.0", hasUpdate: true, desktop: ${desktop}, downloadUrl: "https://github.com/example/repo/releases/latest", components: [] };`);
	return { run, modal, element };
}

test("desktop UI adds App controls and a wizard-only step; service UI stays unchanged", async () => {
	for (const desktop of [false, true]) {
		const f = uiFixture(desktop);
		f.run("renderSettings()");
		assert.equal(f.modal.innerHTML.includes("<h4>App</h4>"), desktop);
		assert.equal(f.modal.fields.filter((field) => field.dataset.k.startsWith("desktop.")).length, desktop ? 3 : 0);
		f.run("setState.wizard = 0; renderSettings()");
		assert.ok(f.modal.innerHTML.includes(`1/${desktop ? 6 : 5} 歡迎`));
		assert.equal(f.modal.innerHTML.includes('data-k="desktop.'), false);
		await f.element("setSave").onclick();
		assert.equal(f.run("setState.tab"), desktop ? "desktop" : "ai");
		if (desktop) {
			assert.match(f.modal.innerHTML, /2\/6 元件與背景執行/);
			assert.equal(f.modal.fields.length, 3);
			assert.ok(f.modal.fields.every((field) => field.checked));
			f.modal.fields[0].checked = false;
			f.run("collectSettings()");
			assert.equal(f.run("setState.s.desktop.herdrCli"), false);
			assert.match(f.modal.innerHTML, /你自己裝的 herdr 不會被覆蓋/);
		}
	}
});

test("desktop About links to the App download and hides installer update/removal controls", () => {
	for (const desktop of [false, true]) {
		const f = uiFixture(desktop);
		const markup = f.run("aboutPane()");
		assert.equal(markup.includes('id="updApply"'), !desktop);
		assert.equal(markup.includes("到 GitHub 下載新版 App"), desktop);
		assert.equal(markup.includes("sh ~/.agent-steward/app/uninstall.sh"), !desktop);
		if (desktop) {
			assert.match(markup, /href="https:\/\/github.com\/example\/repo\/releases\/latest" target="_blank" rel="noopener"/);
			assert.match(markup, /在 Mac 把 App 拖到垃圾桶；Windows 到『設定 → 應用程式』移除/);
		}
	}
});
