import { readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import { inflateRawSync } from "node:zlib";
import { extractText, getDocumentProxy } from "unpdf";
import { tr } from "./i18n.ts";

const DOCUMENT_LIMIT = 50 * 1024 * 1024;
const ROW_LIMIT = 2000;

type ZipEntry = { method: number; size: number; compressed: number; offset: number };

/** 從中央目錄找出 ZIP 成員,只解開需要的 XML,不寫入磁碟。 */
function readZip(buf: Buffer) {
	const invalid = () => new Error(tr("ZIP 結構不完整或已損壞"));
	let end = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
		if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) { end = i; break; }
	}
	if (end < 0) throw invalid();
	const count = buf.readUInt16LE(end + 10);
	const size = buf.readUInt32LE(end + 12);
	const start = buf.readUInt32LE(end + 16);
	if (count === 0xffff || size === 0xffffffff || start === 0xffffffff || (end >= 20 && buf.readUInt32LE(end - 20) === 0x07064b50)) {
		throw new Error(tr("不支援 ZIP64，請另存成一般 Office 檔或 PDF 再附上"));
	}
	if (buf.readUInt16LE(end + 4) || buf.readUInt16LE(end + 6) || buf.readUInt16LE(end + 8) !== count) {
		throw new Error(tr("不支援分割的 ZIP，請另存成一般 Office 檔或 PDF 再附上"));
	}
	if (start + size > end) throw invalid();
	const files = new Map<string, ZipEntry>();
	let at = start;
	for (let i = 0; i < count; i++) {
		if (at + 46 > start + size || buf.readUInt32LE(at) !== 0x02014b50) throw invalid();
		const flags = buf.readUInt16LE(at + 8);
		const method = buf.readUInt16LE(at + 10);
		const compressed = buf.readUInt32LE(at + 20);
		const expanded = buf.readUInt32LE(at + 24);
		const nameLength = buf.readUInt16LE(at + 28);
		const extraLength = buf.readUInt16LE(at + 30);
		const commentLength = buf.readUInt16LE(at + 32);
		const disk = buf.readUInt16LE(at + 34);
		const offset = buf.readUInt32LE(at + 42);
		const next = at + 46 + nameLength + extraLength + commentLength;
		if (next > start + size) throw invalid();
		if (compressed === 0xffffffff || expanded === 0xffffffff || offset === 0xffffffff || disk === 0xffff) {
			throw new Error(tr("不支援 ZIP64，請另存成一般 Office 檔或 PDF 再附上"));
		}
		if (disk) throw new Error(tr("不支援分割的 ZIP，請另存成一般 Office 檔或 PDF 再附上"));
		if (flags & 0x41) throw new Error(tr("Office 檔案已加密，請移除密碼或另存成 PDF 再附上"));
		if (method !== 0 && method !== 8) throw new Error(tr("不支援 ZIP 壓縮方式 {method}，請另存成 PDF 再附上", { method }));
		const extraEnd = at + 46 + nameLength + extraLength;
		for (let extra = at + 46 + nameLength; extra < extraEnd;) {
			if (extra + 4 > extraEnd) throw invalid();
			if (buf.readUInt16LE(extra) === 1) throw new Error(tr("不支援 ZIP64，請另存成一般 Office 檔或 PDF 再附上"));
			extra += 4 + buf.readUInt16LE(extra + 2);
			if (extra > extraEnd) throw invalid();
		}
		const name = buf.subarray(at + 46, at + 46 + nameLength).toString("utf8");
		files.set(name, { method, size: expanded, compressed, offset });
		at = next;
	}
	if (at !== start + size) throw invalid();
	const cache = new Map<string, string>();
	let expandedBytes = 0;
	return {
		names: [...files.keys()],
		has: (name: string) => files.has(name),
		xml(name: string): string {
			if (cache.has(name)) return cache.get(name)!;
			const entry = files.get(name);
			if (!entry) throw new Error(tr("找不到文件內容：{part}", { part: name }));
			const at = entry.offset;
			if (at + 30 > start || buf.readUInt32LE(at) !== 0x04034b50) throw invalid();
			if (buf.readUInt16LE(at + 6) & 0x41) throw new Error(tr("Office 檔案已加密，請移除密碼或另存成 PDF 再附上"));
			if (buf.readUInt16LE(at + 8) !== entry.method) throw invalid();
			const dataStart = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
			if (dataStart + entry.compressed > start) throw invalid();
			expandedBytes += entry.size;
			if (expandedBytes > DOCUMENT_LIMIT) throw new Error(tr("解壓縮後的內容太大，請拆成較小的檔案再附上"));
			const data = buf.subarray(dataStart, dataStart + entry.compressed);
			const decoded = entry.method === 8 ? inflateRawSync(data, { maxOutputLength: DOCUMENT_LIMIT }) : data;
			if (decoded.length !== entry.size) throw invalid();
			const xml = decoded.toString("utf8");
			cache.set(name, xml);
			return xml;
		},
	};
}

