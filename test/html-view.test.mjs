import "./helpers/git-isolation.mjs";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), "steward-html-view-"));
Object.assign(process.env, { HOME, USERPROFILE: HOME, STEWARD_DATA_DIR: HOME, XDG_CONFIG_HOME: HOME, APPDATA: HOME });
after(() => rmSync(HOME, { recursive: true, force: true }));
const { DEFAULTS } = await import("../src/settings.ts");
const { Store } = await import("../src/store.ts");
const { VIEW_LIMIT } = await import("../src/code.ts");

async function freePort() {
	const server = createServer();
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));
	assert.ok(![8791, 8792, 8793].includes(port));
	return port;
}

async function within(promise, ms) {
	let timer;
	try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Child did not exit in time")), ms); })]); }
	finally { clearTimeout(timer); }
}

async function launch(t) {
	const data = join(HOME, "data"), root = join(HOME, "project");
	mkdirSync(data);
	mkdirSync(join(root, "site", "img"), { recursive: true });
	const html = '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>HTML preview</h1><img src="img/a.png"><script src="app.js"></script></body></html>';
	const css = "body { color: navy; }";
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
	writeFileSync(join(root, "site", "index.html"), html);
	writeFileSync(join(root, "site", "style.css"), css);
	writeFileSync(join(root, "site", "app.js"), "alert('disabled')");
	writeFileSync(join(root, "site", "app.mjs"), "alert('disabled')");
	writeFileSync(join(root, "site", "img", "a.png"), png);
	writeFileSync(join(root, "site", "中.html"), "<h1>中文</h1>");
	writeFileSync(join(HOME, "outside.html"), "<h1>Outside project</h1>");
	const config = structuredClone(DEFAULTS);
	config.aiDetected = true;
	config.setupDone = true;
	config.server.tailnetBindReviewed = true;
	const password = "html-view-test", salt = randomBytes(16);
	config.access.passwordHash = ["scrypt", salt.toString("hex"), scryptSync(password, salt, 32).toString("hex")].join("$");
	writeFileSync(join(data, "settings.json"), JSON.stringify(config));
	const store = new Store(join(data, "state.json"));
	const project = store.addProject({ root, name: "HTML preview", kind: "project", status: "active", private: false });
	const herdr = join(HOME, process.platform === "win32" ? "herdr.cmd" : "herdr");
	writeFileSync(herdr, process.platform === "win32" ? "@echo off\r\necho {}\r\n" : "#!/bin/sh\nprintf '{}\\n'\n", { mode: 0o755 });
	const port = await freePort();
	const env = { ...process.env, STEWARD_DATA_DIR: data, STEWARD_HOSTS: "127.0.0.1", STEWARD_PORT: String(port),
		STEWARD_TERMINAL_PORT: String(await freePort()), STEWARD_DESKTOP: "1", STEWARD_APP_DIR: ROOT,
		HERDR_BIN_PATH: herdr, HERDR_SOCKET_PATH: join(HOME, "no-herdr.sock") };
	delete env.STEWARD_DESKTOP_TOKEN;
	for (const key of Object.keys(env)) if (key.startsWith("HERDR_") && !["HERDR_BIN_PATH", "HERDR_SOCKET_PATH"].includes(key)) delete env[key];
	const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ROOT, "src/main.ts")], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (data) => { output += data; });
	child.stderr.on("data", (data) => { output += data; });
	const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.stdin.end();
			try { await within(exited, 4500); } catch { child.kill("SIGKILL"); }
		}
		await within(exited, 2000);
	});
	const base = `http://127.0.0.1:${port}`, headers = { connection: "close" };
	let ready = false;
	for (const until = Date.now() + 15000; Date.now() < until;) {
		if (child.exitCode !== null || child.signalCode !== null) throw new Error(output);
		try { if ((await fetch(base + "/api/health", { headers, signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
		await new Promise((resolve) => setTimeout(resolve, 40));
	}
	assert.ok(ready, output);
	const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ password }) });
	assert.equal(login.status, 200);
	headers.cookie = login.headers.get("set-cookie").split(";")[0];
	await login.arrayBuffer();
	return { base, headers, root, html, css, png, path: `/api/code/${project.id}/view/` };
}

