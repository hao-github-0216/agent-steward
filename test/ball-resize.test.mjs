// 執行 index.html 的實際面板 controller 與球事件,不需要瀏覽器依賴。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const start = html.indexOf("const ball = { open:");
const end = html.indexOf("/** 目前專案變了", start);
assert.ok(start > 0 && end > start, "ball controller source seam");
const controller = html.slice(start, end);
const modeStart = html.indexOf("function setMode(mode, opts = {}) {");
const modeSource = html.slice(modeStart, html.indexOf("\n}\n", modeStart) + 2);

class Element {
	constructor(id = "") {
		this.id = id;
		this.hidden = false;
		this.dataset = {};
		this.listeners = new Map();
		this.captures = new Set();
		const classes = new Set();
		this.classList = {
			add: (...xs) => xs.forEach((x) => classes.add(x)),
			remove: (...xs) => xs.forEach((x) => classes.delete(x)),
			contains: (x) => classes.has(x),
			toggle: (x, force = !classes.has(x)) => { if (force) classes.add(x); else classes.delete(x); return force; },
		};
		this.style = { setProperty(key, value) { this[key] = value; } };
	}
	addEventListener(type, fn) {
		if (!this.listeners.has(type)) this.listeners.set(type, []);
		this.listeners.get(type).push(fn);
	}
	emit(type, props = {}) {
		const e = { type, pointerId: 1, isPrimary: true, button: 0, clientX: 500, clientY: 400, preventDefault() {}, stopPropagation() {}, ...props };
		for (const fn of this.listeners.get(type) || []) fn(e);
	}
	setPointerCapture(id) { this.captures.add(id); }
	hasPointerCapture(id) { return this.captures.has(id); }
	releasePointerCapture(id) { this.captures.delete(id); this.emit("lostpointercapture", { pointerId: id }); }
	focus() {}
	appendChild(child) { child.parentElement = this; }
}

function setup({ width = 1400, height = 1000, corner = "br" } = {}) {
	const nodes = new Map();
	const $ = (id) => { if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id); };
	const panel = $("ballPanel"), ball = $("stewardBall"), body = new Element(), events = new Element();
	panel.hidden = true;
	$("ballWrap").dataset.corner = "br";
	const handles = Object.fromEntries(["n", "s", "e", "w", "nw", "ne", "sw", "se"].map((edge) => {
		const handle = new Element(); handle.dataset.edge = edge; return [edge, handle];
	}));
	panel.querySelectorAll = (selector) => { assert.equal(selector, ".bp-resize"); return Object.values(handles); };
	const prefs = new Map([["steward.ballCorner", corner]]), timers = new Map();
	let timerId = 0, snaps = 0;
	const desktop = new Element(); desktop.matches = width > 800;
	const context = vm.createContext({
		$, innerWidth: width, innerHeight: height,
		document: { body }, navigator: { vibrate() {} },
		matchMedia: (query) => query === "(min-width: 801px)" ? desktop : { matches: false },
		addEventListener: events.addEventListener.bind(events),
		pref: (key, value) => { if (value !== undefined) prefs.set(key, value); return prefs.get(key); },
		setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
		clearTimeout: (id) => timers.delete(id),
		setInterval: () => 1, clearInterval() {},
		inApp: () => false, loadAgents: () => Promise.resolve(), renderBall() {}, syncBall() {}, renderCtx() {}, focusTerm() {},
		renderDrawer() {}, syncMenuLabel() {}, enterTerminal() {}, applyFont() {}, hookClipboard() {}, xterm() {},
		location: { hash: "", pathname: "/" }, history: { replaceState() {} },
	});
	context.window = context;
	context.snapStart = () => snaps++;
	context.codeMode = { show() {} };
	const geometry = () => {
		const r = Object.fromEntries(["left", "top", "width", "height"].map((key) => [key, parseFloat(panel.style[`--bp-${key}`])]));
		return { ...r, right: r.left + r.width, bottom: r.top + r.height };
	};
	panel.getBoundingClientRect = geometry;
	vm.runInContext(controller + "\n" + modeSource, context);
	const run = (code) => vm.runInContext(code, context);
	const resizeViewport = (w, h) => {
		context.innerWidth = w; context.innerHeight = h;
		const changed = desktop.matches !== (w > 800); desktop.matches = w > 800;
		if (changed) desktop.emit("change");
		events.emit("resize");
	};
	const open = () => run("toggleBall(true)");
	const drag = (edge, dx, dy, type = "pointerup") => {
		const h = handles[edge]; h.emit("pointerdown");
		h.emit("pointermove", { clientX: 500 + dx, clientY: 400 + dy });
		if (type) h.emit(type);
	};
	return { $, panel, ball, body, handles, geometry, run, open, drag, resizeViewport, prefs, timers, snaps: () => snaps };
}

