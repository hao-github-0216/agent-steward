// 問管家對話框的 Markdown 顯示:先把全部文字轉成純文字(擋掉 HTML),再只套模型常用的格式:
// **粗體**、*斜體*、~~刪除線~~、`行內程式`、```程式區塊```、清單(可巢狀、可勾選)、編號清單、表格、
// ## 小標題、> 引用、---、連結(只允許 http/https/mailto)、數學式 $…$ / $$…$$(載得到 KaTeX 才排版)。
(() => {
	const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
	const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
	const P = (i) => `\u0000${i}\u0000`; // 佔位符:先收起來的片段,最後放回去

	function render(src) {
		const keep = [];
		const hold = (html) => P(keep.push(html) - 1);
		let text = String(src ?? "").replace(/\r\n?/g, "\n");
		// 程式區塊(沒有結尾的 ``` 就到最後)
		text = text.replace(/^ {0,3}(`{3,}|~{3,})[ \t]*([\w+#.-]*)[^\n]*\n([\s\S]*?)(?:\n {0,3}\1[ \t]*(?=\n|$)|$(?![\s\S]))/gm, (_, f, lang, code) =>
			`\n${hold(`<pre class="md-pre"${lang ? ` data-lang="${esc(lang)}"` : ""}><code>${esc(code.replace(/\n$/, ""))}</code></pre>`)}\n`);
		// 區塊數學式
		text = text.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, a, b) => `\n${hold(`<div class="md-math" data-display="1">${esc((a ?? b).trim())}</div>`)}\n`);
		return blocks(text.split("\n"), hold, keep).replace(/\u0000(\d+)\u0000/g, (_, i) => keep[i]).replace(/\u0000(\d+)\u0000/g, (_, i) => keep[i]);
	}

	function inline(s, hold) {
		// 行內程式、行內數學式先收起來,裡面的符號不再處理
		s = s.replace(/(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)/g, (_, __, c) => hold(`<code>${esc(c.trim() || c)}</code>`));
		s = s.replace(/\\\(([^\n]+?)\\\)|(?<![\\$\w])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![\w$])/g, (_, a, b) => hold(`<span class="md-math">${esc(a ?? b)}</span>`));
		// 連結 [文字](網址)
		s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, t, u) => hold(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${inlineFmt(esc(t))}</a>`));
		// 直接寫出來的網址
		s = s.replace(/https?:\/\/[^\s<>()　-〿＀-￯]+[^\s<>()　-〿＀-￯.,;:!?'"]/g, (u) => hold(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`));
		return inlineFmt(esc(s));
	}
	function inlineFmt(s) {
		return s
			.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
			.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?![\w])/g, "$1<strong>$2</strong>")
			.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, "$1<em>$2</em>")
			.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w])/g, "$1<em>$2</em>")
			.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
	}

	const RE = {
		hold: /^\s*\u0000\d+\u0000\s*$/,
		head: /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
		hr: /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/,
		quote: /^ {0,3}>\s?(.*)$/,
		item: /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/,
		tsep: { test: (l) => l.includes("|") && /-/.test(l) && /^[\s|:-]+$/.test(l) },
	};
	const isRow = (l) => l.includes("|") && l.trim().length > 1;

	function blocks(lines, hold, keep) {
		const out = [];
		let para = [];
		const flush = () => { if (para.length) out.push(`<p>${para.map((l) => inline(l, hold)).join("<br>")}</p>`); para = []; };
		for (let i = 0; i < lines.length; i++) {
			const l = lines[i];
			if (!l.trim()) { flush(); continue; }
			if (RE.hold.test(l)) { flush(); out.push(l.trim()); continue; }
			let m;
			if ((m = l.match(RE.head))) { flush(); const n = Math.min(6, m[1].length); out.push(`<div class="md-h md-h${n}">${inline(m[2], hold)}</div>`); continue; }
			if (RE.hr.test(l) && !para.length) { flush(); out.push("<hr>"); continue; }
			if (RE.quote.test(l)) {
				flush();
				const q = [];
				while (i < lines.length && RE.quote.test(lines[i])) q.push(lines[i++].match(RE.quote)[1]);
				i--;
				out.push(`<blockquote>${blocks(q, hold, keep)}</blockquote>`);
				continue;
			}
			if (isRow(l) && i + 1 < lines.length && RE.tsep.test(lines[i + 1])) {
				flush();
				const cells = (r) => r.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
				const align = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
				const head = cells(l);
				const rows = [];
				i += 2;
				while (i < lines.length && isRow(lines[i]) && !RE.hold.test(lines[i])) rows.push(cells(lines[i++]));
				i--;
				const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(c ?? "", hold)}</${tag}>`;
				out.push(`<div class="md-table"><table><thead><tr>${head.map((c, k) => td("th", c, k)).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => td("td", r[k], k)).join("")}</tr>`).join("")}</tbody></table></div>`);
				continue;
			}
			if (RE.item.test(l)) {
				flush();
				const items = [];
				while (i < lines.length) {
					const x = lines[i];
					const im = x.match(RE.item);
					if (im) { items.push({ ind: im[1].replace(/\t/g, "    ").length, ord: /\d/.test(im[2]), start: parseInt(im[2], 10), text: [im[3]] }); i++; continue; }
					// 清單項目的下一行(縮排或沒有空行):接在上一項
					if (x.trim() && items.length && (/^\s{2,}/.test(x) || !RE.hold.test(x) && !RE.head.test(x) && !RE.quote.test(x) && !RE.hr.test(x) && !(isRow(x) && RE.tsep.test(lines[i + 1] ?? "")))) { items.at(-1).text.push(x.trim()); i++; continue; }
					break;
				}
				i--;
				for (let k = 0; k < items.length;) { const r = list(items, k, hold); out.push(r.html); k = Math.max(r.next, k + 1); }
				continue;
			}
			para.push(l);
		}
		flush();
		return out.join("");
	}
	/** 依縮排組成巢狀清單 */
	function list(items, from, hold) {
		const base = items[from].ind, ord = items[from].ord;
		let html = ord ? `<ol${items[from].start > 1 ? ` start="${items[from].start}"` : ""}>` : "<ul>";
		let i = from;
		while (i < items.length && items[i].ind >= base) {
			if (items[i].ind > base) { const sub = list(items, i, hold); html = html.replace(/<\/li>$/, `${sub.html}</li>`); i = sub.next; continue; }
			if (items[i].ord !== ord && i > from) break;
			let body = items[i].text.map((t) => inline(t, hold)).join("<br>");
			const task = body.match(/^\[([ xX])\]\s+/);
			if (task) body = `<input type="checkbox" disabled${task[1] !== " " ? " checked" : ""}> ${body.slice(task[0].length)}`;
			html += `<li${task ? ' class="md-task"' : ""}>${body}</li>`;
			i++;
		}
		return { html: html + (ord ? "</ol>" : "</ul>"), next: i };
	}

	// ---------- 數學式:用到才載 KaTeX ----------
	let katexP = null;
	const KATEX = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist";
	function loadKatex() {
		if (window.katex) return Promise.resolve(window.katex);
		return (katexP ||= new Promise((ok) => {
			if (!document.querySelector("link[data-katex]")) {
				const l = document.createElement("link");
				l.rel = "stylesheet"; l.href = `${KATEX}/katex.min.css`; l.dataset.katex = "1";
				document.head.appendChild(l);
			}
			// Monaco 的 AMD 載入器在的話,UMD 會註冊成模組而不是 window.katex:暫時藏起 define
			const def = window.define;
			window.define = undefined;
			const s = document.createElement("script");
			s.src = `${KATEX}/katex.min.js`;
			s.onload = () => { window.define = def; ok(window.katex || null); };
			s.onerror = () => { window.define = def; katexP = null; ok(null); };
			document.head.appendChild(s);
		}));
	}
	async function typeset(root) {
		const els = root?.querySelectorAll?.(".md-math:not([data-done])");
		if (!els?.length) return;
		const k = await loadKatex();
		if (!k) return; // 載不到:維持原本的 TeX 文字
		for (const el of els) {
			try { k.render(el.textContent, el, { displayMode: el.dataset.display === "1", throwOnError: false, output: "html" }); el.dataset.done = "1"; } catch { /* 保留原文 */ }
		}
	}

	window.chatMd = { render, typeset };
})();
