// 自動抓取只更新遠端紀錄；認證失敗會停用，手動抓取成功後恢復。
import "./helpers/git-isolation.mjs";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = realpathSync.native(mkdtempSync(join(tmpdir(), "steward-autofetch-data-")));
process.env.STEWARD_DATA_DIR = DATA;
const roots = [DATA];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});
// 載入沒有 code 欄位的舊設定，由 merge 補齊預設值。
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ version: 1, access: { tailscale: { enabled: false } }, plugins: {}, setupDone: true }));
const { autoFetchInfo, gitAction, repoPrefix, status } = await import("../src/code.ts");
const { DEFAULTS, settings, updateSettings } = await import("../src/settings.ts");

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const proj = (root) => ({ id: "x", root, name: "x", kind: "project", status: "active", private: false });
function tmp() {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "steward-autofetch-repo-")));
	roots.push(root);
	return root;
}
function identity(root) {
	git(root, "config", "user.email", "t@t");
	git(root, "config", "user.name", "t");
}
function repo(root = tmp()) {
	mkdirSync(root, { recursive: true });
	git(root, "init", "-q", "-b", "main");
	identity(root);
	return root;
}
function pair() {
	const root = tmp();
	const remote = join(root, "remote.git"), a = join(root, "a"), b = join(root, "b");
	git(root, "init", "--bare", "-q", "-b", "main", remote);
	git(root, "clone", "-q", remote, a);
	identity(a);
	writeFileSync(join(a, "file.txt"), "v1\n");
	git(a, "add", "-A");
	git(a, "commit", "-qm", "init");
	git(a, "push", "-qu", "origin", "main");
	git(root, "clone", "-q", remote, b);
	identity(b);
	return { remote, a, b };
}
function pushCommit(root) {
	writeFileSync(join(root, "file.txt"), "v2\n");
	git(root, "commit", "-qam", "remote change");
	git(root, "push", "-q");
}

test("預設先問、間隔三分鐘；舊設定會補齊，未開啟就不抓取", async () => {
	assert.deepEqual(DEFAULTS.code, { autoFetch: "ask", autoFetchMinutes: 3 });
	assert.deepEqual(settings().code, { autoFetch: "ask", autoFetchMinutes: 3 });
	const { a, b } = pair();
	const p = proj(a), before = git(a, "rev-parse", "origin/main");
	pushCommit(b);
	assert.deepEqual(await gitAction(p, "autofetch", {}), { skipped: "off" });
	updateSettings({ code: { autoFetch: "off" } });
	assert.deepEqual(await gitAction(p, "autofetch", {}), { skipped: "off" });
	assert.equal(git(a, "rev-parse", "origin/main"), before);
	assert.deepEqual((await status(p)).autoFetch, {});
});

test("自動抓取更新落後數量與時間，不合併也不改工作目錄", async () => {
	const { a, b } = pair();
	const p = proj(a), head = git(a, "rev-parse", "HEAD");
	pushCommit(b);
	updateSettings({ code: { autoFetch: "on" } });
	const out = await gitAction(p, "autofetch", {});
	assert.equal(out.fetched, true);
	assert.ok(out.at > 0);
	const st = await status(p);
	assert.equal(st.behind, 1);
	assert.equal(st.autoFetch.at, out.at);
	assert.equal(git(a, "rev-parse", "HEAD"), head);
	assert.equal(readFileSync(join(a, "file.txt"), "utf8"), "v1\n");
});

test("緊接著再次自動抓取會因間隔未到而跳過", async () => {
	const p = proj(pair().a);
	updateSettings({ code: { autoFetch: "on" } });
	const first = await gitAction(p, "autofetch", {});
	assert.equal(first.fetched, true);
	const second = await gitAction(p, "autofetch", {});
	assert.equal(second.skipped, "recent");
	assert.equal(second.at, first.at);
});

test("沒有遠端的 repo 不會自動抓取", async () => {
	updateSettings({ code: { autoFetch: "on" } });
	assert.deepEqual(await gitAction(proj(repo()), "autofetch", {}), { skipped: "no-remote" });
});

test("登入失敗不丟錯誤、停止自動抓取，手動抓取成功後清除記錄", async () => {
	const { remote, a } = pair();
	const p = proj(a);
	let requests = 0;
	const server = createServer((_req, res) => {
		requests++;
		res.writeHead(401, { "WWW-Authenticate": 'Basic realm="x"', Connection: "close" });
		res.end();
	});
	try {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const { port } = server.address();
		git(a, "remote", "set-url", "origin", `http://127.0.0.1:${port}/x.git`);
		git(a, "config", "branch.main.remote", "origin");
		git(a, "config", "branch.main.merge", "refs/heads/main");
		updateSettings({ code: { autoFetch: "on" } });
		const failed = await gitAction(p, "autofetch", {});
		assert.equal(failed.fetched, false);
		assert.ok(failed.authFailed);
		assert.equal(failed.error, undefined);
		assert.ok(requests > 0);
		const count = requests;
		const skipped = await gitAction(p, "autofetch", {});
		assert.equal(skipped.skipped, "auth");
		assert.equal(skipped.authFailed, failed.authFailed);
		assert.equal(requests, count);
		assert.equal((await status(p)).autoFetch.authFailed, failed.authFailed);

		git(a, "remote", "set-url", "origin", remote);
		await gitAction(p, "fetch", {});
		const info = autoFetchInfo((await repoPrefix(p)).top);
		assert.ok(info.at > 0);
		assert.equal(info.authFailed, undefined);
		assert.equal(info.error, undefined);
		assert.equal((await status(p)).autoFetch.authFailed, undefined);
	} finally {
		if (server.listening) await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
	}
});

test("一般抓取錯誤會記錄，但不會當成登入失敗而停止", async () => {
	const root = repo(), p = proj(root);
	git(root, "remote", "add", "origin", join(root, "missing.git"));
	updateSettings({ code: { autoFetch: "on" } });
	const failed = await gitAction(p, "autofetch", {});
	assert.equal(failed.fetched, false);
	assert.ok(failed.error);
	assert.equal(failed.authFailed, undefined);
	assert.equal((await status(p)).autoFetch.error, failed.error);
	assert.notEqual((await gitAction(p, "autofetch", {})).skipped, "auth");
});