for (const edge of ["n", "s", "e", "w", "nw", "ne", "sw", "se"]) {
	test(`ballPanel ${edge}: 拖曳真實調整四邊,對邊與未拖軸固定`, () => {
		const h = setup(); h.open();
		const before = h.geometry();
		const dx = edge.includes("w") ? -45 : edge.includes("e") ? 45 : 0;
		const dy = edge.includes("n") ? -35 : edge.includes("s") ? 35 : 0;
		h.handles[edge].emit("pointerdown");
		assert.ok(h.handles[edge].hasPointerCapture(1));
		h.handles[edge].emit("pointermove", { clientX: 500 + dx, clientY: 400 + dy });
		const after = h.geometry();
		assert.equal(after.left, before.left + (edge.includes("w") ? dx : 0));
		assert.equal(after.right, before.right + (edge.includes("e") ? Math.min(dx, 10) : 0));
		assert.equal(after.top, before.top + (edge.includes("n") ? dy : 0));
		assert.equal(after.bottom, before.bottom + (edge.includes("s") ? dy : 0));
		assert.ok(h.panel.classList.contains("resizing"));
		h.handles[edge].emit("pointerup");
		assert.ok(!h.handles[edge].hasPointerCapture(1));
		assert.ok(!h.panel.classList.contains("resizing"));
		assert.equal(h.prefs.get("steward.ballCorner"), "br");
		assert.equal(h.ball.style.left, undefined, "resize handle 不會拖動球");
	});

	test(`ballPanel ${edge}: 320px 最小及 viewport 最大值,固定對邊`, () => {
		const h = setup(); h.open(); const before = h.geometry();
		h.drag(edge, edge.includes("w") ? 10000 : -10000, edge.includes("n") ? 10000 : -10000);
		const small = h.geometry();
		assert.equal(small.width, /[ew]/.test(edge) ? 320 : before.width);
		assert.equal(small.height, /[ns]/.test(edge) ? 320 : before.height);
		assert.equal(edge.includes("w") ? small.right : small.left, edge.includes("w") ? before.right : before.left);
		assert.equal(edge.includes("n") ? small.bottom : small.top, edge.includes("n") ? before.bottom : before.top);
		h.drag(edge, edge.includes("w") ? -10000 : 10000, edge.includes("n") ? -10000 : 10000);
		const large = h.geometry();
		assert.equal(large.left, edge.includes("w") ? 8 : small.left);
		assert.equal(large.right, edge.includes("e") ? 1392 : small.right);
		assert.equal(large.top, edge.includes("n") ? 8 : small.top);
		assert.equal(large.bottom, edge.includes("s") ? 992 : small.bottom);
	});
}

test("ballPanel 四球角與 board/code/term 對應位置,本輪尺寸保留", () => {
	const h = setup(); h.open(); h.drag("nw", 40, 60);
	for (const mode of ["board", "code", "term"]) {
		h.run(`setMode(${JSON.stringify(mode)})`);
		for (const corner of ["br", "bl", "tr", "tl"]) {
			h.run(`setBallCorner(${JSON.stringify(corner)})`);
			const r = h.geometry();
			assert.equal(r.width, 360); assert.equal(r.height, 500);
			assert.equal(corner.endsWith("l") ? r.left : r.right, corner.endsWith("l") ? 18 : 1382);
			if (corner.startsWith("b")) assert.equal(r.bottom, 920);
			else assert.equal(r.top, mode === "code" ? 232 : mode === "term" ? 158 : 124);
		}
	}
});

test("ballPanel viewport/模式變更限界,短畫面優先可見,手機不寫入桌面幾何", () => {
	const h = setup(); h.open(); h.drag("nw", -500, -300);
	for (const corner of ["br", "bl", "tr", "tl"]) {
		for (const mode of ["board", "code", "term"]) {
			h.run(`setMode(${JSON.stringify(mode)}); setBallCorner(${JSON.stringify(corner)})`);
			for (const [w, height] of [[900, 600], [801, 350], [900, 220], [1400, 1000]]) {
				h.resizeViewport(w, height);
				const r = h.geometry();
				assert.ok(r.left >= 8 && r.top >= 8);
				assert.ok(r.right <= w - 8 && r.bottom <= height - 8);
				assert.ok(r.width >= 320 && r.height >= Math.min(320, height - 16));
			}
		}
	}
	const before = h.geometry(); h.resizeViewport(390, 700);
	h.drag("se", -100, -100);
	assert.deepEqual(h.geometry(), before, "手機沒有更新 desktop CSS variables");
	h.run('toggleBall(false); toggleBall(true); setMode("code"); setBallCorner("tr")');
	assert.deepEqual(h.geometry(), before);
	h.resizeViewport(1400, 1000);
	assert.equal(h.geometry().top, 232);
	assert.equal(h.geometry().width, before.width);
});

