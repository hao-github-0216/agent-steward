// 專案的「分支」總覽:三種來源、session 對應、兄弟專案只算自己資料夾、.gitignore 防呆、合併與移除的安全檢查
// 先隔離使用者的 git 設定,要在載入 src 之前
import "./helpers/git-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = process.platform === "win32" ? realpathSync.native(mkdtempSync(join(tmpdir(), "steward-data-"))) : mkdtempSync(join(tmpdir(), "steward-data-"));
process.env.STEWARD_DATA_DIR = DATA;
const W = await import("../src/worktrees.ts");
const { Store } = await import("../src/store.ts");
const { resolveProject, ownerOf } = await import("../src/projects.ts");

const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), p)));

/** repo 根目錄底下兩個兄弟專案資料夾 A、B(像 course/hw1、course/hw2) */
function repo() {
	const root = tmp("wt-repo-");
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "t@t");
	git(root, "config", "user.name", "t");
	for (const d of ["A", "B"]) {
		mkdirSync(join(root, d));
		writeFileSync(join(root, d, "doc.tex"), `${d} v1\n`);
	}
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "init");
	return root;
}
function newStore() {
	return new Store(join(tmp("wt-store-"), "state.json"));
}
/** 模擬 Claude Code 的 EnterWorktree:在 .claude/worktrees/<name> 開 worktree-<name> 分支,並寫一份紀錄檔 */
function claudeWorktree(root, name, projectsDir, sessionId, originalCwd) {
	const path = join(root, ".claude", "worktrees", name);
	git(root, "worktree", "add", "-q", "-b", `worktree-${name}`, path, "HEAD");
	if (projectsDir) {
		const dir = join(projectsDir, W.claudeSlug(path));
		mkdirSync(dir, { recursive: true });
		const lines = [
			{ type: "user", sessionId, message: { role: "user", content: "hi" } },
			{ type: "worktree-state", sessionId, worktreeSession: { originalCwd, worktreePath: path, worktreeName: name, worktreeBranch: `worktree-${name}`, sessionId } },
		];
		writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	}
	return path;
}

test("parsePorcelain 讀得出分支、detached、locked、prunable", () => {
	const out = [
		"worktree /r", "HEAD aaa", "branch refs/heads/main", "",
		"worktree /r/.claude/worktrees/x", "HEAD bbb", "branch refs/heads/worktree-x", "locked claude session x (pid 1)", "",
		"worktree /gone", "HEAD ccc", "detached", "prunable gitdir file points to non-existent location", "",
	].join("\n");
	const r = W.parsePorcelain(out);
	assert.equal(r.length, 3);
	assert.deepEqual([r[0].branch, r[1].branch, r[2].branch], ["main", "worktree-x", null]);
	assert.equal(r[1].locked, "claude session x (pid 1)");
	assert.match(r[2].prunable, /non-existent/);
});

