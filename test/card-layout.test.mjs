// 執行資訊卡的實際 render;捲動數值只用來驗證分支,實際尺寸由 browser 測試檢查。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const start = html.indexOf("let openCardId = null;");
const end = html.indexOf("async function askCard(id)", start);
assert.ok(start > 0 && end > start, "card render source seam");
const escSource = html.match(/^const esc = .*;$/m)[0];
const css = html.slice(html.indexOf("/* 資訊卡 */"), html.indexOf(".ghost {"));
function rule(selector) {
	const match = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{([^}]+)\\}"));
	assert.ok(match, selector);
	return match[1];
}

class Node {
	constructor() { this.dataset = {}; this.nodes = {}; this.listeners = {}; this.style = {}; this.value = ""; this.scrollTop = 0; this.clientHeight = 200; this.scrollHeight = 2000; this.writes = 0; }
	set innerHTML(value) {
		this.markup = value; this.writes++;
		if (value.includes('role="dialog"')) {
			for (const key of [".box", "[data-cp=title]", "[data-cp=body]", "[data-cp=ask]", "[data-cp=foot]"]) this.nodes[key] = new Node();
			const form = this.nodes["[data-cp=ask]"];
			form.nodes.textarea = new Node();
		}
	}
	get innerHTML() { return this.markup; }
	querySelector(selector) { return this.nodes[selector] || null; }
	addEventListener(type, handler) { this.listeners[type] = handler; }
	setAttribute(key, value) { this[key] = value; }
}
function setup(overrides = {}) {
	const card = { id: "layout", projectId: "project", title: "測試標題", column: "done", agent: "pi", instructions: "指示", doneCriteria: "完成", paneId: "w1:p1", thread: [], ...overrides };
	let wrap;
	const context = vm.createContext({
		COLS: [["done", "完成"], ["blocked", "卡住"], ["running", "進行中"], ["proposed", "提案"]],
		state: { cards: [card], projects: [{ id: "project", name: "測試專案" }] },
		$: () => wrap,
		document: { createElement: () => new Node(), body: { appendChild: (node) => { wrap = node; } } },
		ago: () => "剛剛", chatMd: { render: (text) => text, typeset() {} },
		tr: (zh, vars) => zh.replace(/\{([^{}]+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m)),
		LANG: "zh-TW",
	});
	vm.runInContext(escSource + "\n" + html.slice(start, end), context);
	const run = (source) => vm.runInContext(source, context);
	run('openCardId = "layout"; renderCardPop()');
	return { card, run, wrap, body: wrap.querySelector("[data-cp=body]"), ask: wrap.querySelector("[data-cp=ask]"), foot: wrap.querySelector("[data-cp=foot]") };
}

test("cardpop CSS: 單一內容捲動區,指示不截高、不縮小,捲動條覆蓋全域隱藏規則", () => {
	assert.match(rule(".modal.cardpop .mbody"), /overflow-y: scroll/);
	assert.match(rule(".modal.cardpop .mbody"), /scrollbar-width: thin/);
	assert.match(rule(".cardpop .mbody::-webkit-scrollbar"), /display: block/);
	assert.match(rule(".cardpop .mbody > *"), /flex-shrink: 0/);
	assert.match(rule(".cardpop .ctext"), /white-space: pre-wrap/);
	assert.match(rule(".cardpop .ctext"), /overflow-wrap: anywhere/);
	assert.doesNotMatch(rule(".cardpop .ctext"), /max-height|overflow:\s*(auto|scroll)/);
	assert.match(rule(".cardpop .csection"), /gap: 8px/);
});

test("cardpop CSS: header/composer/footer 不壓縮,標題和長字串換行,輸入框可收窄", () => {
	assert.match(rule(".cardpop .mhead, .cardpop .cask, .cardpop .mfoot"), /flex-shrink: 0/);
	assert.match(rule(".cardpop .mhead h3"), /overflow-wrap: anywhere/);
	assert.match(rule(".cardpop .mhead button"), /flex-shrink: 0/);
	assert.match(rule(".cardpop .mbody, .cardpop .csection, .cardpop .turn"), /overflow-wrap: anywhere/);
	assert.match(rule(".cardpop .cmeta > *"), /min-width: 0; max-width: 100%/);
	assert.match(rule(".cardpop .cask textarea"), /min-width: 0/);
});

test("cardpop CSS: 長追問限制在視窗高度兩成,短視窗保留閱讀空間", () => {
	assert.match(rule(".cardpop .cask textarea"), /max-height: min\(140px, 20vh\); max-height: min\(140px, 20dvh\)/);
});

test("renderCardPop: instructions 全文 escape,分段標題與長結果均保留", () => {
	const instructions = '<script>"&內容</script>\n' + "長指示".repeat(2000) + "指示最後字";
	const result = "完整結果".repeat(2000) + "結果最後字";
	const h = setup({ instructions, doneCriteria: "<完成&>", note: "<備註>", thread: [{ role: "agent", text: result, original: true }] });
	assert.ok(h.body.innerHTML.includes(`<pre class="ctext">&lt;script&gt;&quot;&amp;內容&lt;/script&gt;\n${"長指示".repeat(2000)}指示最後字</pre>`));
	assert.match(h.body.innerHTML, /<section class="csection"><h4>指示<\/h4>/);
	assert.match(h.body.innerHTML, /完成標準<\/h4><div>&lt;完成&amp;&gt;/);
	assert.match(h.body.innerHTML, /結果與追問/);
	assert.ok(h.body.innerHTML.includes(result));
	assert.match(h.body.innerHTML, /&lt;備註&gt;/);
	assert.equal(h.wrap.querySelector("[data-cp=title]").textContent, "測試標題");
});

test("renderCardPop: 無指示與完成標準的 fallback", () => {
	const h = setup({ instructions: "", doneCriteria: null });
	assert.match(h.body.innerHTML, /class="ctext">\(沒有\)<\/pre>/);
	assert.match(h.body.innerHTML, /完成標準<\/h4><div>\(沒有\)<\/div>/);
	assert.doesNotMatch(h.body.innerHTML, /結果與追問/);
});

for (const [column, ask, moves, jump] of [
	["done", true, ["重做一次"], true], ["blocked", true, ["標成完成", "重新派工"], true],
	["running", true, [], true], ["proposed", false, ["不要", "核准派工"], false], ["approved", false, [], false],
]) test(`renderCardPop: ${column} 既有按鈕、agent 和追問狀態`, () => {
	const h = setup({ column });
	assert.equal(h.ask.hidden, !ask);
	for (const move of moves) assert.ok(h.foot.innerHTML.includes(move));
	assert.equal(h.foot.innerHTML.includes("data-jumpcard"), jump);
	assert.equal(h.body.innerHTML.includes("data-cagent"), ["done", "blocked", "proposed"].includes(column));
	assert.equal(h.ask.querySelector("textarea").placeholder.includes("這一輪做完"), column === "running");
});

test("threadHtml: queued/sent/failed 追問保留取消、重送與完整 escape", () => {
	const h = setup({ column: "running", thread: [
		{ role: "user", id: "q", status: "queued", text: "<問題>" },
		{ role: "user", id: "s", status: "sent", text: "已送" },
		{ role: "user", id: "f", status: "failed", text: "失敗", note: "<錯誤>" },
	] });
	assert.match(h.body.innerHTML, /&lt;問題&gt;/);
	assert.match(h.body.innerHTML, /data-askcancel="q"/);
	assert.match(h.body.innerHTML, /data-askretry="f"/);
	assert.match(h.body.innerHTML, /data-askcancel="f"/);
	assert.match(h.body.innerHTML, /&lt;錯誤&gt;/);
	assert.match(h.body.innerHTML, /回覆中/);
});

test("renderCardPop: 同卡更新不重建 composer,保留 draft/閱讀位置,初開與新回覆跳底", () => {
	const h = setup({ thread: [{ role: "agent", text: "結果" }] });
	assert.equal(h.body.scrollTop, h.body.scrollHeight, "初開跳到最新結果");
	const textarea = h.ask.querySelector("textarea");
	textarea.value = "未送出的追問";
	textarea.style.height = "92px";
	h.body.scrollTop = 180;
	h.run("renderCardPop()");
	assert.equal(h.body.scrollTop, 180, "上方閱讀位置不變");
	assert.equal(h.wrap.writes, 1);
	assert.equal(h.wrap.querySelector("[data-cp=ask]"), h.ask);
	assert.equal(h.ask.querySelector("textarea"), textarea);
	assert.equal(textarea.value, "未送出的追問");
	assert.equal(textarea.style.height, "92px");
	h.body.scrollTop = h.body.scrollHeight - h.body.clientHeight;
	h.run("renderCardPop()");
	assert.equal(h.body.scrollTop, h.body.scrollHeight, "底部閱讀會跟隨更新");
	h.body.scrollTop = 180;
	h.card.thread.push({ role: "agent", text: "新回覆" });
	h.run("renderCardPop()");
	assert.equal(h.body.scrollTop, h.body.scrollHeight, "新增回覆沿用跳底行為");
	assert.equal(textarea.value, "未送出的追問");
});
