import test from "node:test";
import assert from "node:assert/strict";
import { marked } from "marked";
import { toggleWrap, toggleLinePrefix, makeTable, protectMath, safeImageName, isMathPosition, MATH_TEMPLATES, MERMAID_TEMPLATES } from "../web/md-tools.js";

const preview = (source, wrap = false) => {
	const math = protectMath(source);
	return math.restore(marked.parse(math.text, { gfm: true }), wrap);
};

test("protectMath preserves underscores through marked 12.0.2", () => {
	const html = preview("Before $a_1+b_2$ after");
	assert.ok(html.includes("$a_1+b_2$"));
	assert.doesNotMatch(html, /<em>/);
});

test("protectMath leaves fenced and inline code unchanged", () => {
	for (const source of ["```latex\n$a_1$\n```", "~~~\n$$a_1$$\n~~~", "`$a_1$`", "``x `$a_1$` x``", "```\n$a_1$", "   ~~~~latex\n\\[a_1\\]\n   ~~~~~\n"]) {
		assert.equal(protectMath(source).text, source);
	}
	const html = preview("`$a_1$` and $b_1+c_2$");
	assert.ok(html.includes("<code>$a_1$</code>"));
	assert.ok(html.includes("$b_1+c_2$"));
});

test("protectMath leaves currency and invalid inline delimiters unchanged", () => {
	for (const source of ["$5 and $10", "Cost: $5 and $10 today", "$ spaced$", "$spaced $", "$a\nb$", "\\$a_1+b_2$", "$5.00", "US$10"]) {
		assert.equal(protectMath(source).text, source, source);
	}
	assert.equal(preview("$5 and $10", true), "<p>$5 and $10</p>\n");
});

test("protectMath handles display and backslash delimiters", () => {
	for (const source of ["$$a_1\n+b_2$$", "\\[a_1\n+b_2\\]", "\\(a_1+b_2\\)", "$a_1+b_2$"]) {
		const math = protectMath(source);
		assert.notEqual(math.text, source);
		assert.ok(preview(source).includes(source));
	}
});

test("protectMath HTML-escapes restored math after sanitization", () => {
	const source = '$a< img src=x onerror="bad"> & b$';
	const html = preview(source);
	assert.ok(html.includes('$a&lt; img src=x onerror=&quot;bad&quot;&gt; &amp; b$'));
	assert.doesNotMatch(html, /<img/);
});

test("protectMath placeholders cannot collide with source text", () => {
	const source = "MDMATHPLACEHOLDER0END MDMATHPLACEHOLDERX0END $a_1+b_2$";
	assert.equal(preview(source), `<p>${source}</p>\n`);
	const math = protectMath("$x$ $y$");
	assert.equal(math.restore(math.text), "$x$ $y$");
	assert.equal(math.restore(math.text), "$x$ $y$");
});

test("protectMath optionally wraps only text formulas, not HTML attributes", () => {
	assert.equal(preview("$a_1+b_2$", true), '<p><span class="md-math">$a_1+b_2$</span></p>\n');
	const math = protectMath('$a<b$');
	assert.equal(math.restore(`<a title=">${math.text}">${math.text}</a>`, true), '<a title=">$a&lt;b$"><span class="md-math">$a&lt;b$</span></a>');
	assert.doesNotMatch(preview("`$x$`", true), /md-math/);
});

test("toggleWrap wraps a selection and keeps its contents selected", () => {
	assert.deepEqual(toggleWrap("abc", 1, 2, "**"), { text: "a**b**c", selStart: 3, selEnd: 4 });
});

test("toggleWrap removes surrounding or selected markers", () => {
	assert.deepEqual(toggleWrap("a**b**c", 3, 4, "**"), { text: "abc", selStart: 1, selEnd: 2 });
	assert.deepEqual(toggleWrap("a~~b~~c", 1, 6, "~~"), { text: "abc", selStart: 1, selEnd: 2 });
});

test("toggleWrap inserts a pair at an empty selection", () => {
	assert.deepEqual(toggleWrap("ab", 1, 1, "`"), { text: "a``b", selStart: 2, selEnd: 2 });
	assert.deepEqual(toggleWrap("****", 2, 2, "**"), { text: "", selStart: 0, selEnd: 0 });
});

test("toggleWrap round-trips every toolbar marker", () => {
	for (const marker of ["**", "*", "~~", "`", "$"]) {
		const wrapped = toggleWrap("hello", 0, 5, marker);
		assert.deepEqual(toggleWrap(wrapped.text, wrapped.selStart, wrapped.selEnd, marker), { text: "hello", selStart: 0, selEnd: 5 });
	}
});

