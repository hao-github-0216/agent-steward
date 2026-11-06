// git 的正斜線路徑在 Windows 轉成完整名稱與反斜線,專案查找不分大小寫與斜線
import "./helpers/git-isolation.mjs";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = realpathSync.native(mkdtempSync(join(tmpdir(), "steward-windows-data-")));
process.env.STEWARD_DATA_DIR = DATA;
const roots = [DATA];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const { fromGit } = await import("../src/platform.ts");
const { Store } = await import("../src/store.ts");
const { gitRoot } = await import("../src/projects.ts");

const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
function tmp() {
	const root = mkdtempSync(join(tmpdir(), "steward-windows-paths-"));
	roots.push(root);
	return root;
}

test("fromGit:非 Windows 保留原始路徑與空字串", { skip: process.platform === "win32" }, () => {
	assert.equal(fromGit("/a/b"), "/a/b");
	assert.equal(fromGit(""), "");
});

test("fromGit:Windows 不存在的路徑改用反斜線", { skip: process.platform !== "win32" }, () => {
	assert.equal(fromGit("C:/nope-xyz/a"), "C:\\nope-xyz\\a");
});

test("fromGit:Windows 現有資料夾展開為完整名稱", { skip: process.platform !== "win32" }, () => {
	const root = tmp();
	assert.equal(fromGit(root.replace(/\\/g, "/")), realpathSync.native(root));
});

test("projectByRoot:Windows 不分大小寫與斜線", { skip: process.platform !== "win32" }, () => {
	const store = new Store(join(DATA, "state.json"));
	const p = store.addProject({ root: "C:\\Foo\\Bar", name: "Bar", kind: "project", status: "active", private: false });
	assert.equal(store.projectByRoot("c:/foo/bar"), p);
});

test("gitRoot:Windows 子資料夾對回完整名稱的 repo 路徑", { skip: process.platform !== "win32" }, () => {
	const root = tmp();
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "t@t");
	git(root, "config", "user.name", "t");
	const sub = join(root, "sub");
	mkdirSync(sub);
	assert.equal(gitRoot(sub), realpathSync.native(root));
});
