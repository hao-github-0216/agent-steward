// 工作卡追問:送給同一個 agent、進行中先排隊、窗格關掉就開新的 agent、agent 回答完把回覆收進卡片
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "followup-"));
process.env.STEWARD_DATA_DIR = join(dir, "data");
const stateFile = join(dir, "herdr-state.json");
const callsFile = join(dir, "calls.log");
const root = join(dir, "proj");

// 假 herdr:窗格清單放在檔案裡(測試可以改),每個指令都記下來
const bin = join(dir, "herdr");
writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n");
const save = () => fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(st));
const out = (o) => process.stdout.write(JSON.stringify(o));
const [a, b] = args;
if (a === "pane" && b === "list") out({ result: { panes: st.panes } });
else if (a === "workspace" && b === "list") out({ result: { workspaces: [{ workspace_id: "w1", label: "demo" }] } });
else if (a === "agent" && b === "prompt") out(st.failPrompt ? { error: { message: "boom" } } : {});
else if (a === "tab" && b === "create") {
  const p = { pane_id: "w1:p9", terminal_id: "t9", tab_id: "w1:t9", workspace_id: "w1", cwd: ${JSON.stringify(root)} };
  st.panes.push(p); save();
  out({ result: { root_pane: { pane_id: p.pane_id, terminal_id: p.terminal_id } } });
} else if (a === "agent" && b === "start") {
  const pane = st.panes.find((x) => x.pane_id === args[args.indexOf("--pane") + 1]);
  if (pane) { pane.agent = args[args.indexOf("--kind") + 1]; pane.agent_status = "idle"; save(); }
  out({});
} else out({});
`);
chmodSync(bin, 0o755);
process.env.HERDR_BIN_PATH = bin;

const { Store } = await import("../src/store.ts");
const { askCard, cancelQuestion, collectReplies, deliverFollowUps, finalReply, retryQuestion } = await import("../src/followup.ts");
const { listPanes } = await import("../src/herdr.ts");

// Claude Code 的紀錄格式
const T = (ms) => new Date(ms).toISOString();
const userLine = (text, ms) => JSON.stringify({ type: "user", timestamp: T(ms), message: { role: "user", content: text } });
const sayLine = (text, ms) => JSON.stringify({ type: "assistant", timestamp: T(ms), message: { role: "assistant", content: [{ type: "text", text }] } });
const toolLine = (ms) => JSON.stringify({ type: "assistant", timestamp: T(ms), message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "a.txt" } }] } });
const resultLine = (ms) => JSON.stringify({ type: "user", timestamp: T(ms), message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });

function setup(name, card) {
	const transcript = join(dir, `${name}.jsonl`);
	const t0 = Date.now() - 3_600_000;
	writeFileSync(transcript, [userLine("【專案管家派工 #c1】改 a.txt", t0), sayLine("我先讀檔案", t0 + 1000), toolLine(t0 + 2000), resultLine(t0 + 3000), sayLine("已經把 a.txt 改好了。", t0 + 4000)].join("\n") + "\n");
	const panes = [{ pane_id: "w1:p1", terminal_id: "t1", tab_id: "w1:t1", workspace_id: "w1", cwd: root, agent: "claude", agent_status: "idle", agent_session: { agent: "claude", kind: "path", value: transcript } }];
	writeFileSync(stateFile, JSON.stringify({ panes }));
	writeFileSync(callsFile, "");
	const store = new Store(join(dir, `${name}-state.json`));
	const p = store.addProject({ root, name: "demo", kind: "project", status: "active", private: false, spaceId: "w1", spaceLabel: "demo" });
	const c = store.addCard({ projectId: p.id, title: "改 a.txt", agent: "claude", instructions: "把 a.txt 的錯字改掉", doneCriteria: "改好並說明", column: "done", note: "已改好錯字", paneId: "w1:p1", terminalId: "t1", ...card });
	return { store, card: c, transcript };
}
const calls = () => readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const prompts = () => calls().filter((a) => a[0] === "agent" && a[1] === "prompt");

test("完成的卡:問題送給同一個 agent,卡片回到進行中,對話最上面記下原本的結果", () => {
	const { store, card } = setup("same", {});
	askCard(store, card.id, "為什麼要這樣改?");
	const sent = [];
	deliverFollowUps(store, listPanes(), { onSent: (c, paneId) => sent.push([c.id, paneId]) });
	const ps = prompts();
	assert.equal(ps.length, 1);
	assert.equal(ps[0][2], "w1:p1");
	assert.match(ps[0][3], new RegExp(`【專案管家追問 #${card.id}】`));
	assert.match(ps[0][3], /為什麼要這樣改\?/);
	const c = store.card(card.id);
	assert.equal(c.column, "running");
	assert.deepEqual(sent, [[card.id, "w1:p1"]]);
	assert.equal(c.thread[0].original, true);
	assert.equal(c.thread[0].text, "已經把 a.txt 改好了。");
	assert.equal(c.thread[1].status, "sent");
});

