// Git 面板認得專案資料夾裡面的 repo:列出巢狀 repo、外層沒有 commit 時歷史是空的、?repo= 只認伺服器列出的 repo、路徑一律相對於專案資料夾
import "./helpers/git-isolation.mjs";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = realpathSync(mkdtempSync(join(tmpdir(), "steward-nested-data-")));
process.env.STEWARD_DATA_DIR = DATA;
const roots = [DATA];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const { CodeError, nestedRepos, status, statusIn, diffIn, gitAction, gitActionIn } = await import("../src/code.ts");

const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
const proj = (root) => ({ id: "x", root, name: "x", kind: "project", status: "active", private: false });
function tmp() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "steward-nested-repo-")));
	roots.push(root);
	return root;
}
function repo(root = tmp()) {
	mkdirSync(root, { recursive: true });
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "t@t");
	git(root, "config", "user.name", "t");
	return root;
}
function innerRepo(root) {
	const inner = repo(join(root, "inner"));
	mkdirSync(join(inner, "pkg"));
	writeFileSync(join(inner, "pkg", "method.py"), "def method():\n    return 1\n");
	git(inner, "add", "-A");
	git(inner, "commit", "-qm", "init");
	git(inner, "switch", "-q", "-c", "feature/x");
	writeFileSync(join(inner, "pkg", "method.py"), "def method():\n    return 2\n");
	git(inner, "commit", "-qam", "change method");
	return inner;
}

test("外層沒有 commit:巢狀 repo 的歷史、狀態、diff 與暫存都維持專案相對路徑", async () => {
	const outer = repo();
	const root = join(outer, "proj");
	mkdirSync(root);
	const inner = innerRepo(root);
	const p = proj(root);
	const st = await status(p);
	assert.equal(st.repo, true);
	assert.equal(st.empty, true);
	assert.deepEqual(st.nested, [{ rel: "inner", branch: "feature/x" }]);
	assert.deepEqual(await gitAction(p, "log", {}), []);

	const log = await gitActionIn(p, "inner", "log", {});
	assert.equal(log.length, 2);
	const show = await gitActionIn(p, "inner", "show", { commit: log[0].hash });
	assert.deepEqual(show.files, [{ code: "M", path: "inner/pkg/method.py" }]);

	writeFileSync(join(inner, "pkg", "method.py"), "def method():\n    return 3\n");
	const nested = await statusIn(p, "inner");
	assert.equal(nested.repo, true);
	assert.equal(nested.empty, false);
	assert.deepEqual(nested.unstaged.map((x) => x.path), ["inner/pkg/method.py"]);
	assert.equal(nested.repoRel, "inner");
	assert.equal("nested" in nested, false);
	assert.equal(nested.prefix, undefined);
	assert.deepEqual(await diffIn(p, "inner", "inner/pkg/method.py", "unstaged"), {
		original: "def method():\n    return 2\n",
		modified: "def method():\n    return 3\n",
	});

	const outerStatus = git(outer, "status", "--porcelain");
	const outerStaged = git(outer, "diff", "--cached", "--name-only");
	await gitActionIn(p, "inner", "stage", { paths: ["inner/pkg/method.py"] });
	assert.equal(git(inner, "diff", "--cached", "--name-only"), "pkg/method.py");
	assert.equal(git(outer, "diff", "--cached", "--name-only"), outerStaged);
	assert.equal(git(outer, "status", "--porcelain"), outerStatus);
});

test("專案資料夾不是 repo:仍列出裡面的巢狀 repo", async () => {
	const root = tmp();
	repo(join(root, "inner"));
	assert.deepEqual(await status(proj(root)), { repo: false, nested: [{ rel: "inner", branch: "main" }] });
});

test("巢狀 repo 與檔案路徑只接受伺服器列出的範圍", async () => {
	const root = tmp();
	repo(join(root, "inner"));
	const p = proj(root);
	const badPath = (e) => e instanceof CodeError && e.status === 400;
	await assert.rejects(statusIn(p, "../x"), badPath);
	await assert.rejects(statusIn(p, "nope"), badPath);
	await assert.rejects(gitActionIn(p, "inner", "stage", { paths: ["other/x"] }), badPath);
});

test("巢狀掃描跳過隱藏與依賴資料夾、限制深度、找到就停止並排除自己的 linked worktree", async () => {
	const skipped = tmp();
	repo(join(skipped, ".hidden", "r"));
	repo(join(skipped, "node_modules", "r"));
	assert.deepEqual(await nestedRepos(proj(skipped)), []);

	const depth3 = tmp();
	repo(join(depth3, "one", "two", "three"));
	assert.deepEqual(await nestedRepos(proj(depth3)), [{ rel: "one/two/three", branch: "main" }]);
	const depth4 = tmp();
	repo(join(depth4, "one", "two", "three", "four"));
	assert.deepEqual(await nestedRepos(proj(depth4)), []);

	const stopped = tmp();
	const inner = repo(join(stopped, "inner"));
	repo(join(inner, "inside"));
	assert.deepEqual(await nestedRepos(proj(stopped)), [{ rel: "inner", branch: "main" }]);

	const own = repo();
	writeFileSync(join(own, "a.txt"), "init\n");
	git(own, "add", "-A");
	git(own, "commit", "-qm", "init");
	git(own, "worktree", "add", "-q", "-b", "b1", join(own, "wt1"));
	assert.deepEqual(await nestedRepos(proj(own)), []);
});
