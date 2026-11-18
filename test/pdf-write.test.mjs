import { after, test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";

const dir = mkdtempSync(join(tmpdir(), "steward-pdf-write-"));
const home = join(dir, "home"), data = join(dir, "data"), root = join(dir, "project");
for (const path of [home, data, root]) mkdirSync(path);
const previous = Object.fromEntries(["HOME", "USERPROFILE", "STEWARD_DATA_DIR"].map((key) => [key, process.env[key]]));
Object.assign(process.env, { HOME: home, USERPROFILE: home, STEWARD_DATA_DIR: data });
writeFileSync(join(data, "settings.json"), JSON.stringify({ ui: { lang: "zh-TW" }, access: { tailscale: { enabled: false } }, setupDone: true }));
after(() => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(dir, { recursive: true, force: true });
});
const { CodeError, officeStamp, pdfFromTex, readFile, UPLOAD_LIMIT, writePdf } = await import("../src/code.ts");
const { officeVersionFile, officeVersions } = await import("../src/office-dav.ts");
const project = { root, id: "pdf-write", name: "PDF write", kind: "project", status: "active", private: false };
const original = Buffer.from("%PDF-1.4\noriginal\n%%EOF\n");
const edited = Buffer.from("%PDF-1.7\nannotation added\n%%EOF\n");
const save = (name, content = original) => { const path = join(root, name); writeFileSync(path, content); return path; };
const body = (content = edited) => Readable.from([content]);
const noTemps = () => assert.deepEqual(readdirSync(root).filter((name) => name.includes(".pdfsave-")), []);
const status = (expected) => (error) => error instanceof CodeError && error.status === expected;

// 攔下外部指令,避免測試誤呼叫作業系統垃圾桶。
test("writePdf:寫回、新 hash、舊版備份,不呼叫垃圾桶", async (t) => {
	const path = save("normal.pdf");
	const before = readFile(project, "normal.pdf");
	assert.equal(before.kind, "pdf");
	assert.equal(before.fromTex, false);
	assert.equal(pdfFromTex(path), false);
	const versions = officeVersions(project, "normal.pdf");
	const trash = join(home, ".Trash");
	mkdirSync(trash);
	writeFileSync(join(trash, "sentinel"), "unchanged");
	const trashBefore = readdirSync(trash);
	const exec = t.mock.method(childProcess, "execFile", () => assert.fail("PDF 存檔不應呼叫外部垃圾桶指令"));
	syncBuiltinESMExports();
	try {
		const result = await writePdf(project, "normal.pdf", Readable.from([edited.subarray(0, 3), edited.subarray(3)]), before.hash, false, edited.length);
		assert.deepEqual(readFileSync(path), edited);
		const st = statSync(path);
		assert.deepEqual(result, { hash: officeStamp(st), size: edited.length, mtime: st.mtimeMs });
		assert.notEqual(result.hash, before.hash);
		assert.equal(readFile(project, "normal.pdf").hash, result.hash);
		const after = officeVersions(project, "normal.pdf");
		assert.equal(after.length, versions.length + 1);
		assert.equal(after[0].size, original.length);
		assert.deepEqual(readFileSync(officeVersionFile(project, "normal.pdf", after[0].id)), original);
		assert.deepEqual(readdirSync(trash), trashBefore);
		assert.equal(readFileSync(join(trash, "sentinel"), "utf8"), "unchanged");
		assert.equal(exec.mock.callCount(), 0);
		noTemps();
	} finally { exec.mock.restore(); syncBuiltinESMExports(); }
});

test("writePdf:409 附 disk.hash,保留原檔且不建立備份", async () => {
	const path = save("conflict.pdf");
	const hash = officeStamp(statSync(path));
	await assert.rejects(writePdf(project, "conflict.pdf", body(), "stale", false), (error) => {
		assert.ok(status(409)(error));
		assert.deepEqual(error.disk, { hash });
		return true;
	});
	assert.deepEqual(readFileSync(path), original);
	assert.deepEqual(officeVersions(project, "conflict.pdf"), []);
	noTemps();
});

test("writePdf:force 可覆寫衝突,未提供 baseHash 也能存檔", async () => {
	for (const [name, hash, force] of [["force.pdf", "stale", true], ["no-hash.PDF", undefined, false]]) {
		const path = save(name);
		await writePdf(project, name, body(), hash, force);
		assert.deepEqual(readFileSync(path), edited);
		assert.equal(officeVersions(project, name).length, 1);
	}
	noTemps();
});

