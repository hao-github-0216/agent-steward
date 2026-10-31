// 工作卡作者與使用者修改紀錄:改前 → 改後、多次修改合併、存檔後讀得回來
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "authorship-"));
process.env.STEWARD_DATA_DIR = join(dir, "data");
const { diffEdits, mergeEdits, textOf } = await import("../src/authorship.ts");
const { Store } = await import("../src/store.ts");

const steward = { title: "刪除 Q2 預測段", instructions: "Write the remaining inequalities as …", doneCriteria: "完成" };

test("只記有變的欄位,空白差異不算", () => {
	const e = diffEdits(steward, { ...steward, instructions: "Rewriting the remaining constraints gives …", doneCriteria: " 完成 " }, "t1");
	assert.deepEqual(e, [{ field: "instructions", before: steward.instructions, after: "Rewriting the remaining constraints gives …", at: "t1" }]);
});

test("同一欄位改兩次:保留管家的原稿與最新版本;改回原樣就不算修改", () => {
	const first = diffEdits(steward, { ...steward, title: "刪 Q2" }, "t1");
	const second = mergeEdits(first, diffEdits(steward, { ...steward, title: "刪掉 Q2 的 Prediction 段" }, "t2"));
	assert.deepEqual(second, [{ field: "title", before: steward.title, after: "刪掉 Q2 的 Prediction 段", at: "t2" }]);
	assert.deepEqual(mergeEdits(second, diffEdits(steward, steward)), second);
	assert.deepEqual(mergeEdits(second, [{ field: "title", before: steward.title, after: steward.title, at: "t3" }]), []);
});

test("textOf 只取三個文字欄位", () => {
	assert.deepEqual(textOf({ ...steward, agent: "pi", column: "proposed" }), steward);
});

test("作者與修改紀錄存檔後讀得回來", () => {
	const statePath = join(dir, "state.json");
	const s = new Store(statePath);
	const mine = s.addCard({ projectId: "p", title: "自己建的", agent: "pi", instructions: "做 X", doneCriteria: "完成", authoredBy: "user" });
	const edited = s.addCard({ projectId: "p", ...steward, agent: "pi", authoredBy: "steward", userEdits: diffEdits(steward, { ...steward, title: "改過" }, "t1") });
	const again = new Store(statePath);
	assert.equal(again.card(mine.id).authoredBy, "user");
	assert.equal(again.card(edited.id).userEdits[0].after, "改過");
});
