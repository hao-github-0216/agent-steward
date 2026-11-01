// 附圖的問答(圈選、貼圖)由看圖模型單獨回答、管家的持續對話沒看過:下一次一般提問要補給管家
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STEWARD_DATA_DIR = mkdtempSync(join(tmpdir(), "unseen-"));
const { appendChat, markShared, unseenImageTurns } = await import("../src/chat-log.ts");
const P = "demo";

test("圈選問第三題之後,中間有開工作卡和文字提問,下一題仍補上第三題;補過就不再補", () => {
	appendChat(P, { role: "me", text: "第一題怎麼解" });
	appendChat(P, { role: "bot", text: "第一題的思路…" });
	appendChat(P, { role: "me", text: "這題的解答思路是甚麼?", via: "圈選", quote: { path: "hw.pdf", text: "3. Maximum A-Posteriori Estimation" }, images: ["data:image/jpeg;base64,AAAA"] });
	appendChat(P, { role: "bot", text: "第 3(a) 題:先驗 × 似然 → Beta" });
	appendChat(P, { role: "me", text: "開工作卡:加變體" });
	appendChat(P, { role: "bot", text: "工作卡草稿", draft: { title: "t", agent: "a", instructions: "", doneCriteria: "", status: "draft" } });
	appendChat(P, { role: "me", text: "怎麼認出 beta 形式?" });
	appendChat(P, { role: "bot", text: "不確定你指的上下文" });
	const now = appendChat(P, { role: "me", text: "第三題的積分步驟怎麼來的" });

	const u = unseenImageTurns(P, now.id);
	assert.equal(u.ids.length, 1);
	assert.match(u.text, /圈選畫面/);
	assert.match(u.text, /Maximum A-Posteriori/);
	assert.match(u.text, /先驗 × 似然/);
	assert.doesNotMatch(u.text, /第一題/); // 一般提問管家本來就看過

	markShared(P, u.ids);
	assert.deepEqual(unseenImageTurns(P, now.id), { text: "", ids: [] });
});

test("看圖失敗的不補;沒有附圖的問答不補", () => {
	appendChat(P, { role: "me", text: "看這張圖", images: ["data:image/jpeg;base64,BBBB"] });
	appendChat(P, { role: "bot", text: "看圖失敗", error: true });
	assert.equal(unseenImageTurns(P).ids.length, 0);
});
