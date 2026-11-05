// 測試補建只參考有內容且被上層紀錄提到的子資料夾,提示詞也禁止照抄上層狀態。
import "./helpers/data-dir.mjs";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapMessage, folderHasContent, parentMentions, useParentState } from "../src/bootstrap-context.ts";

const parentRoot = mkdtempSync(join(tmpdir(), "bootstrap-ctx-"));
after(() => rmSync(parentRoot, { recursive: true, force: true }));

function parentWith(text, recentSummary = "") {
	return {
		id: "parent",
		name: "上層",
		root: parentRoot,
		kind: "project",
		state: {
			goal: "",
			progress: text,
			nextSteps: [],
			decisions: [],
			blockers: [],
			recent: recentSummary ? [{ at: "2026-01-01T00:00:00Z", agent: "claude", summary: recentSummary }] : [],
			updatedAt: "2026-01-01T00:00:00Z",
		},
	};
}

test("只有隱藏檔案與資料夾時,即使上層提到也不參考", () => {
	const childRoot = join(parentRoot, "示範空資料夾");
	mkdirSync(childRoot);
	mkdirSync(join(childRoot, ".git"));
	writeFileSync(join(childRoot, ".DS_Store"), "示範");
	const parent = parentWith("正在整理示範空資料夾");
	assert.equal(folderHasContent(childRoot), false);
	assert.equal(useParentState(childRoot, parent), false);
});

test("不存在的資料夾視為沒有內容", () => {
	assert.equal(folderHasContent(join(parentRoot, "示範不存在")), false);
});

test("資料夾有檔案但上層紀錄沒提到時不參考", () => {
	const childRoot = join(parentRoot, "示範子資料夾");
	mkdirSync(childRoot);
	writeFileSync(join(childRoot, "demo.txt"), "示範");
	assert.equal(useParentState(childRoot, parentWith("正在整理其他範例")), false);
});

test("上層提到的名稱忽略大小寫、空白與連字號差異", () => {
	const childRoot = join(parentRoot, "Demo-Sub");
	mkdirSync(childRoot);
	writeFileSync(join(childRoot, "demo.txt"), "示範");
	const parent = parentWith("正在做 demo sub 的實驗");
	assert.equal(parentMentions(parent, childRoot), true);
	assert.equal(useParentState(childRoot, parent), true);
});

test("只在最近工作摘要提到子資料夾也算相關", () => {
	const childRoot = join(parentRoot, "demo-recent");
	mkdirSync(childRoot);
	assert.equal(parentMentions(parentWith("正在整理其他範例", "完成 demo_recent 的示範"), childRoot), true);
});

test("沒有上層專案時不參考上層狀態", () => {
	const childRoot = join(parentRoot, "示範無上層");
	mkdirSync(childRoot);
	writeFileSync(join(childRoot, "demo.txt"), "示範");
	assert.equal(useParentState(childRoot, undefined), false);
});

test("補建提示詞禁止照抄上層且允許沒有可補建內容", () => {
	const message = bootstrapMessage("示範", "/x/示範", ["資料A"]);
	assert.ok(message.includes("不要照抄"));
	assert.ok(message.includes("沒有可補建的內容"));
	assert.ok(message.includes("資料A"));
	assert.ok(!message.includes("goal 也要填"));
});