test("HTML 靜態預覽路由", { timeout: 30000 }, async (t) => {
	const f = await launch(t);
	const get = (rel, headers = f.headers) => fetch(f.base + f.path + rel, { headers });
	await t.test("HTML 保留內容並設定停用 JavaScript 的標頭", async () => {
		const r = await get("site/index.html");
		assert.equal(r.status, 200);
		assert.equal(r.headers.get("content-type"), "text/html; charset=utf-8");
		assert.equal(r.headers.get("cache-control"), "no-store");
		assert.equal(r.headers.get("x-content-type-options"), "nosniff");
		const csp = r.headers.get("content-security-policy");
		assert.match(csp, /sandbox allow-same-origin/);
		assert.match(csp, /script-src 'none'/);
		for (const rule of ["object-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "connect-src 'none'", "style-src 'self' 'unsafe-inline' https:", "img-src 'self' data: https:", "font-src 'self' data: https:", "media-src 'self' https:"]) assert.ok(csp.includes(rule), rule);
		assert.equal(await r.text(), f.html);
	});
	await t.test("相對路徑的 CSS 和圖片可以載入", async () => {
		const css = await get("site/style.css");
		assert.equal(css.status, 200);
		assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
		assert.equal(await css.text(), f.css);
		const png = await get("site/img/a.png");
		assert.equal(png.status, 200);
		assert.equal(png.headers.get("content-type"), "image/png");
		assert.deepEqual(Buffer.from(await png.arrayBuffer()), f.png);
	});
	await t.test("HTM 與字型可以載入，副檔名不分大小寫", async () => {
		for (const [name, type] of [["other.HTM", "text/html; charset=utf-8"], ["a.woff", "font/woff"], ["a.woff2", "font/woff2"], ["a.ttf", "font/ttf"], ["a.otf", "font/otf"]]) {
			writeFileSync(join(f.root, "site", name), "fixture");
			const r = await get(`site/${name}`);
			assert.equal(r.status, 200);
			assert.equal(r.headers.get("content-type"), type);
			assert.equal(await r.text(), "fixture");
		}
	});
	await t.test("JavaScript 與不支援的副檔名回 JSON 404", async () => {
		for (const rel of ["site/app.js", "site/app.mjs", "site/file.txt"]) {
			const r = await get(rel);
			assert.equal(r.status, 404);
			assert.ok((await r.json()).error);
		}
	});
	await t.test("未登入不能讀取預覽", async () => {
		const r = await get("site/index.html", { connection: "close" });
		assert.equal(r.status, 401);
		assert.ok((await r.json()).error);
	});
	await t.test("拒絕一般與編碼後的專案外路徑", async () => {
		for (const rel of ["../outside.html", "%2e%2e/outside.html", "%2e%2e%2foutside.html", "..%2foutside.html"]) {
			const r = await new Promise((resolve, reject) => {
				const req = request(f.base, { path: f.path + rel, headers: f.headers }, (res) => {
					res.resume();
					res.on("end", () => resolve(res));
				});
				req.on("error", reject);
				req.end();
			});
			assert.ok(r.statusCode >= 400 && r.statusCode < 500, `${rel}: ${r.statusCode}`);
		}
	});
	await t.test("中文檔名只解碼一次，錯誤編碼回 400", async () => {
		const r = await get("site/%E4%B8%AD.html");
		assert.equal(r.status, 200);
		assert.equal(await r.text(), "<h1>中文</h1>");
		const bad = await get("site/%ZZ.html");
		assert.equal(bad.status, 400);
		assert.ok((await bad.json()).error);
	});
	await t.test("超過 VIEW_LIMIT 的檔案回 413", async () => {
		const file = join(f.root, "site", "large.html");
		writeFileSync(file, "");
		truncateSync(file, VIEW_LIMIT + 1);
		const r = await get("site/large.html");
		assert.equal(r.status, 413);
		assert.ok((await r.json()).error);
	});
});
