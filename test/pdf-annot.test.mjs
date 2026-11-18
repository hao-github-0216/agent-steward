import { test } from "node:test";
import assert from "node:assert/strict";
import * as PDFLib from "pdf-lib";
import { getDocumentProxy } from "unpdf";
import { applyAnnotations } from "../web/pdf-annot.js";

const { PDFDocument, PDFName, PDFArray, PDFDict, PDFRawStream, PDFNumber, PDFHexString, PDFString, PDFRef, StandardFonts } = PDFLib;
const name = (s) => PDFName.of(s);
const numbers = (array) => array.asArray().map((v) => v.asNumber());
const quads = [[40, 720, 150, 720, 40, 706, 150, 706], [40, 700, 120, 700, 40, 686, 120, 686]];
const color = [1, 0.85, 0];
const additions = [
	{ op: "add", page: 0, type: "highlight", color, quads },
	{ op: "add", page: 0, type: "underline", color: [0.2, 0.8, 0.3], quads },
	{ op: "add", page: 0, type: "strikeout", color: [0.2, 0.5, 1], quads },
	{ op: "add", page: 0, type: "freetext", color: [1, 0.4, 0.7], rect: [40, 610, 220, 660], text: "Hello (PDF) \\ world\nSecond line", fontSize: 12 },
	{ op: "add", page: 1, type: "freetext", color, rect: [40, 610, 220, 660], text: "中文標註\n第二行 🖊", fontSize: 12 },
	{ op: "add", page: 1, type: "ink", color, width: 2, paths: [[40, 500, 60, 520, 80, 505], [90, 490, 110, 515]] },
];
const subtypes = ["Highlight", "Underline", "StrikeOut", "FreeText", "FreeText", "Ink"];

async function fixture() {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	for (let i = 0; i < 2; i++) doc.addPage([612, 792]).drawText(`Original page ${i + 1}`, { x: 40, y: 740, font, size: 12 });
	return doc.save({ useObjectStreams: false });
}
function annotations(doc, page) {
	return doc.getPage(page).node.lookupMaybe(name("Annots"), PDFArray);
}
function appearance(annot) {
	return annot.lookup(name("AP"), PDFDict).lookup(name("N"), PDFRawStream);
}
function contentStreams(doc, page) {
	const entry = doc.getPage(page).node.get(name("Contents"));
	const obj = doc.context.lookup(entry);
	const refs = obj instanceof PDFArray ? obj.asArray() : [entry];
	return refs.map((ref) => {
		const stream = doc.context.lookup(ref, PDFRawStream);
		return { ref: ref.toString(), dict: stream.dict.toString(), data: Buffer.from(stream.getContents()).toString("base64") };
	});
}

