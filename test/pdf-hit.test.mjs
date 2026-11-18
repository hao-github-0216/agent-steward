import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hitAnnotation } from "../web/pdf-hit.js";

const ink = { id: "1R", rect: [0, 0, 612, 792], width: 2, paths: [[40, 100, 180, 100, 180, 300]] };
const highlight = { id: "2R", rect: [80, 90, 120, 110], quads: [[80, 110, 120, 110, 80, 90, 120, 90]] };

test("hitAnnotation: 整頁 Ink 與小 Highlight 重疊時回傳 Highlight", () => {
	assert.equal(hitAnnotation([100, 100], [ink, highlight]), highlight);
	assert.equal(hitAnnotation([100, 100], [highlight, ink]), highlight);
});

test("hitAnnotation: 點折線回傳 Ink,整頁矩形內的空白不命中", () => {
	assert.equal(hitAnnotation([60, 100], [ink, highlight]), ink);
	assert.equal(hitAnnotation([180, 250], [ink, highlight]), ink);
	assert.equal(hitAnnotation([300, 400], [ink, highlight]), undefined);
});

test("hitAnnotation: 矩形重疊選面積最小的原物件,不改動輸入", () => {
	const large = Object.freeze({ rect: Object.freeze([0, 0, 100, 100]) });
	const small = Object.freeze({ rect: Object.freeze([20, 20, 40, 40]) });
	const items = Object.freeze([large, small]);
	assert.equal(hitAnnotation(Object.freeze([30, 30]), items), small);
	assert.deepEqual(items, [large, small]);
	assert.equal(hitAnnotation([200, 200], items), undefined);
	assert.equal(hitAnnotation([0, 0], []), undefined);
});

test("hitAnnotation: 新 ops 與舊標註一起比較,由形狀推算新 ops 的矩形", () => {
	const newHighlight = { op: "add", page: 0, type: "highlight", quads: highlight.quads };
	const newInk = { op: "add", page: 0, type: "ink", width: 2, paths: [[0, 100, 612, 100]] };
	assert.equal(hitAnnotation([100, 100], [ink, newHighlight]), newHighlight);
	assert.equal(hitAnnotation([100, 100], [newInk, highlight]), highlight);
	assert.equal(hitAnnotation([200, 100], [newInk, highlight]), newInk);
	const newText = { op: "add", page: 0, type: "freetext", rect: [90, 95, 110, 105] };
	assert.equal(hitAnnotation([100, 100], [newHighlight, newText]), newText);
});

test("hitAnnotation: 四邊形依周界判斷,含斜邊外兩點容差", () => {
	const diamond = { rect: [0, 0, 20, 20], quads: [[0, 10, 10, 20, 10, 0, 20, 10]] };
	assert.equal(hitAnnotation([10, 10], [diamond]), diamond);
	assert.equal(hitAnnotation([1, 19], [diamond]), undefined);
	assert.equal(hitAnnotation([4, 16], [diamond]), diamond);
	assert.equal(hitAnnotation([3, 17], [diamond]), undefined);
});

test("hitAnnotation: 多個 quads 的間隙不命中,邊緣容差為兩點", () => {
	const markup = { rect: [10, 10, 60, 60], quads: [[10, 20, 30, 20, 10, 10, 30, 10], [40, 60, 60, 60, 40, 50, 60, 50]] };
	assert.equal(hitAnnotation([50, 55], [markup]), markup);
	assert.equal(hitAnnotation([35, 35], [markup]), undefined);
	assert.equal(hitAnnotation([20, 22], [markup]), markup);
	assert.equal(hitAnnotation([20, 22.01], [markup]), undefined);
	assert.equal(hitAnnotation([31.5, 21.5], [markup]), undefined);
});

test("hitAnnotation: Ink 使用線寬一半加六點,包含端點與預設線寬", () => {
	const stroke = { rect: [0, 0, 100, 100], paths: [[20, 20, 80, 20]], width: 4 };
	assert.equal(hitAnnotation([50, 28], [stroke]), stroke);
	assert.equal(hitAnnotation([50, 28.01], [stroke]), undefined);
	assert.equal(hitAnnotation([12, 20], [stroke]), stroke);
	assert.equal(hitAnnotation([11.99, 20], [stroke]), undefined);
	const defaultWidth = { rect: stroke.rect, paths: stroke.paths };
	assert.equal(hitAnnotation([50, 26.5], [defaultWidth]), defaultWidth);
	assert.equal(hitAnnotation([50, 26.51], [defaultWidth]), undefined);
});