test("三種來源都列出;Claude Code 的對回紀錄檔與窗格;兄弟專案只算改到自己資料夾的", async () => {
	const root = repo();
	const projects = tmp("wt-claude-projects-");
	const stewardDir = join(DATA, "worktrees");
	const store = newStore();
	const A = store.addProject({ root: join(root, "A"), name: "A", kind: "project", status: "active", private: false });
	const B = store.addProject({ root: join(root, "B"), name: "B", kind: "project", status: "active", private: false });

	// Claude Code:從 A 開,改了 A/doc.tex 並 commit
	const cw = claudeWorktree(root, "a-variant", projects, "sess-1111", join(root, "A"));
	writeFileSync(join(cw, "A", "doc.tex"), "A v2\n");
	git(cw, "commit", "-qam", "A v2");
	// 管家支線(放在 DATA_DIR/worktrees 底下)
	const sw = join(stewardDir, A.id, "b1");
	mkdirSync(join(stewardDir, A.id), { recursive: true });
	git(root, "worktree", "add", "-q", "-b", "steward/branch-b1", sw, "HEAD");
	// 手動開在 repo 外面,改了 B
	const mw = join(tmp("wt-manual-"), "m");
	git(root, "worktree", "add", "-q", "-b", "manual-b", mw, "HEAD");
	writeFileSync(join(mw, "B", "new.txt"), "x\n");

	const panes = [
		{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "claude", cwd: join(root, "A"), agent_session: { agent: "claude", kind: "id", value: "sess-1111" } },
		{ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", agent: "pi", cwd: join(mw, "B"), agent_session: { agent: "pi", kind: "path", value: "/s/pi.jsonl" } },
	];
	const deps = { panes, claudeProjectsDir: projects, stewardWorktreesDir: stewardDir };
	const la = await W.listWorktrees(store, A, deps);
	assert.equal(la.repo, true);
	assert.equal(la.repoRoot, root);
	assert.equal(la.prefix, "A");
	assert.equal(la.target, "main");
	const by = (l, src) => l.items.find((x) => x.source === src);
	assert.equal(la.items[0].source, "main");
	assert.equal(la.items.length, 4);

	const c = by(la, "claude");
	assert.equal(c.branch, "worktree-a-variant");
	assert.equal(c.ahead, 1);
	assert.equal(c.changed, 1);
	assert.equal(c.relevant, true);
	assert.equal(c.cwd, join(cw, "A"));
	assert.equal(c.session.via, "claude-transcript");
	assert.equal(c.session.id, "sess-1111");
	assert.equal(c.session.alive, true);
	assert.equal(c.session.pane.paneId, "w1:p1"); // 窗格的資料夾還是 A,但靠 session ID 對得到
	assert.deepEqual(W.chatPlan(c), { kind: "focus", paneId: "w1:p1", agent: "claude", cwd: join(cw, "A") });

	const s = by(la, "steward");
	assert.equal(s.branch, "steward/branch-b1");
	assert.equal(s.relevant, false); // 沒有支線紀錄、也沒改東西

	const m = by(la, "manual");
	assert.equal(m.session.via, "pane-cwd");
	assert.equal(m.session.agent, "pi");
	assert.equal(m.dirty, 1);
	assert.equal(m.relevant, false); // 改的是 B,不算 A 的

	// 從 B 看:Claude 那條不算(改的是 A、從 A 開的),手動那條算(改到 B)
	const lb = await W.listWorktrees(store, B, deps);
	assert.equal(by(lb, "claude").relevant, false);
	assert.equal(by(lb, "manual").relevant, true);
	assert.equal(by(lb, "manual").changed, 1);

	const counts = await W.worktreeCounts(store, [A, B], deps);
	assert.deepEqual(counts, { [A.id]: 1, [B.id]: 1 });

	// 窗格關了:Claude 接回 session(從 worktree 根目錄開);pi 用紀錄檔;都沒有就開新的
	const closed = await W.listWorktrees(store, A, { ...deps, panes: [] });
	assert.deepEqual(W.chatPlan(by(closed, "claude")), { kind: "resume", agent: "claude", cwd: cw, args: ["--resume", "sess-1111"] });
	assert.equal(W.chatPlan(by(closed, "manual")).kind, "new");
	assert.deepEqual(W.resumeArgs("pi", "/s/pi.jsonl", "/x"), ["--session", "/s/pi.jsonl"]);
	assert.deepEqual(W.resumeArgs("codex", "abc", "/x"), ["resume", "-C", "/x", "abc"]);
});

test("worktree 放在 repo 裡沒被排除 → 警告;誤 commit 成子專案 → 抓得到,也能從版本控制拿掉", async () => {
	const root = repo();
	const store = newStore();
	const A = store.addProject({ root: join(root, "A"), name: "A", kind: "project", status: "active", private: false });
	claudeWorktree(root, "x", undefined);
	let l = await W.listWorktrees(store, A, {});
	assert.deepEqual(l.warnings.unignored.map((x) => x.pattern), [".claude/worktrees/"]);
	assert.deepEqual(l.warnings.gitlinks, []);

	// 使用者「全部加入」→ worktree 被當成子專案 commit 進去
	git(root, "-c", "advice.addEmbeddedRepo=false", "add", "-A");
	git(root, "commit", "-qm", "oops");
	l = await W.listWorktrees(store, A, {});
	assert.deepEqual(l.warnings.gitlinks, [".claude/worktrees/x"]);

	const r = await W.untrackGitlinks(store, A, {});
	assert.deepEqual(r.untracked, [".claude/worktrees/x"]);
	assert.deepEqual(r.ignoreAdded, [".claude/worktrees/"]);
	assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^\.claude\/worktrees\/$/m);
	// 放進暫存區、還沒 commit;worktree 資料夾本身還在
	assert.match(git(root, "status", "--porcelain"), /^D  \.claude\/worktrees\/x$/m);
	assert.match(git(root, "status", "--porcelain"), /^A  \.gitignore$/m);
	assert.ok(existsSync(join(root, ".claude", "worktrees", "x", "A", "doc.tex")));
	git(root, "commit", "-qm", "fix");
	l = await W.listWorktrees(store, A, {});
	assert.deepEqual(l.warnings, { unignored: [], gitlinks: [] });
	// 再加一次不會重複寫
	assert.deepEqual((await W.ignoreWorktrees(store, A, {})).added, []);
});