test("writePdf:無效、過短與非 ASCII PDF 標頭回 400,保留原檔並刪暫存", async () => {
	for (const [i, content] of [Buffer.from("not PDF"), Buffer.from("%PDF"), Buffer.alloc(0), Buffer.from([0xa5, 0x50, 0x44, 0x46, 0x2d])].entries()) {
		const name = `invalid-${i}.pdf`, path = save(name);
		await assert.rejects(writePdf(project, name, body(content), undefined, false), status(400));
		assert.deepEqual(readFileSync(path), original);
		assert.deepEqual(officeVersions(project, name), []);
		noTemps();
	}
});

test("writePdf:拒絕 ../ 跳出專案", async () => {
	const outside = join(dir, "x.pdf");
	writeFileSync(outside, original);
	await assert.rejects(writePdf(project, "../x.pdf", body(), undefined, true), status(400));
	assert.deepEqual(readFileSync(outside), original);
	noTemps();
});

test("writePdf:拒絕 symlink 跳出專案", async (t) => {
	const outside = join(dir, "outside.pdf");
	writeFileSync(outside, original);
	try { symlinkSync(outside, join(root, "linked.pdf"), "file"); }
	catch (error) { if (error.code === "EPERM") { t.skip("此環境無法建立 symlink"); return; } throw error; }
	await assert.rejects(writePdf(project, "linked.pdf", body(), undefined, true), status(400));
	assert.deepEqual(readFileSync(outside), original);
	noTemps();
});

test("writePdf:非 PDF 回 400、缺檔回 404、資料夾回 400", async () => {
	const text = save("note.txt", "text");
	mkdirSync(join(root, "folder.pdf"));
	for (const [name, expected] of [["note.txt", 400], ["missing.pdf", 404], ["folder.pdf", 400]]) {
		await assert.rejects(writePdf(project, name, body(), undefined, false), status(expected));
	}
	assert.equal(readFileSync(text, "utf8"), "text");
	noTemps();
});

test("pdfFromTex/readFile/writePdf:同目錄同名 .tex 標記來源,即使 force 也回 403", async () => {
	const path = save("latex.pdf");
	save("latex.tex", "\\documentclass{article}");
	assert.equal(pdfFromTex(path), true);
	assert.equal(readFile(project, "latex.pdf").fromTex, true);
	for (const force of [false, true]) {
		await assert.rejects(writePdf(project, "latex.pdf", body(), undefined, force), (error) => {
			assert.ok(status(403)(error));
			assert.equal(error.message, "這是 LaTeX 產生的 PDF,請改 .tex");
			return true;
		});
	}
	assert.deepEqual(readFileSync(path), original);
	assert.deepEqual(officeVersions(project, "latex.pdf"), []);
	noTemps();
});

test("writePdf:宣告大小超過 UPLOAD_LIMIT 回 413,不讀串流", async () => {
	const path = save("oversize.pdf");
	const input = body();
	await assert.rejects(writePdf(project, "oversize.pdf", input, undefined, false, UPLOAD_LIMIT + 1), status(413));
	assert.equal(input.readableFlowing, null);
	assert.deepEqual(readFileSync(path), original);
	noTemps();
});

