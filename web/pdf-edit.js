const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// 使用 PDF 座標平移矩形；原尺寸須可容於 bounds。
export function moveRect(rect, dx, dy, { bounds } = {}) {
	if (bounds) {
		dx = clamp(dx, bounds[0] - rect[0], bounds[2] - rect[2]);
		dy = clamp(dy, bounds[1] - rect[1], bounds[3] - rect[3]);
	}
	return [rect[0] + dx, rect[1] + dy, rect[2] + dx, rect[3] + dy];
}

// 固定對角，依拖曳角落調整矩形大小；原矩形須在 bounds 內。
export function resizeRect(rect, handle, dx, dy, { keepAspect = false, minSize = 12, bounds } = {}) {
	if (!["nw", "ne", "sw", "se"].includes(handle)) throw new RangeError(`Invalid PDF resize handle: ${handle}`);
	const west = handle[1] === "w", north = handle[0] === "n";
	const sx = west ? -1 : 1, sy = north ? 1 : -1;
	const anchorX = west ? rect[2] : rect[0], anchorY = north ? rect[1] : rect[3];
	const originalWidth = rect[2] - rect[0], originalHeight = rect[3] - rect[1];
	const maxWidth = bounds ? Math.max(0, west ? anchorX - bounds[0] : bounds[2] - anchorX) : Infinity;
	const maxHeight = bounds ? Math.max(0, north ? bounds[3] - anchorY : anchorY - bounds[1]) : Infinity;
	let width = originalWidth + sx * dx, height = originalHeight + sy * dy;
	if (keepAspect && originalWidth > 0 && originalHeight > 0) {
		const scaleX = width / originalWidth, scaleY = height / originalHeight;
		const requested = Math.abs(scaleX - 1) >= Math.abs(scaleY - 1) ? scaleX : scaleY;
		const maxScale = Math.min(maxWidth / originalWidth, maxHeight / originalHeight);
		const minScale = Math.min(maxScale, Math.max(minSize / originalWidth, minSize / originalHeight));
		const scale = clamp(requested, minScale, maxScale);
		width = originalWidth * scale;
		height = originalHeight * scale;
	} else {
		width = clamp(width, Math.min(minSize, maxWidth), maxWidth);
		height = clamp(height, Math.min(minSize, maxHeight), maxHeight);
	}
	return [west ? anchorX - width : anchorX, north ? anchorY : anchorY - height, west ? anchorX : anchorX + width, north ? anchorY + height : anchorY];
}

// 將筆跡或文字四邊形從原矩形映射到新矩形。
export function transformPaths(paths, fromRect, toRect) {
	const width = fromRect[2] - fromRect[0], height = fromRect[3] - fromRect[1];
	return paths.map((path) => path.map((value, i) => {
		const axis = i % 2, size = axis === 0 ? width : height;
		return toRect[axis] + (size === 0 ? 0 : (value - fromRect[axis]) / size) * (toRect[axis + 2] - toRect[axis]);
	}));
}

// 依量測寬度分行，保留顯式換行與空行。
export function wrapLines(text, maxWidth, measure) {
	const result = [];
	for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
		const tokens = paragraph.match(/[^\S\n]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? [];
		let line = "", spaces = "";
		for (const token of tokens) {
			if (/^\s+$/.test(token)) { spaces += token; continue; }
			if (line && measure(line + spaces + token) <= maxWidth) {
				line += spaces + token;
				spaces = "";
				continue;
			}
			if (line) { result.push(line); line = ""; }
			spaces = "";
			for (const char of token) {
				if (line && measure(line + char) > maxWidth) { result.push(line); line = ""; }
				line += char;
			}
		}
		result.push(line);
	}
	return result;
}
