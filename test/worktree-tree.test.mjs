// 分支樹狀圖資料:worktree / agent 留下的分支歸到哪個資料夾、分岔圖的分岔點與合併點
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = mkdtempSync(join(tmpdir(), "steward-data-"));
process.env.STEWARD_DATA_DIR = DATA;
const { worktreeTree } = await import("../src/worktree-tree.ts");
const { claudeSlug } = await import("../src/worktrees.ts");
const { Store } = await import("../src/store.ts");

const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const commitFile = (cwd, file, text, msg) => {
	mkdirSync(join(cwd, file, ".."), { recursive: true });
	writeFileSync(join(cwd, file), text);
	git(cwd, "add", "-A");
	git(cwd, "commit", "-qm", msg);
};

test("資料夾樹與分岔圖:已合併 / 沒合併 / worktree 已移除 / 歸不到資料夾", async () => {
	const root = tmp("course-");
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "t@t");
	git(root, "config", "user.name", "t");
	for (const d of ["hw1", "hw2", "hw3"]) mkdirSync(join(root, d));
	writeFileSync(join(root, ".gitignore"), ".claude/worktrees/\n");
	commitFile(root, "hw1/a.tex", "1\n", "c1");
	commitFile(root, "hw2/b.tex", "1\n", "c2");
	const store = new Store(join(tmp("st-"), "state.json"));
	const hw1 = store.addProject({ root: join(root, "hw1"), name: "hw1", kind: "project", status: "active", private: false });
	store.addProject({ root: join(root, "hw2"), name: "hw2", kind: "project", status: "active", private: false });
	const projects = tmp("claude-projects-");
	const claudeWt = (name, from) => {
		const path = join(root, ".claude", "worktrees", name);
		git(root, "worktree", "add", "-q", "-b", `worktree-${name}`, path, "HEAD");
		const dir = join(projects, claudeSlug(path));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `s-${name}.jsonl`), JSON.stringify({ type: "worktree-state", worktreeSession: { worktreePath: path, originalCwd: from, sessionId: `s-${name}` } }) + "\n");
		return path;
	};

	// 1. 從 hw1 開、改 hw1、合併回主線、再移除 worktree → 留下的分支,已合併
	const m = claudeWt("merged", join(root, "hw1"));
	commitFile(m, "hw1/a.tex", "2\n", "m1");
	commitFile(m, "hw1/a.tex", "3\n", "m2");
	git(root, "merge", "-q", "--no-ff", "--no-edit", "worktree-merged");
	git(root, "worktree", "remove", "--force", m);
	commitFile(root, "hw2/b.tex", "2\n", "c3");
	// 2. 從 hw2 開、還沒合併、worktree 還在
	const o = claudeWt("open", join(root, "hw2"));
	commitFile(o, "hw2/b.tex", "x\n", "o1");
	// 3. 手動 worktree,只改 repo 根目錄的檔案 → 歸到「其他」
	const man = join(tmp("man-"), "w");
	git(root, "worktree", "add", "-q", "-b", "manual", man, "HEAD");
	commitFile(man, "README.md", "r\n", "readme");
	// 4. 手動開、改 hw3(沒登記的資料夾)→ 資料夾樹多一個 hw3
	const man3 = join(tmp("man3-"), "w");
	git(root, "worktree", "add", "-q", "-b", "manual3", man3, "HEAD");
	commitFile(man3, "hw3/c.tex", "c\n", "hw3");
	commitFile(root, "hw1/a.tex", "4\n", "c4");

	const t = await worktreeTree(store, hw1, { panes: [], claudeProjectsDir: projects, stewardWorktreesDir: join(DATA, "worktrees") });
	assert.equal(t.repo, true);
	assert.equal(t.currentFolder, "hw1");
	assert.deepEqual(t.folders.map((f) => [f.path, f.current, !!f.projectId]), [["hw1", true, true], ["hw2", false, true], ["hw3", false, false]]);
	const by = (b) => t.items.find((x) => x.branch === b);
	assert.equal(by("main").folder, "");
	assert.equal(by("worktree-open").folder, "hw2"); // 從 hw2 開的
	assert.equal(by("manual").folder, ""); // 只改了根目錄 → 其他
	assert.equal(by("manual3").folder, "hw3"); // 主要改 hw3(沒登記也列出來)

	assert.equal(t.leftovers.length, 1);
	const left = t.leftovers[0];
	assert.equal(left.branch, "worktree-merged");
	assert.equal(left.merged, true);
	assert.equal(left.folder, "hw1");
	assert.equal(left.ahead, 2);
	assert.equal(left.session.id, "s-merged");

	// 分岔圖:主線 c1 c2 merge c3 c4;merged 從 c2 分出、在合併點合回;open/manual/manual3 從 c3 分出、沒合併
	const g = t.graph;
	const subj = g.nodes.map((n) => n.subject);
	assert.deepEqual(subj, ["c2", "Merge branch 'worktree-merged'", "c3", "c4"]);
	assert.deepEqual(g.nodes.map((n) => n.gapBefore), [1, 0, 0, 0]);
	const gb = (k) => g.branches.find((x) => x.branch === k);
	assert.deepEqual([gb("worktree-merged").forkAt, gb("worktree-merged").mergedAt, gb("worktree-merged").ahead], [0, 1, 2]);
	assert.deepEqual([gb("worktree-open").forkAt, gb("worktree-open").mergedAt, gb("worktree-open").ahead], [2, undefined, 1]);
	assert.equal(gb("manual").forkAt, 2);
	assert.equal(gb("worktree-merged").key, "branch:worktree-merged");
	assert.equal(gb("worktree-open").key, by("worktree-open").id);
});

test("不是 git 的專案回 repo:false", async () => {
	const store = new Store(join(tmp("st-"), "state.json"));
	const p = store.addProject({ root: tmp("plain-"), name: "p", kind: "project", status: "active", private: false });
	assert.deepEqual(await worktreeTree(store, p, {}), { repo: false });
});
