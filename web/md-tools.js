export function toggleWrap(text, selStart, selEnd, marker) {
	const size = marker.length;
	if (selStart >= size && text.slice(selStart - size, selStart) === marker && text.slice(selEnd, selEnd + size) === marker) {
		return { text: text.slice(0, selStart - size) + text.slice(selStart, selEnd) + text.slice(selEnd + size), selStart: selStart - size, selEnd: selEnd - size };
	}
	if (selEnd - selStart >= size * 2 && text.slice(selStart, selStart + size) === marker && text.slice(selEnd - size, selEnd) === marker) {
		return { text: text.slice(0, selStart) + text.slice(selStart + size, selEnd - size) + text.slice(selEnd), selStart, selEnd: selEnd - size * 2 };
	}
	return { text: text.slice(0, selStart) + marker + text.slice(selStart, selEnd) + marker + text.slice(selEnd), selStart: selStart + size, selEnd: selEnd + size };
}

export function toggleLinePrefix(lines, prefix) {
	const remove = lines.every((line) => line.startsWith(prefix));
	return lines.map((line) => remove ? line.slice(prefix.length) : prefix + line);
}

export function makeTable(cols, rows) {
	cols = Math.max(1, Math.min(10, Math.trunc(Number(cols)) || 3));
	rows = Math.max(1, Math.min(30, Math.trunc(Number(rows)) || 3));
	const row = (values) => `| ${values.join(" | ")} |`;
	return [row(Array.from({ length: cols }, (_, i) => `Column ${i + 1}`)), row(Array(cols).fill("---")), ...Array.from({ length: rows - 1 }, () => row(Array(cols).fill(" ")))].join("\n");
}

export function safeImageName(name, now = Date.now()) {
	const base = String(name).split(/[\\/]/).pop();
	const match = base.match(/^(.*)(\.[a-zA-Z0-9]+)$/);
	const stem = (match ? match[1] : base).normalize("NFKC").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "image";
	return `${stem}-${now}${match ? match[2] : ""}`;
}

