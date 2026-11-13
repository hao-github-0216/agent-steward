// Word 預覽(docx-preview)每一頁會產生 <section class="docx"><header>…</header><article>…</article></section>。
// 網頁上方標題列的樣式如果寫成元素選擇器 header,也會套到文件的頁首,
// 變成 50px 高、底色 var(--panel)、sticky 的方塊,蓋住文件第一行(深色模式看起來是黑塊)。
// 這裡檢查 index.html 裡所有 header 規則都限定在 body 底下那一個。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");

/** 回傳每條規則的選擇器(逗號拆開),@media 之類的外層會被略過 */
function selectors(text) {
	const out = [];
	for (const m of text.matchAll(/([^{}]+)\{/g)) {
		const sel = m[1].trim();
		if (!sel || sel.startsWith("@")) continue;
		out.push(...sel.split(",").map((s) => s.trim()));
	}
	return out;
}

test("header 樣式只套到網頁本身的標題列,不會套到 Word 預覽的頁首", () => {
	const withHeader = selectors(css).filter((s) => /(^|[\s>+~(])header(?![-\w])/.test(s));
	assert.ok(withHeader.length > 0, "應該找得到標題列的樣式");
	const loose = withHeader.filter((s) => !/(^|\s)(body|body\.[\w-]+|html(\.[\w-]+)? body)\s*>\s*header(?![-\w])/.test(s));
	assert.deepEqual(loose, [], `這些選擇器會套到所有 <header>,包括 Word 預覽的頁首:${loose.join(" | ")}`);
});