type Zip = ReturnType<typeof readZip>;

function decodeXml(text: string): string {
	const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
	return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_, entity: string) => {
		if (entity[0] !== "#") return named[entity];
		const n = entity[1] === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
		return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "\ufffd";
	});
}

function* elements(xml: string, name: string): Generator<{ attrs: string; body: string }> {
	const re = new RegExp(`<${name}(?=[\\s/>])([^>]*?)(?:/\\s*>|>([\\s\\S]*?)</${name}\\s*>)`, "g");
	for (const m of xml.matchAll(re)) yield { attrs: m[1], body: m[2] ?? "" };
}

function attribute(attrs: string, name: string): string | undefined {
	const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`));
	return m ? decodeXml(m[2]) : undefined;
}

function textRuns(xml: string, tag: string): string {
	return [...elements(xml, tag)].map((part) => decodeXml(part.body)).join("");
}

function wordParagraph(xml: string): string {
	return [...xml.matchAll(/<w:(t|tab|br)(?=[\s/>])[^>]*?(?:\/\s*>|>([\s\S]*?)<\/w:\1\s*>)/g)]
		.map((m) => m[1] === "tab" ? "\t" : m[1] === "br" ? "\n" : decodeXml(m[2] ?? "")).join("");
}

function wordText(zip: Zip): string {
	const xml = zip.xml("word/document.xml");
	const out: string[] = [];
	for (const m of xml.matchAll(/<w:(p|tbl)(?=[\s/>])[^>]*?(?:\/\s*>|>([\s\S]*?)<\/w:\1\s*>)/g)) {
		if (m[1] === "p") { out.push(wordParagraph(m[2] ?? "")); continue; }
		for (const row of elements(m[2] ?? "", "w:tr")) {
			out.push([...elements(row.body, "w:tc")].map((cell) => [...elements(cell.body, "w:p")].map((p) => wordParagraph(p.body)).join("\n")).join(" | "));
		}
	}
	return out.join("\n");
}

function slideText(zip: Zip): string {
	const slides = zip.names.map((name) => ({ name, n: Number(name.match(/^ppt\/slides\/slide(\d+)\.xml$/)?.[1]) }))
		.filter((slide) => slide.n > 0).sort((a, b) => a.n - b.n);
	if (!slides.length) throw new Error(tr("找不到文件內容：{part}", { part: "ppt/slides/slideN.xml" }));
	const paragraphs = (xml: string) => [...elements(xml, "a:p")].map((p) => textRuns(p.body, "a:t")).join("\n");
	let hasText = false;
	const out = slides.map(({ name, n }) => {
		const text = paragraphs(zip.xml(name));
		const notesName = `ppt/notesSlides/notesSlide${n}.xml`;
		const notes = zip.has(notesName) ? paragraphs(zip.xml(notesName)) : "";
		if (text.trim() || notes.trim()) hasText = true;
		return `${tr("--- 投影片 {n} ---", { n })}\n${text}${notes.trim() ? `\n${tr("（備註）")}\n${notes}` : ""}`;
	});
	return hasText ? out.join("\n\n") : "";
}

function spreadsheetText(zip: Zip): string {
	const shared = zip.has("xl/sharedStrings.xml") ? [...elements(zip.xml("xl/sharedStrings.xml"), "si")].map((s) => textRuns(s.body, "t")) : [];
	const relationships = new Map<string, string>();
	if (zip.has("xl/_rels/workbook.xml.rels")) {
		for (const rel of elements(zip.xml("xl/_rels/workbook.xml.rels"), "Relationship")) {
			const id = attribute(rel.attrs, "Id"), target = attribute(rel.attrs, "Target");
			if (id && target && attribute(rel.attrs, "TargetMode") !== "External") relationships.set(id, target.startsWith("/") ? target.slice(1) : posix.normalize(posix.join("xl", target)));
		}
	}
	const sheets = [...elements(zip.xml("xl/workbook.xml"), "sheet")];
	if (!sheets.length) throw new Error(tr("找不到文件內容：{part}", { part: "xl/workbook.xml sheets" }));
	const out: string[] = [];
	let rows = 0, hasText = false;
	for (const [i, sheet] of sheets.entries()) {
		if (rows >= ROW_LIMIT) break;
		const name = attribute(sheet.attrs, "name") ?? `sheet${i + 1}`;
		const part = relationships.get(attribute(sheet.attrs, "r:id") ?? "") ?? `xl/worksheets/sheet${attribute(sheet.attrs, "sheetId") ?? i + 1}.xml`;
		out.push(tr("--- 工作表 {name} ---", { name }));
		for (const row of elements(zip.xml(part), "row")) {
			if (rows >= ROW_LIMIT) break;
			const cells: string[] = [];
			let column = 0;
			for (const cell of elements(row.body, "c")) {
				const letters = attribute(cell.attrs, "r")?.match(/^([A-Z]+)\d+$/i)?.[1].toUpperCase();
				if (letters) column = [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
				if (column > 16383) throw new Error(tr("試算表的欄位位置無效"));
				const type = attribute(cell.attrs, "t");
				const value = [...elements(cell.body, "v")][0]?.body ?? "";
				let text = type === "inlineStr" ? textRuns(cell.body, "t") : decodeXml(value);
				if (type === "s" && value.trim()) {
					const index = Number(value);
					if (!Number.isInteger(index) || shared[index] === undefined) throw new Error(tr("試算表的共用字串索引無效"));
					text = shared[index];
				}
				cells[column++] = text;
				if (text.trim()) hasText = true;
			}
			out.push(cells.join("\t"));
			rows++;
		}
	}
	return hasText ? out.join("\n") : "";
}

/** 把 PDF 或 Office 附檔轉成文字;不能擷取時回傳原因。 */
export async function documentText(abs: string, ext: string): Promise<{ text?: string; note?: string }> {
	ext = ext.toLowerCase();
	try {
		if ((await stat(abs)).size > DOCUMENT_LIMIT) return { note: tr("檔案太大") };
		if ([".doc", ".ppt", ".xls"].includes(ext)) return { note: tr("舊版 Office 格式（.doc/.ppt/.xls）沒辦法直接讀，請另存成 .docx/.pptx/.xlsx 或 PDF 再附上") };
		const buf = await readFile(abs);
		if (buf.length > DOCUMENT_LIMIT) return { note: tr("檔案太大") };
		if (ext === ".pdf") {
			const pdf = await getDocumentProxy(new Uint8Array(buf));
			try {
				const { text: pages } = await extractText(pdf, { mergePages: false });
				if (pages.join("").replace(/\s/g, "").length < 20) return { note: tr("這份 PDF 沒有可以擷取的文字（可能是掃描檔或圖片），請把需要的頁面截圖，用「＋ 圖片」附上") };
				return { text: pages.map((page, i) => `${tr("--- 第 {n} 頁 ---", { n: i + 1 })}\n${page}`).join("\n\n") };
			} finally { await pdf.loadingTask.destroy(); }
		}
		if (![".docx", ".pptx", ".xlsx", ".xlsm"].includes(ext)) return { note: tr("不支援這種文件格式，請另存成 PDF 再附上") };
		const zip = readZip(buf);
		const text = ext === ".docx" ? wordText(zip) : ext === ".pptx" ? slideText(zip) : spreadsheetText(zip);
		return text.trim() ? { text } : { note: tr("這份 Office 檔案沒有可以擷取的文字，請另存成 PDF 或把需要的內容用「＋ 圖片」附上") };
	} catch (e) {
		const error = e instanceof Error ? e.message : String(e);
		return { note: ext === ".pdf" ? tr("PDF 打不開：{error}", { error }) : tr("Office 檔案打不開：{error}，請確認檔案沒有損壞，或另存成 PDF 再附上", { error }) };
	}
}
