import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

const dir = mkdtempSync(join(tmpdir(), "steward-doc-text-"));
const home = join(dir, "home"), data = join(dir, "data"), root = join(dir, "project");
for (const path of [home, data, root]) mkdirSync(path);
const previous = Object.fromEntries(["HOME", "USERPROFILE", "STEWARD_DATA_DIR"].map((key) => [key, process.env[key]]));
Object.assign(process.env, { HOME: home, USERPROFILE: home, STEWARD_DATA_DIR: data });
writeFileSync(join(data, "settings.json"), JSON.stringify({ ui: { lang: "zh-TW" }, access: { tailscale: { enabled: false } }, plugins: { notebook: { pythons: [] } }, setupDone: true }));
after(() => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(dir, { recursive: true, force: true });
});
const { documentText } = await import("../src/doc-text.ts");
const { CHAT_FILE_LIMIT, fileForChat } = await import("../src/code.ts");
const { updateSettings } = await import("../src/settings.ts");

const project = { root, id: "doc-text", name: "Document text", kind: "project", status: "active", private: false };
const save = (name, content) => { const path = join(root, name); writeFileSync(path, content); return path; };
const textPage = (text) => `BT /F1 12 Tf 72 720 Td (${text.replace(/[\\()]/g, "\\$&")}) Tj ET`;