test("hitAnnotation: Ink 不連接不同 paths,並支援單點與重複點", () => {
	const strokes = { rect: [0, 0, 100, 100], paths: [[10, 10, 20, 10], [80, 90, 90, 90]], width: 0 };
	assert.equal(hitAnnotation([50, 50], [strokes]), undefined);
	const dot = { rect: [10, 10, 30, 30], paths: [[20, 20]], width: 2 };
	assert.equal(hitAnnotation([27, 20], [dot]), dot);
	assert.equal(hitAnnotation([27.01, 20], [dot]), undefined);
	const repeated = { ...dot, paths: [[20, 20, 20, 20]] };
	assert.equal(hitAnnotation([20, 20], [repeated]), repeated);
	assert.equal(hitAnnotation([20, 20], [{ ...dot, paths: [] }]), undefined);
});

test("hitAnnotation: 其他標註只使用外擴兩點的矩形", () => {
	const item = { rect: [10, 10, 20, 20] };
	assert.equal(hitAnnotation([8, 22], [item]), item);
	assert.equal(hitAnnotation([7.99, 20], [item]), undefined);
	assert.equal(hitAnnotation([20, 22.01], [item]), undefined);
});

test("hitAnnotation: 以 rect 面積而非 quads 面積排序,同面積保留輸入順序", () => {
	const wideRect = { ...highlight, rect: [0, 0, 612, 792] };
	const smallRect = { rect: [50, 50, 150, 150] };
	assert.equal(hitAnnotation([100, 100], [wideRect, smallRect]), smallRect);
	const equalRect = { ...smallRect };
	assert.equal(hitAnnotation([100, 100], [smallRect, equalRect]), smallRect);
});

const code = readFileSync(new URL("../web/code.js", import.meta.url), "utf8");
const eraseSource = code.slice(code.indexOf("\tfunction pdfErase("), code.indexOf("\tfunction pdfWirePage("));
function eraseFixture(ops, existing) {
	let changes = 0;
	const erase = new Function("hitAnnotation", "pdfChanged", `${eraseSource}\nreturn pdfErase;`)(hitAnnotation, () => { changes++; });
	const tab = { pdfOps: [...ops] };
	return { tab, erase: (point) => erase(tab, { existing }, 0, point), changes: () => changes };
}

test("pdfErase: 新舊一起比較,舊標註加 remove 且可用原復原操作還原", () => {
	const newInk = { op: "add", page: 0, type: "ink", width: 2, paths: [[0, 100, 612, 100]] };
	const f = eraseFixture([newInk], [highlight]);
	f.erase([100, 100]);
	assert.deepEqual(f.tab.pdfOps, [newInk, { op: "remove", page: 0, ref: highlight.id }]);
	assert.equal(f.changes(), 1);
	f.tab.pdfOps.pop();
	f.erase([100, 100]);
	assert.deepEqual(f.tab.pdfOps, [newInk, { op: "remove", page: 0, ref: highlight.id }]);
	f.erase([100, 100]);
	assert.deepEqual(f.tab.pdfOps, [{ op: "remove", page: 0, ref: highlight.id }]);
});

test("pdfErase: 命中新 op 只移除該筆,排除其他頁與已移除標註,空白不更新", () => {
	const newHighlight = { op: "add", page: 0, type: "highlight", quads: highlight.quads };
	const otherPage = { op: "add", page: 1, type: "freetext", rect: [95, 95, 105, 105] };
	const removed = { op: "remove", page: 0, ref: "3R" };
	const f = eraseFixture([newHighlight, otherPage, removed], [ink, { id: "3R", rect: [95, 95, 105, 105] }]);
	f.erase([100, 100]);
	assert.deepEqual(f.tab.pdfOps, [otherPage, removed]);
	assert.equal(f.changes(), 1);
	f.erase([300, 400]);
	assert.deepEqual(f.tab.pdfOps, [otherPage, removed]);
	assert.equal(f.changes(), 1);
});

test("hitAnnotation: 四邊形角點順序不同(例如右上、左上、右下、左下)也能命中內部", () => {
	const item = { rect: [10, 10, 110, 30], quads: [[110, 30, 10, 30, 110, 10, 10, 10]] };
	assert.equal(hitAnnotation([60, 20], [item]), item);
	assert.equal(hitAnnotation([60, 40], [item]), undefined);
});