test("合併:主資料夾有沒 commit 的改動就擋;成功用 --no-ff;衝突會取消、主資料夾不變", async () => {
	const root = repo();
	const store = newStore();
	const A = store.addProject({ root: join(root, "A"), name: "A", kind: "project", status: "active", private: false });
	writeFileSync(join(root, ".gitignore"), ".claude/worktrees/\n");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "ignore");
	const cw = claudeWorktree(root, "m", undefined);
	writeFileSync(join(cw, "A", "doc.tex"), "A from branch\n");
	git(cw, "commit", "-qam", "branch change");
	const id = W.worktreeId(cw);

	const pv = await W.mergePreview(store, A, id, {});
	assert.equal(pv.target, "main");
	assert.equal(pv.branch, "worktree-m");
	assert.deepEqual(pv.files, [{ status: "M", path: "A/doc.tex" }]);
	assert.equal(pv.commits.length, 1);
	assert.equal(pv.blocker, undefined);

	// 主資料夾改了追蹤中的檔案 → 擋
	writeFileSync(join(root, "B", "doc.tex"), "dirty\n");
	await assert.rejects(W.mergeWorktree(store, A, id, {}), (e) => e.code === "main-dirty" && e.status === 409);
	git(root, "checkout", "--", "B/doc.tex");
	// 沒追蹤的新檔不擋
	writeFileSync(join(root, "untracked.txt"), "u\n");

	const r = await W.mergeWorktree(store, A, id, {});
	assert.equal(r.merged, true);
	assert.equal(readFileSync(join(root, "A", "doc.tex"), "utf8"), "A from branch\n");
	assert.equal(git(root, "rev-list", "--parents", "-n1", "HEAD").split(" ").length, 3); // 合併 commit 有兩個 parent
	await assert.rejects(W.mergeWorktree(store, A, id, {}), (e) => e.code === "nothing");

	// 衝突
	writeFileSync(join(cw, "A", "doc.tex"), "branch again\n");
	git(cw, "commit", "-qam", "branch again");
	writeFileSync(join(root, "A", "doc.tex"), "main again\n");
	git(root, "commit", "-qam", "main again");
	const before = git(root, "rev-parse", "HEAD");
	await assert.rejects(W.mergeWorktree(store, A, id, {}), (e) => e.code === "conflict" && e.detail.conflicts[0] === "A/doc.tex");
	assert.equal(git(root, "rev-parse", "HEAD"), before);
	assert.equal(readFileSync(join(root, "A", "doc.tex"), "utf8"), "main again\n");
	assert.equal(git(root, "status", "--porcelain", "--untracked-files=no"), "");
});

test("移除:窗格開著、被鎖住、有沒 commit 的改動都要先確認;確認後改動存進分支、分支保留", async () => {
	const root = repo();
	const store = newStore();
	const A = store.addProject({ root: join(root, "A"), name: "A", kind: "project", status: "active", private: false });
	const projects = tmp("wt-claude-projects-");
	const cw = claudeWorktree(root, "r", projects, "sess-r", join(root, "A"));
	git(root, "worktree", "lock", "--reason", "claude session r", cw);
	writeFileSync(join(cw, "A", "wip.txt"), "wip\n");
	const id = W.worktreeId(cw);
	const panes = [{ pane_id: "w1:p9", tab_id: "w1:t9", workspace_id: "w1", agent: "claude", cwd: join(root, "A"), agent_session: { agent: "claude", value: "sess-r" } }];
	const deps = { panes, claudeProjectsDir: projects };

	await assert.rejects(W.removeWorktreeItem(store, A, id, {}, deps), (e) => e.code === "alive");
	await assert.rejects(W.removeWorktreeItem(store, A, id, { alive: true }, deps), (e) => e.code === "locked");
	await assert.rejects(W.removeWorktreeItem(store, A, id, { alive: true, locked: true }, deps), (e) => e.code === "dirty");
	const r = await W.removeWorktreeItem(store, A, id, { alive: true, locked: true, dirty: true }, deps);
	assert.equal(r.branch, "worktree-r");
	assert.equal(existsSync(cw), false);
	assert.equal(git(root, "show", "worktree-r:A/wip.txt"), "wip"); // 改動在分支上
	await assert.rejects(W.removeWorktreeItem(store, A, id, {}, deps), (e) => e.status === 404);
	await assert.rejects(W.removeWorktreeItem(store, A, W.worktreeId(root), {}, deps), /主資料夾不能移除/);
});