/** 產生 Helvetica PDF,依實際位元組長度填入 xref。 */
function pdf(streams) {
	const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
	const pages = [];
	for (const stream of streams) {
		const page = objects.length + 1;
		pages.push(`${page} 0 R`);
		objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R >>`);
		objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
	}
	objects[1] = `<< /Type /Pages /Kids [${pages.join(" ")}] /Count ${pages.length} >>`;
	let out = "%PDF-1.4\n";
	const offsets = [0];
	objects.forEach((object, i) => {
		offsets.push(Buffer.byteLength(out));
		out += `${i + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = Buffer.byteLength(out);
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out);
}

function crc32(buf) {
	let crc = 0xffffffff;
	for (const byte of buf) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** 產生中央目錄與 local header;預設每個成員都不壓縮。 */
function zip(entries, method = 0) {
	const locals = [], central = [];
	let offset = 0;
	for (const [path, content] of entries) {
		const name = Buffer.from(path), data = Buffer.from(content);
		const packed = method === 8 ? deflateRawSync(data) : data;
		const checksum = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x800, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(packed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, packed);
		const record = Buffer.alloc(46);
		record.writeUInt32LE(0x02014b50);
		record.writeUInt16LE(20, 4);
		record.writeUInt16LE(20, 6);
		record.writeUInt16LE(0x800, 8);
		record.writeUInt16LE(method, 10);
		record.writeUInt32LE(checksum, 16);
		record.writeUInt32LE(packed.length, 20);
		record.writeUInt32LE(data.length, 24);
		record.writeUInt16LE(name.length, 28);
		record.writeUInt32LE(offset, 42);
		central.push(record, name);
		offset += local.length + name.length + packed.length;
	}
	const directory = Buffer.concat(central), end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

const word = (body) => `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
const paragraph = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const slide = (text) => `<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;

test("PDF:擷取文字並標示第 1 頁", async () => {
	const path = save("text.pdf", pdf([textPage("Hello DP table for edit distance results")]));
	const result = await documentText(path, ".pdf");
	assert.match(result.text, /--- 第 1 頁 ---/);
	assert.match(result.text, /Hello DP table/);
	assert.equal(result.note, undefined);
});

test("PDF:只有圖形或不足 20 字時回掃描檔建議,不把頁碼算成文字", async () => {
	const shapes = save("shapes.pdf", pdf(Array(4).fill("0 0 50 50 re S")));
	assert.match((await documentText(shapes, ".pdf")).note, /可能是掃描檔或圖片.*截圖.*＋ 圖片/);
	const short = save("short.pdf", pdf([textPage("Hello DP table")]));
	assert.equal((await documentText(short, ".pdf")).text, undefined);
	const nineteen = save("nineteen.pdf", pdf([textPage("a".repeat(19))]));
	assert.match((await documentText(nineteen, ".pdf")).note, /沒有可以擷取的文字/);
	const twenty = save("twenty.pdf", pdf([textPage("a".repeat(20))]));
	assert.match((await documentText(twenty, ".pdf")).text, /a{20}/);
});

test("PDF:解析失敗回傳原因,不丟例外", async () => {
	const result = await documentText(save("broken.pdf", "not a PDF"), ".pdf");
	assert.match(result.note, /^PDF 打不開：.+/);
	assert.equal(result.text, undefined);
});

test("DOCX:兩段、tab、換行、表格與 XML 實體", async () => {
	const body = paragraph("Hello &amp; &lt; &gt; &quot; &apos; &#65; &#x4E2D;")
		+ '<w:p><w:r><w:t>Second</w:t><w:tab/><w:t>column</w:t><w:br/><w:t>line</w:t></w:r></w:p>'
		+ `<w:tbl><w:tr><w:tc>${paragraph("left")}</w:tc><w:tc>${paragraph("right")}</w:tc></w:tr></w:tbl>`;
	const result = await documentText(save("table.docx", zip([["word/document.xml", word(body)]])), ".docx");
	assert.equal(result.text, 'Hello & < > " \' A 中\nSecond\tcolumn\nline\nleft | right');
});

test("PPTX:依投影片編號排序,段落換行並附上講者備註", async () => {
	const result = await documentText(save("slides.pptx", zip([
		["ppt/slides/slide2.xml", slide("Second slide")],
		["ppt/notesSlides/notesSlide1.xml", slide("Speaker note")],
		["ppt/slides/slide1.xml", '<p:sld><a:p><a:r><a:t>First &amp; </a:t></a:r><a:r><a:t>slide</a:t></a:r></a:p><a:p><a:r><a:t>Next paragraph</a:t></a:r></a:p></p:sld>'],
	])), ".pptx");
	assert.equal(result.text, "--- 投影片 1 ---\nFirst & slide\nNext paragraph\n（備註）\nSpeaker note\n\n--- 投影片 2 ---\nSecond slide");
});

const sheetEntries = [
	["xl/sharedStrings.xml", '<sst><si><r><t>Shared &amp; </t></r><r><t>rich text</t></r></si></sst>'],
	["xl/workbook.xml", '<workbook><sheets><sheet name="Results &amp; totals" sheetId="2" r:id="rId2"/><sheet name="Second" sheetId="1" r:id="rId1"/></sheets></workbook>'],
	["xl/worksheets/sheet1.xml", '<worksheet><sheetData><row><c r="A1"><v>7</v></c></row></sheetData></worksheet>'],
	["xl/worksheets/sheet2.xml", '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>42.5</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Inline &#x41;</t></is></c><c r="B2"><f>1+2</f><v>3</v></c></row></sheetData></worksheet>'],
];

test("XLSX / XLSM:工作表名稱與順序、共用字串、inlineStr、數值及空欄", async () => {
	for (const ext of [".xlsx", ".xlsm"]) {
		const result = await documentText(save(`results${ext}`, zip(sheetEntries)), ext);
		assert.equal(result.text, "--- 工作表 Results & totals ---\nShared & rich text\t\t42.5\nInline A\t3\n--- 工作表 Second ---\n7");
	}
});

test("XLSX:依 workbook 關聯找到工作表,整份最多帶 2000 列", async () => {
	const rows = (count, prefix) => Array.from({ length: count }, (_, i) => `<row><c t="inlineStr"><is><t>${prefix}${i + 1}</t></is></c></row>`).join("");
	const result = await documentText(save("many.xlsx", zip([
		["xl/workbook.xml", '<workbook><sheets><sheet name="One" sheetId="50" r:id="one"/><sheet name="Two" sheetId="60" r:id="two"/></sheets></workbook>'],
		["xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="one" Target="worksheets/sheet1.xml"/><Relationship Id="two" Target="/xl/worksheets/sheet2.xml"/></Relationships>'],
		["xl/worksheets/sheet1.xml", `<worksheet><sheetData>${rows(1500, "one-")}</sheetData></worksheet>`],
		["xl/worksheets/sheet2.xml", `<worksheet><sheetData>${rows(1000, "two-")}</sheetData></worksheet>`],
	])), ".xlsx");
	assert.ok(result.text.endsWith("two-500"));
	assert.ok(!result.text.includes("two-501"));
	assert.equal(result.text.split("\n").filter((line) => !line.startsWith("---")).length, 2000);
});

test("舊版 .doc / .ppt / .xls:說明另存格式", async () => {
	for (const ext of [".doc", ".ppt", ".xls"]) {
		assert.match((await documentText(save(`legacy${ext}`, Buffer.from([0xd0, 0xcf, 0x11, 0xe0])), ext)).note, /舊版 Office 格式.*另存成 \.docx\/\.pptx\/\.xlsx 或 PDF/);
	}
});

test("ZIP:壞檔、加密、ZIP64 與不支援的壓縮回 note,不丟例外", async () => {
	for (const [name, content] of [["broken", Buffer.from("not a zip")], ["truncated", zip([["word/document.xml", word(paragraph("test"))]]).subarray(0, 30)]]) {
		assert.match((await documentText(save(`${name}.docx`, content), ".docx")).note, /ZIP 結構不完整或已損壞/);
	}
	const encrypted = zip([["word/document.xml", word(paragraph("test"))]]);
	const central = encrypted.readUInt32LE(encrypted.length - 6);
	encrypted.writeUInt16LE(1, central + 8);
	assert.match((await documentText(save("encrypted.docx", encrypted), ".docx")).note, /已加密.*移除密碼/);
	const zip64 = zip([["word/document.xml", word(paragraph("test"))]]);
	zip64.writeUInt16LE(0xffff, zip64.length - 12);
	assert.match((await documentText(save("zip64.docx", zip64), ".docx")).note, /不支援 ZIP64/);
	const unsupported = zip([["word/document.xml", word(paragraph("test"))]], 12);
	assert.match((await documentText(save("unsupported.docx", unsupported), ".docx")).note, /不支援 ZIP 壓縮方式 12/);
});

test("ZIP:method 8 的 Office 檔可以解壓,過大的展開內容會拒絕", async () => {
	const packed = zip([["word/document.xml", word(paragraph("deflated text"))]], 8);
	assert.equal((await documentText(save("deflated.docx", packed), ".docx")).text, "deflated text");
	const oversized = Buffer.from(packed), central = oversized.readUInt32LE(oversized.length - 6);
	oversized.writeUInt32LE(50 * 1024 * 1024 + 1, central + 24);
	assert.match((await documentText(save("expanded.docx", oversized), ".docx")).note, /解壓縮後的內容太大/);
});

test("檔案大於 50MB:PDF 與 Office 都回檔案太大", async () => {
	for (const ext of [".pdf", ".docx"]) {
		const name = `large${ext}`, path = save(name, "");
		truncateSync(path, 50 * 1024 * 1024 + 1);
		assert.deepEqual(await documentText(path, ext), { note: "檔案太大" });
		assert.deepEqual(await fileForChat(project, name), { path: name, note: "檔案太大" });
	}
});

test("fileForChat:PDF 回文字,圖片回附圖建議,拒絕 ../ 與 symlink 跳出專案", async (t) => {
	const result = await fileForChat(project, "text.pdf");
	assert.match(result.text, /--- 第 1 頁 ---\nHello DP table/);
	assert.equal(result.converted, true);
	writeFileSync(join(dir, "outside.pdf"), readFileSync(join(root, "text.pdf")));
	await assert.rejects(fileForChat(project, "../outside.pdf"), /路徑不在專案資料夾內/);
	await assert.rejects(fileForChat(project, "../outside.pdf", "supplied content"), /路徑不在專案資料夾內/);
	save("image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	assert.deepEqual(await fileForChat(project, "image.png"), { path: "image.png", note: "這是圖片，請用「＋ 圖片」附上" });
	try { symlinkSync(join(dir, "outside.pdf"), join(root, "linked.pdf"), "file"); }
	catch (e) { if (e.code === "EPERM") { t.diagnostic("此環境無法建立 symlink,略過 symlink 斷言"); return; } throw e; }
	await assert.rejects(fileForChat(project, "linked.pdf"), /路徑不在專案資料夾內/);
});

test("fileForChat:Office 轉出的長文字仍只帶頭尾,純文字與編輯器版本照常", async () => {
	const text = "A".repeat(CHAT_FILE_LIMIT / 2) + "middle".repeat(50) + "Z".repeat(CHAT_FILE_LIMIT / 2);
	save("long.docx", zip([["word/document.xml", word(paragraph(text))]]));
	const result = await fileForChat(project, "long.docx");
	assert.ok(result.text.startsWith("A".repeat(CHAT_FILE_LIMIT / 2)));
	assert.ok(result.text.endsWith("Z".repeat(CHAT_FILE_LIMIT / 2)));
	assert.match(result.text, /中間省略 300 字/);
	assert.ok(!result.text.includes("middle"));
	save("plain.txt", "disk");
	assert.deepEqual(await fileForChat(project, "plain.txt"), { path: "plain.txt", text: "disk" });
	assert.deepEqual(await fileForChat(project, "plain.txt", "unsaved"), { path: "plain.txt", text: "unsaved" });
});

test("新增的 note 與頁面、投影片、工作表標記都有英文", async () => {
	updateSettings({ ui: { lang: "en" } });
	try {
		assert.match((await documentText(join(root, "shapes.pdf"), ".pdf")).note, /no extractable text.*screenshots.*\+ Image/);
		assert.match((await documentText(join(root, "legacy.doc"), ".doc")).note, /Legacy Office files/);
		assert.match((await documentText(join(root, "broken.docx"), ".docx")).note, /Could not open the Office file.*ZIP structure/);
		assert.match((await documentText(join(root, "text.pdf"), ".pdf")).text, /--- Page 1 ---/);
		assert.match((await documentText(join(root, "slides.pptx"), ".pptx")).text, /--- Slide 1 ---[\s\S]*\(Speaker notes\)/);
		assert.match((await documentText(join(root, "results.xlsx"), ".xlsx")).text, /--- Sheet Results & totals ---/);
		assert.match((await fileForChat(project, "image.png")).note, /This is an image/);
	} finally { updateSettings({ ui: { lang: "zh-TW" } }); }
});