test("toggleLinePrefix toggles whole multiline selections without mutation", () => {
	const lines = ["one", "two", ""];
	const prefixed = toggleLinePrefix(lines, "- ");
	assert.deepEqual(prefixed, ["- one", "- two", "- "]);
	assert.deepEqual(toggleLinePrefix(prefixed, "- "), lines);
	assert.deepEqual(lines, ["one", "two", ""]);
	assert.deepEqual(toggleLinePrefix(["- one", "two"], "- "), ["- - one", "- two"]);
	for (const prefix of ["# ", "## ", "### ", "1. ", "- [ ] ", "> "]) {
		assert.deepEqual(toggleLinePrefix(toggleLinePrefix(lines, prefix), prefix), lines);
	}
});

test("makeTable includes the header in its row count", () => {
	assert.equal(makeTable(3, 2), "| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|   |   |   |");
	const table = makeTable(100, 100).split("\n");
	assert.equal(table.length, 31);
	assert.equal(table[0].split("|").length, 12);
	assert.equal(makeTable(0, 0).split("\n").length, 4);
});

test("safeImageName keeps Unicode letters and the original extension", () => {
	assert.equal(safeImageName("我的 圖片.PNG", 123), "我的-圖片-123.PNG");
	assert.equal(safeImageName("a/b/../hello world.jpeg", 456), "hello-world-456.jpeg");
	assert.equal(safeImageName(" []?#.png", 7), "image-7.png");
	assert.equal(safeImageName("paste.png", 123), "paste-123.png");
	assert.doesNotMatch(safeImageName('a)(<script>".svg', 123), /[()<>"/\\]/);
});

test("isMathPosition recognizes existing and open math but ignores code", () => {
	assert.equal(isMathPosition("text $a_1$ end", 8), true);
	assert.equal(isMathPosition("text $$\na_1\n$$", 10), true);
	assert.equal(isMathPosition("text \\(a_1\\)", 9), true);
	assert.equal(isMathPosition("$a_1", 4), true);
	assert.equal(isMathPosition("`$a_1$`", 4), false);
	assert.equal(isMathPosition("plain text", 5), false);
	assert.equal(isMathPosition("$5 and $10", 3), false);
});

test("MATH_TEMPLATES contain editable snippets and correct TeX backslashes", () => {
	assert.equal(Object.keys(MATH_TEMPLATES).length, 21);
	assert.equal(MATH_TEMPLATES.fraction, "\\frac{${1:a}}{${2:b}}$0");
	assert.ok(MATH_TEMPLATES.matrix.includes("\\\\ "));
	assert.ok(MATH_TEMPLATES.aligned.includes("\\\\ "));
	for (const snippet of Object.values(MATH_TEMPLATES)) assert.ok(snippet.endsWith("$0"));
});

test("matrix and aligned snippets remain protected when wrapped in inline math", () => {
	const defaults = {
		matrix: "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}",
		aligned: "\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}",
	};
	for (const [key, expected] of Object.entries(defaults)) {
		const snippet = MATH_TEMPLATES[key];
		assert.doesNotMatch(snippet, /[\r\n]/);
		assert.deepEqual([...snippet.matchAll(/\$\{(\d+):/g)].map((match) => match[1]), ["1", "2", "3", "4"]);
		const expanded = snippet.replace(/\$\{\d+:([^}]+)\}/g, "$1").replace(/\$0/g, "");
		assert.equal(expanded, expected);
		const source = `$${expanded}$`;
		assert.doesNotMatch(source, /[\r\n]/);
		const math = protectMath(source);
		assert.notEqual(math.text, source);
		assert.equal(math.restore(math.text), source.replace(/&/g, "&amp;"));
		assert.equal(preview(source), `<p>${source.replace(/&/g, "&amp;")}</p>\n`);
	}
});

test("MERMAID_TEMPLATES start with the corresponding Mermaid 11 diagram type", () => {
	assert.deepEqual(Object.keys(MERMAID_TEMPLATES), ["flowchart", "sequence", "gantt", "pie", "class"]);
	const types = { flowchart: /^flowchart TD\n/, sequence: /^sequenceDiagram\n/, gantt: /^gantt\n/, pie: /^pie title /, class: /^classDiagram\n/ };
	for (const [key, source] of Object.entries(MERMAID_TEMPLATES)) {
		assert.match(source, types[key]);
		assert.ok(source.split("\n").length > 1);
	}
});