test("agent 回答完:要看到工作過、停下一段時間才收;收的是最後一次動作之後說的話", () => {
	const { store, card, transcript } = setup("reply", {});
	askCard(store, card.id, "改了哪幾行?");
	deliverFollowUps(store, listPanes());
	const sentAt = Date.parse(store.card(card.id).thread.find((t) => t.status === "sent").sentAt);
	appendFileSync(transcript, [userLine("【專案管家追問】改了哪幾行?", sentAt + 500), sayLine("我查一下", sentAt + 1000), toolLine(sentAt + 2000), resultLine(sentAt + 3000), sayLine("改了第 3 行和第 7 行。", sentAt + 4000)].join("\n") + "\n");
	const now = sentAt + 30_000;
	// 還沒停夠久
	assert.equal(collectReplies(store, listPanes(), () => ({ idleSince: now - 5_000, lastWorkAt: sentAt + 2_000 }), now).length, 0);
	// 送出後沒看到工作過、也還沒過一分鐘:先不收
	assert.equal(collectReplies(store, listPanes(), () => ({ idleSince: now - 20_000 }), now).length, 0);
	const answered = collectReplies(store, listPanes(), () => ({ idleSince: now - 20_000, lastWorkAt: sentAt + 2_000 }), now);
	assert.equal(answered.length, 1);
	const c = store.card(card.id);
	assert.equal(c.column, "done");
	assert.equal(c.thread.at(-1).role, "agent");
	assert.equal(c.thread.at(-1).text, "改了第 3 行和第 7 行。");
	assert.equal(c.thread.find((t) => t.role === "user").status, "answered");
	assert.match(c.note, /^追問有回覆:改了第 3 行/);
});

test("紀錄裡還沒有回答就不收(下一輪再看)", () => {
	const { store, card } = setup("noreply", {});
	askCard(store, card.id, "還有別的嗎?");
	deliverFollowUps(store, listPanes());
	const sentAt = Date.parse(store.card(card.id).thread.find((t) => t.status === "sent").sentAt);
	const now = sentAt + 120_000;
	assert.equal(collectReplies(store, listPanes(), () => ({ idleSince: now - 60_000, lastWorkAt: sentAt + 1_000 }), now).length, 0);
	assert.equal(store.card(card.id).column, "running");
});

test("進行中的卡:先排隊,這一輪做完才送;agent 在忙也先等", () => {
	const { store, card } = setup("queue", { column: "running" });
	askCard(store, card.id, "做完之後順便說明");
	deliverFollowUps(store, listPanes());
	assert.equal(prompts().length, 0);
	assert.equal(store.card(card.id).thread[0].status, "queued");
	store.updateCard(card.id, { column: "done" });
	const st = JSON.parse(readFileSync(stateFile, "utf8"));
	st.panes[0].agent_status = "working";
	writeFileSync(stateFile, JSON.stringify(st));
	deliverFollowUps(store, listPanes());
	assert.equal(prompts().length, 0, "agent 在忙不能送");
	st.panes[0].agent_status = "idle";
	writeFileSync(stateFile, JSON.stringify(st));
	deliverFollowUps(store, listPanes());
	assert.equal(prompts().length, 1);
	assert.equal(store.card(card.id).column, "running");
});

