// 圈選提問:Alt+S(或浮動球旁的圈選鈕、長按浮動球)→ 畫面變暗 → 手畫一圈或拉框 →
// 取出那塊的文字(圈到圖片、圖表、PDF 頁時一律加附截圖)→ 圈選處旁邊跳出小框問管家。
// 依賴主頁面的全域:$, esc, post, toast, sel, selectProject, toggleBall, copyText, manualCopy, xterm, focusTerm, pref
(() => {
	const KEY_DEFAULT = "Alt+S";
	const QUICK = [
		["解釋", "解釋這段內容"],
		["翻譯", "把這段翻譯成繁體中文;如果本來就是中文,翻成英文"],
		["找錯", "這裡有什麼錯誤或問題?說明原因和怎麼修"],
	];
	const S = { layer: null, pop: null, mark: null, pts: [], snap: null, images: [], asked: false, answer: "", project: null, pane: null, busy: false };
	const isTouch = () => matchMedia("(pointer: coarse)").matches;

	// ---------- 快捷鍵 ----------
	const keySpec = () => (pref("steward.snapKey") || KEY_DEFAULT).trim();
	function matchKey(e, spec) {
		if (!spec) return false;
		const parts = spec.split("+").map((x) => x.trim().toLowerCase());
		const key = parts.pop();
		const want = { alt: parts.includes("alt") || parts.includes("option"), ctrl: parts.includes("ctrl"), shift: parts.includes("shift"), meta: parts.includes("cmd") || parts.includes("meta") };
		if (e.altKey !== want.alt || e.ctrlKey !== want.ctrl || e.shiftKey !== want.shift || e.metaKey !== want.meta) return false;
		// Mac 的 Option+S 會打出 ß:用實體按鍵比對
		if (/^[a-z]$/.test(key)) return e.code === `Key${key.toUpperCase()}`;
		if (/^[0-9]$/.test(key)) return e.code === `Digit${key}`;
		return e.key.toLowerCase() === key;
	}
	/** 設定頁錄快捷鍵:按下的組合直接寫進框裡(這台裝置記住) */
	function recordKey(e) {
		if (["Alt", "Control", "Shift", "Meta", "Tab"].includes(e.key)) return e.key === "Tab";
		e.preventDefault(); e.stopImmediatePropagation();
		if (e.key === "Escape" || e.key === "Backspace") return true;
		const k = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.key.length === 1 ? e.key.toUpperCase() : e.key;
		const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Cmd"].filter(Boolean);
		if (!mods.length) { toast("至少要加一個 Ctrl / Alt / Shift / Cmd,免得打字時誤觸"); return true; }
		const spec = [...mods, k].join("+");
		e.target.value = spec; pref("steward.snapKey", spec); toast(`圈選快捷鍵改成 ${spec}`);
		return true;
	}
	document.addEventListener("click", (e) => {
		if (e.target.id !== "snapKeyReset") return;
		pref("steward.snapKey", KEY_DEFAULT);
		const i = $("snapKeyIn"); if (i) i.value = KEY_DEFAULT;
		toast(`圈選快捷鍵還原成 ${KEY_DEFAULT}`);
	});
	function onKey(e) {
		if (e.target?.id === "snapKeyIn" && e.target.offsetParent !== null && recordKey(e)) return;
		if (e.key === "Escape") {
			if (S.layer) { e.preventDefault(); e.stopImmediatePropagation(); cancelLayer(); return; }
			if (S.pop && (S.pop.contains(e.target) || S.pop.contains(document.activeElement))) { e.preventDefault(); e.stopImmediatePropagation(); closePop(); return; }
			return;
		}
		if (e.repeat || !matchKey(e, keySpec())) return;
		e.preventDefault(); e.stopImmediatePropagation();
		// iPhone/iPad app:用 app 自己的圈選(Apple 樣式)
		if (inApp()) { toApp({ type: "snap" }); return; }
		start();
	}
	document.addEventListener("keydown", onKey, true);
	window.snapHookFrame = (win) => { try { win.document.addEventListener("keydown", onKey, true); } catch { /* 跨來源:不會發生 */ } };
	window.snapStart = () => start();
	// iPhone/iPad app 的原生圈選:圈到終端機時,用這個拿那一塊的原文(rect 是網頁畫面的座標)
	window.snapTermText = (rect) => { try { const r = termExtract(rect); return r.error ? { error: r.error } : { text: r.text }; } catch (e) { return { error: String(e) }; } };
	window.snapKeyDefault = KEY_DEFAULT;
	$("ballSnap")?.addEventListener("click", () => start());

	// ---------- 圈選圖層 ----------
	function start() {
		if (S.layer) return;
		closePop();
		const L = document.createElement("div");
		L.id = "snapLayer";
		L.innerHTML = `<canvas></canvas><div class="snap-hint">${isTouch() ? "用手指圈出想問的地方" : "圈出或拉框選出想問的地方 · Esc 取消"}</div>`;
		document.body.appendChild(L);
		S.layer = L; S.pts = [];
		const c = L.querySelector("canvas"), dpr = devicePixelRatio || 1;
		c.width = innerWidth * dpr; c.height = innerHeight * dpr;
		const ctx = c.getContext("2d");
		ctx.scale(dpr, dpr);
		const draw = () => {
			ctx.clearRect(0, 0, innerWidth, innerHeight);
			if (S.pts.length < 2) return;
			ctx.lineWidth = 4; ctx.lineJoin = ctx.lineCap = "round";
			ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.shadowColor = "rgba(47,111,223,.9)"; ctx.shadowBlur = 10;
			ctx.beginPath(); ctx.moveTo(S.pts[0][0], S.pts[0][1]);
			for (const [x, y] of S.pts.slice(1)) ctx.lineTo(x, y);
			ctx.stroke();
		};
		L.addEventListener("pointerdown", (e) => { e.preventDefault(); L.setPointerCapture(e.pointerId); S.pts = [[e.clientX, e.clientY]]; S.down = true; draw(); });
		L.addEventListener("pointermove", (e) => { if (!S.down) return; S.pts.push([e.clientX, e.clientY]); draw(); });
		const up = (e) => { if (!S.down) return; S.down = false; finish(e); };
		L.addEventListener("pointerup", up);
		L.addEventListener("pointercancel", () => { S.down = false; cancelLayer(); });
		L.addEventListener("contextmenu", (e) => { e.preventDefault(); cancelLayer(); });
	}
	function cancelLayer() { S.layer?.remove(); S.layer = null; S.pts = []; }

	async function finish() {
		const xs = S.pts.map((p) => p[0]), ys = S.pts.map((p) => p[1]);
		let rect = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
		cancelLayer();
		// 點一下(沒有拉開):取點到的那一段
		if (rect.right - rect.left < 12 && rect.bottom - rect.top < 12) rect = blockAt(rect.left, rect.top);
		if (!rect) return;
		rect = { left: Math.max(0, rect.left - 2), top: Math.max(0, rect.top - 2), right: Math.min(innerWidth, rect.right + 2), bottom: Math.min(innerHeight, rect.bottom + 2) };
		showMark(rect);
		let res;
		try { res = await extract(rect); } catch (e) { res = { error: String(e?.message || e) }; }
		if (res?.error || (!res?.text && !res?.images?.length)) {
			hideMark();
			toast(res?.error || "這一塊沒有文字,也截不到圖片");
			return;
		}
		openPop(rect, res);
	}

	function blockAt(x, y) {
		const el = document.elementFromPoint(x, y);
		if (!el) return null;
		if (el.id === "term") return { left: x - 200, top: y - 10, right: x + 200, bottom: y + 10 };
		for (let n = el; n && n !== document.body; n = n.parentElement) {
			const r = n.getBoundingClientRect();
			if (r.height >= 14 && r.height <= 360 && r.width <= innerWidth * 0.95 && (n.innerText || "").trim()) return r;
			if (/^(IMG|CANVAS)$/.test(n.tagName)) return r;
		}
		return null;
	}

	// ---------- 取出圈到的內容 ----------
	async function extract(rect) {
		const cx = (rect.left + rect.right) / 2, cy = (rect.top + rect.bottom) / 2;
		const el = document.elementFromPoint(cx, cy);
		if (!el) return null;
		if (el.id === "term" || el.closest?.("#term")) return termExtract(rect);
		if (document.body.classList.contains("code") && el.closest(".cv-group")) {
			const r = window.codeMode?.snapAt?.(rect);
			if (r?.kind === "code") return { snap: { kind: "code", label: r.label, path: r.path, from: r.from, to: r.to, text: r.text, context: r.context }, text: r.text, images: [] };
			if (r?.dom) return domExtract(r.dom, rect, { label: r.label, path: r.path, kind: "doc" });
		}
		return domExtract(document.body, rect, { label: pageLabel(), kind: "page" });
	}
	const pageLabel = () => (document.body.classList.contains("term") ? "終端機" : document.body.classList.contains("code") ? "程式碼頁" : "看板");

	function termExtract(rect) {
		const fr = $("term"), t = xterm();
		if (!t) return { error: "終端機還沒準備好" };
		const fo = fr.getBoundingClientRect();
		const scr = t.element.querySelector(".xterm-screen").getBoundingClientRect();
		const cell = t._core?._renderService?.dimensions?.css?.cell;
		if (!cell?.width) return { error: "讀不到終端機的字格大小" };
		const ox = fo.left + fr.clientLeft + scr.left, oy = fo.top + fr.clientTop + scr.top;
		// 字格的中心落在圈選範圍裡才算(只擦到邊的那一行、那一欄不算)
		const c0 = Math.max(0, Math.ceil((rect.left - ox) / cell.width - 0.5)), c1 = Math.min(t.cols, Math.floor((rect.right - ox) / cell.width + 0.5));
		const r0 = Math.max(0, Math.ceil((rect.top - oy) / cell.height - 0.5)), r1 = Math.min(t.rows - 1, Math.floor((rect.bottom - oy) / cell.height - 0.5));
		if (r1 < r0 || c1 <= c0) return { error: "圈的範圍太小,沒有圈到字" };
		const buf = t.buffer.active, lines = [];
		for (let r = r0; r <= r1; r++) lines.push((buf.getLine(buf.viewportY + r)?.translateToString(true, c0, c1) ?? "").replace(/\s+$/, ""));
		while (lines.length && !lines[0].trim()) lines.shift();
		while (lines.length && !lines.at(-1).trim()) lines.pop();
		const text = dedent(lines).join("\n");
		return { snap: { kind: "terminal", label: "終端機", text }, text, images: [] };
	}
	const dedent = (lines) => {
		const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
		return Number.isFinite(pad) && pad > 0 ? lines.map((l) => l.slice(pad)) : lines;
	};

	const SKIP = "#snapLayer,#snapPop,#snapMark,#ballSnap,script,style,noscript,.monaco-editor,[aria-hidden=true]";
	function domExtract(root, rect, info) {
		const hits = (r) => r.width > 0 && r.height > 0 && r.right > rect.left && r.left < rect.right && r.bottom > rect.top && r.top < rect.bottom;
		const inside = (r) => { const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2; return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom; };
		const pieces = [];
		let firstNode = null;
		const range = document.createRange();
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			const s = n.nodeValue;
			if (!s || !s.trim()) continue;
			const pe = n.parentElement;
			if (!pe || pe.closest(SKIP)) continue;
			range.selectNodeContents(n);
			const rs = [...range.getClientRects()];
			if (!rs.some(hits)) continue;
			if (rs.every(inside)) { const r = rs[0]; pieces.push({ x: r.left, y: r.top, h: r.height, right: rs.at(-1).right, text: s }); firstNode ||= n; continue; }
			if (s.length > 6000) continue;
			// 只圈到一部分:逐字判斷
			let run = null;
			for (let i = 0; i < s.length; i++) {
				range.setStart(n, i); range.setEnd(n, i + 1);
				const r = range.getBoundingClientRect();
				const ok = r.width > 0 ? inside(r) : run !== null;
				if (ok) {
					if (!run || Math.abs(r.top - run.y) > run.h * 0.6 && r.width > 0) { if (run) pieces.push(run); run = { x: r.left, y: r.top, h: r.height || 14, right: r.right, text: "" }; }
					run.text += s[i]; if (r.width > 0) run.right = r.right;
				} else if (run) { pieces.push(run); run = null; }
			}
			if (run) pieces.push(run);
			firstNode ||= n;
		}
		const text = joinPieces(pieces);
		// 圖片、圖表、PDF 頁面(畫布):圈到就一律截圖附上,文字一起送(網頁截不到純文字的地方,只截得到這些)
		const media = [...root.querySelectorAll("img,canvas,video")].filter((m) => !m.closest(SKIP) && hits(m.getBoundingClientRect()));
		const images = media.length ? [cropImage(media, rect)].filter(Boolean) : [];
		// 出處:PDF 標頁碼
		let label = info.label;
		const page = (firstNode?.parentElement ?? document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2))?.closest?.(".pdfpage");
		if (page) label += ` 第 ${[...page.parentElement.children].indexOf(page) + 1} 頁`;
		const context = contextOf(firstNode?.parentElement, root, text);
		return { snap: { kind: info.kind, label, path: info.path, text, context }, text, images };
	}
	function joinPieces(pieces) {
		pieces.sort((a, b) => (Math.abs(a.y - b.y) <= Math.min(a.h, b.h) * 0.5 ? a.x - b.x : a.y - b.y));
		const lines = [];
		let cur = null;
		for (const p of pieces) {
			if (!cur || Math.abs(p.y - cur.y) > Math.min(p.h, cur.h) * 0.5) { cur = { y: p.y, h: p.h, right: p.right, text: p.text.replace(/\n+$/, "") }; lines.push(cur); continue; }
			const gap = p.x - cur.right;
			const sp = gap > p.h * 0.25 && !/\s$/.test(cur.text) && !/^\s/.test(p.text) ? " " : "";
			cur.text += sp + p.text; cur.right = Math.max(cur.right, p.right);
		}
		return lines.map((l) => l.text.replace(/[ \t]+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
	}
	/** 周圍內容:往上找到一個夠大的區塊(PDF 一頁、Notebook 一格、Word 一節),取圈選處前後各約 3000 字 */
	function contextOf(node, root, text) {
		if (!node) return undefined;
		let el = node;
		while (el && el !== root && el.parentElement) {
			if (el.matches?.(".pdfpage,.nb-cell,section.docx,table,.cv-surface")) break;
			if ((el.innerText || "").length >= 1500) break;
			el = el.parentElement;
		}
		const all = (el?.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
		if (!all || all === text) return undefined;
		if (all.length <= 6000) return all;
		const key = text.split("\n").find((l) => l.trim().length >= 6)?.trim().slice(0, 40);
		const i = key ? Math.max(0, all.indexOf(key)) : 0;
		return all.slice(Math.max(0, i - 3000), i + 3000);
	}
	/** 把圈選範圍裡的圖片 / 畫布畫成一張圖(最長邊 1600) */
	function cropImage(media, rect) {
		const w = rect.right - rect.left, h = rect.bottom - rect.top;
		const k = Math.min(devicePixelRatio || 1, 1600 / Math.max(w, h));
		const c = document.createElement("canvas");
		c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
		const g = c.getContext("2d");
		g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
		let drawn = 0;
		for (const m of media) {
			const r = m.getBoundingClientRect();
			const sw = m.naturalWidth || m.videoWidth || m.width, sh = m.naturalHeight || m.videoHeight || m.height;
			if (!sw || !sh || !r.width || !r.height) continue;
			const ix0 = Math.max(r.left, rect.left), iy0 = Math.max(r.top, rect.top), ix1 = Math.min(r.right, rect.right), iy1 = Math.min(r.bottom, rect.bottom);
			if (ix1 <= ix0 || iy1 <= iy0) continue;
			const sx = sw / r.width, sy = sh / r.height;
			try {
				g.drawImage(m, (ix0 - r.left) * sx, (iy0 - r.top) * sy, (ix1 - ix0) * sx, (iy1 - iy0) * sy, (ix0 - rect.left) * k, (iy0 - rect.top) * k, (ix1 - ix0) * k, (iy1 - iy0) * k);
				drawn++;
			} catch { /* 還沒載入完 */ }
		}
		if (!drawn) return null;
		try {
			const url = c.toDataURL("image/png");
			const t = document.createElement("canvas"), tk = Math.min(1, 160 / Math.max(c.width, c.height));
			t.width = Math.max(1, Math.round(c.width * tk)); t.height = Math.max(1, Math.round(c.height * tk));
			t.getContext("2d").drawImage(c, 0, 0, t.width, t.height);
			return { mimeType: "image/png", data: url.split(",")[1], thumb: t.toDataURL("image/jpeg", 0.7) };
		} catch { return null; } // 別的網站的圖片:瀏覽器不讓讀
	}

	// ---------- 圈選框標記 ----------
	function showMark(r) {
		hideMark();
		const m = document.createElement("div");
		m.id = "snapMark";
		Object.assign(m.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` });
		document.body.appendChild(m);
		S.mark = m;
	}
	function hideMark() { S.mark?.remove(); S.mark = null; }

	// ---------- 小框 ----------
	function openPop(rect, res) {
		S.pop?.remove(); S.pop = null; // 換掉舊的小框,圈選框留著
		Object.assign(S, { snap: res.snap, images: res.images || [], asked: false, answer: "", project: null, pane: null, busy: false });
		const lines = res.text ? res.text.split("\n").length : 0;
		const src = `${res.snap.label}${res.snap.from ? ` 第 ${res.snap.from}${res.snap.to !== res.snap.from ? `–${res.snap.to}` : ""} 行` : lines ? ` · ${lines} 行` : ""}${S.images.length ? " · 圖片" : ""}`;
		const P = document.createElement("div");
		P.id = "snapPop";
		P.setAttribute("role", "dialog");
		P.setAttribute("aria-label", "圈選提問");
		P.innerHTML = `<div class="sp-head"><span class="sp-src" title="${esc(src)}">⊙ ${esc(src)}</span><button class="small" data-sp="close" title="關閉(Esc)">×</button></div>
			<details class="sp-peek"><summary>圈到的內容</summary>${res.text ? `<pre>${esc(res.text.slice(0, 4000))}</pre>` : ""}${S.images.map((i) => `<img src="${i.thumb}" alt="">`).join("")}</details>
			<div class="sp-chips">${QUICK.map(([l, q]) => `<button class="small" data-q="${esc(q)}">${l}</button>`).join("")}<button class="small" data-sp="card">開工作卡</button></div>
			<form class="sp-form"><input type="text" placeholder="問這一塊,或寫要做的事(再按「開工作卡」)…" autocomplete="off"><button class="small primary">送出</button></form>
			<div class="sp-ans" hidden></div>
			<div class="sp-acts" hidden><button class="small" data-sp="copy">複製</button><button class="small" data-sp="ball">${inApp() ? "到問管家繼續" : "到浮動球繼續"}</button><button class="small" data-sp="card">開工作卡</button><button class="small primary" data-sp="agent" hidden>交給這個 agent</button></div>`;
		document.body.appendChild(P);
		S.pop = P;
		place(P, rect);
		P.addEventListener("click", onPopClick);
		P.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); const i = P.querySelector("input"); const q = i.value.trim(); if (!q) return; i.value = ""; ask(q); });
		if (!isTouch()) setTimeout(() => P.querySelector("input").focus(), 30);
	}
	function place(P, r) {
		if (innerWidth <= 700) { P.classList.add("sheet"); return; } // 手機:從下面滑出
		const w = Math.min(400, innerWidth - 24), gap = 12;
		P.style.width = `${w}px`;
		const h = P.offsetHeight || 240;
		let left = r.right + gap, top = r.top;
		if (left + w > innerWidth - 12) left = r.left - gap - w; // 右邊放不下:放左邊
		if (left < 12) { left = Math.min(Math.max(12, r.left), innerWidth - w - 12); top = r.bottom + gap; } // 左右都放不下:放下面
		if (top + h > innerHeight - 12) top = Math.max(12, innerHeight - h - 12);
		P.style.left = `${left}px`; P.style.top = `${top}px`;
	}
	function closePop() {
		S.pop?.remove(); S.pop = null; hideMark();
		if (document.body.classList.contains("term")) focusTerm();
	}

	async function ask(q) {
		if (S.busy || !S.pop) return;
		const P = S.pop, ans = P.querySelector(".sp-ans"), acts = P.querySelector(".sp-acts");
		S.busy = true;
		ans.hidden = false; ans.classList.remove("err");
		ans.innerHTML = `<div class="sp-q">${esc(q)}</div><div class="sp-wait">思考中…</div>`;
		acts.hidden = true;
		P.querySelector(".sp-chips").hidden = true;
		const pid = S.project || sel;
		// 第一題帶圈選內容;接著問就在同一個專案對話裡繼續(管家記得前面圈過什麼)
		const payload = S.asked ? { project: pid, message: q } : { project: pid, message: q, snap: S.snap, images: S.images.map(({ data, mimeType }) => ({ data, mimeType })), thumbs: S.images.map((i) => i.thumb) };
		const r = await post("/api/chat", payload).catch((e) => ({ error: `連不上管家:${e}` }));
		S.busy = false;
		if (!S.pop) return;
		S.asked = true;
		if (r.snap) { S.project = r.snap.project; S.pane = r.snap.pane || S.pane; }
		S.answer = r.answer || "";
		ans.innerHTML = `<div class="sp-q">${esc(q)}</div><div class="sp-text${r.answer ? " md" : ""}">${r.answer ? chatMd.render(r.answer) : esc(r.error || "沒有回應")}</div>`;
		chatMd.typeset(ans);
		ans.classList.toggle("err", !r.answer);
		acts.hidden = false;
		acts.querySelector('[data-sp="agent"]').hidden = !(S.snap?.kind === "terminal" && S.pane?.agent && S.answer);
		acts.querySelector('[data-sp="copy"]').hidden = !S.answer;
		if (r.snap?.project && r.snap.project !== sel) toast(`記在「${state.projects.find((p) => p.id === r.snap.project)?.name ?? "另一個專案"}」的管家紀錄`);
		if (P.classList.contains("sheet") === false) place(P, S.mark?.getBoundingClientRect() ?? P.getBoundingClientRect());
	}

	async function onPopClick(e) {
		const q = e.target.closest("[data-q]")?.dataset.q;
		if (q) return ask(q);
		const act = e.target.closest("[data-sp]")?.dataset.sp;
		if (!act) return;
		if (act === "close") return closePop();
		if (act === "copy") { copyText(window, S.answer).then((ok) => (ok ? toast("已複製") : manualCopy(S.answer))); return; }
		const pid = S.project || sel;
		const go = async () => { if (pid && pid !== sel) await selectProject(pid, "圈選"); };
		if (act === "ball") { await go(); closePop(); toggleBall(true); return; }
		if (act === "card") {
			const s = S.snap, answer = S.answer;
			// 輸入框裡寫的話(問題或要做的事)放最前面:管家照它擬工作卡
			const box = S.pop?.querySelector(".sp-form input");
			const task = box?.value.trim() || "";
			if (box) box.value = "";
			const msg = `依照這段圈選的內容開工作卡${task ? `\n要做的事:${task}` : ""}\n出處:${s.label}${s.from ? ` 第 ${s.from}–${s.to} 行` : ""}\n${s.text ? `內容:\n${s.text.slice(0, 3000)}` : "(圈到的是圖片)"}${answer ? `\n\n管家的看法:\n${answer.slice(0, 2000)}` : ""}`;
			// iPhone app:工作卡草稿在 app 自己的問管家裡擬
			if (inApp()) {
				closePop();
				toApp({ type: "draft", project: pid, message: msg });
				return;
			}
			await go(); closePop(); toggleBall(true);
			$("bpInput").value = msg;
			$("bpDraft").click();
			return;
		}
		if (act === "agent") {
			const pane = S.pane?.paneId, text = `關於這段:\n${S.snap.text}\n\n管家的建議:\n${S.answer.trim()}`;
			const r = await post("/api/snap/agent", { pane }).catch(() => ({ error: "連不上管家" }));
			if (r.error) return toast(`沒辦法切到那個 agent:${r.error}`);
			closePop();
			const t = xterm();
			if (!t) return toast("終端機還沒準備好");
			setTimeout(() => { t.paste(text); focusTerm(); toast(`已貼到 ${S.pane?.agent ?? "agent"} 的輸入框,看過再按 Enter 送出`); }, 150);
		}
	}
	// 調整視窗大小:小框跟著圈選框
	addEventListener("resize", () => { if (S.pop && S.mark) place(S.pop, S.mark.getBoundingClientRect()); });
})();
