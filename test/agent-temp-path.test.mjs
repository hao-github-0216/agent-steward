// Claude Code 的暫存資料夾歸雜務,一般暫存資料夾仍可建議登記
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const DATA = mkdtempSync(join(tmpdir(), "agent-temp-data-"));
process.env.STEWARD_DATA_DIR = DATA;
after(() => rmSync(DATA, { recursive: true, force: true }));
const { resolveProject } = await import("../src/projects.ts");
const { Store } = await import("../src/store.ts");
const { isAgentTempPath } = await import("../src/config.ts");

const agentBase = join(realpathSync(tmpdir()), `claude-999999${process.pid}`);
mkdirSync(agentBase);
after(() => rmSync(agentBase, { recursive: true, force: true }));

test("isAgentTempPath 只認 Claude Code 的暫存區", () => {
	for (const p of [
		"/private/tmp/claude-501/x/y/scratchpad/pitest",
		"/tmp/claude-1000/a",
		"/private/tmp/claude-501",
		join(homedir(), ".claude/jobs/abc/tmp/demo"),
		join(homedir(), ".claude/jobs/abc/tmp"),
		join(tmpdir(), "claude-999999", "demo"),
		agentBase,
	]) assert.equal(isAgentTempPath(p), true, p);
	for (const p of [
		join(homedir(), ".claude/jobs/abc/other"),
		"/tmp/myproj",
		"/private/tmp/claudette/x",
		"/tmp/claude-501-extra/x",
		join(tmpdir(), "myproj", "claude-501"),
		join(homedir(), "code/claude-501"),
	]) assert.equal(isAgentTempPath(p), false, p);
});

test("Claude 暫存區的非 git 資料夾歸雜務,不建立 pending", () => {
	const cwd = mkdtempSync(join(agentBase, "plain-"));
	const store = new Store(join(DATA, "plain-state.json"));
	assert.equal(resolveProject(store, cwd).kind, "misc");
	assert.equal(store.projectByRoot(cwd), undefined);
	assert.equal(store.projects().filter((p) => p.kind === "project").length, 0);
});

test("Claude 暫存區的 git repo 歸雜務,不自動登記", () => {
	const cwd = mkdtempSync(join(agentBase, "repo-"));
	execFileSync("git", ["-C", cwd, "init", "-q"], { encoding: "utf8" });
	const store = new Store(join(DATA, "repo-state.json"));
	assert.equal(resolveProject(store, cwd).kind, "misc");
	assert.equal(store.projectByRoot(cwd), undefined);
	assert.equal(store.projects().filter((p) => p.kind === "project").length, 0);
});

test("一般暫存目錄的非 git 資料夾仍建立 pending", (t) => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agent-temp-control-")));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const store = new Store(join(DATA, "control-state.json"));
	assert.equal(isAgentTempPath(cwd), false);
	assert.equal(resolveProject(store, cwd).kind, "misc");
	assert.equal(store.projectByRoot(cwd)?.status, "pending");
	assert.equal(store.projects().filter((p) => p.kind === "project").length, 1);
});