function codeRanges(src) {
	const ranges = [];
	const fences = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/gm;
	let match;
	while ((match = fences.exec(src))) {
		const closing = new RegExp(`^ {0,3}${match[1][0]}{${match[1].length},}[ \\t]*(?:\\n|$)`, "gm");
		closing.lastIndex = fences.lastIndex;
		const end = closing.exec(src);
		const to = end ? closing.lastIndex : src.length;
		ranges.push([match.index, to]);
		fences.lastIndex = to;
	}
	const ticks = /`+/g;
	while ((match = ticks.exec(src))) {
		const fence = ranges.find(([start, end]) => match.index >= start && match.index < end);
		if (fence) { ticks.lastIndex = fence[1]; continue; }
		const closing = new RegExp(`(?<!\x60)\x60{${match[0].length}}(?!\x60)`, "g");
		closing.lastIndex = ticks.lastIndex;
		const end = closing.exec(src);
		if (end && !ranges.some(([start, to]) => end.index >= start && end.index < to)) {
			ranges.push([match.index, closing.lastIndex]);
			ticks.lastIndex = closing.lastIndex;
		}
	}
	return ranges.sort((a, b) => a[0] - b[0]);
}

const escapedAt = (src, at) => {
	let count = 0;
	while (at > 0 && src[--at] === "\\") count++;
	return count % 2 === 1;
};

function mathRanges(src, includeOpen = false) {
	const code = codeRanges(src);
	const ranges = [];
	for (let i = 0; i < src.length; i++) {
		const skip = code.find(([start, end]) => i >= start && i < end);
		if (skip) { i = skip[1] - 1; continue; }
		if (escapedAt(src, i)) continue;
		const left = src.startsWith("$$", i) ? "$$" : src.startsWith("\\[", i) ? "\\[" : src.startsWith("\\(", i) ? "\\(" : src[i] === "$" ? "$" : null;
		if (!left) continue;
		const right = left === "\\[" ? "\\]" : left === "\\(" ? "\\)" : left;
		const from = i + left.length;
		const inline = left === "$";
		if (inline && (!src[from] || /\s/.test(src[from]))) continue;
		let end = from;
		while ((end = src.indexOf(right, end)) !== -1) {
			if (inline && src.slice(from, end).includes("\n")) { end = -1; break; }
			if (!escapedAt(src, end) && !code.some(([a, b]) => a < end + right.length && b > from) && (!inline || (end > from && !/\s/.test(src[end - 1]) && !/\d/.test(src[end + 1] || "")))) break;
			end += right.length;
		}
		if (end !== -1) {
			ranges.push([i, end + right.length]);
			i = end + right.length - 1;
		} else if (includeOpen && (!inline || (!src.slice(from).includes("\n") && !/^\d/.test(src.slice(from))))) {
			ranges.push([i, src.length + 1]);
			break;
		}
	}
	return ranges;
}

export function isMathPosition(src, offset) {
	return mathRanges(src, true).some(([start, end]) => offset > start && offset < end);
}

export function protectMath(src) {
	let prefix = "MDMATHPLACEHOLDER";
	while (src.includes(prefix)) prefix += "X";
	const originals = [];
	let text = "", from = 0;
	for (const [start, end] of mathRanges(src)) {
		text += src.slice(from, start) + `${prefix}${originals.length}END`;
		originals.push(src.slice(start, end));
		from = end;
	}
	text += src.slice(from);
	const escapeHtml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	const tokens = new RegExp(`${prefix}(\\d+)END`, "g");
	return { text, restore: (html, wrap = false) => {
		const restoreTokens = (value) => value.replace(tokens, (token, index) => index < originals.length ? escapeHtml(originals[index]) : token);
		if (!wrap) return restoreTokens(html);
		const parts = new RegExp(`<(?:[^>"']|"[^"]*"|'[^']*')*>|${prefix}(\\d+)END`, "g");
		return html.replace(parts, (part, index) => index === undefined ? restoreTokens(part) : `<span class="md-math">${escapeHtml(originals[index])}</span>`);
	} };
}

export const MATH_TEMPLATES = {
	fraction: "\\frac{${1:a}}{${2:b}}$0",
	sqrt: "\\sqrt{${1:x}}$0",
	power: "${1:x}^{${2:n}}$0",
	subscript: "${1:x}_{${2:i}}$0",
	sum: "\\sum_{${1:i=1}}^{${2:n}}$0",
	integral: "\\int_{${1:a}}^{${2:b}} ${3:f(x)}\\,dx$0",
	limit: "\\lim_{${1:x} \\to ${2:\\infty}}$0",
	matrix: "\\begin{pmatrix} ${1:a} & ${2:b} \\\\ ${3:c} & ${4:d} \\end{pmatrix}$0",
	aligned: "\\begin{aligned} ${1:a} &= ${2:b} \\\\ ${3:c} &= ${4:d} \\end{aligned}$0",
	alpha: "\\alpha$0", beta: "\\beta$0", gamma: "\\gamma$0", delta: "\\delta$0", epsilon: "\\epsilon$0", theta: "\\theta$0", lambda: "\\lambda$0", mu: "\\mu$0", pi: "\\pi$0", sigma: "\\sigma$0", phi: "\\phi$0", omega: "\\omega$0",
};

export const MERMAID_TEMPLATES = {
	flowchart: 'flowchart TD\n    A[Start] --> B[End]',
	sequence: 'sequenceDiagram\n    Alice->>Bob: Hello\n    Bob-->>Alice: Hello',
	gantt: 'gantt\n    title Schedule\n    dateFormat YYYY-MM-DD\n    section Tasks\n    Task :a1, 2026-01-01, 1d',
	pie: 'pie title Distribution\n    "Group A" : 60\n    "Group B" : 40',
	class: 'classDiagram\n    class Item {\n        +String name\n    }',
};
