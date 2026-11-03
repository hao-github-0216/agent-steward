// git 面板只管專案資料夾:一個 repo 底下有好幾個專案資料夾(course/hw1、course/hw2)時,狀態、暫存、diff、歷史都不混在一起
// 先隔離使用者的 git 設定,要在載入 src 之前
import "./helpers/git-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STEWARD_DATA_DIR = mkdtempSync(join(tmpdir(), "steward-data-"));
const { status, gitAction, diffSides } = await import("../src/code.ts");

const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();

function course() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "course-")));
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "t@t");
	git(root, "config", "user.name", "t");
	for (const d of ["hw1", "hw2"]) {
		mkdirSync(join(root, d));
		writeFileSync(join(root, d, "sol.tex"), `${d} v1\n`);
	}
	git(root, "add", "-A");
	git(root, "commit", "-qm", "init");
	git(root, "commit", "-qm", "only hw2", "--allow-empty");
	return root;
}
const proj = (root) => ({ id: "x", root, name: "x", kind: "project", status: "active", private: false });

test("子資料夾專案:狀態只列自己的檔案,路徑相對於專案資料夾", async () => {
	const root = course();
	writeFileSync(join(root, "hw1", "sol.tex"), "hw1 v2\n");
	writeFileSync(join(root, "hw1", "new.txt"), "n\n");
	writeFileSync(join(root, "hw2", "sol.tex"), "hw2 v2\n");
	const st = await status(proj(join(root, "hw1")));
	assert.deepEqual(st.unstaged.map((x) => x.path), ["sol.tex"]);
	assert.deepEqual(st.untracked.map((x) => x.path), ["new.txt"]);
	assert.equal(st.prefix, "hw1");
	assert.equal(st.repoName, root.split("/").pop());
	assert.deepEqual(st.outsideStaged, []);

	// 單一檔案暫存、diff 都用相對路徑
	await gitAction(proj(join(root, "hw1")), "stage", { paths: ["sol.tex"] });
	assert.match(git(root, "status", "--porcelain"), /^M  hw1\/sol\.tex$/m);
	const d = await diffSides(proj(join(root, "hw1")), "sol.tex", "staged");
	assert.deepEqual(d, { original: "hw1 v1\n", modified: "hw1 v2\n" });

	// 全部暫存只加 hw1,不碰 hw2
	await gitAction(proj(join(root, "hw1")), "stage", { all: true });
	assert.deepEqual(git(root, "diff", "--cached", "--name-only").split("\n"), ["hw1/new.txt", "hw1/sol.tex"]);
});

test("commit:暫存區有別的資料夾的檔案就先問;可以只提交自己的,或一起提交", async () => {
	const root = course();
	const hw1 = proj(join(root, "hw1"));
	writeFileSync(join(root, "hw1", "sol.tex"), "hw1 v2\n");
	writeFileSync(join(root, "hw2", "sol.tex"), "hw2 v2\n");
	git(root, "add", "-A"); // 像在終端機下了 git add -A
	assert.deepEqual((await status(hw1)).outsideStaged, ["hw2/sol.tex"]);
	await assert.rejects(gitAction(hw1, "commit", { message: "m" }), (e) => e.status === 409 && e.outside[0] === "hw2/sol.tex");

	await gitAction(hw1, "commit", { message: "hw1 only", outside: "unstage" });
	assert.equal(git(root, "show", "--name-only", "--format=", "HEAD"), "hw1/sol.tex");
	assert.equal(git(root, "diff", "--cached", "--name-only"), ""); // hw2 取消暫存了
	assert.equal(git(root, "diff", "--name-only"), "hw2/sol.tex"); // 內容還在

	writeFileSync(join(root, "hw1", "sol.tex"), "hw1 v3\n");
	git(root, "add", "-A");
	await gitAction(hw1, "commit", { message: "both", outside: "include" });
	assert.deepEqual(git(root, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["hw1/sol.tex", "hw2/sol.tex"]);
	await assert.rejects(gitAction(hw1, "commit", { message: "empty" }), /沒有已暫存的變更/);
});

test("歷史只列改到這個資料夾的 commit;commit 的檔案清單相對於專案資料夾", async () => {
	const root = course();
	const hw1 = proj(join(root, "hw1"));
	writeFileSync(join(root, "hw2", "sol.tex"), "hw2 v2\n");
	git(root, "commit", "-qam", "hw2 change");
	writeFileSync(join(root, "hw1", "sol.tex"), "hw1 v2\n");
	writeFileSync(join(root, "hw2", "sol.tex"), "hw2 v3\n");
	git(root, "commit", "-qam", "both change");
	const log = await gitAction(hw1, "log", {});
	assert.deepEqual(log.map((c) => c.subject), ["both change", "init"]);
	const show = await gitAction(hw1, "show", { commit: log[0].hash });
	assert.deepEqual(show.files, [{ code: "M", path: "sol.tex" }]);
	const d = await diffSides(hw1, "sol.tex", "commit", log[0].hash);
	assert.deepEqual(d, { original: "hw1 v1\n", modified: "hw1 v2\n" });
});

test("專案就是 repo 根目錄:行為不變", async () => {
	const root = course();
	writeFileSync(join(root, "hw1", "sol.tex"), "hw1 v2\n");
	writeFileSync(join(root, "hw2", "sol.tex"), "hw2 v2\n");
	const p = proj(root);
	const st = await status(p);
	assert.deepEqual(st.unstaged.map((x) => x.path).sort(), ["hw1/sol.tex", "hw2/sol.tex"]);
	assert.equal(st.prefix, undefined);
	await gitAction(p, "stage", { all: true });
	await gitAction(p, "commit", { message: "all" });
	assert.equal(git(root, "status", "--porcelain"), "");
});
