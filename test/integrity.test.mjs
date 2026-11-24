import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { writeIntegrityManifest } from "../desktop/scripts/integrity-manifest.mjs";

const home = await mkdtemp(join(tmpdir(), "steward-integrity-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.STEWARD_DATA_DIR = home;
process.env.STEWARD_APP_DIR = join(home, "app");
after(() => rm(home, { recursive: true, force: true }));
const { checkIntegrity, integrityStatus } = await import("../src/integrity.ts");
const { checkUpdate } = await import("../src/update.ts");

async function fixture(t) {
	const app = await mkdtemp(join(tmpdir(), "steward-integrity-"));
	t.after(() => rm(app, { recursive: true, force: true }));
	for (const dir of ["nested/deeper", "__pycache__/nested", "nested/__pycache__"]) await mkdir(join(app, dir), { recursive: true });
	for (const [path, text] of Object.entries({ "z.txt": "last", "nested/deeper/a.txt": "nested", "a.txt": "first", REVISION: "v1.2.3\n", "__pycache__/nested/cache.pyc": "cache", "nested/__pycache__/cache.pyc": "cache", ".DS_Store": "metadata", "nested/.DS_Store": "metadata" })) await writeFile(join(app, path), text);
	return app;
}
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

test("integrityStatus starts pending; checkIntegrity defaults to APP_DIR and caches unavailable", async () => {
	assert.deepEqual(integrityStatus(), { status: "pending" });
	assert.deepEqual(await checkIntegrity(), { status: "unavailable", changed: [], missing: [], added: [], counts: { changed: 0, missing: 0, added: 0 } });
	assert.equal(integrityStatus().status, "unavailable");
});

test("writeIntegrityManifest sorts slash paths, hashes REVISION, excludes metadata, and agrees with checkIntegrity", async (t) => {
	const app = await fixture(t);
	await writeIntegrityManifest(app);
	const manifest = JSON.parse(await readFile(join(app, "INTEGRITY.json"), "utf8"));
	assert.deepEqual(manifest, { version: 1, files: { REVISION: sha256("v1.2.3\n"), "a.txt": sha256("first"), "nested/deeper/a.txt": sha256("nested"), "z.txt": sha256("last") } });
	assert.deepEqual(Object.keys(manifest.files), ["REVISION", "a.txt", "nested/deeper/a.txt", "z.txt"]);
	const result = await checkIntegrity(app);
	assert.deepEqual(result, { status: "ok", changed: [], missing: [], added: [], counts: { changed: 0, missing: 0, added: 0 } });
	assert.equal(integrityStatus(), result);
	const first = await readFile(join(app, "INTEGRITY.json"), "utf8");
	await writeIntegrityManifest(app);
	assert.equal(await readFile(join(app, "INTEGRITY.json"), "utf8"), first);
});

for (const kind of ["changed", "missing", "added"]) test(`checkIntegrity reports ${kind} and updates the cache`, async (t) => {
	const app = await fixture(t);
	await writeIntegrityManifest(app);
	const path = kind === "added" ? "nested/new.txt" : "nested/deeper/a.txt";
	if (kind === "missing") await rm(join(app, path));
	else await writeFile(join(app, path), "different");
	const result = await checkIntegrity(app);
	assert.equal(result.status, "modified");
	assert.deepEqual(result[kind], [path]);
	assert.deepEqual(result.counts, { changed: Number(kind === "changed"), missing: Number(kind === "missing"), added: Number(kind === "added") });
	assert.equal(integrityStatus(), result);
});

test("excluded file changes and newly added metadata remain ok in both implementations", async (t) => {
	const app = await fixture(t);
	await writeIntegrityManifest(app);
	const before = await readFile(join(app, "INTEGRITY.json"), "utf8");
	await mkdir(join(app, "nested/deeper/__pycache__/more"), { recursive: true });
	for (const path of [".DS_Store", "nested/.DS_Store", "nested/deeper/.DS_Store", "__pycache__/new.pyc", "nested/__pycache__/cache.pyc", "nested/deeper/__pycache__/more/new.pyc"]) await writeFile(join(app, path), "new metadata");
	assert.equal((await checkIntegrity(app)).status, "ok");
	await writeIntegrityManifest(app);
	assert.equal(await readFile(join(app, "INTEGRITY.json"), "utf8"), before);
});

test("symlinks to files and directories are not followed by either implementation", async (t) => {
	const app = await fixture(t);
	try {
		await symlink(join(app, "a.txt"), join(app, "linked-file"), "file");
		await symlink(join(app, "nested"), join(app, "linked-dir"), process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("Creating symlinks is not permitted");
		throw error;
	}
	await writeIntegrityManifest(app);
	const manifest = JSON.parse(await readFile(join(app, "INTEGRITY.json"), "utf8"));
	assert.ok(Object.keys(manifest.files).every((path) => !path.startsWith("linked-")));
	assert.equal((await checkIntegrity(app)).status, "ok");
	await rm(join(app, "z.txt"));
	await symlink(join(app, "a.txt"), join(app, "z.txt"), "file");
	const result = await checkIntegrity(app);
	assert.deepEqual(result.missing, ["z.txt"]);
	assert.equal(result.counts.changed, 0);
});

test("checkIntegrity caps each sorted path list at 20 but keeps full counts", async (t) => {
	const app = await fixture(t);
	for (let i = 0; i < 25; i++) for (const kind of ["changed", "missing"]) await writeFile(join(app, `${kind}-${String(i).padStart(2, "0")}`), "old");
	await writeIntegrityManifest(app);
	for (let i = 0; i < 25; i++) {
		await writeFile(join(app, `changed-${String(i).padStart(2, "0")}`), "new");
		await rm(join(app, `missing-${String(i).padStart(2, "0")}`));
		await writeFile(join(app, `added-${String(i).padStart(2, "0")}`), "new");
	}
	const result = await checkIntegrity(app);
	assert.equal(result.status, "modified");
	assert.deepEqual(result.counts, { changed: 25, missing: 25, added: 25 });
	for (const kind of ["changed", "missing", "added"]) assert.deepEqual(result[kind], Array.from({ length: 20 }, (_, i) => `${kind}-${String(i).padStart(2, "0")}`));
});

test("missing manifest is unavailable; malformed or unsupported manifests cache error without throwing", async (t) => {
	const app = await fixture(t);
	assert.equal((await checkIntegrity(app)).status, "unavailable");
	for (const text of ["not json", '{"version":2,"files":{}}', '{"version":1,"files":[]}', JSON.stringify({ version: 1, files: { "../outside": sha256("bad") } })]) {
		await writeFile(join(app, "INTEGRITY.json"), text);
		const result = await checkIntegrity(app);
		assert.equal(result.status, "error");
		assert.ok(result.error);
		assert.equal(integrityStatus(), result);
	}
	await rm(join(app, "INTEGRITY.json"));
	await mkdir(join(app, "INTEGRITY.json"));
	assert.equal((await checkIntegrity(app)).status, "error");
	assert.equal(integrityStatus().status, "error");
	await rm(join(app, "INTEGRITY.json"), { recursive: true });
	await writeIntegrityManifest(app);
	assert.equal((await checkIntegrity(app)).status, "ok");
});

test("stage writes the integrity manifest immediately after REVISION", async () => {
	const source = await readFile(new URL("../desktop/scripts/stage.mjs", import.meta.url), "utf8");
	assert.match(source, /await writeFile\(join\(app, "REVISION"\), `\$\{revision\}\\n`\);\s*await writeIntegrityManifest\(app\);/);
});

test("checkUpdate includes the latest integrity cache and current release URL on every return path", async (t) => {
	const app = process.env.STEWARD_APP_DIR;
	await mkdir(app, { recursive: true });
	await writeFile(join(app, "REVISION"), "v1.2.3\n");
	await writeIntegrityManifest(app);
	await writeFile(join(app, "REVISION"), "v1.2.4\n");
	const integrity = await checkIntegrity(app);
	const originalFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = originalFetch; });
	for (const response of [() => new Response("", { status: 404 }), () => { throw new Error("offline"); }, () => new Response(JSON.stringify({ tag_name: "v9.0.0", html_url: "https://example.invalid/release" }))]) {
		globalThis.fetch = async () => response();
		const info = await checkUpdate(true);
		assert.equal(info.integrity, integrity);
		assert.equal(info.releaseUrl, info.downloadUrl.replace(/\/latest$/, "/tag/v1.2.4"));
	}
	globalThis.fetch = async () => { throw new Error("cache should avoid fetch"); };
	assert.equal((await checkUpdate()).integrity, integrity);
	await writeFile(join(app, "REVISION"), "dev\n");
	const dev = await checkUpdate();
	assert.equal(dev.releaseUrl, dev.downloadUrl);
});

test("aboutPane renders only modified integrity as a hint with a manual installer button", async () => {
	const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
	const source = html.slice(html.indexOf("function aboutPane() {"), html.indexOf("// ---- 訂閱登入 ----"));
	const en = JSON.parse(await readFile(new URL("../web/i18n/en.json", import.meta.url), "utf8"));
	const u = { current: "v1.2.3", integrity: { status: "modified", counts: { changed: 23, missing: 2, added: 1 } }, releaseUrl: "https://example.invalid/current-release" };
	const context = { setUpdate: u, setState: {}, esc: (text) => String(text), tr: (text, vars = {}) => (en[text] ?? text).replace(/\{([^{}]+)\}/g, (_, name) => String(vars[name])) };
	const rendered = runInNewContext(`${source}\naboutPane()`, context);
	assert.match(rendered, /class="hint">Program files differ from the official v1.2.3 release \(26 files\)\. If you didn't change them yourself, download and reinstall\./);
	assert.match(rendered, /class="small" id="updInstaller">Download the v1.2.3 installer/);
	for (const status of ["pending", "ok", "unavailable", "error"]) {
		u.integrity.status = status;
		assert.doesNotMatch(runInNewContext(`${source}\naboutPane()`, context), /updInstaller|Program files differ/);
	}
	let opened;
	const listener = html.split("\n").find((line) => line.includes('$("updInstaller")?.addEventListener'));
	runInNewContext(listener, { setUpdate: u, $: () => ({ addEventListener: (_, click) => click() }), window: { open: (...args) => { opened = args; } } });
	assert.deepEqual(opened, [u.releaseUrl, "_blank", "noopener"]);
});

test("writeIntegrityManifest keeps integer-looking names in dictionary order and escapes unusual paths", async (t) => {
	const app = await fixture(t);
	const names = ["2", "10", 'nested/引號".txt', "nested/INTEGRITY.json", "nested/deeper/__pycache__"];
	if (process.platform !== "win32") names.push("nested/back\\slash");
	for (const name of names) await writeFile(join(app, name), name);
	await writeIntegrityManifest(app);
	const text = await readFile(join(app, "INTEGRITY.json"), "utf8");
	assert.ok(text.indexOf('"10":') < text.indexOf('"2":'));
	const manifest = JSON.parse(text);
	for (const name of names) assert.equal(manifest.files[name], sha256(name));
	assert.equal((await checkIntegrity(app)).status, "ok");
});

test("server schedules one non-blocking integrity check five seconds after listening and warns with all counts", async () => {
	const source = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
	const block = source.slice(source.indexOf("\tfor (const host of hosts) {"), source.indexOf("\tif (!lan && !process.env.STEWARD_HOSTS) onSettingsChange"));
	const callbacks = [], timers = [], warnings = [];
	let checked = 0, unrefed = 0;
	runInNewContext(`const listening = new Map(); let integrityTimer; ${block}`, {
		hosts: ["127.0.0.1", "100.1.2.3"], PORT: 0, proxyUpgrade: () => {},
		createServer: () => ({ on: () => {}, listen: (_, host, callback) => callbacks.push(callback) }),
		console: { log: () => {}, warn: (line) => warnings.push(line) },
		setTimeout: (callback, delay) => { timers.push({ callback, delay }); return { unref: function () { unrefed++; return this; } }; },
		checkIntegrity: async () => { checked++; return { status: "modified", counts: { changed: 2, missing: 3, added: 4 } }; },
	});
	assert.equal(checked, 0);
	assert.equal(timers.length, 0);
	for (const callback of callbacks) callback();
	assert.equal(timers.length, 1);
	assert.equal(timers[0].delay, 5000);
	assert.equal(unrefed, 1);
	assert.equal(checked, 0);
	await timers[0].callback();
	assert.equal(checked, 1);
	assert.deepEqual(warnings, ["[integrity] Program files differ: changed=2, missing=3, added=4"]);
});

test("health exposes integrity only to authenticated requests without running another check", async () => {
	const source = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
	const start = source.indexOf('if (req.method === "GET" && path === "/api/health") {');
	const block = source.slice(start, source.indexOf("\n\t\t\t// 手動觸發:", start));
	const cached = { status: "pending" };
	for (const authenticated of [false, true]) {
		let read = 0;
		const response = await runInNewContext(`(async () => { ${block} })()`, {
			req: { method: "GET" }, path: "/api/health", res: {}, process: { env: {} },
			authorize: async () => ({ ok: authenticated }),
			steward: { usage: async () => ({}), watchedCards: async () => [], patrolStatus: async () => ({}) },
			watcher: { status: () => ({}) }, send: (_, status, data) => ({ status, data }),
			integrityStatus: () => { read++; return cached; },
		});
		assert.equal(response.status, 200);
		assert.equal(read, Number(authenticated));
		assert.equal(response.data.integrity, authenticated ? cached : undefined);
	}
});
