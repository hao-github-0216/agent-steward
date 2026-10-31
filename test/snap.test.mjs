// 圈選提問:整理網頁送來的資料、組給模型看的段落、找出終端機圈的是哪個窗格
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 假 herdr:兩個窗格,畫面內容不同
const dir = mkdtempSync(join(tmpdir(), "snap-"));
const bin = join(dir, "herdr");
writeFileSync(bin, `#!/usr/bin/env node
const [a, b, c] = process.argv.slice(2);
const screens = { "w1:p1": "$ ls\\nREADME.md", "w1:p2": "$ npm test\\nTypeError: x is not a function\\n    at main (src/a.js:3:5)" };
if (a === "pane" && b === "list") process.stdout.write(JSON.stringify({ result: { panes: [
  { pane_id: "w1:p1", workspace_id: "w1", focused: true, cwd: "/tmp" },
  { pane_id: "w1:p2", workspace_id: "w1", focused: false, cwd: "/tmp", agent: "claude" } ] } }));
else if (a === "workspace" && b === "list") process.stdout.write(JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", focused: true }] } }));
else if (a === "pane" && b === "read") process.stdout.write(screens[c] || "");
else process.stdout.write("{}");
`);
chmodSync(bin, 0o755);
process.env.HERDR_BIN_PATH = bin;
const { findSnapPane, parseSnap, snapPrompt, terminalContext } = await import("../src/snap.ts");

test("parseSnap 擋掉怪資料、截長度", () => {
	assert.equal(parseSnap(null), undefined);
	const s = parseSnap({ kind: "bogus", label: "", text: "x".repeat(30_000), from: "12", to: "x" });
	assert.equal(s.kind, "page");
	assert.equal(s.label, "畫面");
	assert.equal(s.text.length, 20_000);
	assert.equal(s.from, 12);
	assert.equal(s.to, undefined);
});

test("snapPrompt:有出處、圈到的內容、周圍內容;沒文字時說明是圖片", () => {
	const p = snapPrompt({ kind: "code", label: "src/a.ts", from: 3, to: 5, text: "let a = 1", context: "整個檔案" }, false);
	assert.match(p, /src\/a\.ts 第 3–5 行/);
	assert.match(p, /let a = 1/);
	assert.match(p, /周圍的內容/);
	assert.match(snapPrompt({ kind: "doc", label: "a.pdf 第 2 頁", text: "" }, true), /圈到的是圖片/);
	// 文字和截圖都有:說明截圖附在這題,原文 / 辨識的字哪個為準
	assert.match(snapPrompt({ kind: "terminal", label: "終端機", text: "npm test" }, true), /截圖附在這題.*以文字為準/);
	assert.match(snapPrompt({ kind: "page", label: "看板", text: "辨識的字" }, true), /以截圖為準/);
	assert.doesNotMatch(snapPrompt({ kind: "page", label: "看板", text: "辨識的字" }, false), /截圖/);
});

test("findSnapPane:用畫面內容找出圈的是哪個窗格(不一定是目前的窗格)", () => {
	const p = findSnapPane("TypeError: x is not a function");
	assert.equal(p.pane_id, "w1:p2");
	assert.match(terminalContext(p), /npm test/);
	// 對不上就用目前的窗格
	assert.equal(findSnapPane("完全沒出現過的字").pane_id, "w1:p1");
});