for (const [i, op] of additions.entries()) {
	test(`PDF 標註: ${subtypes[i]} ${i === 4 ? "保留中文" : "有顏色和外觀串流"}`, async () => {
		const bytes = await fixture();
		const out = await applyAnnotations(PDFLib, bytes, [op]);
		assert.ok(out instanceof Uint8Array);
		assert.equal(Buffer.from(out.subarray(0, 5)).toString(), "%PDF-");
		const doc = await PDFDocument.load(out, { updateMetadata: false });
		const list = annotations(doc, op.page);
		assert.equal(list.size(), 1);
		const annot = list.lookup(0, PDFDict);
		assert.equal(annot.lookup(name("Type")).toString(), "/Annot");
		assert.equal(annot.lookup(name("Subtype")).toString(), `/${subtypes[i]}`);
		assert.deepEqual(numbers(annot.lookup(name("C"), PDFArray)), op.color);
		assert.equal(annot.lookup(name("F"), PDFNumber).asNumber(), 4);
		assert.equal(annot.lookup(name("T"), PDFString).decodeText(), "Agent Steward");
		assert.match(annot.lookup(name("M"), PDFString).decodeText(), /^D:\d{14}/);
		assert.equal(annot.get(name("P")).toString(), doc.getPage(op.page).ref.toString());
		const ap = appearance(annot);
		assert.equal(ap.dict.lookup(name("Subtype")).toString(), "/Form");
		assert.deepEqual(numbers(ap.dict.lookup(name("BBox"), PDFArray)), numbers(annot.lookup(name("Rect"), PDFArray)));
		const commands = Buffer.from(ap.getContents()).toString();
		if (op.quads) assert.deepEqual(numbers(annot.lookup(name("QuadPoints"), PDFArray)), quads.flat());
		if (op.type === "highlight") {
			assert.deepEqual(numbers(annot.lookup(name("Rect"), PDFArray)), [39, 685, 151, 721]);
			const gs = ap.dict.lookup(name("Resources"), PDFDict).lookup(name("ExtGState"), PDFDict).lookup(name("GS"), PDFDict);
			assert.equal(gs.lookup(name("BM")).toString(), "/Multiply");
			assert.equal(gs.lookup(name("CA"), PDFNumber).asNumber(), 0.4);
			assert.equal(gs.lookup(name("ca"), PDFNumber).asNumber(), 0.4);
			assert.match(commands, /40 720 m 150 720 l 150 706 l 40 706 l h f/);
		}
		if (op.type === "underline") assert.match(commands, /1 w 40 706 m 150 706 l S/);
		if (op.type === "strikeout") assert.match(commands, /1 w 40 713 m 150 713 l S/);
		if (op.type === "freetext") {
			assert.equal(annot.lookup(name("Contents"), PDFHexString).decodeText(), op.text);
			assert.match(annot.lookup(name("DA"), PDFString).decodeText(), /^\/Helv 12 Tf /);
			assert.ok(ap.dict.lookup(name("Resources"), PDFDict).lookup(name("Font"), PDFDict).has(name("Helv")));
			if (i === 4) { assert.match(commands, /re S/); assert.doesNotMatch(commands, /Tj/); }
			else assert.equal((commands.match(/ Tj/g) || []).length, 2);
		}
		if (op.type === "ink") {
			assert.deepEqual(annot.lookup(name("InkList"), PDFArray).asArray().map((a) => numbers(a)), op.paths);
			assert.equal(annot.lookup(name("BS"), PDFDict).lookup(name("W"), PDFNumber).asNumber(), 2);
			assert.deepEqual(numbers(annot.lookup(name("Rect"), PDFArray)), [37, 487, 113, 523]);
			assert.match(commands, /1 J 1 j/);
		}
	});
}

test("中文文字框可用 PNG 外觀,並保留 Unicode 原文", async () => {
	const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEElEQVR4nGP4z8DwHwohFABFzAf5Zsv/OQAAAABJRU5ErkJggg==", "base64"));
	const op = { ...additions[4], page: 0, text: "中文筆記測試", png };
	const out = await applyAnnotations(PDFLib, await fixture(), [op]);
	const doc = await PDFDocument.load(out, { updateMetadata: false });
	const annot = annotations(doc, 0).lookup(0, PDFDict);
	assert.equal(annot.lookup(name("Subtype")).toString(), "/FreeText");
	assert.equal(annot.lookup(name("Contents"), PDFHexString).decodeText(), op.text);
	assert.match(annot.lookup(name("DA"), PDFString).decodeText(), /^\/Helv 12 Tf /);
	const ap = appearance(annot);
	const image = ap.dict.lookup(name("Resources"), PDFDict).lookup(name("XObject"), PDFDict).lookup(name("Im1"), PDFRawStream);
	assert.equal(image.dict.lookup(name("Subtype")).toString(), "/Image");
	assert.equal(image.dict.lookup(name("Width"), PDFNumber).asNumber(), 2);
	assert.equal(image.dict.lookup(name("Height"), PDFNumber).asNumber(), 2);
	assert.deepEqual(numbers(ap.dict.lookup(name("BBox"), PDFArray)), op.rect);
	assert.match(Buffer.from(ap.getContents()).toString(), /q 180 0 0 50 40 610 cm \/Im1 Do Q/);
});

