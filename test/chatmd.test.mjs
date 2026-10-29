// 問管家對話框的 Markdown 顯示:常見格式要轉,HTML 和 javascript: 連結要擋掉
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const ctx = { window: {}, document: {} };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL("../web/chatmd.js", import.meta.url), "utf8"), ctx);
const md = ctx.window.chatMd.render;

test("粗體、行內程式、斜體、刪除線;snake_case 不受影響", () => {
	assert.equal(md("**粗** `a*b*c` *斜* ~~刪~~ snake_case_name"), "<p><strong>粗</strong> <code>a*b*c</code> <em>斜</em> <del>刪</del> snake_case_name</p>");
});
test("清單(巢狀)、編號清單、勾選", () => {
	assert.equal(md("- a\n  - b\n- c"), "<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>");
	assert.equal(md("1. x\n2. y"), "<ol><li>x</li><li>y</li></ol>");
	assert.match(md("- [x] done"), /checkbox" disabled checked/);
});
test("表格(含對齊、只有一個 - 的分隔欄)", () => {
	const h = md("| a | b |\n|:-:|--:|\n| 1 | **2** |");
	assert.match(h, /<table>/);
	assert.match(h, /text-align:center">a/);
	assert.match(h, /<strong>2<\/strong>/);
});
test("程式區塊裡的符號原樣顯示", () => {
	assert.equal(md("```py\nx = 2**-7 < 1\n```"), '<pre class="md-pre" data-lang="py"><code>x = 2**-7 &lt; 1</code></pre>');
});
test("擋掉 HTML 與 javascript: 連結", () => {
	const h = md('<img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://a.b/?q=1&r=2)');
	assert.doesNotMatch(h, /<img/);
	assert.doesNotMatch(h, /href="javascript/);
	assert.match(h, /href="https:\/\/a\.b\/\?q=1&amp;r=2"/);
});
test("數學式;價錢的 $ 不當成數學", () => {
	assert.match(md("$E=mc^2$"), /class="md-math">E=mc\^2</);
	assert.doesNotMatch(md("$5 和 $10"), /md-math/);
	assert.match(md("$$\\sum k$$"), /data-display="1"/);
});
