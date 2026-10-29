// 支線的 git worktree:帶上主線未提交的改動、共用 node_modules、diff 只算支線自己的改動、移除時改動存進分支
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 資料夾要在載入管家模組之前設好(worktree 放在 DATA_DIR/worktrees 底下)
const DATA = mkdtempSync(join(tmpdir(), "steward-data-"));
process.env.STEWARD_DATA_DIR = DATA;
const { createWorktree, removeWorktree, worktreeBlocker, worktreeChanges } = await import("../src/worktree.ts");
const { Store } = await import("../src/store.ts");
const { ownerOf, resolveProject } = await import("../src/projects.ts");

const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();

function repo(ignore = "node_modules/\n") {
	const root = mkdtempSync(join(tmpdir(), "steward-repo-"));
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "t@t");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, ".gitignore"), ignore);
	writeFileSync(join(root, "a.txt"), "committed\n");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "init");
	// 主線還沒提交的改動 + 沒追蹤的新檔 + 依賴資料夾
	writeFileSync(join(root, "a.txt"), "main wip\n");
	writeFileSync(join(root, "new.txt"), "untracked\n");
	mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
	writeFileSync(join(root, "node_modules", "pkg", "index.js"), "x");
	return root;
}

test("非 git 資料夾不能開 worktree", () => {
	assert.equal(worktreeBlocker(mkdtempSync(join(tmpdir(), "plain-"))), "不是 git 專案");
});

test("worktree 帶上主線未提交的改動,node_modules 連回主線,主線不受影響", () => {
	const root = repo();
	const w = createWorktree(root, "proj1", "b1");
	assert.equal(w.gitBranch, "steward/branch-b1");
	assert.equal(readFileSync(join(w.path, "a.txt"), "utf8"), "main wip\n");
	assert.equal(readFileSync(join(w.path, "new.txt"), "utf8"), "untracked\n");
	assert.ok(lstatSync(join(w.path, "node_modules")).isSymbolicLink());
	assert.deepEqual(w.shared, ["node_modules"]);
	// 主線的檔案和 git 狀態沒被動到
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "main wip\n");
	assert.match(git(root, "status", "--porcelain"), /M a\.txt/);
	assert.equal(git(root, "stash", "list"), "");
	removeWorktree({ ...w });
});

test("帶回主線的 diff 只含支線自己的改動(不含主線的未提交改動)", () => {
	const root = repo();
	const w = createWorktree(root, "proj1", "b2");
	assert.deepEqual(worktreeChanges(w).files, []);
	writeFileSync(join(w.path, "a.txt"), "branch edit\n");
	writeFileSync(join(w.path, "branch-new.txt"), "hello\n");
	const c = worktreeChanges(w);
	assert.deepEqual(c.files.sort(), ["a.txt", "branch-new.txt"]);
	assert.match(c.diff, /-main wip\n\+branch edit/);
	assert.doesNotMatch(c.diff, /node_modules/);
	// 照結論裡的指令套回主線
	execFileSync("sh", ["-c", `git -C "${w.path}" diff ${w.base} -- . ':(exclude)node_modules' | git -C "${root}" apply`]);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "branch edit\n");
	assert.equal(readFileSync(join(root, "branch-new.txt"), "utf8"), "hello\n");
	removeWorktree(w);
});

test(".gitignore 寫 node_modules(沒有斜線,連結也會被擋):列改動不會出錯", () => {
	const root = repo("node_modules\n");
	const w = createWorktree(root, "proj1", "b5");
	writeFileSync(join(w.path, "branch-new.txt"), "hello\n");
	assert.deepEqual(worktreeChanges(w).files, ["branch-new.txt"]);
	removeWorktree(w);
});

test("移除 worktree:改動先提交到支線分支,分支保留,主線的 node_modules 還在", () => {
	const root = repo();
	const w = createWorktree(root, "proj1", "b3");
	writeFileSync(join(w.path, "a.txt"), "branch edit\n");
	removeWorktree(w);
	assert.ok(!existsSync(w.path));
	assert.equal(git(root, "show", `${w.gitBranch}:a.txt`), "branch edit");
	assert.ok(existsSync(join(root, "node_modules", "pkg", "index.js")));
});

test("worktree 的窗格算回原專案,不會被登記成新專案", () => {
	const root = repo();
	const store = new Store(join(DATA, "state-test.json"));
	const p = store.addProject({ root, name: "demo", kind: "project", status: "active", private: false });
	const w = createWorktree(root, p.id, "b4");
	store.addBranch({ id: "b4", projectId: p.id, n: 1, agent: "claude", mode: "fork", label: "x", mainLabel: "x", mainPaneId: "w:p1", paneId: "w:p2", worktree: { ...w } });
	const before = store.projects().length;
	assert.equal(resolveProject(store, w.cwd).id, p.id);
	assert.equal(resolveProject(store, join(w.path, "sub")).id, p.id);
	assert.equal(ownerOf(store, w.cwd)?.id, p.id);
	assert.equal(store.projects().length, before);
	removeWorktree(w);
});