test("窗格關掉了:開新 tab、啟動同一種 agent,帶著卡片紀錄和這次的問題", () => {
	const { store, card } = setup("restart", { terminalId: "t-gone", paneId: "w1:p5" });
	store.updateCard(card.id, { thread: [
		{ id: "o1", role: "agent", text: "原本的回答", at: T(Date.now() - 100_000), original: true },
		{ id: "q1", role: "user", text: "第一個追問", at: T(Date.now() - 90_000), status: "answered" },
		{ id: "a1", role: "agent", text: "第一個回答", at: T(Date.now() - 80_000) },
	] });
	askCard(store, card.id, "第二個追問");
	deliverFollowUps(store, listPanes());
	const cs = calls();
	assert.ok(cs.some((a) => a[0] === "tab" && a[1] === "create"), "要開新 tab");
	const start = cs.find((a) => a[0] === "agent" && a[1] === "start");
	assert.ok(start && start.includes("claude") && start.includes("w1:p9"), "要在新窗格啟動 claude");
	const p = prompts()[0];
	assert.equal(p[2], "w1:p9");
	for (const s of ["【原本的指示】", "把 a.txt 的錯字改掉", "【上次的結果】", "原本的回答", "問:第一個追問", "答:第一個回答", "【這次的問題】", "第二個追問"]) assert.ok(p[3].includes(s), `缺 ${s}`);
	const c = store.card(card.id);
	assert.equal(c.paneId, "w1:p9");
	assert.equal(c.terminalId, "t9");
	assert.equal(c.column, "running");
});

test("舊卡沒有終端機 ID:認不出窗格是不是同一個,不打進那個窗格,改開新的 agent", () => {
	const { store, card } = setup("noterm", {});
	store.updateCard(card.id, { terminalId: undefined });
	askCard(store, card.id, "這是舊卡的追問");
	deliverFollowUps(store, listPanes());
	const ps = prompts();
	assert.equal(ps.length, 1);
	assert.equal(ps[0][2], "w1:p9", "要送到新開的窗格,不是 w1:p1");
	assert.ok(calls().some((a) => a[0] === "tab" && a[1] === "create"));
});

test("取消排隊中的問題;送不出去標成失敗,可以重送", () => {
	const { store, card } = setup("cancel", { column: "running" });
	const q = askCard(store, card.id, "不問了").thread.at(-1);
	assert.equal(cancelQuestion(store, card.id, q.id).thread?.length ?? 0, 0);
	store.updateCard(card.id, { column: "done" });
	const st = JSON.parse(readFileSync(stateFile, "utf8"));
	st.failPrompt = true;
	writeFileSync(stateFile, JSON.stringify(st));
	const q2 = askCard(store, card.id, "送不出去的問題").thread.at(-1);
	deliverFollowUps(store, listPanes());
	const failed = store.card(card.id).thread.find((t) => t.id === q2.id);
	assert.equal(failed.status, "failed");
	assert.match(failed.note, /boom/);
	assert.equal(store.card(card.id).column, "done");
	assert.equal(retryQuestion(store, card.id, q2.id).thread.find((t) => t.id === q2.id).status, "queued");
	assert.throws(() => askCard(store, card.id, "   "), /請輸入問題/);
	store.updateCard(card.id, { column: "proposed" });
	assert.throws(() => askCard(store, card.id, "提案不能問"), /還沒做過/);
});

test("等回覆中的問題,卡片卻不在進行中了:標成沒收到回覆,下一題送得出去", () => {
	const { store, card } = setup("stale", {});
	store.updateCard(card.id, { column: "blocked", thread: [{ id: "q1", role: "user", text: "舊問題", at: T(Date.now() - 60_000), status: "sent", sentAt: T(Date.now() - 60_000) }] });
	askCard(store, card.id, "新問題");
	deliverFollowUps(store, listPanes());
	assert.equal(store.card(card.id).thread.find((t) => t.id === "q1").status, "failed");
	deliverFollowUps(store, listPanes());
	assert.equal(prompts().length, 1);
	assert.match(prompts()[0][3], /新問題/);
});

test("finalReply:最後一次動作之後說的話;沒有動作就是最後一段", () => {
	const L = (role, text) => ({ role, text });
	assert.equal(finalReply([L("user", "q"), L("assistant", "先看"), L("tool", "Read"), L("assistant", "結論 A"), L("assistant", "補充 B")]), "結論 A\n\n補充 B");
	assert.equal(finalReply([L("user", "q"), L("assistant", "只有一段")]), "只有一段");
	assert.equal(finalReply([L("user", "q"), L("assistant", "前面"), L("tool", "Bash")]), "前面");
	assert.equal(finalReply([L("assistant", "舊的"), L("user", "新問題")]), "");
});