test("同頁多筆標註與兩頁標註都保留,原本內容串流不變", async () => {
	const bytes = await fixture();
	const before = await PDFDocument.load(bytes, { updateMetadata: false });
	const out = await applyAnnotations(PDFLib, bytes, additions);
	const after = await PDFDocument.load(out, { updateMetadata: false });
	assert.equal(annotations(after, 0).size(), 4);
	assert.equal(annotations(after, 1).size(), 2);
	assert.deepEqual(contentStreams(after, 0), contentStreams(before, 0));
	assert.deepEqual(contentStreams(after, 1), contentStreams(before, 1));
});

test("用 PDF.js 的物件編號R格式刪除既有標註", async () => {
	const first = await applyAnnotations(PDFLib, await fixture(), [additions[0]]);
	const doc = await PDFDocument.load(first);
	const ref = annotations(doc, 0).get(0);
	const out = await applyAnnotations(PDFLib, first, [{ op: "remove", page: 0, ref: `${ref.objectNumber}R` }]);
	const after = await PDFDocument.load(out);
	assert.equal(annotations(after, 0).size(), 0);
});

test("同頁刪除再新增,其他標註不受影響", async () => {
	const first = await applyAnnotations(PDFLib, await fixture(), additions.slice(0, 2));
	const doc = await PDFDocument.load(first);
	const ref = annotations(doc, 0).get(0);
	const out = await applyAnnotations(PDFLib, first, [{ op: "remove", page: 0, ref: `${ref.objectNumber}R` }, additions[2], additions[3]]);
	const after = await PDFDocument.load(out);
	assert.deepEqual(annotations(after, 0).asArray().map((ref) => after.context.lookup(ref).lookup(name("Subtype")).toString()), ["/Underline", "/StrikeOut", "/FreeText"]);
});

test("刪除時物件編號和 generation 都要相符", async () => {
	const doc = await PDFDocument.load(await fixture());
	const ref = PDFRef.of(doc.context.largestObjectNumber + 1, 1);
	doc.context.assign(ref, doc.context.obj({ Type: "Annot", Subtype: "Square", Rect: [1, 1, 20, 20] }));
	doc.getPage(0).node.set(name("Annots"), doc.context.obj([ref]));
	const first = await doc.save({ useObjectStreams: false });
	const unchanged = await applyAnnotations(PDFLib, first, [{ op: "remove", page: 0, ref: `${ref.objectNumber}R` }]);
	assert.equal(annotations(await PDFDocument.load(unchanged), 0).size(), 1);
	const removed = await applyAnnotations(PDFLib, unchanged, [{ op: "remove", page: 0, ref: `${ref.objectNumber}R1` }]);
	assert.equal(annotations(await PDFDocument.load(removed), 0).size(), 0);
});

const pngDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEElEQVR4nGP4z8DwHwohFABFzAf5Zsv/OQAAAABJRU5ErkJggg==";
const pdfjsRef = (ref) => `${ref.objectNumber}R${ref.generationNumber || ""}`;

test("PNG FreeText 重新載入後仍可讀到原字級與 Unicode 文字", async () => {
	const bytes = await applyAnnotations(PDFLib, await fixture(), [{ ...additions[3], text: "中文標註", fontSize: 24, png: pngDataUrl }]);
	const doc = await getDocumentProxy(bytes);
	try {
		const page = await doc.getPage(1);
		const [annotation] = await page.getAnnotations();
		assert.equal(annotation.contentsObj.str, "中文標註");
		assert.equal(annotation.defaultAppearanceData.fontSize, 24);
	} finally { await doc.loadingTask.destroy(); }
});