test("writePdf:未宣告長度仍檢查串流 UPLOAD_LIMIT", async (t) => {
	const path = save("stream-oversize.pdf");
	const chunk = Buffer.alloc(1024 * 1024);
	const input = Readable.from((function* () {
		for (let i = 0; i <= UPLOAD_LIMIT / chunk.length; i++) yield chunk;
	})());
	const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
	const create = t.mock.method(fs, "createWriteStream", (tmp) => {
		assert.match(tmp, /\.stream-oversize\.pdf\.pdfsave-\d+-\d+$/);
		assert.equal(dirname(tmp), realpathSync(root));
		return output;
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(writePdf(project, "stream-oversize.pdf", input, undefined, false), status(413));
		assert.equal(input.destroyed, true);
		assert.equal(output.destroyed, true);
		assert.deepEqual(readFileSync(path), original);
		assert.deepEqual(officeVersions(project, "stream-oversize.pdf"), []);
		noTemps();
	} finally { create.mock.restore(); syncBuiltinESMExports(); }
});

test("writePdf:串流失敗保留原檔並刪暫存", async () => {
	const path = save("stream-error.pdf");
	const failure = new Error("fixture stream failure");
	const input = Readable.from((async function* () { yield edited; throw failure; })());
	await assert.rejects(writePdf(project, "stream-error.pdf", input, undefined, false), (error) => error === failure);
	assert.deepEqual(readFileSync(path), original);
	assert.deepEqual(officeVersions(project, "stream-error.pdf"), []);
	noTemps();
});

test("writePdf:串流中斷回 400,保留原檔並刪暫存", async () => {
	const path = save("aborted.pdf");
	const input = new Readable({ read() { this.push(edited); this.emit("aborted"); } });
	await assert.rejects(writePdf(project, "aborted.pdf", input, undefined, false), status(400));
	assert.deepEqual(readFileSync(path), original);
	noTemps();
});

test("writePdf:備份失敗不覆蓋原檔且刪暫存", async (t) => {
	const path = save("backup-error.pdf");
	const failure = new Error("fixture backup failure");
	const copy = t.mock.method(fs, "copyFileSync", () => { throw failure; });
	syncBuiltinESMExports();
	try {
		await assert.rejects(writePdf(project, "backup-error.pdf", body(), undefined, false), (error) => error === failure);
		assert.deepEqual(readFileSync(path), original);
		noTemps();
	} finally { copy.mock.restore(); syncBuiltinESMExports(); }
});

test("writePdf:rename 失敗保留原檔且刪暫存", async (t) => {
	const path = save("rename-error.pdf");
	const failure = new Error("fixture rename failure");
	const rename = t.mock.method(fs, "renameSync", () => { throw failure; });
	syncBuiltinESMExports();
	try {
		await assert.rejects(writePdf(project, "rename-error.pdf", body(), undefined, false), (error) => error === failure);
		assert.deepEqual(readFileSync(path), original);
		noTemps();
	} finally { rename.mock.restore(); syncBuiltinESMExports(); }
});

test("PUT /api/code/:id/pdf:串流存檔、409 JSON disk.hash、force 與 403", { timeout: 30_000 }, () => {
	const serverURL = new URL("../src/server.ts", import.meta.url).href;
	const storeURL = new URL("../src/store.ts", import.meta.url).href;
	const codeURL = new URL("../src/code.ts", import.meta.url).href;
	const script = `
		import assert from 'node:assert/strict';
		import { createServer } from 'node:net';
		import { readFileSync, writeFileSync } from 'node:fs';
		import { join } from 'node:path';
		const probe = createServer();
		await new Promise((done, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', done); });
		const port = probe.address().port;
		await new Promise((done) => probe.close(done));
		process.env.STEWARD_PORT = String(port);
		process.env.STEWARD_HOSTS = '127.0.0.1';
		const { Store } = await import(${JSON.stringify(storeURL)});
		const { startServer } = await import(${JSON.stringify(serverURL)});
		const { readFile } = await import(${JSON.stringify(codeURL)});
		const store = new Store(join(process.env.STEWARD_DATA_DIR, 'pdf-api-state.json'));
		const project = store.addProject({ root: ${JSON.stringify(root)}, name: 'PDF API', kind: 'project', status: 'active', private: false });
		const path = join(project.root, 'api.pdf');
		writeFileSync(path, '%PDF-1.4\\nold');
		const hash = readFile(project, 'api.pdf').hash;
		const close = startServer(store, {}, {});
		await new Promise((done) => setImmediate(done));
		const put = async (params, content = '%PDF-1.7\\nnew annotation') => {
			const response = await fetch('http://127.0.0.1:' + port + '/api/code/' + project.id + '/pdf?' + new URLSearchParams(params), { method: 'PUT', body: content, headers: { connection: 'close' }, signal: AbortSignal.timeout(5000) });
			return { status: response.status, data: await response.json() };
		};
		try {
			const conflict = await put({ path: 'api.pdf', baseHash: 'stale' });
			assert.equal(conflict.status, 409);
			assert.deepEqual(conflict.data, { error: '檔案在你開啟之後被改過了', disk: { hash } });
			const result = await put({ path: 'api.pdf', baseHash: hash });
			assert.equal(result.status, 200);
			assert.equal(result.data.hash, readFile(project, 'api.pdf').hash);
			assert.notEqual(result.data.hash, hash);
			assert.equal(result.data.size, Buffer.byteLength('%PDF-1.7\\nnew annotation'));
			assert.equal(result.data.mtime, readFile(project, 'api.pdf').mtime);
			assert.equal((await put({ path: 'api.pdf', baseHash: 'stale', force: '1' })).status, 200);
			const before = readFileSync(path);
			const invalid = await put({ path: 'api.pdf' }, 'invalid');
			assert.equal(invalid.status, 400);
			assert.deepEqual(invalid.data, { error: '不是 PDF 檔' });
			assert.deepEqual(readFileSync(path), before);
			writeFileSync(join(project.root, 'api.tex'), 'source');
			const latex = await put({ path: 'api.pdf', force: '1' });
			assert.equal(latex.status, 403);
			assert.deepEqual(latex.data, { error: '這是 LaTeX 產生的 PDF,請改 .tex' });
		} finally { await close(); }
		process.exit(0);
	`;
	childProcess.execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], { env: process.env, encoding: "utf8", timeout: 25_000 });
});
