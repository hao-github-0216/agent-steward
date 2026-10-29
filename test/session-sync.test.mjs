// 把 Claude 窗格的對話 ID 補報給 herdr:herdr 重開時才接得回原本的對話
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeSessionSync } from "../src/session-sync.ts";

function setup(found) {
	let t = 1_000_000;
	const calls = [];
	const sync = new ClaudeSessionSync({
		resolve: (p) => found[p.pane_id],
		report: (p, id, replacing) => (calls.push(replacing ? [p.pane_id, id, "replace"] : [p.pane_id, id]), true),
		now: () => t,
	});
	return { sync, calls, tick: (ms) => (t += ms) };
}

test("沒有 ID 的 Claude 窗格:找到就回報;其他 agent 不碰", () => {
	const { sync, calls } = setup({ "w1:p1": "aaa", "w1:p2": "bbb" });
	sync.sync([
		{ pane_id: "w1:p1", agent: "claude", agent_session: null },
		{ pane_id: "w1:p2", agent: "pi", agent_session: null },
		{ pane_id: "w1:p3" },
	]);
	assert.deepEqual(calls, [["w1:p1", "aaa"]]);
});

test("對不出唯一的對話(例如重開後同資料夾好幾個 Claude 同時啟動)就不回報", () => {
	const { sync, calls } = setup({});
	sync.sync([
		{ pane_id: "w1:p1", agent: "claude", agent_session: { agent: "claude", kind: "id", value: "old1" } },
		{ pane_id: "w1:p2", agent: "claude", agent_session: { agent: "claude", kind: "id", value: "old2" } },
		{ pane_id: "w1:p3", agent: "claude", agent_session: null },
	]);
	assert.deepEqual(calls, []);
});

test("已經有 ID:90 秒才對一次,換了對話才更新", () => {
	const found = { "w1:p1": "aaa" };
	const { sync, calls, tick } = setup(found);
	const pane = { pane_id: "w1:p1", agent: "claude", agent_session: { agent: "claude", kind: "id", value: "aaa" } };
	sync.sync([pane]);
	assert.deepEqual(calls, []); // 一樣,不用報
	found["w1:p1"] = "bbb"; // 使用者 /clear 換了對話
	tick(30_000);
	sync.sync([pane]);
	assert.deepEqual(calls, []); // 還沒到重新檢查的時間
	tick(61_000);
	sync.sync([pane]);
	assert.deepEqual(calls, [["w1:p1", "bbb", "replace"]]); // 換 ID 要讓 herdr 知道是換對話
});

test("還沒有 ID 的窗格每輪都找", () => {
	const found = {};
	const { sync, calls, tick } = setup(found);
	const pane = { pane_id: "w1:p1", agent: "claude", agent_session: null };
	sync.sync([pane]);
	found["w1:p1"] = "ccc"; // 背景程式剛起來
	tick(10_000);
	sync.sync([pane]);
	assert.deepEqual(calls, [["w1:p1", "ccc"]]);
});

test("pickClaudeSession:attach 用 ID 開頭對;時間比對不拿別的窗格的前台 claude", async () => {
	const { pickClaudeSession } = await import("../src/transcripts.ts");
	const sessions = [
		{ file: "100.json", pid: 100, sessionId: "3180667e-aaaa", cwd: "/p", startedAt: 1000, kind: "bg" },
		{ file: "200.json", pid: 200, sessionId: "eb3835a2-bbbb", cwd: "/p", startedAt: 50_000, kind: "interactive" },
	];
	// 自己的 pid 檔
	assert.equal(pickClaudeSession({ pid: 200, argv: ["claude", "--resume", "eb3835a2-bbbb"] }, 50_000, "/p", sessions), "eb3835a2-bbbb");
	// 重開後對話已經在背景跑:claude attach <ID 開頭>,同一時間隔壁窗格剛起一個前台 claude
	assert.equal(pickClaudeSession({ pid: 300, argv: ["claude", "attach", "3180667e"] }, 50_500, "/p", sessions), "3180667e-aaaa");
	// 沒有 attach、沒有自己的檔:只跟背景程式比時間,前台的不算
	assert.equal(pickClaudeSession({ pid: 300, argv: ["claude"] }, 50_500, "/p", sessions), undefined);
	assert.equal(pickClaudeSession({ pid: 300, argv: ["claude"] }, 1_500, "/p", sessions), "3180667e-aaaa");
	// 預先開好的備用背景程式(spare)還沒接對話,不算
	const spare = [{ file: "400.json", pid: 400, sessionId: "2ffbf1fa", cwd: "/h", startedAt: 9_000, kind: "bg", spare: true }];
	assert.equal(pickClaudeSession({ pid: 500, argv: ["claude"] }, 9_200, "/h", spare), undefined);
});