test("update 同檔修改 PNG FreeText 與 Ink、刪除其他標註，頁面內容不變", async () => {
	const bytes = await applyAnnotations(PDFLib, await fixture(), [
		{ ...additions[3], png: pngDataUrl },
		{ ...additions[5], page: 0 }, additions[0], additions[1],
	]);
	const before = await PDFDocument.load(bytes);
	const refs = annotations(before, 0).asArray();
	const inkPaths = [[60, 400, 70, 430, 100, 405], [95, 395, 125, 425]];
	const textRect = [50, 600, 300, 680], inkRect = [55, 390, 130, 435];
	const out = await applyAnnotations(PDFLib, bytes, [
		{ op: "update", page: 0, ref: pdfjsRef(refs[0]), text: "Updated text\nNext line", fontSize: 18, rect: textRect },
		{ op: "update", page: 0, ref: pdfjsRef(refs[1]), paths: inkPaths, rect: inkRect },
		{ op: "remove", page: 0, ref: pdfjsRef(refs[2]) },
		{ op: "update", page: 0, ref: pdfjsRef(refs[2]), text: "Must not return", rect: [0, 0, 50, 50] },
		{ op: "update", page: 0, ref: "999999R", text: "Missing" },
	]);
	const after = await PDFDocument.load(out);
	const list = annotations(after, 0);
	assert.deepEqual(list.asArray().map(String), [refs[0], refs[1], refs[3]].map(String));
	const freetext = list.lookup(0, PDFDict), ink = list.lookup(1, PDFDict);
	assert.equal(freetext.lookup(name("Contents"), PDFHexString).decodeText(), "Updated text\nNext line");
	assert.equal(freetext.lookup(name("DA"), PDFString).decodeText(), "/Helv 18 Tf 1 0.4 0.7 rg");
	assert.deepEqual(numbers(freetext.lookup(name("Rect"), PDFArray)), textRect);
	assert.deepEqual(numbers(appearance(freetext).dict.lookup(name("BBox"), PDFArray)), textRect);
	const resources = appearance(freetext).dict.lookup(name("Resources"), PDFDict);
	assert.ok(resources.lookup(name("Font"), PDFDict).has(name("Helv")));
	assert.ok(!resources.has(name("XObject")));
	assert.match(Buffer.from(appearance(freetext).getContents()).toString(), /\/Helv 18 Tf/);
	assert.equal((Buffer.from(appearance(freetext).getContents()).toString().match(/ Tj/g) || []).length, 2);
	assert.deepEqual(numbers(ink.lookup(name("Rect"), PDFArray)), inkRect);
	assert.deepEqual(ink.lookup(name("InkList"), PDFArray).asArray().map(numbers), inkPaths);
	assert.deepEqual(numbers(ink.lookup(name("C"), PDFArray)), additions[5].color);
	assert.equal(ink.lookup(name("BS"), PDFDict).lookup(name("W"), PDFNumber).asNumber(), 2);
	assert.deepEqual(numbers(appearance(ink).dict.lookup(name("BBox"), PDFArray)), inkRect);
	assert.match(Buffer.from(appearance(ink).getContents()).toString(), /2 w\n1 J 1 j\n60 400 m\n70 430 l\n100 405 l\nS/);
	assert.equal(list.lookup(2, PDFDict).toString(), annotations(before, 0).lookup(3, PDFDict).toString());
	for (const page of [0, 1]) assert.deepEqual(contentStreams(after, page), contentStreams(before, page));
});

