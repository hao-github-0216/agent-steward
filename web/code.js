// 「程式碼」模式:檔案樹 + 可分割的 Monaco 編輯區 + Git 面板(類 VS Code)。
// 編輯區版面:欄(左右並排,最多 4 欄)→ 每欄裡的群組(上下並排,最多 3 個);每個群組有自己的分頁列與編輯器。
// 分頁可以拖拉:同一列換順序、拖到別的群組、拖到群組的上下左右邊緣就分割出新的群組。
// 依賴主頁面的全域:$, esc, post, toast, state, sel, setMode, jumpTo, load, pref
(() => {
	const MONACO = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min";
	const MAX_COLS = 4, MAX_ROWS = 3;
	const mobile = () => innerWidth <= 800;
	const cm = {
		pid: null, view: "files", expanded: new Set([""]), hidden: false, dirs: {}, git: null, history: null, openCommit: null, selRow: null,
		monaco: null, ready: null,
		cols: [], // [{ id, size, groups: [group] }]
		activeGroup: null,
		drag: null, // 正在拖的分頁
		stash: new Map(), // 有沒存修改就切走的專案:整組分頁留在記憶體 pid → { cols, activeGroup, expanded }
	};
	let uid = 0;

	// ---------- 工具 ----------
	async function api(path, opts = {}) {
		const r = await fetch(`/api/code/${cm.pid}/${path}`, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
		const ct = r.headers.get("content-type") || "";
		const data = ct.includes("json") ? await r.json() : null;
		if (!r.ok) {
			const err = new Error(data?.error || `錯誤 ${r.status}`);
			err.status = r.status; err.data = data;
			throw err;
		}
		return data;
	}
	const gitPost = (action, body = {}) => api(`git/${action}`, { method: "POST", body: JSON.stringify(body) });
	const fail = (e) => toast(e.message || String(e));
	const baseName = (p) => p.split("/").pop();
	const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
	const fmtSize = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${(n / 1e3).toFixed(0)} KB` : `${n} B`);
	const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

	function dialog({ title, html, buttons }) {
		const wrap = el("div", "modal");
		wrap.innerHTML = `<div class="box" role="dialog"><div class="mhead"><h3>${esc(title)}</h3><button class="small" data-x>關閉</button></div><div class="mbody">${html}</div><div class="mfoot"></div></div>`;
		const close = () => wrap.remove();
		wrap.querySelector("[data-x]").onclick = close;
		wrap.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
		for (const b of buttons || []) {
			const bt = el("button", `small${b.primary ? " primary" : ""}`);
			bt.textContent = b.label;
			bt.onclick = async () => { bt.disabled = true; try { if ((await b.onClick?.(wrap)) !== false) close(); } catch (e) { fail(e); } finally { bt.disabled = false; } };
			wrap.querySelector(".mfoot").appendChild(bt);
		}
		document.body.appendChild(wrap);
		setTimeout(() => wrap.querySelector("input,textarea")?.focus(), 30);
		return wrap;
	}
	function askName(title, value = "", label = "名稱") {
		return new Promise((resolve) => {
			const d = dialog({ title, html: `<label class="field">${esc(label)}<input type="text" data-v value="${esc(value)}"></label>`, buttons: [{ label: "確定", primary: true, onClick: (w) => resolve(w.querySelector("[data-v]").value.trim() || null) }] });
			d.querySelector("[data-x]").addEventListener("click", () => resolve(null));
			d.querySelector("[data-v]").addEventListener("keydown", (e) => { if (e.key === "Enter") d.querySelector(".mfoot button").click(); });
		});
	}
	function confirmBox(title, text, okLabel = "確定") {
		return new Promise((resolve) => {
			const d = dialog({ title, html: `<p>${esc(text)}</p>`, buttons: [{ label: okLabel, primary: true, onClick: () => resolve(true) }] });
			d.querySelector("[data-x]").addEventListener("click", () => resolve(false));
		});
	}
	window.confirmBox = confirmBox; // 看板頁(浮動球)也用同一個確認對話框
	function menu(x, y, items) {
		document.querySelector(".cv-menu")?.remove();
		const m = el("div", "cv-menu");
		for (const it of items) {
			const b = el("button");
			b.textContent = it.label;
			b.onclick = () => { m.remove(); it.run(); };
			m.appendChild(b);
		}
		document.body.appendChild(m);
		const r = m.getBoundingClientRect();
		m.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
		m.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
		const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
		document.addEventListener("pointerdown", close, true);
	}

	// ---------- Monaco ----------
	function loadMonaco() {
		if (cm.ready) return cm.ready;
		cm.ready = new Promise((resolve, reject) => {
			window.MonacoEnvironment = { getWorkerUrl: () => `data:text/javascript;charset=utf-8,${encodeURIComponent(`self.MonacoEnvironment={baseUrl:'${MONACO}/'};importScripts('${MONACO}/vs/base/worker/workerMain.js');`)}` };
			const s = el("script");
			s.src = `${MONACO}/vs/loader.js`;
			s.onerror = () => reject(new Error("載入編輯器失敗(需要能連上 cdn.jsdelivr.net)"));
			s.onload = () => {
				window.require.config({ paths: { vs: `${MONACO}/vs` } });
				window.require(["vs/editor/editor.main"], () => {
					cm.monaco = window.monaco;
					const dark = matchMedia("(prefers-color-scheme: dark)");
					const theme = () => cm.monaco.editor.setTheme(document.documentElement.dataset.theme === "light" ? "vs" : document.documentElement.dataset.theme === "dark" || dark.matches ? "vs-dark" : "vs");
					theme();
					dark.addEventListener("change", theme);
					for (const g of allGroups()) attachEditors(g);
					resolve(cm.monaco);
				});
			};
			document.head.appendChild(s);
		});
		return cm.ready;
	}
	let mdLib = null;
	/** 用 Monaco 的 AMD 載入器載 marked + DOMPurify(先載好 Monaco) */
	function loadMd() {
		if (mdLib) return mdLib;
		mdLib = loadMonaco().then(() => new Promise((ok, no) => {
			window.require.config({ paths: { "md-marked": "https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min", "md-purify": "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min" } });
			window.require(["md-marked", "md-purify"], (marked, purify) => ok({ marked, purify }), () => no(new Error("載入 Markdown 預覽失敗(需要能連上 cdn.jsdelivr.net)")));
		})).catch((e) => { mdLib = null; throw e; });
		return mdLib;
	}
	const isMd = (p) => /\.(md|markdown|mdx)$/i.test(p || "");
	const isNb = (p) => /\.ipynb$/i.test(p || "");
	let mathLib = null;
	/** KaTeX(數學式排版),一樣經過 Monaco 的 AMD 載入器;載不到就不排版,不影響其他內容 */
	function loadMath() {
		if (mathLib) return mathLib;
		const base = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist";
		if (!document.querySelector("link[data-katex]")) {
			const l = document.createElement("link");
			l.rel = "stylesheet"; l.href = `${base}/katex.min.css`; l.dataset.katex = "1";
			document.head.appendChild(l);
		}
		mathLib = loadMonaco().then(() => new Promise((ok) => {
			window.require.config({ paths: { katex: `${base}/katex.min`, "katex-auto": `${base}/contrib/auto-render.min` } });
			window.require(["katex", "katex-auto"], (katex, auto) => ok({ katex, auto }), () => ok(null));
		}));
		return mathLib;
	}
	function langOf(path) {
		const ext = `.${path.split(".").pop()}`.toLowerCase();
		const name = baseName(path).toLowerCase();
		const hit = cm.monaco.languages.getLanguages().find((l) => (l.extensions || []).includes(ext) || (l.filenames || []).map((f) => f.toLowerCase()).includes(name));
		return hit?.id || "plaintext";
	}

	// ---------- 編輯群組與版面 ----------
	const allGroups = () => cm.cols.flatMap((c) => c.groups);
	const allTabs = () => allGroups().flatMap((g) => g.tabs);
	function newGroup() {
		const g = { id: `g${++uid}`, size: 1, tabs: [], active: null };
		g.el = el("div", "cv-group");
		g.tabsEl = el("div", "cv-tabs");
		g.stageEl = el("div", "cv-stage");
		g.editorEl = el("div", "cv-surface"); g.editorEl.hidden = true;
		g.diffEl = el("div", "cv-surface"); g.diffEl.hidden = true;
		g.previewEl = el("div", "cv-surface cv-preview"); g.previewEl.hidden = true;
		g.emptyEl = el("div", "cv-surface cv-empty", "從左邊選一個檔案,或到 Git 看變更<br><span class=\"hint\">分頁可以拖到旁邊分割編輯區</span>");
		g.dropEl = el("div", "cv-drop"); g.dropEl.hidden = true;
		g.barEl = el("div", "cv-bar"); g.barEl.hidden = true;
		g.stageEl.append(g.editorEl, g.diffEl, g.previewEl, g.emptyEl, g.dropEl);
		g.el.append(g.tabsEl, g.stageEl, g.barEl);
		g.el.addEventListener("pointerdown", () => setActiveGroup(g), true);
		// 編輯器有自己的右鍵選單(問管家、分割…),擋掉瀏覽器的選單免得蓋在上面
		for (const surf of [g.editorEl, g.diffEl]) surf.addEventListener("contextmenu", (e) => e.preventDefault());
		wireGroupEvents(g);
		if (cm.monaco) attachEditors(g);
		return g;
	}
	function attachEditors(g) {
		if (g.editor) return;
		const m = cm.monaco;
		g.editor = m.editor.create(g.editorEl, { automaticLayout: true, fontSize: 13, minimap: { enabled: !mobile() }, scrollBeyondLastLine: false, tabSize: 2 });
		g.diff = m.editor.createDiffEditor(g.diffEl, { automaticLayout: true, fontSize: 13, readOnly: true, originalEditable: false, renderSideBySide: !mobile(), minimap: { enabled: false } });
		for (const ed of [g.editor, g.diff.getModifiedEditor()]) {
			// addCommand 會被最後建立的編輯器蓋掉(全域),所以用 addAction 綁快捷鍵
			ed.addAction({ id: "steward.save", label: "存檔", keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.KeyS], run: () => save(g) });
			ed.onDidFocusEditorText(() => setActiveGroup(g));
		}
		g.editor.onDidChangeCursorPosition(() => saveSoon(3000));
		// 手機:點一下程式碼內容就把游標放進去(在點擊當下聚焦,iPhone 才會叫出鍵盤)
		for (const [surf, getEd] of [[g.editorEl, () => g.editor], [g.diffEl, () => g.diff.getModifiedEditor()]]) {
			let t0 = null;
			surf.addEventListener("touchstart", (e) => { t0 = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, at: Date.now() } : null; }, { passive: true });
			surf.addEventListener("touchend", (e) => {
				const p = e.changedTouches[0];
				if (!t0 || !p || Math.hypot(p.clientX - t0.x, p.clientY - t0.y) > 10 || Date.now() - t0.at > 600) return;
				const ed = getEd();
				if (!ed.hasTextFocus()) ed.focus();
			});
		}
		g.editor.onDidScrollChange(() => saveSoon(3000));
		const pick = (ed) => { const r = ed.getSelection(); return { text: ed.getModel().getValueInRange(r), from: r.startLineNumber, to: r.endLineNumber, path: g.active?.path }; };
		g.editor.addAction({ id: "steward.ask", label: "問管家", contextMenuGroupId: "1_steward", contextMenuOrder: 1, run: (ed) => askSteward(pick(ed)) });
		g.editor.addAction({ id: "steward.card", label: "建立工作卡", contextMenuGroupId: "1_steward", contextMenuOrder: 2, run: (ed) => newCard(pick(ed)) });
		g.editor.addAction({ id: "steward.mdPreview", label: "預覽 Markdown", contextMenuGroupId: "2_layout", contextMenuOrder: 0, precondition: undefined, run: () => isMd(g.active?.path) ? openPreview(g.active.path) : toast("這不是 Markdown 檔") });
		g.editor.addAction({ id: "steward.splitRight", label: "向右分割", contextMenuGroupId: "2_layout", run: () => g.active && splitWith(g.active, g, "right") });
		g.editor.addAction({ id: "steward.splitDown", label: "向下分割", contextMenuGroupId: "2_layout", run: () => g.active && splitWith(g.active, g, "bottom") });
		if (g.active) activate(g, g.active);
	}
	function disposeGroup(g) {
		g.diff?.setModel(null);
		g.editor?.setModel(null);
		g.diff?.dispose(); g.editor?.dispose();
		g.el.remove();
	}
	function setActiveGroup(g) {
		if (cm.activeGroup === g) return;
		cm.activeGroup = g;
		saveSoon();
		for (const x of allGroups()) x.el.classList.toggle("active", x === g);
	}
	function ensureLayout() {
		if (!cm.cols.length) {
			const g = newGroup();
			cm.cols = [{ id: `c${++uid}`, size: 1, groups: [g] }];
			cm.activeGroup = g;
		}
	}
	/** 依 cm.cols 重新排 DOM(群組元素沿用,編輯器不會重建) */
	function layout() {
		ensureLayout();
		const root = $("cvGroups");
		root.replaceChildren();
		cm.cols.forEach((col, ci) => {
			if (ci > 0) root.appendChild(sash("v", cm.cols[ci - 1], col));
			col.el = col.el || el("div", "cv-col");
			col.el.replaceChildren();
			col.el.style.flexGrow = col.size;
			col.groups.forEach((g, gi) => {
				if (gi > 0) col.el.appendChild(sash("h", col.groups[gi - 1], g));
				g.el.style.flexGrow = g.size;
				col.el.appendChild(g.el);
			});
			root.appendChild(col.el);
		});
		for (const g of allGroups()) { g.el.classList.toggle("active", g === cm.activeGroup); renderTabs(g); }
		saveSoon();
	}
	/** 分割線:拖拉調整左右兩欄(或上下兩群組)的比例 */
	function sash(dir, a, b) {
		const s = el("div", dir === "v" ? "cv-sash-v" : "cv-sash-h");
		s.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			s.setPointerCapture(e.pointerId);
			s.classList.add("drag");
			const ra = (a.el).getBoundingClientRect(), rb = (b.el).getBoundingClientRect();
			const total = dir === "v" ? ra.width + rb.width : ra.height + rb.height;
			const start = dir === "v" ? e.clientX : e.clientY;
			const startA = dir === "v" ? ra.width : ra.height;
			const sum = a.size + b.size;
			const move = (ev) => {
				const pos = (dir === "v" ? ev.clientX : ev.clientY) - start;
				const pa = Math.max(120, Math.min(total - 120, startA + pos));
				a.size = (sum * pa) / total; b.size = sum - a.size;
				a.el.style.flexGrow = a.size; b.el.style.flexGrow = b.size;
			};
			const up = () => { s.classList.remove("drag"); s.removeEventListener("pointermove", move); s.removeEventListener("pointerup", up); saveSoon(); };
			s.addEventListener("pointermove", move);
			s.addEventListener("pointerup", up);
		});
		return s;
	}
	function colOf(g) { return cm.cols.find((c) => c.groups.includes(g)); }
	/** 群組空了就移除(至少留一個) */
	function pruneGroup(g) {
		if (g.tabs.length || allGroups().length <= 1) return;
		const col = colOf(g);
		col.groups.splice(col.groups.indexOf(g), 1);
		if (!col.groups.length) cm.cols.splice(cm.cols.indexOf(col), 1);
		disposeGroup(g);
		if (cm.activeGroup === g) setActiveGroup(allGroups()[0]);
		layout();
	}
	/** 把分頁搬到另一個群組的指定位置 */
	function moveTab(t, to, index) {
		const from = t.group;
		if (from === to) {
			const i = from.tabs.indexOf(t);
			from.tabs.splice(i, 1);
			from.tabs.splice(index > i ? index - 1 : index, 0, t);
			renderTabs(from);
			return;
		}
		from.tabs.splice(from.tabs.indexOf(t), 1);
		if (from.active === t) {
			from.active = null;
			from.diff?.setModel(null);
			activate(from, from.tabs[0] || null);
		}
		t.pv?.remove(); t.pv = null; t.pdfDoc?.destroy?.(); t.pdfDoc = null; // 在新群組重建
		t.group = to;
		to.tabs.splice(Math.min(index ?? to.tabs.length, to.tabs.length), 0, t);
		setActiveGroup(to);
		activate(to, t);
		pruneGroup(from);
		renderTabs(from);
	}
	/** 拖到群組邊緣:分割出新群組(左右=新的一欄,上下=同一欄多一個群組) */
	function newGroupAt(target, zone) {
		const col = colOf(target);
		if ((zone === "left" || zone === "right") && cm.cols.length >= MAX_COLS) { toast(`最多 ${MAX_COLS} 欄`); return null; }
		if ((zone === "top" || zone === "bottom") && col.groups.length >= MAX_ROWS) { toast(`每欄最多 ${MAX_ROWS} 個`); return null; }
		const g = newGroup();
		if (zone === "left" || zone === "right") {
			const ci = cm.cols.indexOf(col) + (zone === "right" ? 1 : 0);
			cm.cols.splice(ci, 0, { id: `c${++uid}`, size: col.size, groups: [g] });
		} else {
			const gi = col.groups.indexOf(target) + (zone === "bottom" ? 1 : 0);
			col.groups.splice(gi, 0, g);
			g.size = target.size;
		}
		layout();
		return g;
	}
	function splitWith(t, target, zone) {
		const g = newGroupAt(target, zone);
		if (!g) return;
		moveTab(t, g, 0);
		layout();
	}

	// ---------- 分頁 ----------
	function renderTabs(g) {
		const back = mobile() ? '<button class="small cv-back" data-back>← 返回</button>' : "";
		g.tabsEl.innerHTML = back + g.tabs.map((t) => `<div class="cv-tab${t === g.active ? " on" : ""}${t.dirty ? " dirty" : ""}" data-key="${esc(t.key)}" title="${esc(t.title)}" draggable="${!mobile()}">${esc(t.label)}<button class="x" data-close title="關閉"><span>×</span></button></div>`).join("");
	}
	function findTab(key) { return allTabs().find((t) => t.key === key); }
	function wireGroupEvents(g) {
		g.tabsEl.addEventListener("click", (e) => {
			if (e.target.closest("[data-back]")) { document.body.classList.remove("cv-editing"); return; }
			const tabEl = e.target.closest(".cv-tab");
			if (!tabEl) return;
			const t = findTab(tabEl.dataset.key);
			if (e.target.closest("[data-close]")) return closeTab(t);
			setActiveGroup(g);
			activate(g, t);
		});
		g.tabsEl.addEventListener("auxclick", (e) => { if (e.button === 1) { const t = findTab(e.target.closest(".cv-tab")?.dataset.key); if (t) closeTab(t); } });
		g.tabsEl.addEventListener("contextmenu", (e) => {
			const t = findTab(e.target.closest(".cv-tab")?.dataset.key);
			if (!t) return;
			e.preventDefault();
			menu(e.clientX, e.clientY, [
				{ label: "向右分割", run: () => splitWith(t, g, "right") },
				{ label: "向下分割", run: () => splitWith(t, g, "bottom") },
				{ label: "關閉", run: () => closeTab(t) },
				{ label: "關閉其他分頁", run: () => g.tabs.filter((x) => x !== t).forEach((x) => closeTab(x)) },
			]);
		});
		// 拖拉:分頁列(換順序 / 搬到這個群組)
		g.tabsEl.addEventListener("dragstart", (e) => {
			const tabEl = e.target.closest(".cv-tab");
			if (!tabEl) return;
			cm.drag = findTab(tabEl.dataset.key);
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData("text/plain", tabEl.dataset.key);
			tabEl.classList.add("dragging");
		});
		g.tabsEl.addEventListener("dragend", () => { cm.drag = null; clearDropMarks(); });
		const tabIndexAt = (x) => {
			const tabs = [...g.tabsEl.querySelectorAll(".cv-tab")];
			const i = tabs.findIndex((tEl) => { const r = tEl.getBoundingClientRect(); return x < r.left + r.width / 2; });
			return i < 0 ? tabs.length : i;
		};
		g.tabsEl.addEventListener("dragover", (e) => {
			if (!cm.drag) return;
			e.preventDefault();
			clearDropMarks();
			const i = tabIndexAt(e.clientX);
			const tabs = g.tabsEl.querySelectorAll(".cv-tab");
			if (tabs[i]) tabs[i].classList.add("drop-before"); else g.tabsEl.classList.add("drop-end");
		});
		g.tabsEl.addEventListener("drop", (e) => {
			if (!cm.drag) return;
			e.preventDefault();
			const t = cm.drag; cm.drag = null;
			clearDropMarks();
			if (t.fromTree) openFile(t.fromTree, g);
			else moveTab(t, g, tabIndexAt(e.clientX));
		});
		// 拖拉:編輯區(中間=搬進來,邊緣=分割)
		const zoneAt = (e) => {
			const r = g.stageEl.getBoundingClientRect();
			const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
			if (x < 0.22) return "left";
			if (x > 0.78) return "right";
			if (y < 0.22) return "top";
			if (y > 0.78) return "bottom";
			return "center";
		};
		g.stageEl.addEventListener("dragover", (e) => {
			if (!cm.drag) return;
			e.preventDefault();
			e.stopPropagation();
			const z = zoneAt(e);
			const d = g.dropEl.style;
			g.dropEl.hidden = false;
			Object.assign(d, { left: "0", top: "0", right: "0", bottom: "0" });
			if (z === "left") d.right = "50%";
			if (z === "right") d.left = "50%";
			if (z === "top") d.bottom = "50%";
			if (z === "bottom") d.top = "50%";
		}, true);
		g.stageEl.addEventListener("dragleave", (e) => { if (!g.stageEl.contains(e.relatedTarget)) g.dropEl.hidden = true; });
		g.stageEl.addEventListener("drop", (e) => {
			if (!cm.drag) return;
			e.preventDefault();
			e.stopPropagation();
			const t = cm.drag; cm.drag = null;
			const z = zoneAt(e);
			clearDropMarks();
			if (t.fromTree) {
				const existing = findTab(`file:${t.fromTree}`);
				if (existing && z !== "center") return splitWith(existing, g, z);
				const target = z === "center" ? g : newGroupAt(g, z);
				if (target) openFile(t.fromTree, target);
				return;
			}
			if (z === "center") moveTab(t, g, g.tabs.length);
			else if (t.group === g && g.tabs.length === 1) toast("只有一個分頁,沒辦法分割自己");
			else splitWith(t, g, z);
		}, true);
		// 編輯器區域內的提示列按鈕
		g.barEl.addEventListener("click", (e) => barAction(g, e.target.closest("[data-bar]")?.dataset.bar));
	}
	function clearDropMarks() {
		document.querySelectorAll(".drop-before").forEach((x) => x.classList.remove("drop-before"));
		document.querySelectorAll(".drop-end").forEach((x) => x.classList.remove("drop-end"));
		document.querySelectorAll(".cv-tab.dragging").forEach((x) => x.classList.remove("dragging"));
		for (const g of allGroups()) g.dropEl.hidden = true;
	}
	// ---------- 預覽(圖片 / PDF / 其他):每個分頁自己一塊 ----------
	const touch = () => matchMedia("(pointer: coarse)").matches;
	function pvNode(g, t) {
		if (t.pv && t.pv.parentNode === g.previewEl) return t.pv;
		t.pv?.remove();
		t.pv = el("div", `cv-pv cv-pv-${t.kind}`);
		g.previewEl.appendChild(t.pv);
		return t.pv;
	}
	/** 預覽全螢幕(蓋住整個畫面,右上角 ✕ 或 Esc 關閉) */
	function setFull(t, on) {
		if (!t.pv) return;
		t.pv.classList.toggle("cv-full", on);
		t.pv.querySelector(":scope > .cv-fullx")?.remove();
		if (on) {
			const x = el("button", "cv-fullx", "✕");
			x.type = "button"; x.title = "關閉全螢幕";
			x.onclick = () => setFull(t, false);
			t.pv.appendChild(x);
		}
	}
	addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelectorAll(".cv-pv.cv-full .cv-fullx").forEach((b) => b.click()); });
	function showPv(g, t) { for (const c of g.previewEl.children) c.hidden = c !== t.pv; }
	function buildPreview(t, n) {
		const src = `/api/code/${cm.pid}/raw?path=${encodeURIComponent(t.path)}`;
		if (t.kind === "image") {
			n.innerHTML = `<div class="zoomwrap"><img src="${src}" alt="${esc(t.label)}" draggable="false"></div>`;
			const img = n.querySelector("img"), wrap = n.querySelector(".zoomwrap");
			// 先縮到剛好放得下,之後用 zoom 放大
			const fit = () => { if (!img.naturalWidth) return; const r = Math.min(1, (n.clientWidth - 16) / img.naturalWidth, (n.clientHeight - 16) / img.naturalHeight); img.style.width = `${Math.round(img.naturalWidth * r)}px`; img.style.height = `${Math.round(img.naturalHeight * r)}px`; };
			img.onload = fit;
			attachZoom(n, wrap);
		} else if (t.kind === "pdf") {
			if (touch()) buildPdfjs(t, n, src); // 手機/平板:內建 PDF 無法縮放,改用 PDF.js
			else n.innerHTML = `<iframe src="${src}" title="${esc(t.label)}"></iframe>`;
		} else {
			n.innerHTML = `<div class="empty" style="text-align:center;padding:20px">${t.info}</div>`;
		}
	}
	/**
	 * 雙指縮放 + 點兩下放大/還原(手機),Ctrl/⌘+滾輪或觸控板捏合(電腦)。
	 * 用 CSS zoom 放大內容,版面跟著變大,原生捲動就能左右上下看。
	 */
	function attachZoom(box, wrap, { onEnd } = {}) {
		let z = 1, pinch = null, lastTap = 0;
		const apply = (nz, cx, cy) => {
			const r = box.getBoundingClientRect();
			const px = (box.scrollLeft + cx - r.left) / z, py = (box.scrollTop + cy - r.top) / z;
			z = Math.min(6, Math.max(1, nz));
			wrap.style.zoom = z;
			box.scrollLeft = px * z - (cx - r.left);
			box.scrollTop = py * z - (cy - r.top);
			box.classList.toggle("zoomed", z > 1.01);
		};
		const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
		box.addEventListener("touchstart", (e) => {
			if (e.touches.length === 2) {
				const [a, b] = e.touches;
				pinch = { d: dist(a, b), z };
			}
		}, { passive: true });
		box.addEventListener("touchmove", (e) => {
			if (!pinch || e.touches.length !== 2) return;
			e.preventDefault();
			const [a, b] = e.touches;
			apply(pinch.z * (dist(a, b) / pinch.d), (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
		}, { passive: false });
		box.addEventListener("touchend", (e) => {
			if (pinch && e.touches.length < 2) { pinch = null; onEnd?.(z); return; }
			if (e.touches.length || e.changedTouches.length !== 1) return;
			const now = Date.now(), p = e.changedTouches[0];
			if (now - lastTap < 300 && !String(getSelection?.() ?? "").trim()) { apply(z > 1.05 ? 1 : 2.5, p.clientX, p.clientY); onEnd?.(z); lastTap = 0; } else lastTap = now;
		});
		box.addEventListener("wheel", (e) => {
			if (!e.ctrlKey && !e.metaKey) return; // 觸控板捏合在 Chrome 是 Ctrl+滾輪
			e.preventDefault();
			apply(z * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
			clearTimeout(attachZoom.t); attachZoom.t = setTimeout(() => onEnd?.(z), 200);
		}, { passive: false });
		return { get zoom() { return z; } };
	}
	// PDF.js(只在觸控裝置載入)
	const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build";
	let pdfjsP = null;
	const loadPdfjs = () => (pdfjsP ||= import(`${PDFJS}/pdf.min.mjs`).then((m) => { m.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.mjs`; return m; }).catch((e) => { pdfjsP = null; throw e; }));
	async function buildPdfjs(t, n, src) {
		n.innerHTML = '<div class="zoomwrap pdfpages"><div class="empty" style="padding:20px">載入 PDF…</div></div>';
		const wrap = n.firstChild;
		try {
			const [lib, data] = await Promise.all([loadPdfjs(), fetch(src).then((r) => { if (!r.ok) throw new Error(`讀取失敗 ${r.status}`); return r.arrayBuffer(); })]);
			const doc = await lib.getDocument({ data }).promise;
			t.pdfDoc = doc;
			wrap.innerHTML = "";
			const width = Math.max(200, n.clientWidth - 16);
			const pages = [];
			for (let i = 1; i <= doc.numPages; i++) {
				const page = await doc.getPage(i);
				const vp = page.getViewport({ scale: 1 });
				const css = width / vp.width;
				// 每頁:畫布(圖) + 透明文字層(可以長按選字、複製)
				const box = el("div", "pdfpage");
				box.style.width = `${Math.round(vp.width * css)}px`;
				box.style.height = `${Math.round(vp.height * css)}px`;
				box.style.setProperty("--scale-factor", css);
				const c = document.createElement("canvas");
				const tl = el("div", "textLayer");
				box.append(c, tl);
				wrap.appendChild(box);
				pages.push({ page, c, tl, box, css, done: 0, visible: false, text: false });
			}
			const dpr = window.devicePixelRatio || 1;
			let zoom = 1;
			const render = async (p) => {
				// 解析度跟著放大倍率,但限制畫布大小(手機 canvas 有上限)
				const vp1 = p.page.getViewport({ scale: 1 });
				let scale = p.css * dpr * Math.max(1, zoom);
				const maxPx = 12e6;
				if (vp1.width * vp1.height * scale * scale > maxPx) scale = Math.sqrt(maxPx / (vp1.width * vp1.height));
				if (p.done >= scale * 0.95 || p.busy) return;
				p.busy = true;
				const vp = p.page.getViewport({ scale });
				p.c.width = Math.floor(vp.width); p.c.height = Math.floor(vp.height);
				await p.page.render({ canvasContext: p.c.getContext("2d"), viewport: vp }).promise.catch(() => {});
				p.done = scale; p.busy = false;
			};
			const renderText = async (p) => {
				if (p.text) return;
				p.text = true;
				try {
					const tc = await p.page.getTextContent();
					await new lib.TextLayer({ textContentSource: tc, container: p.tl, viewport: p.page.getViewport({ scale: p.css }) }).render();
				} catch { /* 沒有文字的掃描檔就算了 */ }
			};
			const io = new IntersectionObserver((entries) => {
				for (const en of entries) { const p = pages.find((x) => x.box === en.target); if (!p) continue; p.visible = en.isIntersecting; if (en.isIntersecting) { render(p); renderText(p); } }
			}, { root: n, rootMargin: "150% 0px" });
			for (const p of pages) io.observe(p.box);
			attachZoom(n, wrap, { onEnd: (z) => { zoom = z; for (const p of pages) if (p.visible) render(p); } });
		} catch (e) {
			wrap.innerHTML = `<div class="empty" style="padding:20px">PDF 顯示失敗:${esc(e.message || String(e))}</div>`;
		}
	}
	function surface(g, which) {
		for (const k of ["editorEl", "diffEl", "previewEl", "emptyEl"]) g[k].hidden = k !== which;
	}
	function bar(g, html) { g.barEl.hidden = !html; g.barEl.innerHTML = html || ""; }
	function activate(g, t) {
		if (g.active && g.active !== t && g.active.kind === "file" && !g.active.conflict && g.editor) g.active.viewState = g.editor.saveViewState();
		g.active = t;
		// 浮動球的「目前檔案」:記住最後看的檔案(換專案時清掉)
		if (t?.path && (t.kind === "file" || t.kind === "nb" || t.kind === "md") && cm.lastPath !== t.path) { cm.lastPath = t.path; dispatchEvent(new CustomEvent("steward:codefile")); }
		if (t && mobile()) document.body.classList.add("cv-editing");
		if (!t || !g.editor && (t.kind === "file" || t.kind === "diff")) { surface(g, "emptyEl"); bar(g, ""); renderTabs(g); return; }
		if (t.kind === "file") {
			if (t.conflict) {
				surface(g, "diffEl");
				g.editor.setModel(null);
				g.diff.updateOptions({ readOnly: false, originalEditable: false });
				g.diff.setModel({ original: t.conflict.model, modified: t.model });
				bar(g, `<b>這個檔案在你開啟之後被改過了</b><span>左邊是磁碟上的新版本,右邊是你的版本(可以繼續改)</span><span class="sp"></span><button class="small primary" data-bar="mine">用我的覆蓋</button><button class="small" data-bar="theirs">放棄我的,用磁碟版本</button>`);
			} else {
				surface(g, "editorEl");
				g.diff.setModel(null);
				g.editor.setModel(t.model);
				g.editor.updateOptions({ readOnly: !!t.readonly });
				bar(g, t.truncated ? `<span>大檔(${fmtSize(t.size)})唯讀:只顯示開頭和結尾各 ${t.truncated.shown} 行,共 ${t.truncated.total} 行</span><span class="sp"></span><button class="small" data-bar="more">多載入 2000 行</button><button class="small" data-bar="term">在終端機開啟</button>` : t.readonly ? "<span>唯讀</span>" : isMd(t.path) ? `<span class="sp"></span><button class="small" data-bar="mdprev">${mobile() ? "預覽" : "在旁邊預覽"}</button>` : "");
				if (t.viewState) g.editor.restoreViewState(t.viewState);
				// 手機:切分頁不自動聚焦編輯器(會跳鍵盤、iOS 還會放大);要打字點一下內容就好
				if (!mobile() && !matchMedia("(pointer: coarse)").matches) g.editor.focus();
			}
		} else if (t.kind === "diff") {
			surface(g, "diffEl");
			g.editor.setModel(null);
			g.diff.updateOptions({ readOnly: true });
			g.diff.setModel({ original: t.orig, modified: t.mod });
			bar(g, `<span>${esc(t.caption)}</span><span class="sp"></span>${t.which !== "commit" ? '<button class="small" data-bar="openfile">開啟檔案編輯</button>' : ""}`);
		} else if (t.kind === "nb") {
			surface(g, "previewEl");
			const fresh = !t.pv || t.pv.parentNode !== g.previewEl;
			pvNode(g, t).classList.add("nb");
			showPv(g, t);
			// 原始 JSON 開著而且改過,切回來時用最新內容重畫
			const src = findTab(`file:${t.path}`);
			const ver = src?.model && !src.model.isDisposed() ? src.model.getAlternativeVersionId() : null;
			if (fresh || (ver !== null && ver !== t.srcVer && !t.dirty)) renderNb(t);
			bar(g, `<span>${t.readonly ? "Notebook(檔案太大,唯讀)" : "Notebook · 點程式碼編輯,Shift+Enter 執行"}</span><span class="sp"></span><button class="small" data-bar="nbreload">重新載入</button><button class="small" data-bar="nbraw">${mobile() ? "原始 JSON" : "編輯原始 JSON"}</button>`);
		} else if (t.kind === "md") {
			surface(g, "previewEl");
			pvNode(g, t).classList.add("md");
			showPv(g, t);
			renderMd(t);
			bar(g, `<span>預覽 ${esc(t.path)}(跟著編輯即時更新)</span><span class="sp"></span><button class="small" data-bar="openfile">${mobile() ? "回到編輯" : "開啟原始檔"}</button>`);
		} else {
			surface(g, "previewEl");
			const fresh = !t.pv || t.pv.parentNode !== g.previewEl;
			const n = pvNode(g, t);
			if (fresh) buildPreview(t, n); // 只有第一次(或搬到別的群組)才建立,切回來沿用
			showPv(g, t);
			bar(g, (t.kind === "pdf" || t.kind === "image") && touch() ? '<span>雙指縮放、點兩下放大/還原</span><span class="sp"></span><button class="small" data-bar="fullview">全螢幕</button>' : "");
		}
		renderTabs(g);
		saveSoon();
	}
	async function barAction(g, a) {
		const t = g.active;
		if (!a || !t) return;
		if (a === "mine") return save(g, true);
		if (a === "theirs") {
			g.diff.setModel(null);
			t.model.setValue(t.conflict.content);
			t.hash = t.conflict.hash;
			t.conflict.model.dispose(); t.conflict = null;
			t.savedVersion = t.model.getAlternativeVersionId(); t.dirty = false;
			return activate(g, t);
		}
		if (a === "more") { t.more = (t.more || 0) + 2000; return reloadTab(t); }
		if (a === "term") { setMode("term"); return jumpTo(cm.pid); }
		if (a === "openfile") return openFile(t.path);
		if (a === "mdprev") return openPreview(t.path);
		if (a === "nbreload") {
			if (t.dirty && !(await confirmBox("重新載入", "網頁上還沒存的修改會不見,確定嗎?", "重新載入"))) return;
			return renderNb(t, true);
		}
		if (a === "nbraw") return openFile(t.path, g, { raw: true });
		if (a === "fullview") return setFull(t, true);
	}
	async function openFile(rel, g = cm.activeGroup, { quiet = false, view = null, raw = false } = {}) {
		// .ipynb 跟 VS Code 一樣預設顯示成 Notebook;要改 JSON 用「編輯原始 JSON」
		if (isNb(rel) && !raw) return openNotebook(rel, g, { quiet });
		await loadMonaco().catch(fail);
		if (!cm.monaco) return;
		ensureLayout();
		g = g || allGroups()[0];
		const key = `file:${rel}`;
		const existing = findTab(key);
		if (existing) { setActiveGroup(existing.group); return activate(existing.group, existing); }
		try {
			const f = await api(`file?path=${encodeURIComponent(rel)}`);
			const t = { key, group: g, kind: f.kind === "text" ? "file" : f.kind === "image" || f.kind === "pdf" ? f.kind : "info", path: rel, label: baseName(rel), title: rel, size: f.size };
			if (t.kind === "file") {
				t.model = cm.monaco.editor.createModel(f.content, langOf(rel));
				t.hash = f.hash; t.readonly = f.readonly; t.truncated = f.truncated;
				if (view) t.viewState = view;
				t.savedVersion = t.model.getAlternativeVersionId();
				t.model.onDidChangeContent(() => {
					const d = t.model.getAlternativeVersionId() !== t.savedVersion;
					if (d !== t.dirty) { t.dirty = d; renderTabs(t.group); renderProjSelect(); }
				});
			} else if (t.kind === "info") {
				t.info = f.kind === "toolarge" ? `檔案太大(${fmtSize(f.size)}),不在網頁開啟。<br><br><button class="small" onclick="setMode('term');jumpTo('${cm.pid}')">在終端機開啟</button>` : `這是二進位檔(${fmtSize(f.size)}),無法顯示。`;
			}
			g.tabs.push(t);
			// 預覽分頁先開著的話,接上即時更新
			const pv = findTab(`md:${rel}`);
			if (pv && t.model) { pv.sub?.dispose(); pv.sub = watchMd(pv, t.model); }
			setActiveGroup(g);
			activate(g, t);
		} catch (e) { if (!quiet) fail(e); }
	}
	// ---------- Markdown 預覽 ----------
	/** 開預覽分頁:電腦放在右邊(沒有就分割出來),手機放在同一個群組 */
	async function openPreview(rel, target = null, { quiet = false } = {}) {
		cm.md = await loadMd().catch((e) => { if (!quiet) fail(e); return null; });
		if (!cm.md) return;
		const key = `md:${rel}`;
		const existing = findTab(key);
		if (existing) { setActiveGroup(existing.group); return activate(existing.group, existing); }
		let srcTab = findTab(`file:${rel}`);
		let text;
		if (srcTab?.model) text = srcTab.model.getValue();
		else if (target) text = (await api(`file?path=${encodeURIComponent(rel)}`).catch(() => null))?.content;
		else { await openFile(rel); srcTab = findTab(`file:${rel}`); text = srcTab?.model?.getValue(); }
		if (text == null) return;
		let g = target;
		if (!g) {
			g = srcTab.group;
			if (!mobile()) {
				const ci = cm.cols.indexOf(colOf(g));
				g = cm.cols[ci + 1]?.groups[0] || (cm.cols.length < MAX_COLS ? newGroupAt(g, "right") : g);
			}
		}
		const t = { key, group: g, kind: "md", path: rel, label: `預覽 ${baseName(rel)}`, title: `${rel}(預覽)`, text };
		if (srcTab?.model) t.sub = watchMd(t, srcTab.model);
		g.tabs.push(t);
		setActiveGroup(g);
		activate(g, t);
	}
	function watchMd(t, model) {
		let timer = null;
		return model.onDidChangeContent(() => { clearTimeout(timer); timer = setTimeout(() => { t.text = model.getValue(); if (t.group.active === t) renderMd(t); }, 250); });
	}
	function renderMd(t) {
		const g = t.group;
		// 原始檔還開著就用最新內容(包含還沒存的修改)
		const src = findTab(`file:${t.path}`);
		if (src?.model && !src.model.isDisposed()) t.text = src.model.getValue();
		const html = cm.md.purify.sanitize(cm.md.marked.parse(t.text || "", { gfm: true }));
		const box = t.pv && t.pv.parentNode === g.previewEl ? t.pv : pvNode(g, t);
		const scroll = box.scrollTop;
		box.innerHTML = `<article class="md-body">${html}</article>`;
		const base = dirOf(t.path);
		const resolve = (href) => {
			const parts = (base ? `${base}/${href}` : href).split("/");
			const outp = [];
			for (const x of parts) { if (x === "..") outp.pop(); else if (x && x !== ".") outp.push(x); }
			return outp.join("/");
		};
		const relative = (u) => u && !/^([a-z]+:|\/\/|#|\/)/i.test(u);
		for (const img of box.querySelectorAll("img[src]")) {
			const u = img.getAttribute("src");
			if (relative(u)) img.src = `/api/code/${cm.pid}/raw?path=${encodeURIComponent(resolve(decodeURI(u.split(/[?#]/)[0])))}`;
		}
		for (const a of box.querySelectorAll("a[href]")) {
			const u = a.getAttribute("href");
			if (relative(u)) {
				a.addEventListener("click", (e) => { e.preventDefault(); openFile(resolve(decodeURI(u.split("#")[0])), t.group); });
			} else if (!u.startsWith("#")) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
		}
		box.scrollTop = scroll;
	}
	// ---------- Jupyter Notebook(.ipynb):顯示、編輯、用 kernel 執行 ----------
	async function openNotebook(rel, g = cm.activeGroup, { quiet = false } = {}) {
		await loadMonaco().catch(fail);
		if (!cm.monaco) return;
		ensureLayout();
		g = g || allGroups()[0];
		const key = `nb:${rel}`;
		const existing = findTab(key);
		if (existing) { setActiveGroup(existing.group); return activate(existing.group, existing); }
		const t = { key, group: g, kind: "nb", path: rel, label: baseName(rel), title: `${rel}(Notebook)`, kstate: "off", runs: new Map() };
		g.tabs.push(t);
		setActiveGroup(g);
		activate(g, t);
		if (quiet) return;
	}
	const nbText = (x) => (Array.isArray(x) ? x.join("") : typeof x === "string" ? x : "");
	const nbLines = (s) => (s ? s.split(/(?<=\n)/) : []);
	const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
	let nbUid = 0;
	/** 讀檔(force = 不管原始 JSON 分頁,直接讀磁碟) */
	async function loadNb(t, force = false) {
		const src = findTab(`file:${t.path}`);
		let text;
		t.readonly = false;
		if (src?.model && !src.model.isDisposed() && !force) { text = src.model.getValue(); t.srcVer = src.model.getAlternativeVersionId(); t.hash = src.hash; }
		else {
			// 5MB 以下用一般讀檔(拿得到版本 hash,才能存檔);更大的唯讀
			const f = await api(`file?path=${encodeURIComponent(t.path)}`).catch((e) => ({ error: e }));
			if (f.kind === "text" && !f.truncated) { text = f.content; t.hash = f.hash; }
			else {
				const r = await fetch(`/api/code/${cm.pid}/raw?path=${encodeURIComponent(t.path)}`).catch(() => null);
				if (!r?.ok) throw new Error(`讀不到這個檔案${r ? `(${r.status})` : ""}`);
				text = await r.text();
				t.readonly = true;
			}
			t.srcVer = null;
		}
		const nb = JSON.parse(text);
		if (!Array.isArray(nb.cells)) nb.cells = nb.worksheets?.[0]?.cells ?? [];
		for (const c of nb.cells) c._id = `c${++nbUid}`;
		t.nb = nb;
		t.dirty = false;
		renderTabs(t.group);
	}
	async function renderNb(t, force = false) {
		const box = pvNode(t.group, t);
		if (!box.childElementCount) box.innerHTML = '<div class="nb-msg">讀取中…</div>';
		try { await loadNb(t, force); }
		catch (e) { box.innerHTML = `<div class="nb-msg">${e instanceof SyntaxError ? `這不是有效的 Notebook(JSON 格式錯誤:${esc(e.message)})。可以用「編輯原始 JSON」修正。` : esc(e.message || String(e))}</div>`; return; }
		[t.mdLib, t.math] = await Promise.all([loadMd().catch(() => null), loadMath()]);
		drawNb(t);
		nbConnect(t);
		nbLoadPythons(t);
	}
	const nbLang = (t) => String(t.nb?.metadata?.language_info?.name || t.nb?.metadata?.kernelspec?.language || "python").toLowerCase();
	function nbMarkDirty(t) { if (!t.dirty) { t.dirty = true; renderTabs(t.group); } nbToolbar(t); }
	function drawNb(t) {
		const box = pvNode(t.group, t);
		const scroll = box.scrollTop;
		const root = el("div", "nb-wrap");
		root.appendChild(el("div", "nb-toolbar"));
		const body = el("article", "nb-body");
		for (const c of t.nb.cells) body.appendChild(nbCellEl(t, c));
		const add = el("div", "nb-addrow");
		add.innerHTML = '<button class="small" data-nbadd="code">+ 程式碼</button><button class="small" data-nbadd="markdown">+ Markdown</button>';
		add.onclick = (e) => { const k = e.target.closest("[data-nbadd]")?.dataset.nbadd; if (k) nbInsert(t, t.nb.cells.length, k); };
		body.appendChild(add);
		root.appendChild(body);
		box.replaceChildren(root);
		box.scrollTop = scroll;
		box.tabIndex = -1;
		box.onkeydown = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveNb(t); } };
		nbToolbar(t);
	}
	/** 一個儲存格的畫面(c._el 記住對應的 DOM) */
	function nbCellEl(t, c) {
		const cell = el("section", `nb-cell nb-${c.cell_type}`);
		cell.dataset.id = c._id;
		c._el = cell;
		const tools = el("div", "nb-celltools");
		tools.innerHTML = `${c.cell_type === "code" ? '<button class="small" data-ct="run" title="執行(Shift+Enter)">▶ 執行</button>' : '<button class="small" data-ct="edit">編輯</button>'}<button class="small" data-ct="up" title="上移">↑</button><button class="small" data-ct="down" title="下移">↓</button><button class="small" data-ct="addcode" title="在下面加程式碼">+ 程式碼</button><button class="small" data-ct="addmd" title="在下面加 Markdown">+ MD</button><button class="small" data-ct="del" title="刪除">刪除</button>`;
		tools.onclick = (e) => {
			const a = e.target.closest("[data-ct]")?.dataset.ct;
			const i = t.nb.cells.indexOf(c);
			if (a === "run") nbRun(t, [c]);
			else if (a === "edit") nbEdit(t, c);
			else if (a === "up" && i > 0) { t.nb.cells.splice(i, 1); t.nb.cells.splice(i - 1, 0, c); cell.previousElementSibling.before(cell); nbMarkDirty(t); }
			else if (a === "down" && i < t.nb.cells.length - 1) { t.nb.cells.splice(i, 1); t.nb.cells.splice(i + 1, 0, c); cell.nextElementSibling.after(cell); nbMarkDirty(t); }
			else if (a === "addcode") nbInsert(t, i + 1, "code");
			else if (a === "addmd") nbInsert(t, i + 1, "markdown");
			else if (a === "del") { t.nb.cells.splice(i, 1); cell.remove(); nbMarkDirty(t); }
		};
		if (!t.readonly) cell.appendChild(tools);
		const source = nbText(c.source);
		if (c.cell_type === "markdown") {
			const md = el("div", "nb-md md-body");
			nbFillMd(t, md, source, c.attachments);
			md.ondblclick = () => nbEdit(t, c);
			cell.appendChild(md);
		} else if (c.cell_type === "code") {
			const row = el("div", "nb-row");
			const prompt = el("div", "nb-prompt");
			prompt.textContent = c.execution_count != null ? `[${c.execution_count}]` : "[ ]";
			row.appendChild(prompt);
			const pre = el("pre", "nb-code");
			pre.textContent = source;
			nbColor(t, pre, source);
			pre.onclick = () => nbEdit(t, c);
			row.appendChild(pre);
			cell.appendChild(row);
			const outs = el("div", "nb-outs");
			cell.appendChild(outs);
			for (const o of c.outputs || []) nbAppendOutput(t, outs, o);
		} else {
			const pre = el("pre", "nb-raw");
			pre.textContent = source;
			cell.appendChild(pre);
		}
		return cell;
	}
	function nbColor(t, pre, source) {
		const lang = nbLang(t);
		cm.monaco.editor.colorize(source, langOf(`x.${lang === "python" ? "py" : lang}`) || lang, { tabSize: 4 }).then((h) => { if (pre.isConnected || !pre.parentNode) pre.innerHTML = h; }).catch(() => {});
	}
	function nbSanitize(t, html) { return t.mdLib ? t.mdLib.purify.sanitize(html) : esc(html); }
	function nbFillMd(t, box, source, attachments) {
		let h = t.mdLib ? t.mdLib.marked.parse(source, { gfm: true }) : `<pre>${esc(source)}</pre>`;
		h = nbSanitize(t, h);
		if (attachments) h = h.replace(/src="attachment:([^"]+)"/g, (m, name) => {
			const a = attachments[decodeURIComponent(name)];
			const mime = a && Object.keys(a)[0];
			return mime ? `src="data:${mime};base64,${nbText(a[mime]).replace(/\s/g, "")}"` : m;
		});
		box.innerHTML = h || '<span class="nb-empty">(空白的 Markdown,點兩下編輯)</span>';
		for (const img of box.querySelectorAll("img[src]")) {
			const u = img.getAttribute("src");
			if (u && !/^([a-z]+:|\/\/|#|\/)/i.test(u)) {
				const parts = `${dirOf(t.path) ? `${dirOf(t.path)}/` : ""}${decodeURI(u.split(/[?#]/)[0])}`.split("/");
				const outp = [];
				for (const x of parts) { if (x === "..") outp.pop(); else if (x && x !== ".") outp.push(x); }
				img.src = `/api/code/${cm.pid}/raw?path=${encodeURIComponent(outp.join("/"))}`;
			}
		}
		for (const a of box.querySelectorAll("a[href]")) if (!a.getAttribute("href").startsWith("#")) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
		nbMath(t, box);
	}
	function nbMath(t, box) {
		if (!t.math?.auto) return;
		try { t.math.auto(box, { delimiters: [{ left: "$$", right: "$$", display: true }, { left: "\\[", right: "\\]", display: true }, { left: "$", right: "$", display: false }, { left: "\\(", right: "\\)", display: false }], throwOnError: false }); } catch { /* 排版失敗就顯示原文 */ }
	}
	/** 編輯一個儲存格:換成文字框;Shift+Enter 執行(程式碼)或完成(Markdown),Esc / 點別處結束 */
	function nbEdit(t, c) {
		if (t.readonly || c._editing) return;
		const cell = c._el;
		const view = cell.querySelector(c.cell_type === "code" ? ".nb-code" : ".nb-md");
		if (!view) return;
		c._editing = true;
		const ta = el("textarea", "nb-edit");
		ta.value = nbText(c.source);
		ta.spellcheck = false;
		const fit = () => { ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight + 2}px`; };
		view.replaceWith(ta);
		fit(); ta.focus();
		const finish = () => {
			if (!c._editing) return;
			c._editing = false;
			const v = ta.value;
			if (v !== nbText(c.source)) { c.source = nbLines(v); nbMarkDirty(t); }
			const fresh = nbCellEl(t, c);
			cell.replaceWith(fresh);
		};
		ta.oninput = fit;
		ta.onblur = finish;
		ta.onkeydown = (e) => {
			if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); ta.setRangeText("    ", ta.selectionStart, ta.selectionEnd, "end"); fit(); }
			else if (e.key === "Escape") { e.preventDefault(); ta.blur(); }
			else if (e.key === "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				finish();
				if (c.cell_type === "code") nbRun(t, [c]);
				// Shift+Enter 跳到下一格(跟 Jupyter 一樣)
				if (e.shiftKey) { const next = t.nb.cells[t.nb.cells.indexOf(c) + 1]; if (next) setTimeout(() => nbEdit(t, next), 0); }
			} else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); finish(); saveNb(t); }
		};
	}
	function nbInsert(t, at, type) {
		const c = type === "code" ? { cell_type: "code", execution_count: null, metadata: {}, source: [], outputs: [] } : { cell_type: "markdown", metadata: {}, source: [] };
		c._id = `c${++nbUid}`;
		t.nb.cells.splice(at, 0, c);
		const body = t.pv.querySelector(".nb-body");
		const elc = nbCellEl(t, c);
		const ref = t.nb.cells[at + 1]?._el;
		if (ref?.isConnected) ref.before(elc); else body.querySelector(".nb-addrow").before(elc);
		nbMarkDirty(t);
		nbEdit(t, c);
	}
	/** 一個輸出:圖片 > HTML > Markdown > LaTeX > 純文字(跟 Jupyter 的優先順序一樣) */
	function nbOutputEl(t, o) {
		if (o.output_type === "stream") {
			const pre = el("pre", `nb-out nb-stream${o.name === "stderr" ? " nb-stderr" : ""}`);
			pre.textContent = stripAnsi(nbText(o.text));
			return pre;
		}
		if (o.output_type === "error" || o.output_type === "pyerr") {
			const pre = el("pre", "nb-out nb-error");
			pre.textContent = stripAnsi((o.traceback || []).join("\n") || `${o.ename}: ${o.evalue}`);
			return pre;
		}
		const d = o.data || {};
		const box = el("div", "nb-out nb-data");
		for (const mime of ["image/png", "image/jpeg", "image/gif"]) {
			if (d[mime]) { box.innerHTML = `<img alt="" src="data:${mime};base64,${nbText(d[mime]).replace(/\s/g, "")}">`; return box; }
		}
		if (d["image/svg+xml"]) { box.innerHTML = nbSanitize(t, nbText(d["image/svg+xml"])); return box; }
		if (d["text/html"]) { box.classList.add("nb-html"); box.innerHTML = nbSanitize(t, nbText(d["text/html"])); return box; }
		if (d["text/markdown"]) { box.classList.add("nb-md", "md-body"); nbFillMd(t, box, nbText(d["text/markdown"])); return box; }
		if (d["text/latex"]) { box.classList.add("nb-latex"); box.textContent = nbText(d["text/latex"]); nbMath(t, box); return box; }
		if (d["text/plain"]) { const pre = el("pre", "nb-out nb-stream"); pre.textContent = stripAnsi(nbText(d["text/plain"])); return pre; }
		const kinds = Object.keys(d);
		if (kinds.length) { box.classList.add("nb-note"); box.textContent = `(互動式輸出 ${kinds.join(", ")},網頁無法顯示)`; return box; }
		return null;
	}
	function nbAppendOutput(t, outs, o) {
		const node = nbOutputEl(t, o);
		if (!node) return;
		const row = el("div", "nb-row nb-outrow");
		row.appendChild(el("div", "nb-prompt nb-outprompt", o.output_type === "execute_result" && o.execution_count != null ? `[${o.execution_count}]` : ""));
		row.appendChild(node);
		outs.appendChild(row);
	}

	// ---- kernel ----
	const nbApi = (op, b) => api(`nb/${op}`, { method: "POST", body: JSON.stringify({ path: b.path, ...b }) });
	function nbConnect(t) {
		if (t.es) return;
		const es = new EventSource(`/api/code/${cm.pid}/nb/events?path=${encodeURIComponent(t.path)}`);
		t.es = es;
		es.onmessage = (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } nbEvent(t, ev); };
	}
	async function nbLoadPythons(t) {
		const r = await api(`nb/pythons?path=${encodeURIComponent(t.path)}`).catch(() => null);
		if (!r) return;
		t.envs = r.envs;
		let saved = null;
		try { saved = localStorage.getItem(`steward.nbPy:${cm.pid}:${t.path}`); } catch { /* 無痕模式 */ }
		t.python = (r.kernel.running && r.kernel.python) || (r.envs.find((e) => e.python === saved) || r.envs.find((e) => e.ready) || r.envs[0])?.python;
		if (r.kernel.running) t.kstate = r.kernel.state || "idle";
		nbToolbar(t);
	}
	const KSTATE = { off: "kernel 未啟動", starting: "kernel 啟動中…", idle: "kernel 閒置", busy: "執行中…", dead: "kernel 停止了" };
	function nbToolbar(t) {
		const bar = t.pv?.querySelector(".nb-toolbar");
		if (!bar) return;
		const env = t.envs?.find((e) => e.python === t.python);
		const opts = (t.envs || []).map((e) => `<option value="${esc(e.python)}" ${e.python === t.python ? "selected" : ""}>${esc(e.label)}${e.version ? ` · Python ${esc(e.version)}` : ""}${e.ready ? "" : `(${esc(e.why || "不能用")})`}</option>`).join("");
		const busy = t.kstate === "busy" || t.kstate === "starting";
		bar.innerHTML = `<select class="nb-py" title="用哪個 Python 環境執行">${opts || "<option>偵測 Python 環境中…</option>"}</select>
			${env && !env.ready ? `<button class="small primary" data-nb="install">${env.own ? "建立並安裝 ipykernel" : "在這個環境安裝 ipykernel"}</button>` : ""}
			<span class="nb-kstate nb-k-${t.kstate}">${KSTATE[t.kstate] || t.kstate}</span>
			<span class="sp"></span>
			<button class="small" data-nb="runall" ${t.readonly ? "disabled" : ""}>▶ 全部執行</button>
			<button class="small" data-nb="interrupt" ${busy ? "" : "disabled"}>■ 中斷</button>
			<button class="small" data-nb="restart" ${t.kstate === "off" ? "disabled" : ""}>↻ 重新啟動</button>
			<button class="small" data-nb="clear" ${t.readonly ? "disabled" : ""}>清除輸出</button>
			<button class="small ${t.dirty ? "primary" : ""}" data-nb="save" ${t.readonly ? "disabled title=\"檔案太大,唯讀\"" : ""}>${t.dirty ? "● 存檔" : "存檔"}</button>`;
		bar.querySelector(".nb-py").onchange = (e) => {
			t.python = e.target.value;
			try { localStorage.setItem(`steward.nbPy:${cm.pid}:${t.path}`, t.python); } catch { /* 無痕模式 */ }
			if (t.kstate !== "off") nbApi("stop", { path: t.path }).catch(() => {});
			t.kstate = "off";
			nbToolbar(t);
		};
		bar.onclick = async (e) => {
			const a = e.target.closest("[data-nb]")?.dataset.nb;
			if (!a) return;
			if (a === "install") {
				e.target.disabled = true; e.target.textContent = "安裝中(約 1 分鐘)…";
				const r = await nbApi("install", { path: t.path, python: t.python }).catch((err) => ({ error: err.message }));
				if (r.error) toast(r.error); else { toast("已安裝 ipykernel"); t.python = r.python; }
				return nbLoadPythons(t);
			}
			if (a === "runall") return nbRun(t, t.nb.cells.filter((c) => c.cell_type === "code"));
			if (a === "interrupt") return nbApi("interrupt", { path: t.path }).catch(fail);
			if (a === "restart") {
				if (!(await confirmBox("重新啟動 kernel", "所有變數都會清空,確定嗎?", "重新啟動"))) return;
				t.kstate = "starting"; nbToolbar(t);
				for (const [, c] of t.runs) nbFinishRun(t, c, true);
				return nbApi("restart", { path: t.path }).catch(fail);
			}
			if (a === "clear") {
				for (const c of t.nb.cells) if (c.cell_type === "code") { c.outputs = []; c.execution_count = null; }
				drawNb(t); nbMarkDirty(t);
				return;
			}
			if (a === "save") return saveNb(t);
		};
	}
	/** 確保 kernel 在跑(沒有就用選的 Python 啟動,等到 ready) */
	async function nbEnsureKernel(t) {
		if (t.kstate !== "off" && t.kstate !== "dead") return true;
		const env = t.envs?.find((e) => e.python === t.python);
		if (!env) { toast("找不到可以用的 Python 環境"); return false; }
		if (!env.ready) { toast("這個 Python 環境還沒有 ipykernel:按上面的「安裝 ipykernel」"); return false; }
		t.kstate = "starting"; nbToolbar(t);
		const ready = new Promise((ok) => { t.onReady = ok; });
		const r = await nbApi("start", { path: t.path, python: t.python }).catch((e) => ({ error: e.message }));
		if (r.error) { t.kstate = "off"; nbToolbar(t); toast(r.error); return false; }
		const ok = await Promise.race([ready, new Promise((x) => setTimeout(() => x(false), 120_000))]);
		if (!ok) { toast("kernel 啟動失敗或太久沒回應"); t.kstate = "off"; nbToolbar(t); }
		return !!ok;
	}
	async function nbRun(t, cells) {
		cells = cells.filter((c) => c.cell_type === "code");
		if (!cells.length || t.readonly) return;
		for (const c of cells) if (c._editing) c._el.querySelector("textarea.nb-edit")?.blur();
		// 先把要跑的格子標成排隊中([*]),清掉舊輸出
		for (const c of cells) {
			if (t.runs.has(c._runId)) continue;
			c._runId = `r${++nbUid}`;
			t.runs.set(c._runId, c);
			c.outputs = []; c.execution_count = null; c._started = false; c._clearNext = false;
			c._el.querySelector(".nb-outs")?.replaceChildren();
			const pr = c._el.querySelector(".nb-row .nb-prompt"); if (pr) pr.textContent = "[*]";
			c._el.classList.add("nb-running");
		}
		nbMarkDirty(t);
		if (!(await nbEnsureKernel(t))) { for (const c of cells) nbFinishRun(t, c, true); return; }
		for (const c of cells) {
			if (!t.runs.has(c._runId) || c._sent) continue;
			c._sent = true;
			await nbApi("exec", { path: t.path, id: c._runId, code: nbText(c.source) }).catch((e) => { toast(e.message); nbFinishRun(t, c, true); });
		}
	}
	function nbFinishRun(t, c, aborted = false) {
		if (!c) return;
		t.runs.delete(c._runId);
		c._sent = false;
		c._el?.classList.remove("nb-running");
		const pr = c._el?.querySelector(".nb-row .nb-prompt");
		if (pr) pr.textContent = c.execution_count != null ? `[${c.execution_count}]` : "[ ]";
		if ((aborted || !c._started) && c._el && !c.outputs?.length) {
			const outs = c._el.querySelector(".nb-outs");
			outs?.appendChild(el("div", "nb-row nb-outrow", `<div class="nb-prompt"></div><div class="nb-out nb-note">${aborted ? "沒有執行" : "沒有執行(前面的儲存格出錯或被中斷)"}</div>`));
		}
	}
	function nbEvent(t, ev) {
		const c = ev.id ? t.runs.get(ev.id) : null;
		if (ev.ev === "hello") { if (ev.running) t.kstate = ev.state || "idle"; nbToolbar(t); return; }
		if (ev.ev === "ready") { t.kstate = "idle"; t.onReady?.(true); t.onReady = null; nbToolbar(t); if (ev.restarted) toast("kernel 已重新啟動"); return; }
		if (ev.ev === "status") {
			if (!ev.id && ev.state) { t.kstate = ev.state === "starting" ? "starting" : t.kstate; }
			else if (ev.state === "busy" || ev.state === "idle") t.kstate = ev.state === "busy" ? "busy" : (t.runs.size > 1 ? "busy" : "idle");
			nbToolbar(t);
			return;
		}
		if (ev.ev === "exit" || ev.ev === "dead") {
			for (const [, rc] of t.runs) nbFinishRun(t, rc, true);
			t.kstate = ev.ev === "dead" ? "dead" : "off";
			t.onReady?.(false); t.onReady = null;
			if (ev.message) toast(`kernel 結束了:${ev.message}`);
			nbToolbar(t);
			return;
		}
		if (ev.ev === "error" && !c) { toast(ev.message || "kernel 發生錯誤"); return; }
		if (!c) return; // 別的瀏覽器跑的
		if (ev.ev === "started") {
			c._started = true; c.execution_count = ev.execution_count;
			const pr = c._el?.querySelector(".nb-row .nb-prompt"); if (pr) pr.textContent = "[*]";
		} else if (ev.ev === "output") {
			const outs = c._el?.querySelector(".nb-outs");
			if (c._clearNext) { c.outputs = []; outs?.replaceChildren(); c._clearNext = false; }
			const o = ev.output;
			// 連續的同一種串流輸出合併成一塊(跟 Jupyter 一樣)
			const last = c.outputs[c.outputs.length - 1];
			if (o.output_type === "stream" && last?.output_type === "stream" && last.name === o.name) {
				last.text = nbText(last.text) + o.text;
				const pre = outs?.lastElementChild?.querySelector("pre.nb-stream");
				if (pre) { pre.textContent = stripAnsi(last.text); return; }
			} else c.outputs.push(o);
			if (outs) nbAppendOutput(t, outs, o);
		} else if (ev.ev === "clear") {
			if (ev.wait) c._clearNext = true;
			else { c.outputs = []; c._el?.querySelector(".nb-outs")?.replaceChildren(); }
		} else if (ev.ev === "done") {
			nbFinishRun(t, c);
			if (!t.runs.size) { t.kstate = "idle"; nbToolbar(t); }
		} else if (ev.ev === "error") { toast(ev.message || "執行失敗"); nbFinishRun(t, c, true); }
	}
	/** 存檔:輸出、執行編號都寫回 .ipynb(跟 Jupyter 存的格式一樣) */
	async function saveNb(t, force = false) {
		if (!t.nb || t.readonly) return;
		for (const c of t.nb.cells) if (c._editing) c._el?.querySelector("textarea.nb-edit")?.blur();
		const clean = { ...t.nb, cells: t.nb.cells.map((c) => {
			const o = { cell_type: c.cell_type, metadata: c.metadata || {}, source: Array.isArray(c.source) ? c.source : nbLines(nbText(c.source)) };
			if (c.id) o.id = c.id;
			if (c.attachments) o.attachments = c.attachments;
			if (c.cell_type === "code") { o.execution_count = c.execution_count ?? null; o.outputs = (c.outputs || []).map((x) => (x.output_type === "stream" ? { ...x, text: nbLines(nbText(x.text)) } : x)); }
			return o;
		}) };
		delete clean.worksheets;
		try {
			const r = await api("file", { method: "PUT", body: JSON.stringify({ path: t.path, content: `${JSON.stringify(clean, null, 1)}\n`, baseHash: t.hash, force }) });
			t.hash = r.hash; t.dirty = false;
			renderTabs(t.group); nbToolbar(t);
			toast("已存檔");
			cm.dirs = {}; renderFiles(); refreshGit();
		} catch (e) {
			if (e.status === 409) {
				if (await confirmBox("檔案在外面被改過", "這個 notebook 在你開啟之後被別的程式改過了。要用網頁上的版本覆蓋嗎?(取消就保留磁碟上的版本,你可以按「重新載入」看最新內容)", "用網頁的版本覆蓋")) return saveNb(t, true);
			} else fail(e);
		}
	}
	async function reloadTab(t) {
		const f = await api(`file?path=${encodeURIComponent(t.path)}${t.more ? `&more=${t.more}` : ""}`).catch(fail);
		if (!f || f.kind !== "text") return;
		t.model.setValue(f.content);
		t.hash = f.hash; t.truncated = f.truncated; t.readonly = f.readonly;
		t.savedVersion = t.model.getAlternativeVersionId(); t.dirty = false;
		if (t.group.active === t) activate(t.group, t); else renderTabs(t.group);
	}
	async function save(g = cm.activeGroup, force = false) {
		const t = g?.active;
		if (t?.kind === "nb") return saveNb(t, force);
		if (!t || t.kind !== "file" || t.readonly) return;
		try {
			const r = await api("file", { method: "PUT", body: JSON.stringify({ path: t.path, content: t.model.getValue(), baseHash: t.hash, force }) });
			t.hash = r.hash;
			if (t.conflict) { g.diff.setModel(null); t.conflict.model.dispose(); t.conflict = null; }
			t.savedVersion = t.model.getAlternativeVersionId(); t.dirty = false;
			activate(g, t);
			renderProjSelect();
			toast("已存檔");
			cm.dirs = {}; renderFiles(); refreshGit();
		} catch (e) {
			if (e.status === 409 && e.data?.disk) {
				t.conflict = { content: e.data.disk.content, hash: e.data.disk.hash, model: cm.monaco.editor.createModel(e.data.disk.content, langOf(t.path)) };
				activate(g, t);
			} else fail(e);
		}
	}
	function closeTab(t, force = false) {
		if (!t) return;
		if (t.dirty && !force) {
			confirmBox("還沒存檔", `「${t.label}」有還沒存的修改,確定要關閉嗎?`, "不存直接關閉").then((ok) => ok && closeTab(t, true));
			return;
		}
		const g = t.group;
		if (g.active === t) { g.diff?.setModel(null); g.editor?.setModel(null); }
		const i = g.tabs.indexOf(t);
		g.tabs.splice(i, 1);
		t.model?.dispose(); t.orig?.dispose(); t.mod?.dispose(); t.conflict?.model.dispose(); t.sub?.dispose();
		t.pv?.remove(); t.pdfDoc?.destroy?.();
		// Notebook:關掉分頁就停掉它的 kernel
		if (t.kind === "nb") { t.es?.close(); if (t.kstate !== "off") nbApi("stop", { path: t.path }).catch(() => {}); }
		if (g.active === t) activate(g, g.tabs[i] || g.tabs[i - 1] || null); else renderTabs(g);
		pruneGroup(g);
		saveSoon();
	}
	// 沒修改的分頁:磁碟上的檔案被改了就自動重新載入(agent 改檔時畫面跟著更新)
	setInterval(async () => {
		if (!document.body.classList.contains("code") || document.hidden || !cm.pid) return;
		// 沒修改、沒在執行的 Notebook:檔案在外面被改了(例如 agent 跑完)也重新載入
		for (const t of allTabs().filter((x) => x.kind === "nb" && x.nb && !x.readonly && !x.dirty && !x.runs?.size && x.hash)) {
			const st = (await api("stamps", { method: "POST", body: JSON.stringify({ paths: [t.path] }) }).catch(() => null))?.[t.path];
			if (st?.hash && st.hash !== t.hash) renderNb(t, true);
		}
		const watch = allTabs().filter((t) => t.kind === "file" && !t.readonly);
		if (!watch.length) return;
		const stamps = await api("stamps", { method: "POST", body: JSON.stringify({ paths: [...new Set(watch.map((t) => t.path))] }) }).catch(() => null);
		if (!stamps) return;
		for (const t of watch) {
			const s = stamps[t.path];
			if (!s) continue;
			if (s.gone) { if (!t.label.endsWith("(已刪除)")) { t.label += "(已刪除)"; renderTabs(t.group); } continue; }
			if (s.hash && s.hash !== t.hash && !t.dirty && !t.conflict) await reloadTab(t);
		}
	}, 4000);

	// ---------- 專案 ----------
	const projects = () => state.projects.filter((p) => p.kind === "project" && p.status === "active");
	/** 把目前這組分頁收起來:有沒存的修改 → 整組留在記憶體;沒有 → 釋放(版面已存在伺服器) */
	function putAway() {
		if (cm.pid && allTabs().some((t) => t.dirty)) {
			cm.stash.set(cm.pid, { cols: cm.cols, activeGroup: cm.activeGroup, expanded: cm.expanded });
		} else {
			for (const g of allGroups()) {
				g.diff?.setModel(null); g.editor?.setModel(null);
				for (const t of g.tabs) { t.model?.dispose(); t.orig?.dispose(); t.mod?.dispose(); t.conflict?.model.dispose(); t.sub?.dispose(); }
				disposeGroup(g);
			}
		}
		cm.cols = []; cm.activeGroup = null;
	}
	async function pickProject(id) {
		if (cm.pid === id) return true;
		await saveNow();
		cm.restoring = true;
		try {
			putAway();
			cm.pid = id;
			cm.dirs = {}; cm.expanded = new Set([""]); cm.git = null; cm.history = null; cm.openCommit = null;
			const kept = cm.stash.get(id);
			if (kept) {
				// 之前切走時還有沒存的修改:原封不動放回來
				cm.stash.delete(id);
				cm.cols = kept.cols; cm.activeGroup = kept.activeGroup; cm.expanded = kept.expanded;
				layout();
			} else {
				ensureLayout(); layout();
				const saved = id ? await api("session").catch(() => null) : null;
				if (saved?.layout) await restore(saved.layout);
			}
			renderProjSelect();
			refresh();
		} finally { cm.restoring = false; }
		window.renderDrawer?.();
		// 記下「最後用的是這個專案」(換電腦時打開這個)
		lastSaved = "";
		saveSoon(300);
		return true;
	}

	// ---------- 記住開了什麼(存在伺服器,換專案/換電腦都能還原) ----------
	function tabSpec(t) {
		if (t.kind === "diff") return { kind: "diff", path: t.path, which: t.which, commit: t.commit };
		if (t.kind === "md") return { kind: "md", path: t.path };
		if (t.kind === "nb") return { kind: "nb", path: t.path };
		const spec = { kind: "file", path: t.path };
		const vs = t.group.active === t && t.kind === "file" && !t.conflict && t.group.editor?.getModel() === t.model ? t.group.editor.saveViewState() : t.viewState;
		if (vs) spec.view = vs;
		return spec;
	}
	function snapshot() {
		const groups = allGroups();
		return {
			v: 1,
			cols: cm.cols.map((c) => ({ size: c.size, groups: c.groups.map((g) => ({ size: g.size, active: g.tabs.indexOf(g.active), tabs: g.tabs.map(tabSpec) })) })),
			activeGroup: groups.indexOf(cm.activeGroup),
			expanded: [...cm.expanded].filter(Boolean).slice(0, 200),
			view: cm.view,
		};
	}
	let saveTimer = null, saveDue = 0, lastSaved = "";
	function saveSoon(ms = 800) {
		if (cm.restoring || !cm.pid) return;
		// 已經排了更早的存檔就不往後延(游標一直動也不會一直拖)
		if (saveTimer && saveDue <= Date.now() + ms) return;
		clearTimeout(saveTimer);
		saveDue = Date.now() + ms;
		saveTimer = setTimeout(() => saveNow(), ms);
	}
	async function saveNow({ keepalive = false } = {}) {
		clearTimeout(saveTimer); saveTimer = null; saveDue = 0;
		if (cm.restoring || !cm.pid || !cm.cols.length) return;
		const body = JSON.stringify({ layout: snapshot() });
		const key = cm.pid + body;
		if (key === lastSaved) return;
		lastSaved = key;
		await fetch(`/api/code/${cm.pid}/session`, { method: "PUT", headers: { "content-type": "application/json" }, body, keepalive }).catch(() => { lastSaved = ""; });
	}
	addEventListener("pagehide", () => saveNow({ keepalive: true }));
	document.addEventListener("visibilitychange", () => { if (document.hidden) saveNow({ keepalive: true }); });
	async function restore(L) {
		if (!L?.cols?.length) return;
		await loadMonaco().catch(() => null);
		if (!cm.monaco) return;
		// 先把欄/群組搭好,再依序開分頁
		const keep = allGroups()[0];
		const plan = [];
		cm.cols = L.cols.slice(0, MAX_COLS).map((c, ci) => ({
			id: `c${++uid}`, size: Number(c.size) || 1,
			groups: (c.groups || []).slice(0, MAX_ROWS).map((gs, gi) => {
				const g = ci === 0 && gi === 0 && keep ? keep : newGroup();
				g.size = Number(gs.size) || 1;
				plan.push({ g, spec: gs });
				return g;
			}),
		})).filter((c) => c.groups.length);
		if (!cm.cols.length) { cm.cols = [{ id: `c${++uid}`, size: 1, groups: [keep || newGroup()] }]; }
		cm.activeGroup = allGroups()[Math.max(0, Math.min(L.activeGroup ?? 0, allGroups().length - 1))];
		layout();
		for (const { g, spec } of plan) {
			for (const ts of spec.tabs || []) {
				if (!ts?.path) continue;
				if (ts.kind === "diff") await openDiff(ts.path, ts.which, ts.commit, g, { quiet: true });
				else if (ts.kind === "md") await openPreview(ts.path, g, { quiet: true });
				else if (ts.kind === "nb") await openNotebook(ts.path, g, { quiet: true });
				else await openFile(ts.path, g, { quiet: true, view: ts.view || null, raw: true });
			}
			const want = g.tabs[spec.active] || g.tabs[0] || null;
			// 先記下目前分頁的位置再切,避免被覆蓋
			if (g.active?.kind === "file" && g.editor?.getModel() === g.active.model) g.active.viewState = g.editor.saveViewState();
			if (want) { g.active = null; activate(g, want); }
		}
		// 開不起來的(檔案被刪了)留下空群組 → 收掉
		for (const g of [...allGroups()]) pruneGroup(g);
		const ag = allGroups()[Math.max(0, Math.min(L.activeGroup ?? 0, allGroups().length - 1))];
		cm.activeGroup = null;
		setActiveGroup(ag);
		layout();
		if (Array.isArray(L.expanded)) for (const d of L.expanded) cm.expanded.add(String(d));
		if (L.view === "git" || L.view === "files") cm.view = L.view;
		lastSaved = cm.pid + JSON.stringify({ layout: snapshot() });
	}
	/** 有沒存修改的專案名稱前加「●」 */
	const hasUnsaved = (id) => (id === cm.pid ? allTabs().some((t) => t.dirty) : cm.stash.has(id));
	function renderProjSelect() {
		// 只顯示目前專案;換專案用左上角標題(或點這裡)滑出的專案清單
		const p = state.projects.find((x) => x.id === cm.pid);
		const others = [...cm.stash.keys()].filter((id) => id !== cm.pid).map((id) => state.projects.find((x) => x.id === id)?.name).filter(Boolean);
		$("cvProject").innerHTML = `<span class="nm">${hasUnsaved(cm.pid) ? "● " : ""}${esc(p?.name ?? "(沒有專案)")}</span>${others.length ? `<span class="hint" title="${esc(others.join("、"))}">另有 ${others.length} 個專案沒存</span>` : ""}`;
		window.renderNav?.();
	}
	// 換專案走主頁面的共用入口(看板/終端機也會跟著換)

	// ---------- 檔案樹 ----------
	async function loadDir(rel) {
		const r = await api(`tree?dir=${encodeURIComponent(rel)}${cm.hidden ? "&hidden=1" : ""}`);
		cm.dirs[rel] = r.entries;
		return r.entries;
	}
	async function renderFiles() {
		const root = $("cvFiles");
		if (!cm.pid) { root.innerHTML = '<div class="empty" style="padding:12px">先在看板建立或選一個專案</div>'; return; }
		const rows = [];
		const walk = async (rel, depth) => {
			const entries = cm.dirs[rel] ?? (await loadDir(rel).catch((e) => { rows.push(`<div class="hint" style="padding:6px 10px">${esc(e.message)}</div>`); return []; }));
			for (const e of entries) {
				const open = e.type === "dir" && cm.expanded.has(e.rel);
				const g = e.git ? `<span class="g g-${e.git === "•" ? "dot" : e.git}">${e.git}</span>` : '<span class="g"></span>';
				rows.push(`<div class="tree-row${e.ignored ? " ign" : ""}${cm.selRow === e.rel ? " sel" : ""}" data-rel="${esc(e.rel)}" data-type="${e.type}" style="padding-left:${8 + depth * 14}px" title="${esc(e.rel)}${e.type === "file" ? ` · ${fmtSize(e.size)}` : ""}" ${e.type === "file" && !mobile() ? 'draggable="true"' : ""}>
					<span class="tw">${e.type === "dir" ? (open ? "▾" : "▸") : ""}</span><span class="nm">${esc(e.name)}</span>${g}<button class="more" data-more title="更多">⋯</button></div>`);
				if (open) await walk(e.rel, depth + 1);
			}
		};
		await walk("", 0);
		root.innerHTML = `<div class="cv-tools"><button data-act="newfile" title="新增檔案">＋檔案</button><button data-act="newdir" title="新增資料夾">＋資料夾</button><button data-act="upload" title="從這台電腦上傳檔案或資料夾(也可以直接把檔案拖到下面的檔案樹)">⇪ 上傳</button><button data-act="collapse" title="全部收合">收合</button><button data-act="hidden" title="顯示/隱藏 . 開頭的檔案">${cm.hidden ? "隱藏 ." : "顯示 ."}</button><button data-act="reload" title="重新整理">↻</button><button data-act="term" title="在終端機開啟這個專案">終端機</button></div>${rows.join("") || '<div class="empty" style="padding:12px">空的資料夾</div>'}`;
	}
	$("cvFiles").addEventListener("click", async (e) => {
		const act = e.target.closest("[data-act]")?.dataset.act;
		if (act === "upload") {
			const base = cm.selRow && cm.dirs[dirOf(cm.selRow)]?.find((x) => x.rel === cm.selRow)?.type === "dir" ? cm.selRow : dirOf(cm.selRow || "");
			const r = e.target.getBoundingClientRect();
			return uploadMenu(base, r.left, r.bottom);
		}
		if (act) return toolAct(act, cm.selRow && cm.dirs[dirOf(cm.selRow)]?.find((x) => x.rel === cm.selRow)?.type === "dir" ? cm.selRow : dirOf(cm.selRow || ""));
		const row = e.target.closest(".tree-row");
		if (!row) return;
		const rel = row.dataset.rel, type = row.dataset.type;
		cm.selRow = rel;
		if (e.target.closest("[data-more]")) { const r = e.target.getBoundingClientRect(); return rowMenu(rel, type, r.left, r.bottom); }
		if (type === "dir") { cm.expanded.has(rel) ? cm.expanded.delete(rel) : cm.expanded.add(rel); return renderFiles(); }
		renderFiles();
		openFile(rel);
	});
	// 從檔案樹拖檔案到編輯區:直接在那個位置開啟(或分割)
	$("cvFiles").addEventListener("dragstart", (e) => {
		const row = e.target.closest(".tree-row[data-type=file]");
		if (!row) return;
		cm.drag = { fromTree: row.dataset.rel };
		e.dataTransfer.setData("text/plain", row.dataset.rel);
	});
	$("cvFiles").addEventListener("dragend", () => { cm.drag = null; clearDropMarks(); });
	$("cvFiles").addEventListener("contextmenu", (e) => {
		const row = e.target.closest(".tree-row");
		if (!row) return;
		e.preventDefault();
		cm.selRow = row.dataset.rel;
		renderFiles();
		rowMenu(row.dataset.rel, row.dataset.type, e.clientX, e.clientY);
	});
	function rowMenu(rel, type, x, y) {
		const items = [
			{ label: "重新命名", run: () => renameItem(rel) },
			{ label: "刪除(移到垃圾桶)", run: () => trashItem(rel, type) },
			{ label: "複製路徑", run: () => navigator.clipboard?.writeText(rel).then(() => toast("已複製路徑"), () => toast(rel)) },
		];
		if (type === "file" && !mobile()) items.unshift({ label: "在右邊開啟", run: () => openToSide(rel) });
		if (type === "file" && isMd(rel)) items.unshift({ label: "預覽 Markdown", run: () => openPreview(rel) });
		if (type === "file" && isNb(rel)) items.unshift({ label: "以原始 JSON 開啟", run: () => openFile(rel, cm.activeGroup, { raw: true }) });
		if (type === "dir") items.unshift({ label: "上傳檔案到這裡", run: () => pickAndUpload(rel, false) }, { label: "上傳資料夾到這裡", run: () => pickAndUpload(rel, true) }, { label: "在這裡新增檔案", run: () => toolAct("newfile", rel) }, { label: "在這裡新增資料夾", run: () => toolAct("newdir", rel) });
		menu(x, y, items);
	}
	async function openToSide(rel) {
		const g = cm.activeGroup || allGroups()[0];
		const existing = findTab(`file:${rel}`);
		if (existing) {
			if (existing.group.tabs.length === 1) { setActiveGroup(existing.group); return activate(existing.group, existing); }
			return splitWith(existing, existing.group, "right");
		}
		if (cm.cols.length >= MAX_COLS) return openFile(rel, g);
		await openFile(rel, newGroupAt(g, "right"));
	}
	// ---------- 從本地上傳 ----------
	const UPLOAD_LIMIT = 500 * 1024 * 1024;
	function uploadMenu(base, x, y) {
		menu(x, y, [
			{ label: `上傳檔案${base ? `到 ${base}/` : "到專案根目錄"}`, run: () => pickAndUpload(base, false) },
			{ label: `上傳整個資料夾${base ? `到 ${base}/` : ""}`, run: () => pickAndUpload(base, true) },
		]);
	}
	function pickAndUpload(base, folder) {
		const input = el("input");
		input.type = "file";
		input.multiple = true;
		if (folder) input.webkitdirectory = true;
		input.onchange = () => uploadFiles([...input.files].map((f) => ({ file: f, rel: folder && f.webkitRelativePath ? f.webkitRelativePath : f.name })), base);
		input.click();
	}
	/** 拖進來的東西(可能含資料夾)展開成檔案清單;webkitGetAsEntry 要在 drop 當下同步取 */
	async function droppedFiles(dt) {
		const entries = [...(dt.items || [])].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
		if (!entries.length) return [...(dt.files || [])].map((f) => ({ file: f, rel: f.name }));
		const out = [];
		const walk = async (entry, prefix) => {
			if (entry.isFile) {
				const f = await new Promise((ok, no) => entry.file(ok, no));
				out.push({ file: f, rel: prefix + f.name });
			} else if (entry.isDirectory) {
				const reader = entry.createReader();
				for (;;) {
					const batch = await new Promise((ok, no) => reader.readEntries(ok, no));
					if (!batch.length) break;
					for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
				}
			}
		};
		for (const e of entries) await walk(e, "");
		return out;
	}
	function uploadOne(file, path, overwrite, onProgress) {
		return new Promise((resolve) => {
			const x = new XMLHttpRequest();
			x.open("PUT", `/api/code/${cm.pid}/upload?path=${encodeURIComponent(path)}&overwrite=${overwrite ? 1 : 0}`);
			x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
			x.onload = () => { let d = null; try { d = JSON.parse(x.responseText); } catch {} resolve({ status: x.status, data: d }); };
			x.onerror = () => resolve({ status: 0, data: { error: "連線中斷" } });
			x.send(file);
		});
	}
	function askConflict(path, remaining) {
		return new Promise((resolve) => {
			const d = dialog({
				title: "已經有同名的檔案",
				html: `<p>「${esc(path)}」已經存在。覆蓋的話,舊的檔案會先移到 Mac 的垃圾桶。</p>`,
				buttons: [
					...(remaining > 0 ? [{ label: `之後全部略過`, onClick: () => resolve("skipAll") }, { label: `之後全部覆蓋`, onClick: () => resolve("overwriteAll") }] : []),
					{ label: "略過", onClick: () => resolve("skip") },
					{ label: "覆蓋", primary: true, onClick: () => resolve("overwrite") },
				],
			});
			d.querySelector("[data-x]").addEventListener("click", () => resolve("cancel"));
		});
	}
	let uploading = false;
	async function uploadFiles(list, base = "") {
		if (!list.length || !cm.pid) return;
		if (uploading) return toast("還有檔案在上傳,等它傳完");
		const tooBig = list.filter((x) => x.file.size > UPLOAD_LIMIT);
		list = list.filter((x) => x.file.size <= UPLOAD_LIMIT);
		if (tooBig.length) toast(`${tooBig.length} 個檔案超過 500 MB,略過`);
		uploading = true;
		const bar = el("div", "cv-upload");
		document.body.appendChild(bar);
		let ok = 0, skipped = 0, failed = 0, policy = null, lastErr = "";
		const pid = cm.pid;
		try {
			for (let i = 0; i < list.length; i++) {
				if (cm.pid !== pid) break; // 換專案就停
				const { file, rel } = list[i];
				const path = base ? `${base}/${rel}` : rel;
				const show = (frac) => { bar.textContent = `上傳中 ${i + 1}/${list.length} · ${rel} · ${Math.round(frac * 100)}%`; };
				show(0);
				let r = await uploadOne(file, path, policy === "overwrite", show);
				if (r.status === 409 && r.data?.exists) {
					let choice = policy || (await askConflict(path, list.length - i - 1));
					if (choice === "cancel") break;
					if (choice === "overwriteAll") { policy = "overwrite"; choice = "overwrite"; }
					if (choice === "skipAll") { policy = "skip"; choice = "skip"; }
					if (choice === "skip") { skipped++; continue; }
					r = await uploadOne(file, path, true, show);
				}
				if (r.status === 200) ok++;
				else { failed++; lastErr = r.data?.error || `錯誤 ${r.status}`; }
			}
		} finally {
			uploading = false;
			bar.remove();
		}
		toast(`已上傳 ${ok} 個檔案${skipped ? `,略過 ${skipped} 個` : ""}${failed ? `,失敗 ${failed} 個(${lastErr})` : ""}`);
		if (base) { let d = base; while (d) { cm.expanded.add(d); d = dirOf(d); } }
		cm.dirs = {};
		renderFiles();
		refreshGit();
	}
	// 從 Finder/檔案總管拖進檔案樹:拖到資料夾 = 傳到那個資料夾;拖到檔案 = 傳到它所在的資料夾;空白 = 專案根目錄
	const isOsDrag = (e) => !cm.drag && [...(e.dataTransfer?.types || [])].includes("Files");
	const dropBase = (e) => {
		const row = e.target.closest?.(".tree-row");
		if (!row) return "";
		return row.dataset.type === "dir" ? row.dataset.rel : dirOf(row.dataset.rel);
	};
	const clearUploadMarks = () => { document.querySelectorAll(".tree-row.drop-into").forEach((x) => x.classList.remove("drop-into")); $("cvFiles").classList.remove("drop-root"); };
	$("cvFiles").addEventListener("dragover", (e) => {
		if (!isOsDrag(e)) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "copy";
		clearUploadMarks();
		const base = dropBase(e);
		const row = base ? $("cvFiles").querySelector(`.tree-row[data-rel="${CSS.escape(base)}"]`) : null;
		if (row) row.classList.add("drop-into"); else $("cvFiles").classList.add("drop-root");
	});
	$("cvFiles").addEventListener("dragleave", (e) => { if (!$("cvFiles").contains(e.relatedTarget)) clearUploadMarks(); });
	$("cvFiles").addEventListener("drop", async (e) => {
		if (!isOsDrag(e)) return;
		e.preventDefault();
		clearUploadMarks();
		const base = dropBase(e);
		uploadFiles(await droppedFiles(e.dataTransfer), base);
	});
	// 拖到編輯區:傳到那個分頁檔案所在的資料夾(避免瀏覽器直接打開檔案、把網頁換掉)
	document.addEventListener("dragover", (e) => { if (isOsDrag(e) && document.body.classList.contains("code")) { e.preventDefault(); } }, true);
	document.addEventListener("drop", async (e) => {
		if (!isOsDrag(e) || !document.body.classList.contains("code") || $("cvFiles").contains(e.target)) return;
		e.preventDefault();
		e.stopPropagation();
		const g = allGroups().find((x) => x.el.contains(e.target));
		if (!g) return toast("把檔案拖到左邊的檔案樹就能上傳");
		const base = g.active?.path ? dirOf(g.active.path) : "";
		uploadFiles(await droppedFiles(e.dataTransfer), base);
	}, true);

	async function toolAct(act, base = "") {
		if (act === "reload") { cm.dirs = {}; return renderFiles(); }
		if (act === "collapse") { cm.expanded = new Set([""]); return renderFiles(); }
		if (act === "hidden") { cm.hidden = !cm.hidden; cm.dirs = {}; return renderFiles(); }
		if (act === "term") { setMode("term"); return jumpTo(cm.pid); }
		const name = await askName(act === "newfile" ? "新增檔案" : "新增資料夾", "", base ? `在 ${base}/ 底下` : "在專案根目錄");
		if (!name) return;
		const rel = base ? `${base}/${name}` : name;
		try {
			await api("fs", { method: "POST", body: JSON.stringify({ op: act === "newfile" ? "mkfile" : "mkdir", path: rel }) });
			if (base) cm.expanded.add(base);
			cm.dirs = {};
			await renderFiles();
			if (act === "newfile") openFile(rel);
		} catch (e) { fail(e); }
	}
	async function renameItem(rel) {
		const name = await askName("重新命名", baseName(rel));
		if (!name || name === baseName(rel)) return;
		const to = dirOf(rel) ? `${dirOf(rel)}/${name}` : name;
		try {
			await api("fs", { method: "POST", body: JSON.stringify({ op: "rename", path: rel, to }) });
			for (const t of allTabs()) if (t.path === rel || t.path?.startsWith(rel + "/")) { t.path = to + t.path.slice(rel.length); t.key = `${t.key.split(":")[0]}:${t.path}`; t.label = t.kind === "md" ? `預覽 ${baseName(t.path)}` : baseName(t.path); }
			cm.dirs = {}; renderFiles(); for (const g of allGroups()) renderTabs(g);
		} catch (e) { fail(e); }
	}
	async function trashItem(rel, type) {
		if (!(await confirmBox("刪除", `把「${rel}」${type === "dir" ? "(整個資料夾)" : ""}移到垃圾桶?之後可以從 Mac 的垃圾桶救回來。`, "移到垃圾桶"))) return;
		try {
			await api("fs", { method: "POST", body: JSON.stringify({ op: "trash", path: rel }) });
			for (const t of allTabs()) if (t.path === rel || t.path?.startsWith(rel + "/")) closeTab(t, true);
			cm.dirs = {}; renderFiles(); refreshGit();
			toast("已移到垃圾桶");
		} catch (e) { fail(e); }
	}

	// ---------- Git ----------
	async function refreshGit() {
		if (!cm.pid) return;
		cm.git = await api("git/status").catch((e) => ({ error: e.message }));
		const n = cm.git.repo ? cm.git.staged.length + cm.git.unstaged.length + cm.git.untracked.length + cm.git.conflicted.length : 0;
		$("cvGitCount").hidden = !n;
		$("cvGitCount").textContent = n;
		if (cm.view === "git") renderGit();
	}
	function gitRow(path, code, which) {
		const acts = which === "staged" ? '<button data-g="unstage" title="取消暫存">−</button>' : `<button data-g="discard" title="捨棄變更">↺</button><button data-g="stage" title="暫存">＋</button>`;
		return `<div class="git-row" data-path="${esc(path)}" data-which="${which}" title="${esc(path)}"><span class="nm">${esc(baseName(path))}<span class="dir">${esc(dirOf(path))}</span></span><span class="ra">${acts}</span><span class="g g-${code === "?" ? "U" : code}">${code === "?" ? "U" : code}</span></div>`;
	}
	const gitFold = (k) => { try { return JSON.parse(localStorage.getItem("steward.gitFold") || "{}")[k]; } catch { return false; } };
	const setGitFold = (k, v) => { try { const o = JSON.parse(localStorage.getItem("steward.gitFold") || "{}"); o[k] = v; localStorage.setItem("steward.gitFold", JSON.stringify(o)); } catch {} };
	function sec(key, title, count, acts, body) {
		const folded = gitFold(key);
		return `<div class="git-sec"><div class="h" data-fold="${key}">${folded ? "▸" : "▾"} ${title} ${count ?? ""}<span class="acts">${acts || ""}</span></div>${folded ? "" : body}</div>`;
	}
	async function renderGit() {
		const root = $("cvGit");
		const g = cm.git;
		if (!g) { root.innerHTML = '<div class="empty" style="padding:12px">讀取中…</div>'; return; }
		if (g.error) { root.innerHTML = `<div class="hint" style="padding:12px">${esc(g.error)}</div>`; return; }
		if (!g.repo) { root.innerHTML = '<div class="empty" style="padding:12px">這個專案不是 git repo</div>'; return; }
		const changes = [...g.unstaged.map((x) => ({ ...x, which: "unstaged" })), ...g.untracked.map((x) => ({ ...x, code: "?", which: "untracked" }))];
		const anyStaged = g.staged.length > 0;
		const sync = g.upstream ? `↓${g.behind} ↑${g.ahead}` : "尚未連到遠端";
		let branches = [];
		try { branches = (await gitPost("branches")).out.filter((b) => !b.name.startsWith("origin/") && !b.name.startsWith("remotes/")); } catch {}
		root.innerHTML = `
			<div class="git-branch"><select id="cvBranch" title="切換分支">${branches.map((b) => `<option ${b.current ? "selected" : ""}>${esc(b.name)}</option>`).join("") || `<option>${esc(g.branch)}</option>`}</select>
				<button class="small" data-gb="new" title="建立新分支">＋分支</button></div>
			<div class="git-branch"><span class="hint">${esc(sync)}</span><span style="flex:1"></span>
				<button class="small" data-gb="fetch" title="抓取遠端">抓取</button><button class="small" data-gb="pull" title="拉取(只快轉)">拉取</button><button class="small" data-gb="push" title="推送">推送${g.ahead ? ` ${g.ahead}` : ""}</button></div>
			<div class="git-commit"><textarea id="cvMsg" placeholder="提交訊息(⌘/Ctrl+Enter 提交)">${esc(cm.msgDraft || "")}</textarea>
				<div class="row"><button class="small" data-gb="genmsg">產生提交訊息</button><button class="small primary" data-gb="commit">${anyStaged ? "提交" : changes.length ? "全部暫存並提交" : "提交"}</button></div></div>
			${g.conflicted.length ? sec("conflict", "衝突", g.conflicted.length, "", `<div class="hint" style="padding:4px 14px 8px">合併衝突請到終端機處理</div>${g.conflicted.map((x) => gitRow(x.path, "!", "unstaged")).join("")}`) : ""}
			${sec("staged", "已暫存", g.staged.length, anyStaged ? '<button data-ga="unstageAll" title="全部取消暫存">−</button>' : "", g.staged.map((x) => gitRow(x.path, x.code, "staged")).join(""))}
			${sec("changes", "變更", changes.length, changes.length ? '<button data-ga="discardAll" title="捨棄全部變更">↺</button><button data-ga="stageAll" title="全部暫存">＋</button>' : "", changes.map((x) => gitRow(x.path, x.code, x.which)).join(""))}
			<div class="git-sec"><div class="h" data-ga="history">${cm.history ? "▾" : "▸"} 歷史(最近 50 筆)</div>${cm.history ? cm.history.map((c) => `<div class="git-row" data-commit="${c.hash}" title="${esc(c.author)} · ${esc(c.date)}"><span class="nm">${esc(c.subject)}<span class="dir">${c.short}</span></span></div>${cm.openCommit?.hash === c.hash ? cm.openCommit.files.map((f) => `<div class="git-row" data-cfile="${esc(f.path)}" data-commit="${c.hash}" style="padding-left:28px"><span class="nm">${esc(baseName(f.path))}<span class="dir">${esc(dirOf(f.path))}</span></span><span class="g g-${f.code[0]}">${f.code[0]}</span></div>`).join("") : ""}`).join("") : ""}</div>`;
		$("cvMsg").addEventListener("input", (e) => (cm.msgDraft = e.target.value));
		$("cvMsg").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) root.querySelector('[data-gb="commit"]').click(); });
		$("cvBranch").onchange = (e) => gitDo("checkout", { branch: e.target.value }, `已切換到 ${e.target.value}`);
	}
	async function gitDo(action, body, okMsg) {
		try { await gitPost(action, body); if (okMsg) toast(okMsg); } catch (e) { fail(e); }
		cm.dirs = {};
		await refreshGit();
		renderFiles();
		if (["checkout", "pull", "discard"].includes(action)) for (const t of allTabs()) if (t.kind === "file" && !t.dirty) await reloadTab(t);
	}
	$("cvGit").addEventListener("click", async (e) => {
		const gb = e.target.closest("[data-gb]")?.dataset.gb;
		const ga = e.target.closest("[data-ga]")?.dataset.ga;
		const fold = !e.target.closest("button") && e.target.closest("[data-fold]")?.dataset.fold;
		const g = cm.git;
		if (fold) { setGitFold(fold, !gitFold(fold)); return renderGit(); }
		if (gb === "new") { const n = await askName("建立新分支", "", "分支名稱"); if (n) gitDo("checkout", { branch: n, create: true }, `已建立並切換到 ${n}`); return; }
		if (gb === "fetch") return gitDo("fetch", {}, "已抓取");
		if (gb === "pull") return gitDo("pull", {}, "已拉取");
		if (gb === "push") return gitDo("push", {}, "已推送");
		if (gb === "genmsg") {
			const b = e.target; b.disabled = true; b.textContent = "產生中…";
			try { const r = await api("git/commitmsg", { method: "POST", body: "{}" }); cm.msgDraft = r.message; $("cvMsg").value = r.message; } catch (err) { fail(err); }
			b.disabled = false; b.textContent = "產生提交訊息";
			return;
		}
		if (gb === "commit") {
			const msg = $("cvMsg").value.trim();
			if (!msg) return toast("先寫提交訊息,或按「產生提交訊息」");
			try {
				if (!g.staged.length) await gitPost("stage", { all: true });
				await gitPost("commit", { message: msg });
				cm.msgDraft = ""; cm.history = cm.history ? (await gitPost("log")).out : null;
				toast("已提交");
			} catch (err) { fail(err); }
			cm.dirs = {}; await refreshGit(); renderFiles();
			return;
		}
		if (ga === "stageAll") return gitDo("stage", { all: true });
		if (ga === "unstageAll") return gitDo("unstage", { all: true });
		if (ga === "discardAll") {
			const paths = [...g.unstaged, ...g.untracked].map((x) => x.path);
			if (await confirmBox("捨棄全部變更", `捨棄 ${paths.length} 個檔案的變更?修改會還原成上次提交的內容,新檔案會移到垃圾桶。`, "捨棄")) gitDo("discard", { paths });
			return;
		}
		if (ga === "history") { cm.history = cm.history ? null : (await gitPost("log").catch(fail))?.out ?? null; cm.openCommit = null; return renderGit(); }
		const rowAct = e.target.closest("[data-g]")?.dataset.g;
		const row = e.target.closest(".git-row");
		if (!row) return;
		if (row.dataset.cfile) return openDiff(row.dataset.cfile, "commit", row.dataset.commit);
		if (row.dataset.commit) {
			cm.openCommit = cm.openCommit?.hash === row.dataset.commit ? null : (await gitPost("show", { commit: row.dataset.commit }).catch(fail))?.out ?? null;
			return renderGit();
		}
		const path = row.dataset.path, which = row.dataset.which;
		if (rowAct === "stage") return gitDo("stage", { paths: [path] });
		if (rowAct === "unstage") return gitDo("unstage", { paths: [path] });
		if (rowAct === "discard") {
			if (await confirmBox("捨棄變更", which === "untracked" ? `「${path}」是新檔案,捨棄會把它移到垃圾桶。` : `把「${path}」還原成上次提交的內容?`, "捨棄")) gitDo("discard", { paths: [path] });
			return;
		}
		openDiff(path, which);
	});
	async function openDiff(path, which, commit, into = null, { quiet = false } = {}) {
		await loadMonaco().catch(fail);
		if (!cm.monaco) return;
		ensureLayout();
		const key = `diff:${which}:${commit || ""}:${path}`;
		const old = findTab(key);
		const g = into || old?.group || cm.activeGroup || allGroups()[0];
		if (old) closeTab(old, true);
		try {
			const d = await api(`git/diff?path=${encodeURIComponent(path)}&which=${which}${commit ? `&commit=${commit}` : ""}`);
			const lang = langOf(path);
			const caption = which === "staged" ? "已暫存的變更:上次提交 ↔ 暫存區" : which === "commit" ? `提交 ${commit.slice(0, 7)} 的變更` : which === "untracked" ? "新檔案" : "未暫存的變更:暫存區 ↔ 工作目錄";
			const target = allGroups().includes(g) ? g : allGroups()[0];
			const t = { key, group: target, kind: "diff", path, which, commit, label: `${baseName(path)}${which === "staged" ? "(已暫存)" : which === "commit" ? `@${commit.slice(0, 7)}` : "(變更)"}`, title: `${path} · ${caption}`, caption, orig: cm.monaco.editor.createModel(d.original, lang), mod: cm.monaco.editor.createModel(d.modified, lang) };
			target.tabs.push(t);
			setActiveGroup(target);
			activate(target, t);
		} catch (e) { if (!quiet) fail(e); }
	}

	// ---------- 和管家連動 ----------
	const snippetBlock = (s) => `檔案 ${s.path} 第 ${s.from}${s.to !== s.from ? `–${s.to}` : ""} 行:\n\`\`\`\n${s.text}\n\`\`\``;
	/** 編輯器右鍵「問管家」:打開浮動球的對話面板,把選取的程式當成引用 */
	function askSteward(s) {
		if (!s.text) return toast("先選取一段程式碼");
		window.openStewardChat?.({ quote: { path: s.path, from: s.from, to: s.to, text: s.text } });
	}
	// 能派工的 agent(這台電腦裝了、herdr 支援的)
	fetch("/api/agents").then((r) => r.json()).then((d) => { cm.agents = d.agents; }).catch(() => {});
	function newCard(s) {
		const lines = s.text ? `第 ${s.from}${s.to !== s.from ? `–${s.to}` : ""} 行` : "";
		dialog({
			title: "建立工作卡",
			html: `<label class="field">標題<input type="text" data-t value="${esc(`修改 ${s.path ?? ""} ${lines}`.trim())}"></label>
				<label class="field">給 agent 的指示<textarea data-i rows="8" style="font:13px Menlo,monospace;padding:6px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink)">${esc(`${s.text ? snippetBlock(s) : `檔案 ${s.path}`}\n\n要做的事:`)}</textarea></label>
				<label class="field">完成標準<input type="text" data-c value="完成上述要求,並說明改了什麼"></label>
				<label class="field">交給<select data-g>${(cm.agents?.length ? cm.agents : [{ id: "pi", name: "pi" }, { id: "claude", name: "Claude Code" }, { id: "codex", name: "Codex" }]).map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("")}</select></label>
				<div class="hint">建好的卡會放在「提案」,你核准後才會派出去。</div>`,
			buttons: [{ label: "建立", primary: true, onClick: async (w) => {
				const r = await post("/api/cards", { projectId: cm.pid, title: w.querySelector("[data-t]").value, instructions: w.querySelector("[data-i]").value, doneCriteria: w.querySelector("[data-c]").value, agent: w.querySelector("[data-g]").value });
				if (r.error) throw new Error(r.error);
				toast("已建立工作卡,放在「提案」");
				load();
			} }],
		});
	}

	// ---------- 側欄:切換、收合、拖拉寬度 ----------
	function setView(v) {
		cm.view = v;
		$("cvFilesBtn").classList.toggle("on", v === "files");
		$("cvGitBtn").classList.toggle("on", v === "git");
		$("cvFiles").hidden = v !== "files";
		$("cvGit").hidden = v !== "git";
		if (v === "git") { renderGit(); refreshGit(); }
		saveSoon();
	}
	function setSideCollapsed(on) {
		document.body.classList.toggle("cv-side-collapsed", on);
		pref("steward.cvSideCollapsed", on ? "1" : "0");
		$("cvFilesBtn").title = on ? "展開側欄" : "檔案(再按一次收合側欄)";
		$("cvGitBtn").title = on ? "展開側欄" : "版本控制(再按一次收合側欄)";
	}
	// 跟 VS Code 一樣:按目前的圖示 = 收合/展開側欄;按另一個 = 切過去並展開
	const activityClick = (v) => {
		if (mobile()) { document.body.classList.remove("cv-editing"); return setView(v); }
		const collapsed = document.body.classList.contains("cv-side-collapsed");
		if (cm.view === v && !collapsed) return setSideCollapsed(true);
		setSideCollapsed(false);
		setView(v);
	};
	$("cvFilesBtn").onclick = () => activityClick("files");
	$("cvGitBtn").onclick = () => activityClick("git");
	$("cvSideSash").addEventListener("pointerdown", (e) => {
		e.preventDefault();
		const s = $("cvSideSash");
		s.setPointerCapture(e.pointerId);
		s.classList.add("drag");
		const side = document.querySelector(".cv-side");
		const start = e.clientX, w0 = side.getBoundingClientRect().width;
		const move = (ev) => { side.style.flexBasis = `${Math.max(180, Math.min(600, w0 + ev.clientX - start))}px`; };
		const up = () => { s.classList.remove("drag"); pref("steward.cvSideWidth", side.style.flexBasis); s.removeEventListener("pointermove", move); s.removeEventListener("pointerup", up); };
		s.addEventListener("pointermove", move);
		s.addEventListener("pointerup", up);
	});
	addEventListener("resize", () => { for (const g of allGroups()) renderTabs(g); });

	function render() {
		renderProjSelect();
		renderFiles();
		if (cm.view === "git") renderGit();
	}
	function refresh() { cm.dirs = {}; renderFiles(); refreshGit(); }
	window.codeMode = {
		pid: () => cm.pid,
		/** 浮動球用:最後看的檔案、開著的檔案(目前的排第一)、編輯器裡的最新內容(含沒存的) */
		lastFile: () => cm.lastPath || null,
		openFiles() {
			const cur = cm.activeGroup?.active?.path;
			const paths = [...new Set(allTabs().filter((t) => t.path && (t.kind === "file" || t.kind === "nb" || t.kind === "md")).map((t) => t.path))];
			return paths.sort((a, b) => (a === cur ? -1 : b === cur ? 1 : 0)).map((path) => ({ path, current: path === cur, dirty: allTabs().some((t) => t.path === path && t.dirty) }));
		},
		fileText(path) {
			const t = allTabs().find((x) => x.kind === "file" && x.path === path && x.model && !x.model.isDisposed() && !x.truncated);
			if (t?.dirty) return t.model.getValue();
			const nb = allTabs().find((x) => x.kind === "nb" && x.path === path && x.dirty && x.nb);
			if (nb) return JSON.stringify({ ...nb.nb, cells: nb.nb.cells.map(({ _el, _id, _runId, _editing, _sent, _started, _clearNext, ...c }) => c) }, null, 1);
			return null; // 沒改過:伺服器自己讀磁碟
		},
		hasUnsaved: (id) => (id === cm.pid ? allTabs().some((t) => t.dirty) : cm.stash.has(id)),
		/** 共用入口呼叫:程式碼頁面開著時換到這個專案 */
		async pick(id) {
			if (!projects().some((p) => p.id === id)) return; // 雜務/總覽之類不是程式碼專案:維持原樣
			await pickProject(id);
			render();
		},
		async show() {
			const w = pref("steward.cvSideWidth");
			if (w) document.querySelector(".cv-side").style.flexBasis = w;
			if (pref("steward.cvSideCollapsed") === "1" && !mobile()) setSideCollapsed(true);
			ensureLayout();
			layout();
			const list = projects();
			// 跟著共用的「目前專案」;它不是程式碼專案(雜務、總覽)就維持原本的
			const want = list.find((p) => p.id === sel)?.id ?? (list.find((p) => p.id === cm.pid) ? cm.pid : list[0]?.id ?? null);
			if (want !== cm.pid) await pickProject(want); else render();
			loadMonaco().catch(fail);
			setView(cm.view);
			if (cm.expanded.size > 1) renderFiles();
		},
	};
	addEventListener("beforeunload", (e) => { if (allTabs().some((t) => t.dirty) || cm.stash.size) { e.preventDefault(); e.returnValue = ""; } });
})();