test("ballPanel 取消/lostcapture/關閉/換角/切模式/viewport 變更都釋放拖曳", () => {
	for (const stop of ["pointerup", "pointercancel", "lostpointercapture", "close", "corner", "mode", "viewport"]) {
		const h = setup(); h.open(); h.drag("nw", 30, 40, null);
		assert.ok(h.panel.classList.contains("resizing"));
		if (stop === "close") h.run("toggleBall(false)");
		else if (stop === "corner") h.run('setBallCorner("tl")');
		else if (stop === "mode") h.run('setMode("code")');
		else if (stop === "viewport") h.resizeViewport(1200, 800);
		else h.handles.nw.emit(stop);
		const after = h.geometry();
		h.handles.nw.emit("pointermove", { clientX: 100, clientY: 100 });
		assert.deepEqual(h.geometry(), after, stop);
		assert.ok(!h.panel.classList.contains("resizing"), stop);
		assert.ok(!h.handles.nw.hasPointerCapture(1), stop);
		h.open(); h.drag("nw", 5, 5);
		assert.notDeepEqual(h.geometry(), after, "結束後可再拖曳");
	}
});

test("ballPanel 拒絕非 primary/非左鍵/隱藏/手機,拒絕混入第二個 pointerId", () => {
	const h = setup(); const before = h.geometry();
	h.drag("nw", 50, 50);
	assert.deepEqual(h.geometry(), before, "隱藏面板不可拖曳");
	h.open();
	for (const props of [{ isPrimary: false }, { button: 2 }, { button: 1 }]) {
		h.handles.nw.emit("pointerdown", props);
		h.handles.nw.emit("pointermove", { clientX: 600, clientY: 500 });
		assert.deepEqual(h.geometry(), before);
		assert.ok(!h.handles.nw.hasPointerCapture(1));
	}
	h.handles.nw.emit("pointerdown");
	h.handles.se.emit("pointerdown", { pointerId: 2 });
	h.handles.nw.emit("pointermove", { pointerId: 2, clientX: 100, clientY: 100 });
	h.handles.nw.emit("pointercancel", { pointerId: 2 });
	assert.deepEqual(h.geometry(), before);
	assert.ok(h.panel.classList.contains("resizing"));
	h.handles.nw.emit("pointermove", { clientX: 530, clientY: 440 });
	assert.equal(h.geometry().width, 370);
	h.handles.nw.emit("pointerup");
	const mobile = setup({ width: 390, height: 700 }); mobile.open();
	mobile.handles.nw.emit("pointerdown");
	assert.ok(!mobile.handles.nw.hasPointerCapture(1));
	assert.equal(mobile.panel.style["--bp-width"], undefined);
});

test("stewardBall 原有點擊開關/拖曳吸角/長按圈選不受 resize 影響", () => {
	const h = setup();
	h.ball.emit("pointerdown"); h.ball.emit("pointerup");
	assert.equal(h.panel.hidden, false);
	h.drag("nw", 40, 60); const size = h.geometry();
	for (const [x, y, corner] of [[50, 50, "tl"], [1300, 50, "tr"], [50, 900, "bl"], [1300, 900, "br"]]) {
		h.ball.emit("pointerdown"); h.ball.emit("pointermove", { clientX: x, clientY: y });
		assert.ok(h.ball.classList.contains("dragging"));
		h.ball.emit("pointerup", { clientX: x, clientY: y });
		assert.equal(h.$("ballWrap").dataset.corner, corner);
		assert.equal(h.ball.style.left, "");
		assert.ok(!h.ball.classList.contains("dragging"));
		assert.equal(h.geometry().width, size.width); assert.equal(h.geometry().height, size.height);
		assert.equal(h.panel.hidden, false, "球拖曳不切換面板");
	}
	h.ball.emit("pointerdown");
	for (const fn of [...h.timers.values()]) fn();
	h.ball.emit("pointerup");
	assert.equal(h.snaps(), 1); assert.equal(h.panel.hidden, false, "長按不切換面板");
	h.ball.emit("pointerdown"); h.ball.emit("pointerup");
	assert.equal(h.panel.hidden, true);
});

test("ballPanel 極短 viewport 仍限制在畫面內,不藉撐高面板解決控制項溢出", () => {
	for (const height of [180, 120]) {
		const h = setup({ width: 900, height }); h.open();
		assert.equal(h.geometry().top, 8);
		assert.equal(h.geometry().bottom, height - 8);
		assert.equal(h.geometry().height, height - 16);
		h.run('setMode("code"); setBallCorner("tl")');
		assert.equal(h.geometry().top, 8);
		assert.equal(h.geometry().bottom, height - 8);
	}
	const mobile = setup({ width: 390, height: 220 }); mobile.open();
	assert.equal(mobile.panel.style["--bp-height"], undefined, "手機高度仍由 75dvh sheet 樣式管理");
});