for (const png of [pngDataUrl, new Uint8Array(Buffer.from(pngDataUrl.split(",")[1], "base64"))]) {
	test(`update FreeText ${typeof png === "string" ? "data URL" : "Uint8Array"} PNG 外觀及 Unicode 文字`, async () => {
		const bytes = await applyAnnotations(PDFLib, await fixture(), [additions[3]]);
		const before = await PDFDocument.load(bytes);
		const ref = annotations(before, 0).get(0);
		const rect = [10, 20, 210, 80];
		const out = await applyAnnotations(PDFLib, bytes, [{ op: "update", page: 0, ref: pdfjsRef(ref), text: "更新中文", color: [0, 0.5, 1], fontSize: 24, rect, png }]);
		const annot = annotations(await PDFDocument.load(out), 0).lookup(0, PDFDict);
		assert.equal(annot.lookup(name("Contents"), PDFHexString).decodeText(), "更新中文");
		assert.equal(annot.lookup(name("DA"), PDFString).decodeText(), "/Helv 24 Tf 0 0.5 1 rg");
		assert.deepEqual(numbers(annot.lookup(name("C"), PDFArray)), [0, 0.5, 1]);
		const ap = appearance(annot);
		assert.deepEqual(numbers(ap.dict.lookup(name("BBox"), PDFArray)), rect);
		assert.equal(ap.dict.lookup(name("Resources"), PDFDict).lookup(name("XObject"), PDFDict).lookup(name("Im1"), PDFRawStream).dict.lookup(name("Subtype")).toString(), "/Image");
		assert.match(Buffer.from(ap.getContents()).toString(), /BT\n\/Helv 24 Tf\n\(\) Tj\nET/);
		assert.ok(ap.dict.lookup(name("Resources"), PDFDict).lookup(name("Font"), PDFDict).has(name("Helv")));
		assert.match(Buffer.from(ap.getContents()).toString(), /q 200 0 0 60 10 20 cm \/Im1 Do Q/);
	});
}

test("update FreeText 僅修改字級或顏色時保留其他欄位，空字串可清空", async () => {
	let bytes = await applyAnnotations(PDFLib, await fixture(), [additions[3]]);
	const ref = pdfjsRef(annotations(await PDFDocument.load(bytes), 0).get(0));
	bytes = await applyAnnotations(PDFLib, bytes, [{ op: "update", page: 0, ref, fontSize: 20 }]);
	bytes = await applyAnnotations(PDFLib, bytes, [{ op: "update", page: 0, ref, color: [0, 0, 1] }]);
	let annot = annotations(await PDFDocument.load(bytes), 0).lookup(0, PDFDict);
	assert.equal(annot.lookup(name("Contents"), PDFHexString).decodeText(), additions[3].text);
	assert.equal(annot.lookup(name("DA"), PDFString).decodeText(), "/Helv 20 Tf 0 0 1 rg");
	assert.deepEqual(numbers(annot.lookup(name("Rect"), PDFArray)), additions[3].rect);
	bytes = await applyAnnotations(PDFLib, bytes, [{ op: "update", page: 0, ref, text: "" }]);
	annot = annotations(await PDFDocument.load(bytes), 0).lookup(0, PDFDict);
	assert.equal(annot.lookup(name("Contents"), PDFHexString).decodeText(), "");
});

test("update ref 必須在指定頁且 generation 相符，不存在或格式錯誤略過", async () => {
	const doc = await PDFDocument.load(await fixture());
	const ref = PDFRef.of(doc.context.largestObjectNumber + 1, 2);
	doc.context.assign(ref, doc.context.obj({ Type: "Annot", Subtype: "Square", Rect: [1, 2, 20, 30] }));
	doc.getPage(0).node.set(name("Annots"), doc.context.obj([ref]));
	const bytes = await doc.save({ useObjectStreams: false });
	const unchanged = await applyAnnotations(PDFLib, bytes, [
		{ op: "update", page: 0, ref: `${ref.objectNumber}R`, rect: [5, 6, 40, 50] },
		{ op: "update", page: 1, ref: `${ref.objectNumber}R2`, rect: [5, 6, 40, 50] },
		{ op: "update", page: 0, ref: "invalid", rect: [5, 6, 40, 50] },
		{ op: "update", page: 0, ref: "99999R", rect: [5, 6, 40, 50] },
	]);
	assert.deepEqual(numbers(annotations(await PDFDocument.load(unchanged), 0).lookup(0, PDFDict).lookup(name("Rect"), PDFArray)), [1, 2, 20, 30]);
	const updated = await applyAnnotations(PDFLib, unchanged, [{ op: "update", page: 0, ref: `${ref.objectNumber}R2`, rect: [5, 6, 40, 50] }]);
	assert.deepEqual(numbers(annotations(await PDFDocument.load(updated), 0).lookup(0, PDFDict).lookup(name("Rect"), PDFArray)), [5, 6, 40, 50]);
});

