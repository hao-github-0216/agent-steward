import { test } from "node:test";
import assert from "node:assert/strict";
import { moveRect, resizeRect, transformPaths, wrapLines } from "../web/pdf-edit.js";

const rect = [20, 30, 120, 80];
const bounds = [0, 0, 200, 150];
const measure = (text) => Array.from(text).length;

function close(actual, expected) {
	actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-9, `${actual} != ${expected}`));
}

test("moveRect 平移、不改原值，並限制四個頁邊", () => {
	const before = [...rect];
	assert.deepEqual(moveRect(rect, 5, -10), [25, 20, 125, 70]);
	assert.deepEqual(moveRect(rect, -100, -100, { bounds }), [0, 0, 100, 50]);
	assert.deepEqual(moveRect(rect, 1000, 1000, { bounds }), [100, 100, 200, 150]);
	assert.deepEqual(moveRect(rect, 0, 0, { bounds }), rect);
	assert.deepEqual(rect, before);
});

for (const [handle, expected] of [
	["nw", [25, 30, 120, 90]],
	["ne", [20, 30, 125, 90]],
	["sw", [25, 40, 120, 80]],
	["se", [20, 40, 125, 80]],
]) {
	test(`resizeRect ${handle} 固定對角，PDF 北方為 y 增加`, () => {
		assert.deepEqual(resizeRect(rect, handle, 5, 10), expected);
		assert.deepEqual(rect, [20, 30, 120, 80]);
	});
}

for (const handle of ["nw", "ne", "sw", "se"]) {
	test(`resizeRect ${handle} 不翻轉、至少 12pt、限制頁邊`, () => {
		const west = handle[1] === "w", north = handle[0] === "n";
		const shrunk = resizeRect(rect, handle, west ? 1000 : -1000, north ? -1000 : 1000);
		assert.equal(shrunk[2] - shrunk[0], 12);
		assert.equal(shrunk[3] - shrunk[1], 12);
		assert.equal(west ? shrunk[2] : shrunk[0], west ? rect[2] : rect[0]);
		assert.equal(north ? shrunk[1] : shrunk[3], north ? rect[1] : rect[3]);
		const grown = resizeRect(rect, handle, west ? -1000 : 1000, north ? 1000 : -1000, { bounds });
		assert.equal(west ? grown[0] : grown[2], west ? bounds[0] : bounds[2]);
		assert.equal(north ? grown[3] : grown[1], north ? bounds[3] : bounds[1]);
	});
}

test("resizeRect 最小值可設定，頁面不足時以邊界為準", () => {
	assert.deepEqual(resizeRect(rect, "ne", -500, -500, { minSize: 20 }), [20, 30, 40, 50]);
	assert.deepEqual(resizeRect([0, 0, 5, 8], "ne", 100, 100, { bounds: [0, 0, 8, 10] }), [0, 0, 8, 10]);
	assert.throws(() => resizeRect(rect, "n", 1, 1), RangeError);
});

for (const handle of ["nw", "ne", "sw", "se"]) {
	test(`resizeRect ${handle} 保持比例並遵守最小值與邊界`, () => {
		const west = handle[1] === "w", north = handle[0] === "n";
		const grown = resizeRect(rect, handle, west ? -1000 : 1000, north ? 1000 : -1000, { keepAspect: true, bounds });
		close([(grown[2] - grown[0]) / (grown[3] - grown[1])], [2]);
		assert.ok(grown[0] >= bounds[0] && grown[1] >= bounds[1] && grown[2] <= bounds[2] && grown[3] <= bounds[3]);
		const shrunk = resizeRect(rect, handle, west ? 1000 : -1000, north ? -1000 : 1000, { keepAspect: true });
		close([shrunk[2] - shrunk[0], shrunk[3] - shrunk[1]], [24, 12]);
	});
}

test("resizeRect 保持比例時單軸拖曳可放大與縮小", () => {
	assert.deepEqual(resizeRect(rect, "ne", 50, 0, { keepAspect: true }), [20, 30, 170, 105]);
	assert.deepEqual(resizeRect(rect, "ne", -50, 0, { keepAspect: true }), [20, 30, 70, 55]);
	assert.deepEqual(resizeRect(rect, "ne", 0, 25, { keepAspect: true }), [20, 30, 170, 105]);
	assert.deepEqual(resizeRect([0, 0, 4, 2], "ne", 100, 100, { keepAspect: true, bounds: [0, 0, 8, 10] }), [0, 0, 8, 4]);
});

test("transformPaths 映射多段筆跡、文字 quads 且不改原值", () => {
	const paths = [[20, 30, 70, 55, 120, 80], [20, 80]];
	const before = structuredClone(paths);
	assert.deepEqual(transformPaths(paths, rect, [0, 10, 200, 110]), [[0, 10, 100, 60, 200, 110], [0, 110]]);
	const quads = [[20, 80, 120, 80, 20, 30, 120, 30]];
	assert.deepEqual(transformPaths(quads, rect, [0, 10, 200, 110]), [[0, 110, 200, 110, 0, 10, 200, 10]]);
	assert.deepEqual(paths, before);
	assert.deepEqual(transformPaths([], rect, bounds), []);
	assert.deepEqual(transformPaths([[1, 2]], [1, 2, 1, 2], [5, 6, 10, 12]), [[5, 6]]);
});

test("wrapLines 英文按單字，過長單字逐字分行", () => {
	assert.deepEqual(wrapLines("one two three", 7, measure), ["one two", "three"]);
	assert.deepEqual(wrapLines("one two", 6, measure), ["one", "two"]);
	assert.deepEqual(wrapLines("abcdefgh ij", 3, measure), ["abc", "def", "gh", "ij"]);
	assert.deepEqual(wrapLines("a bb", 1, measure), ["a", "b", "b"]);
});

test("wrapLines 中文逐字、中英混合及非等寬量測", () => {
	assert.deepEqual(wrapLines("中文逐字換行", 2, measure), ["中文", "逐字", "換行"]);
	assert.deepEqual(wrapLines("中文 hello 世界", 5, measure), ["中文", "hello", "世界"]);
	assert.deepEqual(wrapLines("Wi Wi", 3, (text) => Array.from(text).reduce((sum, char) => sum + (char === "W" ? 2 : 1), 0)), ["Wi", "Wi"]);
});

test("wrapLines 保留顯式換行、空行，極窄時至少放一字", () => {
	assert.deepEqual(wrapLines("a\n\nb\n", 10, measure), ["a", "", "b", ""]);
	assert.deepEqual(wrapLines("a\r\n\r\nb\r", 10, measure), ["a", "", "b", ""]);
	assert.deepEqual(wrapLines("", 10, measure), [""]);
	assert.deepEqual(wrapLines("\n\n", 10, measure), ["", "", ""]);
	assert.deepEqual(wrapLines("中🙂a", 0, measure), ["中", "🙂", "a"]);
	assert.deepEqual(wrapLines("ab", -1, measure), ["a", "b"]);
});
