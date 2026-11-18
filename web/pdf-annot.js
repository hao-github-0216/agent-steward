// 把標註寫入各頁的 /Annots,原本的頁面內容串流保持不變。
export async function applyAnnotations(PDFLib, bytes, ops) {
	const { PDFDocument, PDFName, PDFArray, PDFDict, PDFRawStream, PDFRef, PDFString, PDFHexString, PDFNumber, StandardFonts } = PDFLib;
	const doc = await PDFDocument.load(bytes, { updateMetadata: false });
	const ctx = doc.context, pages = doc.getPages();
	const name = (s) => PDFName.of(s);
	const num = (n) => PDFNumber.of(n).toString();
	const nums = (values) => values.map(num).join(" ");
	const subtypes = { highlight: "Highlight", underline: "Underline", strikeout: "StrikeOut", freetext: "FreeText", ink: "Ink" };
	let font;
	const arrayNumbers = (array) => array.asArray().map((value) => value.asNumber());
	const findAnnotation = (annots, id) => {
		const match = /^(\d+)R(\d+)?$/.exec(id);
		if (!match || !annots) return;
		return annots.asArray().find((ref) => ref instanceof PDFRef && ref.objectNumber === Number(match[1]) && ref.generationNumber === Number(match[2] || 0));
	};
	async function setAppearance(annot, op, rect) {
		const color = op.color.length === 1 ? [op.color[0], op.color[0], op.color[0]]
			: op.color.length === 4 ? op.color.slice(0, 3).map((component) => 1 - Math.min(1, component + op.color[3])) : op.color;
		const rgb = nums(color);
		const commands = ["q", `${rgb} RG`, `${rgb} rg`];
		const resources = {};
		if (op.type === "highlight" || op.type === "underline" || op.type === "strikeout") {
			annot.set(name("QuadPoints"), ctx.obj(op.quads.flat()));
			if (op.type === "highlight") {
				resources.ExtGState = { GS: { Type: "ExtGState", BM: "Multiply", CA: 0.4, ca: 0.4 } };
				commands.push("/GS gs");
			}
			for (const q of op.quads) {
				if (op.type === "highlight") commands.push(`${nums(q.slice(0, 2))} m ${nums(q.slice(2, 4))} l ${nums(q.slice(6, 8))} l ${nums(q.slice(4, 6))} l h f`);
				else {
					const height = Math.max(Math.hypot(q[0] - q[4], q[1] - q[5]), Math.hypot(q[2] - q[6], q[3] - q[7]));
					const a = op.type === "underline" ? q.slice(4, 6) : [(q[0] + q[4]) / 2, (q[1] + q[5]) / 2];
					const b = op.type === "underline" ? q.slice(6, 8) : [(q[2] + q[6]) / 2, (q[3] + q[7]) / 2];
					commands.push(`${num(Math.max(0.5, height / 14))} w ${nums(a)} m ${nums(b)} l S`);
				}
			}
		} else if (op.type === "ink") {
			annot.set(name("InkList"), ctx.obj(op.paths));
			annot.set(name("BS"), ctx.obj({ W: op.width, S: "S" }));
			commands.push(`${num(op.width)} w`, "1 J 1 j");
			for (const path of op.paths) {
				if (path.length < 2) continue;
				commands.push(`${nums(path.slice(0, 2))} m`);
				if (path.length === 2) commands.push(`${nums(path)} l`);
				for (let i = 2; i < path.length; i += 2) commands.push(`${nums(path.slice(i, i + 2))} l`);
				commands.push("S");
			}
		} else {
			annot.set(name("Contents"), PDFHexString.fromText(op.text));
			annot.set(name("DA"), PDFString.of(`/Helv ${num(op.fontSize)} Tf ${rgb} rg`));
			font ||= await doc.embedFont(StandardFonts.Helvetica);
			resources.Font = { Helv: font.ref };
			if (op.png) {
				const image = await doc.embedPng(op.png);
				resources.XObject = { Im1: image.ref };
				// 用空文字物件保留圖像外觀的字級與顏色。
				commands.push("BT", `/Helv ${num(op.fontSize)} Tf`, "() Tj", "ET");
				commands.push(`q ${nums([rect[2] - rect[0], 0, 0, rect[3] - rect[1], rect[0], rect[1]])} cm /Im1 Do Q`);
			} else {
				const lines = op.text.replace(/\r\n?/g, "\n").split("\n");
				let encoded;
				try { encoded = lines.map((line) => font.encodeText(line).toString()); } catch { /* 標準字型放不了的字保留在 /Contents。 */ }
				if (encoded) {
					commands.push("BT", `/Helv ${num(op.fontSize)} Tf`);
					encoded.forEach((line, i) => commands.push(`1 0 0 1 ${num(rect[0] + 2)} ${num(rect[3] - 2 - op.fontSize * (1 + i * 1.2))} Tm ${line} Tj`));
					commands.push("ET");
				} else commands.push(`1 w ${nums([rect[0] + 0.5, rect[1] + 0.5, rect[2] - rect[0] - 1, rect[3] - rect[1] - 1])} re S`);
			}
		}
		commands.push("Q");
		const appearance = ctx.register(ctx.stream(commands.join("\n"), { Type: "XObject", Subtype: "Form", FormType: 1, BBox: rect, Matrix: [1, 0, 0, 1, 0, 0], Resources: resources }));
		annot.set(name("AP"), ctx.obj({ N: appearance }));
	}
	function resizeAppearance(annot, rect) {
		const ap = annot.lookupMaybe(name("AP"), PDFDict);
		if (!ap) return;
		const normal = ap.lookup(name("N"));
		const resizedStream = (stream) => {
			if (!(stream instanceof PDFRawStream)) return;
			const bbox = stream.dict.lookupMaybe(name("BBox"), PDFArray);
			if (!bbox) return;
			const [left, bottom, right, top] = arrayNumbers(bbox);
			const matrix = stream.dict.lookupMaybe(name("Matrix"), PDFArray);
			const [a, b, c, d, e, f] = matrix ? arrayNumbers(matrix) : [1, 0, 0, 1, 0, 0];
			const corners = [[left, bottom], [left, top], [right, bottom], [right, top]];
			const xs = corners.map(([x, y]) => a * x + c * y + e), ys = corners.map(([x, y]) => b * x + d * y + f);
			const minX = Math.min(...xs), minY = Math.min(...ys);
			const width = Math.max(...xs) - minX, height = Math.max(...ys) - minY;
			if (width === 0 || height === 0) return;
			const sx = (rect[2] - rect[0]) / width, sy = (rect[3] - rect[1]) / height;
			const copy = stream.clone(ctx);
			copy.dict.set(name("Matrix"), ctx.obj([sx * a, sy * b, sx * c, sy * d, rect[0] + sx * (e - minX), rect[1] + sy * (f - minY)]));
			return ctx.register(copy);
		};
		const copy = ap.clone(ctx);
		if (normal instanceof PDFDict) {
			const states = normal.clone(ctx);
			for (const [key, value] of normal.entries()) {
				const resized = resizedStream(ctx.lookup(value));
				if (resized) states.set(key, resized);
			}
			copy.set(name("N"), states);
		} else {
			const resized = resizedStream(normal);
			if (resized) copy.set(name("N"), resized);
		}
		annot.set(name("AP"), copy);
	}

	for (const op of ops) {
		const page = pages[op.page];
		if (!page) throw new RangeError(`Invalid PDF page: ${op.page}`);
		let annots = page.node.lookupMaybe(name("Annots"), PDFArray);
		if (op.op === "remove") {
			const match = /^(\d+)R(\d+)?$/.exec(op.ref);
			if (!match || !annots) continue;
			for (let i = annots.size() - 1; i >= 0; i--) {
				const ref = annots.get(i);
				if (ref instanceof PDFRef && ref.objectNumber === Number(match[1]) && ref.generationNumber === Number(match[2] || 0)) annots.remove(i);
			}
			continue;
		}
		if (op.op === "update") {
			const ref = findAnnotation(annots, op.ref);
			if (!ref) continue;
			const annot = ctx.lookup(ref, PDFDict);
			if (op.rect) annot.set(name("Rect"), ctx.obj(op.rect));
			const rect = arrayNumbers(annot.lookup(name("Rect"), PDFArray));
			const subtype = annot.lookup(name("Subtype")).toString();
			const color = op.color ?? (annot.has(name("C")) ? arrayNumbers(annot.lookup(name("C"), PDFArray)) : [0, 0, 0]);
			if (op.color) annot.set(name("C"), ctx.obj(op.color));
			if (subtype === "/Ink" && (op.paths || op.color)) {
				const bs = annot.lookupMaybe(name("BS"), PDFDict);
				const border = annot.lookupMaybe(name("Border"), PDFArray);
				const width = bs?.lookupMaybe(name("W"), PDFNumber)?.asNumber() ?? (border && border.size() >= 3 ? border.lookup(2, PDFNumber).asNumber() : 1);
				const paths = op.paths ?? annot.lookup(name("InkList"), PDFArray).asArray().map(arrayNumbers);
				await setAppearance(annot, { type: "ink", paths, color, width }, rect);
			} else if (subtype === "/FreeText" && ["text", "fontSize", "color", "png"].some((key) => op[key] !== undefined)) {
				const da = annot.lookupMaybe(name("DA"), PDFString)?.decodeText() ?? "";
				const size = /([^\s]+)\s+Tf\b/.exec(da);
				const contents = annot.lookup(name("Contents"));
				const text = op.text ?? (contents instanceof PDFString || contents instanceof PDFHexString ? contents.decodeText() : "");
				const fontSize = op.fontSize ?? (size && Number.isFinite(Number(size[1])) ? Number(size[1]) : 12);
				await setAppearance(annot, { type: "freetext", text, fontSize, color, png: op.png }, rect);
			} else if (op.rect) resizeAppearance(annot, rect);
			continue;
		}

		if (op.op !== "add" || !subtypes[op.type]) throw new Error(`Invalid PDF annotation: ${op.type}`);
		const color = op.color;
		let rect;
		if (op.type === "freetext" || (op.type === "ink" && op.rect)) rect = [...op.rect];
		else {
			const points = (op.type === "ink" ? op.paths : op.quads).flat();
			const xs = points.filter((_, i) => i % 2 === 0), ys = points.filter((_, i) => i % 2 === 1);
			const pad = 1 + (op.type === "ink" ? op.width : 0);
			rect = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
		}
		const annot = ctx.obj({
			Type: "Annot", Subtype: subtypes[op.type], Rect: rect, C: color, F: 4,
			T: PDFString.of("Agent Steward"), M: PDFString.fromDate(new Date()), P: page.ref,
		});
		await setAppearance(annot, op, rect);
		if (!annots) { annots = ctx.obj([]); page.node.set(name("Annots"), annots); }
		annots.push(ctx.register(annot));
	}
	return doc.save({ useObjectStreams: false });
}