test("update 僅改 Rect 時以 Matrix 將原 BBox 對應到新 Rect，保留 PNG 外觀", async () => {
	const bytes = await applyAnnotations(PDFLib, await fixture(), [{ ...additions[3], png: pngDataUrl }, additions[0]]);
	const before = await PDFDocument.load(bytes);
	const refs = annotations(before, 0).asArray();
	const rect = [10, 20, 370, 120];
	const out = await applyAnnotations(PDFLib, bytes, refs.map((ref) => ({ op: "update", page: 0, ref: pdfjsRef(ref), rect })));
	const after = await PDFDocument.load(out);
	for (let i = 0; i < 2; i++) {
		const annot = annotations(after, 0).lookup(i, PDFDict);
		const original = appearance(annotations(before, 0).lookup(i, PDFDict));
		const ap = appearance(annot);
		assert.deepEqual(numbers(annot.lookup(name("Rect"), PDFArray)), rect);
		const bbox = numbers(ap.dict.lookup(name("BBox"), PDFArray));
		assert.deepEqual(bbox, numbers(original.dict.lookup(name("BBox"), PDFArray)));
		assert.deepEqual(ap.getContents(), original.getContents());
		const [a, b, c, d, e, f] = numbers(ap.dict.lookup(name("Matrix"), PDFArray));
		const mapped = [a * bbox[0] + c * bbox[1] + e, b * bbox[0] + d * bbox[1] + f, a * bbox[2] + c * bbox[3] + e, b * bbox[2] + d * bbox[3] + f];
		mapped.forEach((value, axis) => assert.ok(Math.abs(value - rect[axis]) < 1e-8));
	}
	assert.ok(appearance(annotations(after, 0).lookup(0, PDFDict)).dict.lookup(name("Resources"), PDFDict).has(name("XObject")));
});

test("update Ink 原始顏色和線寬未設定時使用黑色及 1pt", async () => {
	const doc = await PDFDocument.load(await fixture());
	const annot = doc.context.obj({ Type: "Annot", Subtype: "Ink", Rect: [0, 0, 30, 30], InkList: [[1, 2, 3, 4]] });
	const ref = doc.context.register(annot);
	doc.getPage(0).node.set(name("Annots"), doc.context.obj([ref]));
	const bytes = await doc.save({ useObjectStreams: false });
	const out = await applyAnnotations(PDFLib, bytes, [{ op: "update", page: 0, ref: pdfjsRef(ref), paths: [[5, 6, 7, 8]] }]);
	const after = annotations(await PDFDocument.load(out), 0).lookup(0, PDFDict);
	assert.equal(after.lookup(name("BS"), PDFDict).lookup(name("W"), PDFNumber).asNumber(), 1);
	assert.match(Buffer.from(appearance(after).getContents()).toString(), /0 0 0 RG\n0 0 0 rg\n1 w/);
});

test("add Ink 明確提供 Rect 時保留指定範圍及筆跡", async () => {
	const op = { ...additions[5], page: 0, rect: [30, 480, 130, 540] };
	const bytes = await applyAnnotations(PDFLib, await fixture(), [op]);
	const annot = annotations(await PDFDocument.load(bytes), 0).lookup(0, PDFDict);
	assert.deepEqual(numbers(annot.lookup(name("Rect"), PDFArray)), op.rect);
	assert.deepEqual(numbers(appearance(annot).dict.lookup(name("BBox"), PDFArray)), op.rect);
	assert.deepEqual(annot.lookup(name("InkList"), PDFArray).asArray().map(numbers), op.paths);
});

