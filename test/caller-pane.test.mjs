// 在 agent 窗格裡跑 steward 指令時,認出真的是從哪個窗格來的(窗格搬過 space 後 HERDR_PANE_ID 會過期)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "caller-"));
process.env.STEWARD_DATA_DIR = join(dir, "data");
const { Store } = await import("../src/store.ts");
const { callerPane } = await import("../src/branch.ts");

const steward = join(dir, "agent-steward");
const other = join(dir, "other");
for (const d of [steward, other, join(steward, "src")]) mkdirSync(d, { recursive: true });
const store = new Store(join(dir, "state.json"));
store.addProject({ root: steward, name: "agent-steward", kind: "project", status: "active", private: false });
store.addProject({ root: other, name: "other", kind: "project", status: "active", private: false });
const panes = [
	// 被搬到 agent-steward space 的窗格:現在是 w16:p1,裡面的程式還記著舊的 wA:p3C
	{ pane_id: "w16:p1", workspace_id: "w16", tab_id: "w16:t1", cwd: steward, foreground_cwd: steward, agent: "claude", agent_session: { agent: "claude", kind: "id", value: "sess-mine" } },
	// 舊 ID 現在是別人的窗格(別的專案)
	{ pane_id: "wA:p3C", workspace_id: "wA", tab_id: "wA:t2", cwd: other, foreground_cwd: other, agent: "claude", agent_session: { agent: "claude", kind: "id", value: "sess-other" } },
];

test("Claude:用 session 認出真的窗格,不管環境變數指到哪", () => {
	assert.equal(callerPane(store, { pane: "wA:p3C", session: "sess-mine", cwd: steward }, panes)?.pane_id, "w16:p1");
});

test("環境變數指到別的專案的窗格(過期了):不採用", () => {
	assert.equal(callerPane(store, { pane: "wA:p3C", cwd: steward }, panes), undefined);
});

test("環境變數指到同一個專案的窗格:照用(在子資料夾跑也算)", () => {
	assert.equal(callerPane(store, { pane: "w16:p1", cwd: join(steward, "src") }, panes)?.pane_id, "w16:p1");
});

test("沒給資料夾:照環境變數(舊的行為);找不到窗格回 undefined", () => {
	assert.equal(callerPane(store, { pane: "wA:p3C" }, panes)?.pane_id, "wA:p3C");
	assert.equal(callerPane(store, { pane: "w9:p9", cwd: steward }, panes), undefined);
});