test("ballPanel 短畫面 CSS 降級: log 可縮至 60px 以下,主要控制項可捲到,把手不跟著捲", () => {
	// 只驗證實際 markup 與 CSS 約束,不把假 DOM 當作瀏覽器排版引擎。
	const source = html.slice(html.indexOf('<div id="ballPanel"'), html.indexOf('<button id="ballSnap"'));
	const stack = [], nodes = [];
	for (const [, closing, name, attrs] of source.matchAll(/<(\/)?(\w+)\b([^>]*)>/g)) {
		if (closing) {
			assert.equal(stack.pop().tag, name, "panel markup 正確閉合");
			continue;
		}
		const node = { tag: name, id: /\bid="([^"]+)"/.exec(attrs)?.[1], classes: /\bclass="([^"]+)"/.exec(attrs)?.[1]?.split(/\s+/) || [], parent: stack.at(-1) };
		nodes.push(node); stack.push(node);
	}
	assert.equal(stack.length, 0);
	const panel = nodes.find((n) => n.id === "ballPanel");
	const content = nodes.find((n) => n.classes.includes("bp-content"));
	assert.equal(content.parent, panel);
	for (const n of nodes.filter((n) => n.classes.includes("bp-resize"))) assert.equal(n.parent, panel, "把手必須在 scroll wrapper 外");
	for (const n of nodes.filter((n) => n.id === "bpLog" || n.id === "bpForm" || n.classes.includes("bp-head") || n.classes.includes("bp-extras"))) assert.equal(n.parent, content);
	for (const id of ["bpClose", "bpInput", "bpDraft"]) {
		let n = nodes.find((n) => n.id === id);
		while (n && n !== content) n = n.parent;
		assert.equal(n, content, `${id} 位於可捲動降級容器內`);
	}
	const rule = (selector) => {
		const start = html.indexOf(`\n${selector} {`); assert.ok(start >= 0);
		return html.slice(start, html.indexOf("}", start));
	};
	assert.match(rule(".bp-content"), /display: flex; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto;/);
	assert.doesNotMatch(rule(".bp-content"), /position:/, "不可成為 absolute handles 的捲動定位容器");
	assert.match(rule("#ballPanel .bp-log"), /flex-basis: 60px; min-height: 0;/);
	assert.match(rule(".bp-log"), /overflow-y: auto;/, "歷史紀錄仍有自己的 scroll container");
	assert.match(rule(".bp-head"), /flex-shrink: 0;/);
	assert.match(rule("#bpForm"), /flex-shrink: 0;/);
	assert.match(rule(".bp-resize"), /position: absolute;/);
});

test("ballPanel markup/CSS: 八 handle,中段可捲且 log 載入/表單/堆疊順序不改", () => {
	const panel = html.slice(html.indexOf('<div id="ballPanel"'), html.indexOf('<button id="ballSnap"'));
	for (const edge of ["n", "s", "e", "w", "nw", "ne", "sw", "se"]) assert.equal((panel.match(new RegExp(`data-edge="${edge}"`, "g")) || []).length, 1);
	assert.match(panel, /id="bpLog"><\/div>\s*<div class="bp-extras">[\s\S]*id="bpPick" hidden><\/div>\s*<\/div>\s*<form id="bpForm">/);
	assert.match(html, /\.bp-extras \{[^}]*min-height: 0;[^}]*overflow: auto;/);
	assert.match(html, /#bpForm textarea \{[^}]*min-width: 0;/);
	assert.match(html, /\.bp-head \{[^}]*flex-shrink: 0;/);
	assert.match(html, /#bpForm \{[^}]*flex-shrink: 0;/);
	assert.match(html, /@media \(min-width: 801px\) \{\s*body #ballWrap\[data-corner\] #ballPanel.bp-sized/);
	assert.match(html, /@media \(max-width: 800px\) \{\s*\.bp-resize \{ display: none; \}\s*body.code #ballWrap\[data-corner\] #ballPanel, body.term #ballWrap\[data-corner\] #ballPanel,\s*#ballWrap\[data-corner\] #ballPanel \{ left: 0; right: 0; top: auto; bottom: 0; width: 100%; height: 75vh; height: 75dvh;/);
	assert.match(html, /#ballPanel \{ position: fixed; z-index: 57;/);
	assert.match(html, /#stewardBall \{ position: fixed; z-index: 56;/);
	assert.match(html, /\$\("bpLog"\).addEventListener\("scroll",/);
	assert.match(html, /\$\("bpForm"\).onsubmit =/);
	assert.match(html, /\$\("bpDraft"\).onclick =/);
});
