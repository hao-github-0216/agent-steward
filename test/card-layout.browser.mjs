// 獨立執行: node test/card-layout.browser.mjs (需已安裝 Playwright 與 Chrome)。
// 所有頁面與 API 均由 route mock 提供,不啟動 server、不讀使用者資料。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const assets = new Map(["chatmd.js", "code.js", "snap.js"].map((name) => [`/web/${name}`, readFileSync(new URL(`../web/${name}`, import.meta.url), "utf8")]));
const continuous = "https://example.test/" + "continuous-string-".repeat(40);
const instructions = '指示開頭 <script>"&純文字</script>\n' + Array.from({ length: 50 }, (_, i) => `${i + 1}. 請保留完整指示,確認長結果與多則追問不會壓縮閱讀區。`).join("\n") + `\n${continuous}\n指示最後字-END`;
const result = "## 完成結果\n\n" + "結果段落,保留完整說明並可繼續追問。\n\n".repeat(35) + `${continuous}\n\n結果最後字-END`;
const now = new Date().toISOString();
const project = { id: "layout-project", name: "版面測試" + "專案".repeat(30), root: "/tmp/layout-project", kind: "project", status: "active", createdAt: now, state: { goal: "合成測試資料", progress: "測試中", nextSteps: [], blockers: [], decisions: [] } };
function makeCard() {
	return {
		id: "layout-card", projectId: project.id, title: "完成工作卡：長指示、長結果與多則追問的完整閱讀驗證-" + "LongTitle".repeat(9),
		column: "done", instructions, doneCriteria: "全文可讀；按鈕正常。" + continuous, agent: "pi", note: "已完成,請確認。" + continuous,
		createdAt: now, updatedAt: now, paneId: "w1:p1",
		thread: [{ id: "original", role: "agent", original: true, text: result, at: now }, ...Array.from({ length: 12 }, (_, i) => ({ id: `turn-${i}`, role: i % 2 ? "agent" : "user", status: "done", text: i % 2 ? `回覆 ${i}\n\n${continuous}` : `追問 ${i} ${continuous}`, at: now })),
			{ id: "queued", role: "user", status: "queued", text: "排隊的問題" }, { id: "failed", role: "user", status: "failed", note: continuous, text: "要重送的問題" },
			{ id: "last", role: "agent", text: "最新回覆\n\n最新回覆最後字-END" }],
	};
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
	for (const [width, height, mobile] of [[1440, 1000, false], [900, 600, false], [390, 844, true], [320, 568, true], [844, 390, true]]) {
		const context = await browser.newContext({ viewport: { width, height }, hasTouch: mobile, isMobile: mobile });
		try {
			const page = await context.newPage();
			const errors = [], requests = [];
			let card = makeCard(), revision = 0;
			page.on("pageerror", (error) => errors.push(error.message));
			await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
			await page.route("**/*", async (route) => {
				const request = route.request(), url = new URL(request.url());
				assert.equal(url.origin, "http://steward-layout.test", "不允許外部請求");
				if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
				if (assets.has(url.pathname)) return route.fulfill({ contentType: "application/javascript", body: assets.get(url.pathname) });
				let data = {};
				if (request.method() === "POST" && url.pathname.startsWith("/api/cards/")) {
					const payload = request.postDataJSON();
					requests.push({ path: url.pathname, payload });
					if (url.pathname.endsWith("/move")) card.column = payload.column;
					else if (url.pathname.endsWith("/ask")) card.thread.push({ id: "submitted", role: "user", status: "sent", text: payload.text });
					else if (url.pathname.endsWith("/cancel")) card.thread = card.thread.filter((t) => t.id !== url.pathname.split("/").at(-2));
					else if (url.pathname.endsWith("/retry")) card.thread.find((t) => t.id === "failed").status = "sent";
					else if (!url.pathname.endsWith("/focus")) Object.assign(card, payload);
					if (!url.pathname.endsWith("/focus")) card.updatedAt = new Date(Date.parse(now) + ++revision * 1000).toISOString();
					data = url.pathname.endsWith("/focus") ? { ok: true } : card;
				} else if (url.pathname === "/api/board") data = { projects: [project], cards: [card], watcher: { panes: [] } };
				else if (url.pathname === "/api/current") data = { project: project.id };
				else if (url.pathname === "/api/worktree-counts") data = { counts: {} };
				else if (url.pathname === "/api/agents") data = { agents: [{ id: "pi", name: "pi" }, { id: "claude", name: "Claude Code" }] };
				return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
			});
			await page.goto("http://steward-layout.test/", { waitUntil: "load" });
			await page.locator(".kcard").first().click();
			await page.locator('#cardPop [data-cagent] option[value="claude"]').waitFor({ state: "attached" });
			const pop = page.locator("#cardPop"), body = pop.locator(".mbody"), textarea = pop.locator("textarea");
			// 等待回應被頁面套用;move 還須等後續 board 載入,不能只看樂觀更新的 column。
			async function cardAction(path, action) {
				const moving = path.endsWith("/move");
				const boardResponse = moving ? page.waitForResponse((r) => new URL(r.url()).pathname === "/api/board" && r.request().method() === "GET") : null;
				const [response] = await Promise.all([
					page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === "POST"),
					action(),
				]);
				assert.equal(await response.finished(), null);
				assert.ok(response.ok(), path);
				const updated = await response.json();
				if (boardResponse) assert.equal(await (await boardResponse).finished(), null);
				if (!path.endsWith("/focus")) await page.waitForFunction((updated) => state.cards[0].updatedAt === updated.updatedAt && state.cards[0].column === updated.column, updated);
				if (moving) {
					await pop.waitFor({ state: "detached" });
					await page.waitForFunction((column) => {
						const line = document.querySelector('#board .kcard[data-card="layout-card"]');
						return openCardId === null && (column === "rejected" ? !line : line?.closest(".col")?.dataset.col === column);
					}, updated.column);
				}
			}
			assert.equal(await pop.locator(".ctext").textContent(), instructions);
			assert.equal(await pop.locator(".ctext script").count(), 0, "指示是純文字");
			assert.deepEqual(await pop.locator(".csection > h4").allTextContents(), ["指示", "完成標準", "結果與追問"]);
			assert.ok(await body.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2), "初開停在最新結果底部");
			// Range 量測末字真的出現在內容視窗,不是只檢查 DOM 有文字。
			async function readEnd(selector, marker) {
				return page.evaluate(({ selector, marker }) => {
					const el = document.querySelector(selector), body = document.querySelector("#cardPop .mbody");
					const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
					let node, range;
					while ((node = walker.nextNode())) {
						const index = node.textContent.indexOf(marker);
						if (index >= 0) { range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + marker.length); break; }
					}
					if (!range) return false;
					body.scrollTop += range.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom + 24;
					const r = range.getBoundingClientRect(), b = body.getBoundingClientRect();
					return r.top >= b.top && r.bottom <= b.bottom && r.left >= b.left && r.right <= b.right;
				}, { selector, marker });
			}
			assert.ok(await readEnd("#cardPop .thread", "最新回覆最後字-END"), "初開可讀最新回覆");
			assert.ok(await readEnd("#cardPop .ctext", "指示最後字-END"), "可捲到指示末字");
			assert.ok(await readEnd("#cardPop .thread", "結果最後字-END"), "可捲到原結果末字");
			await body.evaluate((el) => { el.scrollTop = 0; });
			const metrics = await page.evaluate(() => {
				const box = document.querySelector("#cardPop .box"), body = box.querySelector(".mbody"), pre = box.querySelector(".ctext");
				const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
				return { box: rect(box), body: rect(body), instructions: rect(pre), instructionsClientHeight: pre.clientHeight, instructionsScrollHeight: pre.scrollHeight,
					bodyScrollHeight: body.scrollHeight, scrollbar: getComputedStyle(body).scrollbarWidth, whiteSpace: getComputedStyle(pre).whiteSpace,
					overflow: [...box.querySelectorAll("*")].filter((el) => el.clientWidth && el.scrollWidth > el.clientWidth + 1).map((el) => el.className),
					chrome: navigator.userAgent, coarsePointer: matchMedia("(pointer: coarse)").matches };
			});
			assert.ok(metrics.instructions.height > 1000, "指示保留完整高度,不被壓縮");
			assert.ok(metrics.instructionsScrollHeight <= metrics.instructionsClientHeight + 1, "指示沒有內層垂直捲動");
			assert.ok(metrics.body.height >= 60 && metrics.bodyScrollHeight > metrics.body.height, "內容是主捲動區");
			assert.equal(metrics.scrollbar, "thin");
			assert.equal(metrics.whiteSpace, "pre-wrap");
			assert.deepEqual(metrics.overflow, [], "所有卡片內容都不水平溢出");
			assert.ok(metrics.box.x >= 0 && metrics.box.right <= width + 1 && metrics.box.y >= 0 && metrics.box.bottom <= height + 1);
			assert.equal(metrics.coarsePointer, mobile);
			async function visible(selector) {
				const r = await pop.locator(selector).boundingBox();
				assert.ok(r && r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 && r.x + r.width <= width + 1 && r.y + r.height <= height + 1, `${selector} 在可見範圍`);
			}
			for (const selector of [".mhead h3", "[data-closecard]", ".cmeta", ".mfoot", ".cask", "textarea", '[type="submit"]', '[data-move="approved"]']) await visible(selector);
			assert.match(await pop.locator(".cmeta").textContent(), /完成/);
			let expandedComposer = null;
			if (mobile) {
				const longDraft = "長追問內容\n".repeat(30);
				await textarea.fill(longDraft);
				expandedComposer = await page.evaluate(() => {
					const body = document.querySelector("#cardPop .mbody"), textarea = document.getElementById("cardAsk"), css = getComputedStyle(body);
					return { textareaHeight: textarea.getBoundingClientRect().height, textareaStyleHeight: textarea.style.height, bodyHeight: body.getBoundingClientRect().height,
						bodyContentHeight: body.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom), instructionLineHeight: parseFloat(getComputedStyle(body.querySelector(".ctext")).lineHeight) };
				});
				assert.equal(expandedComposer.textareaStyleHeight, "140px", "長追問觸發既有 JS 140px 高度上限");
				assert.ok(Math.abs(expandedComposer.textareaHeight - Math.min(140, height * 0.2)) < 1, "實際輸入區受視窗高度上限限制");
				assert.ok(expandedComposer.bodyContentHeight >= expandedComposer.instructionLineHeight, "展開追問後仍能閱讀至少一整行指示");
				expandedComposer.instructionEndVisible = await readEnd("#cardPop .ctext", "指示最後字-END");
				expandedComposer.resultEndVisible = await readEnd("#cardPop .thread", "結果最後字-END");
				assert.ok(expandedComposer.instructionEndVisible, "長追問時仍可讀到指示末字");
				assert.ok(expandedComposer.resultEndVisible, "長追問時仍可讀到結果末字");
				const inputScroll = await textarea.evaluate((el) => {
					el.scrollTop = el.scrollHeight;
					return { top: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
				});
				assert.ok(inputScroll.top > 0 && inputScroll.top + inputScroll.clientHeight >= inputScroll.scrollHeight - 1, "輸入框自身可捲動到完整 draft 最後一行");
				await page.evaluate(() => { window.expandedAsk = document.getElementById("cardAsk"); renderCardPop(); });
				assert.equal(await textarea.inputValue(), longDraft, "長追問全文不遺失");
				assert.equal(await textarea.evaluate((el) => el.scrollTop), inputScroll.top, "更新保留輸入框內部捲動位置");
				assert.ok(await page.evaluate(() => window.expandedAsk === document.getElementById("cardAsk")), "長追問更新不重建輸入框");
				await textarea.fill("");
			}
			await textarea.fill("未送出 draft\n第二行");
			await body.evaluate((el) => { el.scrollTop = 360; });
			const before = await body.evaluate((el) => el.scrollTop);
			await page.evaluate(() => { window.layoutAsk = document.getElementById("cardAsk"); window.layoutForm = window.layoutAsk.form; renderCardPop(); });
			assert.equal(await body.evaluate((el) => el.scrollTop), before);
			assert.equal(await textarea.inputValue(), "未送出 draft\n第二行");
			assert.ok(await page.evaluate(() => window.layoutAsk === document.getElementById("cardAsk") && window.layoutForm === window.layoutAsk.form));
			await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
			await page.evaluate(() => { renderCardPop(); });
			assert.ok(await body.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2), "底部閱讀跟隨更新");
			await body.evaluate((el) => { el.scrollTop = 360; });
			await page.evaluate(() => { state.cards[0].thread.push({ id: "new", role: "agent", text: "新增回覆-END" }); renderCardPop(); });
			assert.ok(await body.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2), "新增回覆自動捲底");
			assert.equal(await textarea.inputValue(), "未送出 draft\n第二行");
			await body.evaluate((el) => { el.scrollTop = 0; });
			await cardAction("/api/cards/layout-card", () => pop.locator("[data-cagent]").selectOption("claude"));
			await page.waitForFunction(() => state.cards[0].agent === "claude" && document.querySelector("#cardPop [data-cagent]")?.value === "claude");
			assert.equal(await textarea.inputValue(), "未送出 draft\n第二行");
			await cardAction("/api/cards/layout-card/ask/failed/retry", () => pop.locator('[data-askretry="failed"]').click());
			await pop.locator('[data-askretry="failed"]').waitFor({ state: "detached" });
			await cardAction("/api/cards/layout-card/ask/queued/cancel", () => pop.locator('[data-askcancel="queued"]').click());
			await pop.locator('[data-askcancel="queued"]').waitFor({ state: "detached" });
			await textarea.fill("真正按送出的 mock 追問");
			await cardAction("/api/cards/layout-card/ask", () => pop.locator('[type="submit"]').click());
			await page.waitForFunction(() => document.getElementById("cardAsk").value === "");
			assert.ok(requests.some((r) => r.path.endsWith("/ask") && r.payload.text === "真正按送出的 mock 追問"));
			await cardAction("/api/cards/layout-card/move", () => pop.locator('[data-move="approved"]').click());
			// 前一個 action 完成後才換 mock 狀態,後續仍走真實按鈕與事件。
			async function openStatus(column) {
				card.column = column;
				await page.evaluate((mockCard) => { state.cards[0] = mockCard; openCard("layout-card"); }, card);
				await page.waitForFunction((column) => state.cards[0].column === column && document.querySelector("#cardPop .cmeta .chip")?.textContent === COL_LABEL[column], column);
			}
			await openStatus("blocked");
			assert.equal(await pop.locator('[data-move="done"]').textContent(), "標成完成");
			assert.equal(await pop.locator('[data-move="approved"]').textContent(), "重新派工");
			await cardAction("/api/cards/layout-card/move", () => pop.locator('[data-move="done"]').click());
			await openStatus("running");
			assert.match(await textarea.getAttribute("placeholder"), /這一輪做完/);
			assert.equal(await pop.locator("[data-move]").count(), 0);
			await pop.locator("[data-closecard]").click();
			await pop.waitFor({ state: "detached" });
			await openStatus("proposed");
			assert.ok(await pop.locator(".cask").isHidden());
			assert.equal(await pop.locator('[data-move="rejected"]').textContent(), "不要");
			assert.equal(await pop.locator('[data-move="approved"]').textContent(), "核准派工");
			await cardAction("/api/cards/layout-card/move", () => pop.locator('[data-move="approved"]').click());
			await openStatus("proposed");
			await cardAction("/api/cards/layout-card/move", () => pop.locator('[data-move="rejected"]').click());
			await openStatus("blocked");
			await cardAction("/api/cards/layout-card/move", () => pop.locator('[data-move="approved"]').click());
			await openStatus("done");
			await cardAction("/api/cards/layout-card/focus", () => pop.locator("[data-jumpcard]").click());
			await pop.waitFor({ state: "detached" });
			await page.waitForFunction(() => document.body.classList.contains("term"));
			for (const path of ["/api/cards/layout-card", "/api/cards/layout-card/ask/failed/retry", "/api/cards/layout-card/ask/queued/cancel", "/api/cards/layout-card/focus"]) assert.ok(requests.some((r) => r.path === path), path);
			assert.ok(requests.some((r) => r.path.endsWith("/move") && r.payload.column === "approved"));
			assert.deepEqual(errors, [], "沒有頁面 JavaScript 錯誤");
			results.push({ viewport: `${width}x${height}`, mobile, status: "passed", bodyHeight: metrics.body.height, instructionsHeight: metrics.instructions.height, horizontalOverflow: metrics.overflow, expandedComposer, mockActions: requests.length, chrome: metrics.chrome });
		} finally { await context.close(); }
	}
} finally { await browser.close(); }
console.log(JSON.stringify(results, null, 2));
