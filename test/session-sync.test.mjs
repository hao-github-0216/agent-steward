// 把 Claude 窗格的對話 ID 補報給 herdr:herdr 重開時才接得回原本的對話
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeSessionSync } from "../src/session-sync.ts";

function setup(found) {
	let t = 1_000_000;
	const calls = [];
	const sync = new ClaudeSessionSync({
		resolve: (p) => found[p.pane_id],
		report: (p, id) => (calls.push([p.pane_id, id]), true),
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
	assert.deepEqual(calls, [["w1:p1", "bbb"]]);
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