for (const [color, rgb] of [[[0.4], [0.4, 0.4, 0.4]], [[0.1, 0.2, 0.3, 0.4], [0.5, 0.4, 0.3]]]) {
	test(`update Ink 保留 ${color.length === 1 ? "灰階" : "CMYK"} 原色與 Border 線寬`, async () => {
		const doc = await PDFDocument.load(await fixture());
		const ref = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Ink", Rect: [0, 0, 30, 30], InkList: [[1, 2, 3, 4]], C: color, Border: [0, 0, 3] }));
		doc.getPage(0).node.set(name("Annots"), doc.context.obj([ref]));
		const bytes = await doc.save({ useObjectStreams: false });
		const out = await applyAnnotations(PDFLib, bytes, [{ op: "update", page: 0, ref: pdfjsRef(ref), paths: [[5, 6, 7, 8]] }]);
		const after = annotations(await PDFDocument.load(out), 0).lookup(0, PDFDict);
		assert.deepEqual(numbers(after.lookup(name("C"), PDFArray)), color);
		assert.equal(after.lookup(name("BS"), PDFDict).lookup(name("W"), PDFNumber).asNumber(), 3);
		const commands = Buffer.from(appearance(after).getContents()).toString();
		const actualRgb = /([\d.]+) ([\d.]+) ([\d.]+) RG/.exec(commands).slice(1).map(Number);
		actualRgb.forEach((value, i) => assert.ok(Math.abs(value - rgb[i]) < 1e-9));
		assert.match(commands, /3 w/);
	});
}

test("update Rect 保留旋轉 Matrix 且不修改共用外觀的其他標註", async () => {
	const doc = await PDFDocument.load(await fixture());
	const stream = doc.context.register(doc.context.stream("q 0 0 10 20 re S Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 20], Matrix: [0, 1, -1, 0, 20, 0] }));
	const ap = doc.context.register(doc.context.obj({ N: stream }));
	const refs = [0, 1].map(() => doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Square", Rect: [0, 0, 20, 10], AP: ap })));
	doc.getPage(0).node.set(name("Annots"), doc.context.obj(refs));
	const out = await applyAnnotations(PDFLib, await doc.save({ useObjectStreams: false }), [{ op: "update", page: 0, ref: pdfjsRef(refs[0]), rect: [10, 20, 50, 50] }]);
	const list = annotations(await PDFDocument.load(out), 0);
	assert.deepEqual(numbers(appearance(list.lookup(0, PDFDict)).dict.lookup(name("Matrix"), PDFArray)), [0, 3, -2, 0, 50, 20]);
	assert.deepEqual(numbers(appearance(list.lookup(1, PDFDict)).dict.lookup(name("Matrix"), PDFArray)), [0, 1, -1, 0, 20, 0]);
	assert.deepEqual(appearance(list.lookup(0, PDFDict)).getContents(), appearance(list.lookup(1, PDFDict)).getContents());
});

test("update Rect 可調整具外觀狀態的 AP N", async () => {
	const doc = await PDFDocument.load(await fixture());
	const stream = doc.context.register(doc.context.stream("q Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 20] }));
	const ref = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Stamp", Rect: [0, 0, 10, 20], AP: { N: { On: stream, Off: stream } }, AS: "On" }));
	doc.getPage(0).node.set(name("Annots"), doc.context.obj([ref]));
	const out = await applyAnnotations(PDFLib, await doc.save({ useObjectStreams: false }), [{ op: "update", page: 0, ref: pdfjsRef(ref), rect: [10, 20, 30, 80] }]);
	const annot = annotations(await PDFDocument.load(out), 0).lookup(0, PDFDict);
	const states = annot.lookup(name("AP"), PDFDict).lookup(name("N"), PDFDict);
	for (const state of ["On", "Off"]) assert.deepEqual(numbers(states.lookup(name(state), PDFRawStream).dict.lookup(name("Matrix"), PDFArray)), [2, 0, 0, 3, 10, 20]);
	assert.equal(annot.lookup(name("AS")).toString(), "/On");
});
