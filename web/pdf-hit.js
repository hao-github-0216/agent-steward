function segmentDistance(point, start, end) {
	const dx = end[0] - start[0], dy = end[1] - start[1];
	const lengthSquared = dx * dx + dy * dy;
	const t = lengthSquared ? Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared)) : 0;
	return Math.hypot(point[0] - start[0] - t * dx, point[1] - start[1] - t * dy);
}

function hitQuad(point, quad) {
	// 四個角點先依繞中心的角度排好，各家軟體寫入的角點順序不同也能圍成正確的四邊形。
	const corners = [quad.slice(0, 2), quad.slice(2, 4), quad.slice(4, 6), quad.slice(6, 8)];
	const cx = (corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4, cy = (corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4;
	const vertices = corners.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
	let inside = false;
	for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
		const a = vertices[j], b = vertices[i];
		if (segmentDistance(point, a, b) <= 2) return true;
		if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
	}
	return inside;
}

function annotationRect(item) {
	if (item.rect) return item.rect;
	const points = (item.quads || item.paths).flat(), xs = [], ys = [];
	for (let i = 0; i < points.length; i += 2) { xs.push(points[i]); ys.push(points[i + 1]); }
	const pad = item.paths ? (item.width ?? 1) + 1 : 1;
	return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
}

function hitsShape(point, item, rect) {
	if (item.quads?.length) return item.quads.some((quad) => hitQuad(point, quad));
	if (item.paths) {
		const tolerance = (item.width ?? 1) / 2 + 6;
		return item.paths.some((path) => {
			if (path.length === 2) return segmentDistance(point, path, path) <= tolerance;
			for (let i = 2; i < path.length; i += 2) {
				if (segmentDistance(point, path.slice(i - 2, i), path.slice(i, i + 2)) <= tolerance) return true;
			}
			return false;
		});
	}
	return point[0] >= rect[0] - 2 && point[0] <= rect[2] + 2 && point[1] >= rect[1] - 2 && point[1] <= rect[3] + 2;
}

// 回傳命中且矩形面積最小的原始標註物件。
export function hitAnnotation(point, items) {
	let best, bestArea = Infinity;
	for (const item of items) {
		const rect = annotationRect(item);
		if (!hitsShape(point, item, rect)) continue;
		const area = Math.abs((rect[2] - rect[0]) * (rect[3] - rect[1]));
		if (area < bestArea) { best = item; bestArea = area; }
	}
	return best;
}
