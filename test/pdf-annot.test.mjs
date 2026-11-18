import { test } from "node:test";
import assert from "node:assert/strict";
import * as PDFLib from "pdf-lib";
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