test("worktree 裡的 agent 算回原本的專案,不會被當成新專案登記", () => {
	const root = repo();
	const store = newStore();
	const A = store.addProject({ root: join(root, "A"), name: "A", kind: "project", status: "active", private: false });
	const cw = claudeWorktree(root, "own", undefined);
	assert.equal(resolveProject(store, join(cw, "A")).id, A.id);
	assert.equal(ownerOf(store, join(cw, "A"))?.id, A.id);
	assert.equal(store.projects().filter((p) => p.root.includes(".claude")).length, 0);
});

test("worktree 已經移除、只剩誤 commit 的子專案:拿掉時照樣把 .claude/worktrees/ 加進 .gitignore", async () => {
	const root = repo();
	const store = newStore();
	const A = store.addProject({ root: join(root, "A"), name: "A", kind: "project", status: "active", private: false });
	const cw = claudeWorktree(root, "gone", undefined);
	git(root, "-c", "advice.addEmbeddedRepo=false", "add", "-A");
	git(root, "commit", "-qm", "oops");
	git(root, "worktree", "remove", "--force", cw);
	const l = await W.listWorktrees(store, A, {});
	assert.deepEqual(l.warnings, { unignored: [], gitlinks: [".claude/worktrees/gone"] });
	const r = await W.untrackGitlinks(store, A, {});
	assert.deepEqual(r.ignoreAdded, [".claude/worktrees/"]);
	assert.match(git(root, "status", "--porcelain"), /^A  \.gitignore$/m);
});

test("紀錄檔只讀新增的部分:後來才進 worktree、中文路徑都對得到", () => {
	const projects = tmp("wt-claude-projects-");
	const wt = join(tmp("wt-中文-"), "樹");
	const dir = join(projects, W.claudeSlug(wt));
	mkdirSync(dir, { recursive: true });
	const f = join(dir, "s1.jsonl");
	writeFileSync(f, JSON.stringify({ type: "user", message: { content: "前面的對話".repeat(1000) } }) + "\n");
	assert.equal(W.claudeSessionOfWorktree(wt, projects), undefined);
	appendFileSync(f, JSON.stringify({ type: "worktree-state", sessionId: "s1", worktreeSession: { worktreePath: wt, sessionId: "s1" } }) + "\n");
	assert.equal(W.claudeSessionOfWorktree(wt, projects)?.sessionId, "s1");
});

test("移除時有沒 commit 的改動:回檔案清單與建議;已合併建議捨棄,捨棄不會讓分支多 commit", async () => {
	const root = repo();
	const store = newStore();
	const A = store.addProject({ root: join(root, "A"), name: "A", kind: "project", status: "active", private: false });
	writeFileSync(join(root, ".gitignore"), ".claude/worktrees/\n");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "ignore");
	// 沒合併:建議存進分支
	const a = claudeWorktree(root, "a", undefined);
	writeFileSync(join(a, "A", "doc.tex"), "work\n");
	git(a, "commit", "-qam", "work");
	writeFileSync(join(a, "A", "doc.aux"), "tmp\n");
	await assert.rejects(W.removeWorktreeItem(store, A, W.worktreeId(a), {}, {}), (e) => e.code === "dirty" && e.detail.merged === false && e.detail.suggest === "commit" && e.detail.files[0] === "A/doc.aux");
	// 合併後:建議捨棄;捨棄 → 分支頂端不變、還是已合併
	git(root, "merge", "-q", "--no-ff", "--no-edit", "worktree-a");
	const tip = git(root, "rev-parse", "worktree-a");
	await assert.rejects(W.removeWorktreeItem(store, A, W.worktreeId(a), {}, {}), (e) => e.code === "dirty" && e.detail.merged === true && e.detail.suggest === "discard");
	await W.removeWorktreeItem(store, A, W.worktreeId(a), { dirty: "discard" }, {});
	assert.equal(existsSync(a), false);
	assert.equal(git(root, "rev-parse", "worktree-a"), tip);
});
