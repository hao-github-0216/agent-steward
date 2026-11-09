// 「程式碼」模式:檔案樹 + 可分割的 Monaco 編輯區 + Git 面板(類 VS Code)。
// 編輯區版面:欄(左右並排,最多 4 欄)→ 每欄裡的群組(上下並排,最多 3 個);每個群組有自己的分頁列與編輯器。
// 分頁可以拖拉:同一列換順序、拖到別的群組、拖到群組的上下左右邊緣就分割出新的群組。
// 依賴主頁面的全域:$, esc, post, toast, state, sel, setMode, jumpTo, load, pref
(() => {
	const MONACO = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min";
	const MAX_COLS = 4, MAX_ROWS = 3;
	const mobile = () => innerWidth <= 800;
	const cm = {
		pid: null, view: "files", expanded: new Set([""]), hidden: false, dirs: {}, git: null, gitRepo: null, gitMain: null, history: null, openCommit: null, selRow: null,
		fetchPrefs: null, fetchPrefsAt: 0, askLater: false, lastAutoFetch: new Map(),
		monaco: null, ready: null,
		cols: [], // [{ id, size, groups: [group] }]
		activeGroup: null,
		drag: null, // 正在拖的分頁
		stash: new Map(), // 有沒存修改就切走的專案:整組分頁留在記憶體 pid → { cols, activeGroup, expanded }
	};
	let uid = 0;
	/** 程式碼頁請求用的專案代號:在看 worktree 時是「專案@worktree」(伺服器換成 worktree 裡的資料夾) */
	const cp = () => (cm.wt ? `${cm.pid}@${cm.wt.id}` : cm.pid);
	/** 分頁組的代號(主資料夾和每個 worktree 各一組) */
	const viewKey = () => cp();
	/** 分支總覽 API(一律對主專案) */
	const wtApi = async (path, opts = {}) => {
		const r = await fetch(`/api/code/${cm.pid}/worktrees${path ? `/${path}` : ""}`, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
		const data = (r.headers.get("content-type") || "").includes("json") ? await r.json() : null;
		if (!r.ok) { const err = new Error(data?.error || `錯誤 ${r.status}`); err.status = r.status; err.data = data; throw err; }
		return data;
	};

	// ---------- 工具 ----------
	async function api(path, opts = {}) {
		const r = await fetch(`/api/code/${cp()}/${path}`, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
		const ct = r.headers.get("content-type") || "";
		const data = ct.includes("json") ? await r.json() : null;
		if (!r.ok) {
			const err = new Error(data?.error || `錯誤 ${r.status}`);
			err.status = r.status; err.data = data;
			throw err;
		}
		return data;
	}
	const gq = (repo = cm.gitRepo) => (repo && !cm.wt ? `repo=${encodeURIComponent(repo)}` : "");
	const gitPost = (action, body = {}) => api(`git/${action}${gq() ? `?${gq()}` : ""}`, { method: "POST", body: JSON.stringify(body) });
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
			const d = dialog({ title, html: `<p style="white-space:pre-line">${esc(text)}</p>`, buttons: [{ label: okLabel, primary: true, onClick: () => resolve(true) }] });
			d.querySelector("[data-x]").addEventListener("click", () => resolve(false));
		});
	}
	window.confirmBox = confirmBox; // 看板頁(浮動球)也用同一個確認對話框
	window.choiceBox = (title, text, labels) => new Promise((resolve) => {
		const d = dialog({ title, html: `<p style="white-space:pre-line">${esc(text)}</p>`, buttons: labels.map((label, i) => ({ label, onClick: () => resolve(i) })) });
		d.querySelector("[data-x]").addEventListener("click", () => resolve(null));
	});
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
	const isTex = (p) => /\.tex$/i.test(p || "");
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
		// 「目前檔案」以實際點選/取得焦點為準(滑鼠移過去不算)
		g.el.addEventListener("pointerdown", () => setActiveGroup(g), true);
		g.el.addEventListener("focusin", () => setActiveGroup(g));
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
		notifyCurrent();
	}
	// 浮動球的「目前檔案」= 取得焦點的群組正在顯示的檔案(一般檔、Notebook、Markdown 預覽)。
	// 每次現算,不另外記:切群組、關分頁、換專案都不會留下舊的
	const textKind = (t) => !!t?.path && (t.kind === "file" || t.kind === "nb" || t.kind === "md");
	function currentPath() {
		const t = cm.activeGroup?.active;
		return textKind(t) && cm.activeGroup.tabs.includes(t) ? t.path : null;
	}
	let notified = null;
	function notifyCurrent() {
		const cur = cm.pid ? currentPath() : null;
		if (cur === notified) return;
		notified = cur;
		dispatchEvent(new CustomEvent("steward:codefile", { detail: { path: cur } }));
	}
	function ensureLayout() {
		if (!cm.cols.length) {
			const g = newGroup();
			cm.cols = [{ id: `c${++uid}`, size: 1, groups: [g] }];
			cm.activeGroup = g;
		}
	}
	/** 把比例換算成加總等於個數,相對大小不變。
	 *  flex-grow 加總小於 1 時只會分到那個比例的空間:例如拖過分割線後關掉右欄,剩下的左欄是 0.75,右邊就會空一塊 */
	function fitSizes(items) {
		const ok = (x) => (Number.isFinite(x.size) && x.size > 0 ? x.size : 1);
		const sum = items.reduce((a, x) => a + ok(x), 0);
		for (const x of items) x.size = (ok(x) * items.length) / sum;
	}
	/** 依 cm.cols 重新排 DOM(群組元素沿用,編輯器不會重建) */
	function layout() {
		ensureLayout();
		fitSizes(cm.cols);
		for (const col of cm.cols) fitSizes(col.groups);
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
		// 記住看到哪裡(切分頁、重新整理、換電腦都回到原位)
		const pv = t.pv;
		pv.addEventListener("scroll", () => {
			if (pv.hidden || t.restoring) return;
			t.pos = { ...(t.pos || {}), top: pv.scrollTop, left: pv.scrollLeft };
			// PDF 記「第幾頁、頁內位置」:版面寬度改變(分割畫面、換電腦)時頁高會變,像素就不準了
			if (t.kind === "pdf" && t.pdfPages) { const at = pdfWhere(t); if (at) Object.assign(t.pos, at); pdfPageLabel(t); }
			saveSoon(1500);
		}, { passive: true });
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
	function showPv(g, t) {
		for (const c of g.previewEl.children) c.hidden = c !== t.pv;
		// 隱藏的元素會丟掉捲動位置:顯示回來時補回去
		if (t.pv && t.pos) requestAnimationFrame(() => applyPos(t));
	}
	/** 回到記住的位置(內容畫好之後呼叫);有縮放的先還原縮放 */
	function applyPos(t) {
		const pv = t.pv;
		if (!pv || !t.pos) return;
		t.restoring = true;
		if (t.pos.zoom && t.zoomer && Math.abs(t.zoomer.zoom - t.pos.zoom) > 0.01) t.zoomer.setZoom(t.pos.zoom);
		const pr = t.kind === "pdf" && t.pos.page != null ? pdfPageRect(t, t.pos.page) : null;
		pv.scrollTop = pr ? pr.top + pr.height * (t.pos.frac || 0) : t.pos.top || 0;
		pv.scrollLeft = t.pos.left || 0;
		requestAnimationFrame(() => { t.restoring = false; });
	}
	function buildPreview(t, n) {
		const src = `/api/code/${cp()}/raw?path=${encodeURIComponent(t.path)}`;
		if (t.kind === "image") {
			n.innerHTML = `<div class="zoomwrap"><img src="${src}" alt="${esc(t.label)}" draggable="false"></div>`;
			const img = n.querySelector("img"), wrap = n.querySelector(".zoomwrap");
			// 先縮到剛好放得下,之後用 zoom 放大
			const fit = () => { if (!img.naturalWidth) return; const r = Math.min(1, (n.clientWidth - 16) / img.naturalWidth, (n.clientHeight - 16) / img.naturalHeight); img.style.width = `${Math.round(img.naturalWidth * r)}px`; img.style.height = `${Math.round(img.naturalHeight * r)}px`; };
			img.onload = () => { fit(); applyPos(t); };
			t.zoomer = attachZoom(n, wrap, { onEnd: (z) => { t.pos = { ...(t.pos || {}), zoom: z }; saveSoon(1500); } });
		} else if (t.kind === "office") {
			buildOffice(t, n, src);
		} else if (t.kind === "pdf") {
			// 一律用 PDF.js:才能記住看到第幾頁、手機也能縮放;要用瀏覽器內建檢視器(搜尋)按「用瀏覽器開啟」
			buildPdfjs(t, n, src);
		} else {
			n.innerHTML = `<div class="empty" style="text-align:center;padding:20px">${t.info}</div>`;
		}
	}
	// ---------- LaTeX:latexmk 編譯、錯誤清單、PDF 在旁邊自動刷新 ----------
	// 外掛開關(設定 → 外掛):沒開的功能不顯示按鈕
	cm.plugins = { latex: true, notebook: true, office: true };
	async function refreshPlugins() {
		const r = await fetch("/api/plugins").then((x) => (x.ok ? x.json() : null)).catch(() => null);
		if (!r) return;
		cm.plugins = r;
		for (const g of allGroups()) if (g.active) activate(g, g.active);
		for (const t of allTabs()) if (t.kind === "nb" && t.nb) { if (r.notebook) { nbConnect(t); nbLoadPythons(t); } nbToolbar(t); }
	}
	const texAuto = () => pref(`steward.texAuto:${cm.pid}`) === "1";
	function texBar(g, t) {
		const r = t.tex;
		const nErr = r?.issues?.filter((i) => i.level === "error").length || 0, nWarn = r?.issues?.filter((i) => i.level === "warning").length || 0;
		const state = t.texBusy ? "編譯中…" : !r ? "LaTeX" : r.ok ? `✓ 編譯成功(${esc(r.engine)},${r.seconds} 秒)` : r.pdf ? `有錯誤,PDF 可能不完整(${esc(r.engine)})` : "✗ 編譯失敗";
		bar(g, `<span class="tex-state${r && !r.ok && !t.texBusy ? " bad" : ""}">${state}</span>${r && (nErr || nWarn) ? `<button class="small" data-bar="texissues">${nErr ? `✗ ${nErr} 個錯誤` : ""}${nErr && nWarn ? " · " : ""}${nWarn ? `⚠ ${nWarn} 個警告` : ""}</button>` : ""}<span class="sp"></span><label class="tex-auto" title="按 ⌘/Ctrl+S 存檔時自動編譯"><input type="checkbox" data-texauto ${texAuto() ? "checked" : ""}> 存檔時編譯</label><button class="small primary" data-bar="texbuild" ${t.texBusy ? "disabled" : ""}>編譯</button>`);
		g.barEl?.querySelector("[data-texauto]")?.addEventListener("change", (e) => pref(`steward.texAuto:${cm.pid}`, e.target.checked ? "1" : "0"));
	}
	async function texBuild(t) {
		if (t.texBusy) return;
		if (t.dirty && !(await saveTab(t))) return;
		t.texBusy = true;
		if (t.group.active === t) texBar(t.group, t);
		const r = await api("latex", { method: "POST", body: JSON.stringify({ path: t.path }) }).catch((e) => ({ error: e.message }));
		t.texBusy = false;
		if (r.error) { toast(r.error); if (t.group.active === t) texBar(t.group, t); return; }
		// 同一份主檔的所有 .tex 分頁共用結果(\input 進來的子檔也看得到)
		for (const x of allTabs()) if (x.kind === "file" && isTex(x.path) && (x === t || r.issues.some((i) => i.file === x.path))) x.tex = r;
		texMarkers(r);
		if (t.group.active === t) texBar(t.group, t);
		if (r.pdf) await texShowPdf(t, r.pdf);
		const nErr = r.issues.filter((i) => i.level === "error").length;
		toast(`${r.installed?.length ? `自動安裝了 ${r.installed.join("、")};` : ""}${r.ok ? "編譯完成" : nErr ? `編譯有 ${nErr} 個錯誤` : "編譯失敗,看看完整紀錄"}`);
	}
	/** 編輯器裡把錯誤 / 警告畫成波浪線 */
	function texMarkers(r) {
		const m = cm.monaco;
		for (const x of allTabs()) {
			if (x.kind !== "file" || !isTex(x.path) || !x.model) continue;
			const mine = r.issues.filter((i) => i.line && (i.file ? i.file === x.path : x.path === r.main));
			m.editor.setModelMarkers(x.model, "latex", mine.map((i) => ({ severity: i.level === "error" ? m.MarkerSeverity.Error : m.MarkerSeverity.Warning, message: i.message, startLineNumber: i.line, endLineNumber: i.line, startColumn: 1, endColumn: x.model.getLineMaxColumn(Math.min(i.line, x.model.getLineCount())) })));
		}
	}
	/** PDF:已經開著就刷新,沒開就開在旁邊 */
	async function texShowPdf(t, pdf) {
		const ex = findTab(`file:${pdf}`);
		if (ex) { texReloadPdf(ex); return; }
		const g = t.group;
		if (mobile()) return toast("PDF 已經產生,從檔案列表打開");
		const ci = cm.cols.indexOf(colOf(g));
		const target = cm.cols[ci + 1]?.groups[0] || (cm.cols.length < MAX_COLS ? newGroupAt(g, "right") : null);
		await openFile(pdf, target || g);
		// 開完 PDF 把焦點還給 .tex
		setActiveGroup(g); activate(g, t);
	}
	function texReloadPdf(x) {
		x.pv?.remove(); x.pv = null; x.pdfDoc?.destroy?.(); x.pdfDoc = null;
		if (x.group.active === x) activate(x.group, x);
	}
	function texIssues(t) {
		const r = t.tex;
		if (!r) return;
		const row = (i, k) => `<button type="button" class="tex-issue ${i.level}" data-ti="${k}"><b>${i.level === "error" ? "✗" : "⚠"}</b> ${esc(i.file || r.main)}${i.line ? `:${i.line}` : ""} — ${esc(i.message)}</button>`;
		const d = dialog({
			title: `編譯結果 · ${baseName(r.main)}`,
			html: `<div class="hint">引擎 ${esc(r.engine)} · ${r.seconds} 秒${r.pdf ? ` · PDF:${esc(r.pdf)}` : ""}。點一項跳到那一行。</div>
				<div class="tex-list">${r.issues.map(row).join("") || '<div class="hint">沒有錯誤或警告</div>'}</div>
				<details><summary class="hint">完整編譯紀錄(最後 300 行)</summary><pre class="tex-log">${esc(r.log)}</pre></details>`,
			buttons: [],
		});
		d.querySelector(".box")?.classList.add("ov-box");
		d.addEventListener("click", async (e) => {
			const k = e.target.closest("[data-ti]")?.dataset.ti;
			if (k == null) return;
			const i = r.issues[Number(k)];
			if (!i.line) return;
			d.remove();
			await openFile(i.file || r.main);
			const tab = findTab(`file:${i.file || r.main}`);
			const ed = tab?.group.editor;
			if (ed && tab.group.active === tab) { ed.revealLineInCenter(i.line); ed.setPosition({ lineNumber: i.line, column: 1 }); ed.focus(); }
		});
	}
	// ---------- Office:Word 照版面顯示(docx-preview)、Excel 顯示表格(SheetJS) ----------
	const officeLibs = {};
	function loadOfficeLib(which) {
		if (officeLibs[which]) return officeLibs[which];
		officeLibs[which] = loadMonaco().then(() => new Promise((ok, no) => {
			window.require.config({ paths: { jszip: "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min", "docx-preview": "https://cdn.jsdelivr.net/npm/docx-preview@0.3.3/dist/docx-preview.min", xlsx: "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min" } });
			window.require([which === "word" ? "docx-preview" : "xlsx"], (lib) => ok(lib), () => no(new Error("載入 Office 預覽元件失敗(需要能連上 cdn.jsdelivr.net)")));
		})).catch((e) => { delete officeLibs[which]; throw e; });
		return officeLibs[which];
	}
	const OFFICE_NAME = { word: "Word", excel: "Excel", powerpoint: "PowerPoint" };
	const OFFICE_SCHEME = { word: "ms-word", excel: "ms-excel", powerpoint: "ms-powerpoint" };
	function officeBar(g, t) {
		const app = OFFICE_NAME[t.app] || "Office";
		bar(g, `<span class="office-state">${t.editing ? `<b>正在 Office 編輯中</b>${t.editOwner && t.editOwner !== "Office" ? `(${esc(t.editOwner)})` : ""} · 存檔後這裡會自動更新` : `${app} 檔 · 預覽`}</span><span class="sp"></span>${cm.plugins.office ? `<button class="small" data-bar="officehist">歷史版本</button><button class="small primary" data-bar="officeedit">用 ${app} 編輯</button>` : '<span class="hint">要用 Office 編輯,請到 設定 → 外掛 開啟</span>'}`);
	}
	/** 用這台電腦上的 Office 打開(WebDAV 專用連結),存檔直接寫回專案裡的原檔 */
	async function officeEdit(t) {
		const r = await api("office/link", { method: "POST", body: JSON.stringify({ path: t.path }) }).catch((e) => ({ error: e.message }));
		if (r.error) return toast(r.error);
		const url = `${location.origin}/dav/${r.token}/${encodeURIComponent(baseName(t.path))}`;
		const a = document.createElement("a");
		a.href = `${OFFICE_SCHEME[t.app] || "ms-word"}:ofe|u|${url}`;
		document.body.appendChild(a); a.click(); a.remove();
		toast(`正在用 ${OFFICE_NAME[t.app] || "Office"} 打開…沒反應的話,這台電腦可能沒有裝 Office`);
	}
	async function officeInfo(t) {
		const r = await api(`office/info?path=${encodeURIComponent(t.path)}`).catch(() => null);
		if (!r) return null;
		const changed = r.editing !== !!t.editing || r.owner !== t.editOwner;
		t.editing = r.editing; t.editOwner = r.owner;
		if (changed && t.group.active === t) officeBar(t.group, t);
		return r;
	}
	async function officeHistory(t) {
		const r = await officeInfo(t);
		const vs = r?.versions || [];
		const fmt = (ms) => new Date(ms).toLocaleString("zh-TW", { hour12: false });
		const d = dialog({
			title: `歷史版本 · ${baseName(t.path)}`,
			html: vs.length
				? `<div class="hint">每次從 Office 存檔前會留下舊版本(最近 20 版、30 天內)。還原時,目前的版本也會先留一份。</div><div class="ov-list">${vs.map((v) => `<div class="ov-row"><span>${fmt(v.at)}</span><span class="hint">${fmtSize(v.size)}</span><span class="sp"></span><button class="small" data-ovp="${esc(v.id)}">預覽</button><button class="small" data-ovr="${esc(v.id)}">還原</button></div>`).join("")}</div><div class="ov-pv" hidden></div>`
				: '<p class="hint">還沒有歷史版本。從 Office 存檔之後,每次存檔前的版本會留在這裡。</p>',
			buttons: [],
		});
		d.querySelector(".box")?.classList.add("ov-box");
		d.addEventListener("click", async (e) => {
			const pv = e.target.closest("[data-ovp]")?.dataset.ovp, rs = e.target.closest("[data-ovr]")?.dataset.ovr;
			if (pv) {
				const box = d.querySelector(".ov-pv");
				box.hidden = false;
				buildOffice({ ...t, label: `${baseName(t.path)}(${fmt(Number(pv.split(".")[0]))})` }, box, `/api/code/${cp()}/office/version?path=${encodeURIComponent(t.path)}&id=${encodeURIComponent(pv)}`);
			}
			if (rs && (await confirmBox("還原這個版本", `把「${baseName(t.path)}」還原成 ${fmt(Number(rs.split(".")[0]))} 的版本?目前的版本會先留一份在歷史版本裡。${t.editing ? "注意:這個檔案正在 Office 編輯中,還原後請在 Office 重新打開,否則 Office 存檔時會蓋掉還原的內容。" : ""}`, "還原"))) {
				const x = await api("office/restore", { method: "POST", body: JSON.stringify({ path: t.path, id: rs }) }).catch((err) => ({ error: err.message }));
				if (x.error) return toast(x.error);
				d.remove();
				toast("已還原");
				if (t.pv) buildOffice(t, t.pv, `/api/code/${cp()}/raw?path=${encodeURIComponent(t.path)}`);
			}
		});
	}
	/** 預覽:docx → 版面、xlsx/xls → 表格;其他(pptx、doc、ppt)只顯示資訊 */
	async function buildOffice(t, n, src) {
		const ext = (t.path.split(".").pop() || "").toLowerCase();
		const canWord = t.app === "word" && ext === "docx";
		const canExcel = t.app === "excel";
		if (!canWord && !canExcel) {
			n.innerHTML = `<div class="office-info"><div class="oi-name">${esc(t.label)}</div><div class="hint">${esc(OFFICE_NAME[t.app] || "Office")} 檔 · ${fmtSize(t.size || 0)}</div><p class="hint">這種檔案網頁上沒辦法預覽,按上面的「用 ${esc(OFFICE_NAME[t.app] || "Office")} 編輯」在你這台電腦打開。</p></div>`;
			return;
		}
		n.innerHTML = '<div class="nb-msg">讀取中…</div>';
		try {
			const [lib, r] = await Promise.all([loadOfficeLib(canWord ? "word" : "excel"), fetch(`${src}&_=${Date.now()}`)]);
			if (!r.ok) throw new Error(`讀不到這個檔案(${r.status})`);
			const buf = await r.arrayBuffer();
			if (canWord) {
				n.innerHTML = '<div class="office-word"></div>';
				const wrap = n.firstChild;
				await lib.renderAsync(buf, wrap, null, { className: "docx", inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false, renderHeaders: true, renderFooters: true, renderFootnotes: true, useBase64URL: true });
				if (n === t.pv) { t.zoomer = attachZoom(n, wrap, { onEnd: (z) => { t.pos = { ...(t.pos || {}), zoom: z }; saveSoon(1500); } }); applyPos(t); } else attachZoom(n, wrap);
			} else {
				const wb = lib.read(buf, { type: "array", cellDates: true, cellNF: true });
				const names = wb.SheetNames;
				t.sheet = names.includes(t.sheet) ? t.sheet : names.includes(t.pos?.sheet) ? t.pos.sheet : names[0];
				const draw = () => {
					const ws = wb.Sheets[t.sheet];
					// 太大的工作表只畫前 2000 列、200 欄
					let note = "";
					if (ws?.["!ref"]) {
						const rg = lib.utils.decode_range(ws["!ref"]);
						if (rg.e.r - rg.s.r > 2000 || rg.e.c - rg.s.c > 200) {
							note = `<div class="hint xl-note">工作表很大(${rg.e.r - rg.s.r + 1} 列 × ${rg.e.c - rg.s.c + 1} 欄),只顯示前 2000 列、200 欄。</div>`;
							rg.e.r = Math.min(rg.e.r, rg.s.r + 1999); rg.e.c = Math.min(rg.e.c, rg.s.c + 199);
							ws["!ref"] = lib.utils.encode_range(rg);
						}
					}
					const html = ws ? lib.utils.sheet_to_html(ws, { header: "", footer: "" }) : "<p>(空的工作表)</p>";
					n.innerHTML = `${names.length > 1 ? `<div class="xl-tabs">${names.map((nm) => `<button type="button" class="small${nm === t.sheet ? " on" : ""}" data-sheet="${esc(nm)}">${esc(nm)}</button>`).join("")}</div>` : ""}${note}<div class="office-xl">${html}</div>`;
					n.querySelectorAll("[data-sheet]").forEach((b) => (b.onclick = () => { t.sheet = b.dataset.sheet; if (n === t.pv) { t.pos = { sheet: t.sheet, top: 0, left: 0 }; saveSoon(1500); } draw(); }));
				};
				draw();
				if (n === t.pv) applyPos(t);
			}
		} catch (e) {
			n.innerHTML = `<div class="office-info"><div class="oi-name">${esc(t.label)}</div><p class="hint">預覽失敗:${esc(e.message || String(e))}</p></div>`;
		}
	}
	/**
	 * 雙指縮放 + 點兩下放大/還原(手機),Ctrl/⌘+滾輪或觸控板捏合(電腦)。
	 * 用 CSS zoom 放大內容,版面跟著變大,原生捲動就能左右上下看。
	 * min:最小縮放(函式,視窗大小變了會跟著變);沒給就是 1(不能比原本小)。
	 */
	function attachZoom(box, wrap, { onEnd, min = () => 1 } = {}) {
		let z = 1, pinch = null, lastTap = 0;
		const lo = () => Math.min(1, min());
		const apply = (nz, cx, cy) => {
			const r = box.getBoundingClientRect();
			const px = (box.scrollLeft + cx - r.left) / z, py = (box.scrollTop + cy - r.top) / z;
			z = Math.min(6, Math.max(lo(), nz));
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
			if (now - lastTap < 300 && !String(getSelection?.() ?? "").trim()) { apply(Math.abs(z - 1) > 0.05 ? 1 : 2.5, p.clientX, p.clientY); onEnd?.(z); lastTap = 0; } else lastTap = now;
		});
		box.addEventListener("wheel", (e) => {
			if (!e.ctrlKey && !e.metaKey) return; // 觸控板捏合在 Chrome 是 Ctrl+滾輪
			e.preventDefault();
			apply(z * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
			clearTimeout(attachZoom.t); attachZoom.t = setTimeout(() => onEnd?.(z), 200);
		}, { passive: false });
		return {
			get zoom() { return z; },
			/** 工具列的放大縮小、還原上次的縮放 */
			setZoom(nz) { const r = box.getBoundingClientRect(); apply(nz, r.left + r.width / 2, r.top + r.height / 2); onEnd?.(z); },
			/** 視窗大小變了:最小縮放跟著變,目前比新的最小還小就拉回來 */
			refit() { if (z < lo() - 0.001) this.setZoom(lo()); },
		};
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
			// 縮放 1 = 每頁塞滿視窗寬度;視窗大小變了(分割畫面、全螢幕、拖拉邊界)就重新塞滿
			const fitWidth = () => Math.max(200, n.clientWidth - 16);
			const size = (p, width) => {
				p.css = width / p.w;
				p.box.style.width = `${Math.round(p.w * p.css)}px`;
				p.box.style.height = `${Math.round(p.h * p.css)}px`;
				p.box.style.setProperty("--scale-factor", p.css); // 文字層跟著這個變數縮放
			};
			let width = fitWidth();
			const pages = [];
			for (let i = 1; i <= doc.numPages; i++) {
				const page = await doc.getPage(i);
				const vp = page.getViewport({ scale: 1 });
				// 每頁:畫布(圖) + 透明文字層(可以長按選字、複製)
				const box = el("div", "pdfpage");
				const c = document.createElement("canvas");
				const tl = el("div", "textLayer");
				box.append(c, tl);
				wrap.appendChild(box);
				const p = { page, c, tl, box, w: vp.width, h: vp.height, css: 1, done: 0, visible: false, text: false };
				size(p, width);
				pages.push(p);
			}
			// 最小縮放:最高的那一頁整頁放得進視窗高度(一次至少看得到一整頁)
			const minZoom = () => {
				const tallest = Math.max(...pages.map((p) => p.h * p.css));
				const room = n.clientHeight - 16;
				return tallest > 0 && room > 0 ? room / tallest : 1;
			};
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
			t.pdfPages = pages;
			t.zoomer = attachZoom(n, wrap, { min: minZoom, onEnd: (z) => { zoom = z; t.pos = { ...(t.pos || {}), zoom: z }; saveSoon(1500); for (const p of pages) if (p.visible) render(p); } });
			applyPos(t);
			pdfPageLabel(t);
			// 視窗大小變了:頁寬重新塞滿視窗,停在原本看的那一頁、頁內同一個位置
			const relayout = () => {
				if (!n.isConnected || !n.clientWidth) return; // 被關掉或藏起來(同一欄切到別的分頁)
				const w = fitWidth();
				// 用捲動時記下的「第幾頁、頁內位置」:分割畫面會搬動元素,瀏覽器搬動時已經把捲動位置歸零了
				const at = t.pos?.page != null ? { page: t.pos.page, frac: t.pos.frac || 0 } : pdfWhere(t);
				t.restoring = true; // 改頁面大小時捲動會亂跳,先不要記位置
				if (Math.abs(w - width) >= 1) {
					width = w;
					for (const p of pages) size(p, w);
					for (const p of pages) if (p.visible) render(p);
				}
				t.zoomer.refit();
				const r = at && pdfPageRect(t, at.page);
				if (r) n.scrollTop = r.top + r.height * at.frac;
				requestAnimationFrame(() => { t.restoring = false; });
			};
			let timer = 0;
			const ro = new ResizeObserver(() => {
				if (!n.isConnected) return ro.disconnect();
				clearTimeout(timer);
				timer = setTimeout(relayout, 80);
			});
			ro.observe(n);
		} catch (e) {
			wrap.innerHTML = `<div class="empty" style="padding:20px">PDF 顯示失敗:${esc(e.message || String(e))}</div>`;
		}
	}
	/** 每一頁在捲動區裡的實際位置(含縮放) */
	function pdfPageRect(t, i) {
		const pv = t.pv, b = t.pdfPages?.[i]?.box;
		if (!pv || !b) return null;
		const r = b.getBoundingClientRect(), pr = pv.getBoundingClientRect();
		return { top: r.top - pr.top + pv.scrollTop, height: r.height };
	}
	/** 目前畫面頂端在第幾頁、頁內幾成的位置 */
	function pdfWhere(t) {
		const pages = t.pdfPages, pv = t.pv;
		if (!pages?.length || !pv) return null;
		for (let i = 0; i < pages.length; i++) {
			const r = pdfPageRect(t, i);
			if (r && r.top + r.height > pv.scrollTop) return { page: i, frac: Math.max(0, Math.min(1, (pv.scrollTop - r.top) / r.height)) };
		}
		return { page: pages.length - 1, frac: 0 };
	}
	/** PDF 工具列的「第 x / N 頁」:跟記住的位置用同一個基準(畫面頂端) */
	function pdfPageLabel(t) {
		const pages = t.pdfPages;
		if (!pages?.length || !t.pv) return;
		const at = pdfWhere(t);
		t.page = (at?.page ?? 0) + 1;
		const lab = t.group.barEl?.querySelector(".pdf-page");
		if (lab && t.group.active === t) lab.textContent = `第 ${t.page} / ${pages.length} 頁`;
	}
	function surface(g, which) {
		for (const k of ["editorEl", "diffEl", "previewEl", "emptyEl"]) g[k].hidden = k !== which;
	}
	function bar(g, html) { g.barEl.hidden = !html; g.barEl.innerHTML = html || ""; }
	function activate(g, t) {
		if (g.active && g.active !== t && g.active.kind === "file" && !g.active.conflict && g.editor) g.active.viewState = g.editor.saveViewState();
		if (g.active && g.active !== t && g.active.kind === "diff" && g.diff) g.active.viewState = g.diff.saveViewState();
		g.active = t;
		if (g === cm.activeGroup) notifyCurrent();
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
				if (isTex(t.path) && !t.truncated && !t.readonly && cm.plugins.latex) texBar(g, t);
				else bar(g, t.truncated ? `<span>大檔(${fmtSize(t.size)})唯讀:只顯示開頭和結尾各 ${t.truncated.shown} 行,共 ${t.truncated.total} 行</span><span class="sp"></span><button class="small" data-bar="more">多載入 2000 行</button><button class="small" data-bar="term">在終端機開啟</button>` : t.readonly ? "<span>唯讀</span>" : isMd(t.path) ? `<span class="sp"></span><button class="small" data-bar="mdprev">${mobile() ? "預覽" : "在旁邊預覽"}</button>` : "");
				if (t.viewState) g.editor.restoreViewState(t.viewState);
				// 手機:切分頁不自動聚焦編輯器(會跳鍵盤、iOS 還會放大);要打字點一下內容就好
				if (!mobile() && !matchMedia("(pointer: coarse)").matches) g.editor.focus();
			}
		} else if (t.kind === "diff") {
			surface(g, "diffEl");
			g.editor.setModel(null);
			g.diff.updateOptions({ readOnly: true });
			g.diff.setModel({ original: t.orig, modified: t.mod });
			if (t.viewState) g.diff.restoreViewState(t.viewState);
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
		} else if (t.kind === "wtmap") {
			surface(g, "previewEl");
			const fresh = !t.pv || t.pv.parentNode !== g.previewEl;
			pvNode(g, t);
			if (fresh) wireWtMap(t);
			showPv(g, t);
			renderWtMap(t);
			bar(g, `<span>分支圖:${esc(cm.wts?.repoName || "")} 的 worktree 與 agent 留下的分支</span>`);
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
			if (t.kind === "office") officeBar(g, t);
			else if (t.kind === "pdf") bar(g, `<span class="pdf-page">${t.pdfPages ? `第 ${t.page || 1} / ${t.pdfPages.length} 頁` : "PDF"}</span><span class="sp"></span><button class="small" data-bar="zoomout" title="縮小">−</button><button class="small" data-bar="zoomin" title="放大">＋</button>${touch() ? '<button class="small" data-bar="fullview">全螢幕</button>' : ""}<button class="small" data-bar="openraw" title="在瀏覽器的新分頁用內建檢視器打開(可以搜尋文字)">用瀏覽器開啟</button>`);
			else bar(g, (t.kind === "pdf" || t.kind === "image") && touch() ? '<span>雙指縮放、點兩下放大/還原</span><span class="sp"></span><button class="small" data-bar="fullview">全螢幕</button>' : "");
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
		if (a === "zoomin" || a === "zoomout") return t.zoomer?.setZoom((t.zoomer.zoom || 1) * (a === "zoomin" ? 1.25 : 0.8));
		if (a === "openraw") return window.open(`/api/code/${cp()}/raw?path=${encodeURIComponent(t.path)}`, "_blank", "noopener");
		if (a === "officeedit") return officeEdit(t);
		if (a === "texbuild") return texBuild(t);
		if (a === "texissues") return texIssues(t);
		if (a === "officehist") return officeHistory(t);
	}
	async function openFile(rel, g = cm.activeGroup, { quiet = false, view = null, raw = false, pos = null } = {}) {
		// .ipynb 跟 VS Code 一樣預設顯示成 Notebook;要改 JSON 用「編輯原始 JSON」
		if (isNb(rel) && !raw) return openNotebook(rel, g, { quiet, pos });
		await loadMonaco().catch(fail);
		if (!cm.monaco) return;
		ensureLayout();
		g = g || allGroups()[0];
		const key = `file:${rel}`;
		const existing = findTab(key);
		if (existing) { setActiveGroup(existing.group); return activate(existing.group, existing); }
		try {
			const f = await api(`file?path=${encodeURIComponent(rel)}`);
			const t = { key, group: g, kind: f.kind === "text" ? "file" : f.kind === "image" || f.kind === "pdf" || f.kind === "office" ? f.kind : "info", path: rel, label: baseName(rel), title: rel, size: f.size };
			if (t.kind === "office") { t.app = f.app; t.hash = f.hash; }
			if (t.kind === "pdf") t.hash = f.hash;
			if (pos && t.kind !== "file") t.pos = pos;
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
	async function openPreview(rel, target = null, { quiet = false, pos = null } = {}) {
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
		const t = { key, group: g, kind: "md", path: rel, label: `預覽 ${baseName(rel)}`, title: `${rel}(預覽)`, text, ...(pos ? { pos } : {}) };
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
		const restoreTo = t.pos?.top ?? scroll;
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
			if (relative(u)) img.src = `/api/code/${cp()}/raw?path=${encodeURIComponent(resolve(decodeURI(u.split(/[?#]/)[0])))}`;
		}
		for (const a of box.querySelectorAll("a[href]")) {
			const u = a.getAttribute("href");
			if (relative(u)) {
				a.addEventListener("click", (e) => { e.preventDefault(); openFile(resolve(decodeURI(u.split("#")[0])), t.group); });
			} else if (!u.startsWith("#")) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
		}
		// 圖片載入會改變高度:先捲一次,圖片都載好再捲一次
		t.restoring = true; box.scrollTop = restoreTo;
		Promise.all([...box.querySelectorAll("img")].map((im) => (im.complete ? 0 : new Promise((ok) => { im.onload = im.onerror = ok; })))).then(() => { box.scrollTop = t.pos?.top ?? restoreTo; t.restoring = false; });
	}
	// ---------- Jupyter Notebook(.ipynb):顯示、編輯、用 kernel 執行 ----------
	async function openNotebook(rel, g = cm.activeGroup, { quiet = false, pos = null } = {}) {
		await loadMonaco().catch(fail);
		if (!cm.monaco) return;
		ensureLayout();
		g = g || allGroups()[0];
		const key = `nb:${rel}`;
		const existing = findTab(key);
		if (existing) { setActiveGroup(existing.group); return activate(existing.group, existing); }
		const t = { key, group: g, kind: "nb", path: rel, label: baseName(rel), title: `${rel}(Notebook)`, kstate: "off", runs: new Map(), ...(pos ? { pos } : {}) };
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
				const r = await fetch(`/api/code/${cp()}/raw?path=${encodeURIComponent(t.path)}`).catch(() => null);
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
		if (cm.plugins.notebook) { nbConnect(t); nbLoadPythons(t); }
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
		box.scrollTop = t.pos?.top ?? scroll;
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
				img.src = `/api/code/${cp()}/raw?path=${encodeURIComponent(outp.join("/"))}`;
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
		const es = new EventSource(`/api/code/${cp()}/nb/events?path=${encodeURIComponent(t.path)}`);
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
		if (!cm.plugins.notebook) {
			bar.innerHTML = `<span class="hint">要在網頁上執行 Notebook,請到 設定 → 外掛 開啟「Notebook 執行」(可以照常檢視與編輯)</span><span class="sp"></span><button class="small ${t.dirty ? "primary" : ""}" data-nb="save" ${t.readonly ? "disabled" : ""}>${t.dirty ? "● 存檔" : "存檔"}</button>`;
			bar.onclick = (e) => { if (e.target.closest("[data-nb=save]")) saveNb(t); };
			return;
		}
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
		if (!cm.plugins.notebook) return toast("要執行 Notebook,請到 設定 → 外掛 開啟「Notebook 執行」");
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
		if (!t.nb || t.readonly) return false;
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
			return true;
		} catch (e) {
			if (e.status === 409) {
				if (await confirmBox("檔案在外面被改過", "這個 notebook 在你開啟之後被別的程式改過了。要用網頁上的版本覆蓋嗎?(取消就保留磁碟上的版本,你可以按「重新載入」看最新內容)", "用網頁的版本覆蓋")) return saveNb(t, true);
			} else fail(e);
			return false;
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
		return saveTab(g?.active, force);
	}
	/** 存一個分頁(不一定是目前顯示的);成功回傳 true,磁碟被改過(衝突)或失敗回傳 false */
	async function saveTab(t, force = false) {
		if (t?.kind === "nb") return saveNb(t, force);
		if (!t || t.kind !== "file" || t.readonly || !t.model) return false;
		const g = t.group;
		try {
			const r = await api("file", { method: "PUT", body: JSON.stringify({ path: t.path, content: t.model.getValue(), baseHash: t.hash, force }) });
			t.hash = r.hash;
			if (t.conflict) { if (g.active === t) g.diff.setModel(null); t.conflict.model.dispose(); t.conflict = null; }
			t.savedVersion = t.model.getAlternativeVersionId(); t.dirty = false;
			if (g.active === t) activate(g, t); else renderTabs(g);
			renderProjSelect();
			toast("已存檔");
			cm.dirs = {}; renderFiles(); refreshGit();
			if (isTex(t.path) && texAuto()) texBuild(t);
			return true;
		} catch (e) {
			if (e.status === 409 && e.data?.disk) {
				// 檔案在外面被改過:切到這個分頁顯示左右對照,讓使用者決定
				t.conflict = { content: e.data.disk.content, hash: e.data.disk.hash, model: cm.monaco.editor.createModel(e.data.disk.content, langOf(t.path)) };
				setActiveGroup(g);
				activate(g, t);
			} else fail(e);
			return false;
		}
	}
	function closeTab(t, force = false) {
		if (!t) return;
		if (t.dirty && !force) {
			const canSave = !t.readonly && (t.kind === "nb" ? !!t.nb : !!t.model);
			const d = dialog({
				title: "還沒存檔",
				html: `<p>「${esc(t.label)}」有還沒存的修改。</p>`,
				buttons: [
					{ label: "取消" },
					{ label: "不存直接關閉", onClick: () => closeTab(t, true) },
					...(canSave ? [{ label: "存檔並關閉", primary: true, onClick: async () => { if (await saveTab(t)) closeTab(t, true); } }] : []),
				],
			});
			// Enter = 存檔並關閉(沒辦法存就是「不存直接關閉」)
			setTimeout(() => d.querySelector(".mfoot .primary, .mfoot button:last-child")?.focus(), 40);
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
		notifyCurrent();
		saveSoon();
	}
	// 沒修改的分頁:磁碟上的檔案被改了就自動重新載入(agent 改檔時畫面跟著更新)
	setInterval(async () => {
		if (!document.body.classList.contains("code") || document.hidden || !cm.pid) return;
		// PDF:重新產生了(LaTeX 編譯、agent 輸出)就刷新
		const pdfs = allTabs().filter((x) => x.kind === "pdf" && x.hash);
		if (pdfs.length) {
			const st = await api("stamps", { method: "POST", body: JSON.stringify({ paths: [...new Set(pdfs.map((x) => x.path))] }) }).catch(() => null);
			for (const x of pdfs) { const h = st?.[x.path]?.hash; if (h && h !== x.hash) { x.hash = h; texReloadPdf(x); } }
		}
		// Office 檔:被 Office 存檔或 agent 改了就重畫預覽;目前看的那個順便更新「正在 Office 編輯中」
		const offs = allTabs().filter((x) => x.kind === "office" && x.hash);
		for (const t of offs) if (t.group.active === t) officeInfo(t);
		if (offs.length) {
			const st = await api("stamps", { method: "POST", body: JSON.stringify({ paths: [...new Set(offs.map((x) => x.path))] }) }).catch(() => null);
			for (const t of offs) {
				const h = st?.[t.path]?.hash;
				if (h && h !== t.hash) { t.hash = h; if (t.pv) buildOffice(t, t.pv, `/api/code/${cp()}/raw?path=${encodeURIComponent(t.path)}`); }
			}
		}
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
			cm.stash.set(viewKey(), { cols: cm.cols, activeGroup: cm.activeGroup, expanded: cm.expanded, wt: cm.wt });
		} else {
			for (const g of allGroups()) {
				g.diff?.setModel(null); g.editor?.setModel(null);
				for (const t of g.tabs) { t.model?.dispose(); t.orig?.dispose(); t.mod?.dispose(); t.conflict?.model.dispose(); t.sub?.dispose(); }
				disposeGroup(g);
			}
		}
		cm.cols = []; cm.activeGroup = null;
		notifyCurrent();
	}
	async function pickProject(id) {
		return switchView(id, null);
	}
	/** 換專案或進出 worktree 檢視(wt = 分支總覽列表裡的那一筆;null = 主資料夾) */
	async function switchView(id, wt) {
		if (cm.pid === id && (cm.wt?.id ?? null) === (wt?.id ?? null)) return true;
		await saveNow();
		cm.restoring = true;
		try {
			putAway();
			if (cm.pid !== id) cm.wts = null;
			cm.pid = id;
			cm.wt = wt ? { id: wt.id, branch: wt.branch, source: wt.source, path: wt.path } : null;
			cm.dirs = {}; cm.expanded = new Set([""]); cm.git = null; cm.gitMain = null; cm.gitRepo = null; cm.history = null; cm.openCommit = null;
			const kept = cm.stash.get(viewKey());
			if (kept) {
				// 之前切走時還有沒存的修改:原封不動放回來
				cm.stash.delete(viewKey());
				cm.cols = kept.cols; cm.activeGroup = kept.activeGroup; cm.expanded = kept.expanded;
				layout();
			} else {
				ensureLayout(); layout();
				// 版面記錄只存主資料夾的;worktree 從空的開始
				const saved = id && !cm.wt ? await api("session").catch(() => null) : null;
				if (saved?.layout) await restore(saved.layout);
			}
			renderProjSelect();
			refresh();
		} finally { cm.restoring = false; notifyCurrent(); }
		window.renderDrawer?.();
		// 記下「最後用的是這個專案」(換電腦時打開這個)
		lastSaved = "";
		saveSoon(300);
		return true;
	}

	// ---------- 記住開了什麼(存在伺服器,換專案/換電腦都能還原) ----------
	function tabSpec(t) {
		if (t.kind === "diff") {
			const vs = t.group.active === t && t.group.diff ? t.group.diff.saveViewState() : t.viewState;
			return { kind: "diff", path: t.path, which: t.which, commit: t.commit, repo: t.repo || undefined, ...(vs ? { view: vs } : {}) };
		}
		const pos = t.pos ? { pos: t.pos } : {};
		if (t.kind === "md") return { kind: "md", path: t.path, ...pos };
		if (t.kind === "nb") return { kind: "nb", path: t.path, ...pos };
		if (t.kind !== "file") return { kind: "file", path: t.path, ...pos }; // 圖片、PDF、Office:重開時 openFile 會判斷類型
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
		if (cm.restoring || !cm.pid || cm.wt) return;
		// 已經排了更早的存檔就不往後延(游標一直動也不會一直拖)
		if (saveTimer && saveDue <= Date.now() + ms) return;
		clearTimeout(saveTimer);
		saveDue = Date.now() + ms;
		saveTimer = setTimeout(() => saveNow(), ms);
	}
	async function saveNow({ keepalive = false } = {}) {
		clearTimeout(saveTimer); saveTimer = null; saveDue = 0;
		if (cm.restoring || !cm.pid || cm.wt || !cm.cols.length) return;
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
				if (ts.kind === "diff") await openDiff(ts.path, ts.which, ts.commit, g, { quiet: true, view: ts.view || null, repo: ts.repo || null });
				else if (ts.kind === "md") await openPreview(ts.path, g, { quiet: true, pos: ts.pos });
				else if (ts.kind === "nb") await openNotebook(ts.path, g, { quiet: true, pos: ts.pos });
				else await openFile(ts.path, g, { quiet: true, view: ts.view || null, raw: true, pos: ts.pos });
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
	const hasUnsaved = (id) => (id === cm.pid && allTabs().some((t) => t.dirty)) || [...cm.stash.keys()].some((k) => k.split("@")[0] === id);
	function renderProjSelect() {
		// 只顯示目前專案;換專案用左上角標題(或點這裡)滑出的專案清單
		const p = state.projects.find((x) => x.id === cm.pid);
		const others = [...new Set([...cm.stash.keys()].map((k) => k.split("@")[0]))].filter((id) => id !== cm.pid).map((id) => state.projects.find((x) => x.id === id)?.name).filter(Boolean);
		const wtPill = cm.wt ? `<span class="wtpill" title="${esc(cm.wt.path)}"><span class="b">⑂ 正在看 worktree:${esc(cm.wt.branch || "(沒有分支)")}</span><button class="small" data-wtexit title="回到專案的主資料夾">回主資料夾</button></span>` : "";
		$("cvProject").innerHTML = `<span class="nm">${hasUnsaved(cm.pid) ? "● " : ""}${esc(p?.name ?? "(沒有專案)")}</span>${wtPill}${others.length ? `<span class="hint" title="${esc(others.join("、"))}">另有 ${others.length} 個專案沒存</span>` : ""}`;
		document.body.classList.toggle("inwt", !!cm.wt);
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
			x.open("PUT", `/api/code/${cp()}/upload?path=${encodeURIComponent(path)}&overwrite=${overwrite ? 1 : 0}`);
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

	// ---------- 分支(worktree)總覽:在 git 面板最上面 ----------
	const WT_SRC = { claude: "Claude Code", steward: "管家支線", manual: "手動", main: "主資料夾" };
	const agentName = (a) => ({ claude: "Claude", pi: "pi", codex: "Codex" })[a] || a;
	function wtRow(x) {
		const viewing = (cm.wt?.id ?? null) === (x.source === "main" ? null : x.id);
		if (x.source === "main") {
			return `<div class="wt-row main${viewing ? " cur" : ""}" data-wtid="${x.id}"><div class="l1"><span class="src">主資料夾</span><b>${esc(x.branch || "(detached)")}</b>${viewing ? '<span class="hint">正在看</span>' : ""}</div>
				${viewing ? "" : '<div class="acts"><button class="small" data-wa="home">回主資料夾</button></div>'}</div>`;
		}
		const s = x.session;
		const who = s ? `${esc(agentName(s.agent))} · ${s.alive ? `窗格 ${esc(s.pane?.paneId || "")}(開著)` : "窗格已關閉"}` : "開它的 session 不明(手動開的或紀錄已不在)";
		const bits = [
			x.ahead || x.behind ? `↑${x.ahead} ↓${x.behind}` : "和主線一樣",
			x.dirty ? `${x.dirty} 個沒 commit` : "",
			x.changed ? `改到這裡 ${x.changed} 個檔` : "",
			x.lastModified ? ago(x.lastModified) : "",
			x.locked ? "🔒 鎖住" : "",
			x.exists ? "" : "⚠ 資料夾不在",
		].filter(Boolean).join(" · ");
		return `<div class="wt-row${viewing ? " cur" : ""}" data-wtid="${x.id}" title="${esc(x.path)}">
			<div class="l1"><span class="src src-${x.source}">${WT_SRC[x.source]}</span><b>${esc(x.branch || "(detached)")}</b>${viewing ? '<span class="hint">正在看</span>' : ""}</div>
			<div class="l2">${who}</div><div class="l2">${bits}</div>
			<div class="acts"><button class="small" data-wa="chat" ${x.exists ? "" : "disabled"}>跟它對話</button><button class="small" data-wa="files" ${x.exists && !viewing ? "" : "disabled"}>看/改檔案</button><button class="small" data-wa="merge" ${x.branch && x.ahead ? "" : "disabled"} title="${x.ahead ? "" : "沒有比主線多的 commit"}">合併回主線</button><button class="small" data-wa="remove">移除</button></div></div>`;
	}
	function leftRow(l) {
		const who = l.session ? `${esc(agentName(l.session.agent))} 開的` : "開它的 session 不明";
		return `<div class="wt-row left" title="${esc(l.branch)}"><div class="l1"><span class="src src-${l.source}">${WT_SRC[l.source]}</span><b>${esc(l.branch)}</b></div>
			<div class="l2">worktree 已移除 · ${l.merged ? `✔ 已合併${l.savedOnRemove ? `(移除時另存了 ${l.savedOnRemove.files.length} 個沒 commit 的檔案)` : ""}` : `還沒合併 · ↑${l.ahead}`} · ${who}${l.lastModified ? ` · ${ago(l.lastModified)}` : ""}</div></div>`;
	}
	/** 資料夾樹:repo → 子專案資料夾 → worktree(可操作)/ 留下的分支(只顯示)。目前的子專案預設展開;不屬於任何子專案的直接掛在 repo 底下 */
	function folderTree(t) {
		const under = (path) => [...t.items.filter((x) => x.source !== "main" && x.folder === path).map(wtRow), ...t.leftovers.filter((x) => x.folder === path).map(leftRow)];
		const rows = t.folders.map((f) => {
			const items = t.items.filter((x) => x.source !== "main" && x.folder === f.path);
			const lefts = t.leftovers.filter((x) => x.folder === f.path);
			const n = items.length + lefts.filter((x) => !x.merged).length;
			const stored = gitFold(`wtf:${t.repoRoot}:${f.path}`);
			const folded = stored ?? !f.current;
			const kids = folded ? "" : `<div class="wt-kids">${under(f.path).join("") || '<div class="hint wt-none">沒有分支</div>'}</div>`;
			return `<div class="wt-folder${f.current ? " cur" : ""}"><div class="wt-fh" data-wtfold="${esc(f.path)}"><span class="tw">${folded ? "▸" : "▾"}</span>📂 ${esc(f.name)}${f.current ? '<span class="hint">目前</span>' : ""}${n ? `<span class="wtb">⑂${n}</span>` : ""}</div>${kids}</div>`;
		}).join("");
		const direct = under("");
		const main = t.items.find((x) => x.source === "main");
		const empty = !rows && !direct.length ? '<div class="hint wt-none" style="margin-left:14px">沒有另外開的分支</div>' : "";
		return `<div class="wt-tree"><div class="wt-repo">🗂 ${esc(t.repoName)}<span class="hint">主線 ${esc(t.target || "(detached)")}</span>${cm.wt && main ? '<button class="small" data-wa="home">回主資料夾</button>' : ""}</div>${rows}${direct.length ? `<div class="wt-kids wt-direct">${direct.join("")}</div>` : ""}${empty}</div>`;
	}
	function wtWarn(t) {
		if (t.warnings.gitlinks.length) return `<div class="wt-warn">⚠ 這些 worktree 已經被誤 commit 成子專案,之後的 commit 會一直卡住:${t.warnings.gitlinks.map(esc).join("、")}<div class="acts"><button class="small" data-wfix="untrack">從版本控制移除</button></div></div>`;
		if (t.warnings.unignored.length) return `<div class="wt-warn">⚠ ${t.warnings.unignored.length} 個 worktree 放在 repo 裡、沒被 .gitignore 排除,一次「全部加入」就會被誤 commit。<div class="acts"><button class="small" data-wfix="ignore">加入 .gitignore</button></div></div>`;
		return "";
	}
	function wtSection() {
		const w = cm.wts;
		if (!w) return '<div class="hint" style="padding:6px 14px">分支(worktree)讀取中…</div>';
		if (w.error || !w.repo) return w.error ? `<div class="hint" style="padding:6px 14px">分支總覽讀不到:${esc(w.error)}</div>` : "";
		const total = w.items.filter((x) => x.source !== "main").length + w.leftovers.filter((x) => !x.merged).length;
		return sec("wt", "分支(worktree)", total, '<button data-wa="map" title="在編輯區開「分支圖」:資料夾樹和分岔圖">開大圖</button><button data-wa="reload" title="重新整理">⟳</button>', wtWarn(w) + folderTree(w));
	}

	// ---------- 分支圖分頁(編輯區):資料夾樹 / 分岔圖 ----------
	const SRC_COLOR = { claude: "#d9773a", steward: "var(--accent)", manual: "var(--ok)" };
	function openWtMap() {
		ensureLayout();
		const existing = findTab("wtmap");
		if (existing) { setActiveGroup(existing.group); return activate(existing.group, existing); }
		const g = cm.activeGroup || allGroups()[0];
		const t = { key: "wtmap", group: g, kind: "wtmap", label: "分支圖", title: "分支圖:資料夾樹 / 分岔圖", mode: "graph", sel: null };
		g.tabs.push(t);
		setActiveGroup(g);
		activate(g, t);
	}
	/** 分岔圖(SVG):主線一條線,關鍵 commit 依序排開;每條分支一列,從分岔點長出來,有合併就畫回主線 */
	function graphSvg(t, sel) {
		const g = t.graph;
		if (!g.nodes.length) return '<div class="hint" style="padding:12px">沒有分支可以畫</div>';
		const X0 = 130, DX = 190, MAINY = 50, ROW = 58, LX = 16;
		const xs = [];
		let x = X0;
		g.nodes.forEach((n, i) => { if (i > 0) x += n.gapBefore ? DX + 40 : DX; xs.push(x); });
		const brs = [...g.branches].sort((a, b) => a.forkAt - b.forkAt || (a.branch || "").localeCompare(b.branch || ""));
		const W = Math.max(x + 360, 600), H = MAINY + (brs.length + 1) * ROW;
		const info = (b) => b.key.startsWith("branch:") ? t.leftovers.find((l) => `branch:${l.branch}` === b.key) : t.items.find((i) => i.id === b.key);
		// 一打開要捲到哪:最早一條還沒合併的分支的分岔點(沒有就最新的 commit)
		const open = brs.filter((b) => b.mergedAt === undefined).map((b) => xs[b.forkAt]);
		const focusX = Math.max(0, (open.length ? Math.min(...open) : xs[xs.length - 1]) - 60);
		let svg = `<svg class="wt-graph" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" data-focus-x="${focusX}">`;
		// 先畫分支(在下層),再畫主線、commit 點和文字(文字有描邊,線從後面穿過也看得清楚)
		let brSvg = "";
		// 主線與省略段
		let mainSvg = `<line x1="${LX}" y1="${MAINY}" x2="${xs[xs.length - 1] + 30}" y2="${MAINY}" class="gl-main"/>`;
		g.nodes.forEach((n, i) => {
			if (n.gapBefore) {
				const gx = i ? (xs[i - 1] + xs[i]) / 2 : (LX + X0) / 2;
				mainSvg += `<text x="${gx}" y="${MAINY - 8}" class="gl-gap" text-anchor="middle">⋯ ${n.gapBefore} 個 commit</text>`;
			}
			mainSvg += `<g><title>${esc(n.short)} ${esc(n.subject)}\n${esc(n.date)}</title><circle cx="${xs[i]}" cy="${MAINY}" r="6" class="gl-node"/>
				<text x="${xs[i]}" y="${MAINY + 22}" class="gl-c" text-anchor="middle">${esc(n.short)}</text>
				<text x="${xs[i]}" y="${MAINY + 36}" class="gl-s" text-anchor="middle">${esc(n.subject.length > 22 ? n.subject.slice(0, 21) + "…" : n.subject)}</text></g>`;
		});
		mainSvg += `<text x="${LX}" y="${MAINY - 26}" class="gl-label">${esc(t.target || "")}</text>`;
		brs.forEach((b, i) => {
			const y = MAINY + (i + 1) * ROW + 16;
			const it = info(b);
			const src = it?.source || "manual";
			const col = SRC_COLOR[src] || "var(--muted)";
			const fx = xs[b.forkAt];
			const merged = b.mergedAt !== undefined;
			const ex = merged ? xs[b.mergedAt] - 26 : Math.max(fx + 120, xs[xs.length - 1] + 70);
			const on = sel === b.key ? " on" : "";
			const who = it?.session ? agentName(it.session.agent) + (it.session.alive ? `·${it.session.pane?.paneId || ""}` : "") : "";
			const saved = b.savedOnRemove ? `(另存 ${b.savedOnRemove.files.length} 個檔)` : "";
			const tag = it && !("id" in it) ? (merged ? `✔ 已合併${saved} · worktree 已移除` : "worktree 已移除") : merged ? `✔ 已合併${saved}` : "";
			brSvg += `<g class="gl-br${on}" data-gkey="${esc(b.key)}" style="color:${col}">
				<path d="M${fx} ${MAINY} C ${fx} ${y}, ${fx} ${y}, ${fx + 24} ${y} L ${ex} ${y}${merged ? ` C ${ex + 26} ${y}, ${ex + 26} ${y}, ${ex + 26} ${MAINY}` : ""}" class="gl-path${merged ? " merged" : ""}"/>
				${merged ? "" : `<circle cx="${ex}" cy="${y}" r="6" class="gl-tip"/>`}
				<text x="${fx + 30}" y="${y - 8}" class="gl-b">${esc(b.branch || "(detached)")}</text>
				<text x="${fx + 30}" y="${y + 16}" class="gl-s">↑${b.ahead} commit${who ? ` · ${esc(who)}` : ""}${tag ? ` · ${tag}` : ""}</text>
				<rect x="${fx}" y="${y - 24}" width="${Math.max(ex - fx + 30, 220)}" height="48" class="gl-hit"/></g>`;
		});
		svg += brSvg + mainSvg;
		return svg + "</svg>";
	}
	function renderWtMap(tab) {
		const pv = tab?.pv;
		if (!pv) return;
		const t = cm.wts;
		if (!t || t.error || !t.repo) { pv.innerHTML = `<div class="hint" style="padding:16px">${esc(t?.error || "這個專案不是 git repo")}</div>`; return; }
		const head = `<div class="wt-maphead"><b>🗂 ${esc(t.repoName)}</b><span class="hint">主線 ${esc(t.target || "(detached)")}</span><span class="sp"></span>
			<div class="seg"><button class="small${tab.mode === "tree" ? " on" : ""}" data-mapmode="tree">資料夾樹</button><button class="small${tab.mode === "graph" ? " on" : ""}" data-mapmode="graph">分岔圖</button></div><button class="small" data-wa="reload">⟳</button></div>`;
		let body;
		if (tab.mode === "tree") body = wtWarn(t) + folderTree(t);
		else {
			const b = tab.sel ? t.graph.branches.find((x) => x.key === tab.sel) : null;
			const it = b ? (b.key.startsWith("branch:") ? t.leftovers.find((l) => `branch:${l.branch}` === b.key) : t.items.find((i) => i.id === b.key)) : null;
			const detail = it ? `<div class="wt-detail">${"id" in it ? wtRow(it) : leftRow(it)}</div>` : '<div class="hint wt-detail">點一條分支看詳細資料和操作(跟它對話、看/改檔案、合併、移除)</div>';
			body = `${wtWarn(t)}<div class="wt-graphwrap">${graphSvg(t, tab.sel)}</div>${detail}${t.graph.truncated ? '<div class="hint" style="padding:4px 16px">主線太長,只畫最近 5000 個 commit</div>' : ""}`;
		}
		const sx = pv.querySelector(".wt-graphwrap")?.scrollLeft;
		pv.innerHTML = head + `<div class="wt-mapbody">${body}</div>`;
		const wrap = pv.querySelector(".wt-graphwrap");
		// 第一次打開捲到最右邊(最新的 commit 和還沒合併的分支);之後保留使用者捲到的位置
		if (wrap) wrap.scrollLeft = sx ?? Number(wrap.querySelector("svg")?.dataset.focusX || 0);
	}
	const wtMapTab = () => findTab("wtmap");
	function toggleWtFold(path) {
		const t = cm.wts;
		const k = `wtf:${t.repoRoot}:${path}`;
		const cur = gitFold(k) ?? !t.folders.find((f) => f.path === path)?.current;
		setGitFold(k, !cur);
	}
	function wireWtMap(tab) {
		tab.pv.addEventListener("click", (e) => {
			const mode = e.target.closest("[data-mapmode]")?.dataset.mapmode;
			if (mode) { tab.mode = mode; return renderWtMap(tab); }
			const wa = e.target.closest("[data-wa]")?.dataset.wa;
			if (wa) return wtAct(wa, e.target.closest("[data-wtid]")?.dataset.wtid);
			const wfix = e.target.closest("[data-wfix]")?.dataset.wfix;
			if (wfix) return wtFix(wfix);
			const wf = e.target.closest("[data-wtfold]");
			if (wf) { toggleWtFold(wf.dataset.wtfold); renderWtMap(tab); if (cm.view === "git") renderGit(); return; }
			const gk = e.target.closest("[data-gkey]")?.dataset.gkey;
			if (gk) { tab.sel = tab.sel === gk ? null : gk; renderWtMap(tab); }
		});
	}
	const wtById = (id) => cm.wts?.items?.find((x) => x.id === id);
	/** 讀分支樹狀資料;回來時已經換專案就丟掉,回傳有沒有更新 */
	async function loadWts() {
		const pid = cm.pid;
		const t = await wtApi("tree").catch((e) => ({ error: e.message }));
		if (cm.pid !== pid) return false;
		cm.wts = t;
		const mt = wtMapTab();
		if (mt?.pv) renderWtMap(mt);
		return true;
	}
	async function wtChat(x) {
		try {
			const r = await wtApi(`${x.id}/chat`, { method: "POST", body: "{}" });
			toast(r.kind === "focus" ? `已跳到 ${r.paneId}` : r.kind === "resume" ? `已在新 tab「${r.label}」接回原本的對話` : `已在 worktree 裡開新的 ${agentName(r.agent)}(找不到原本的對話)`);
			if (r.note) toast(r.note);
			setMode("term");
		} catch (e) { fail(e); }
	}
	async function wtMerge(x) {
		let pv;
		try { pv = await wtApi(`${x.id}/merge`); } catch (e) { return fail(e); }
		const html = `<p>把 <b>${esc(pv.branch)}</b> 合併進主資料夾的 <b>${esc(pv.target)}</b>(一般合併,會多一個合併 commit,分支保留)。</p>
			${pv.blocker ? `<p class="wt-warn">${esc(pv.blocker)}</p>` : ""}
			${pv.uncommitted ? `<p class="hint">worktree 裡還有 ${pv.uncommitted} 個沒 commit 的改動,不會一起合併。</p>` : ""}
			<p class="hint">${pv.commits.length} 個 commit:</p><ul class="wt-list">${pv.commits.map((c) => `<li><code>${esc(c.hash)}</code> ${esc(c.subject)}</li>`).join("")}</ul>
			<p class="hint">${pv.files.length} 個檔案:</p><ul class="wt-list">${pv.files.map((f) => `<li><span class="g g-${esc(f.status[0])}">${esc(f.status[0])}</span> ${esc(f.path)}</li>`).join("")}</ul>
			<details><summary>看完整 diff</summary><pre class="wt-diff">${esc(pv.diff.slice(0, 120_000))}</pre></details>`;
		dialog({ title: "合併回主線", html, buttons: pv.blocker ? [] : [{ label: `合併到 ${pv.target}`, primary: true, onClick: async () => {
			const r = await wtApi(`${x.id}/merge`, { method: "POST", body: "{}" });
			await afterWtChange();
			dialog({ title: "已合併", html: `<p>已把 ${esc(r.branch)} 合併到 ${esc(r.target)}(commit ${esc(r.commit)})。</p><label class="field"><span><input type="checkbox" data-rm> 也移除這個 worktree(分支保留)</span></label>`, buttons: [{ label: "完成", primary: true, onClick: async (w) => { if (w.querySelector("[data-rm]").checked) await wtRemove(x, { asked: true }); } }] });
		} }] });
	}
	async function wtRemove(x, { asked = false } = {}) {
		if (!asked && !(await confirmBox("移除 worktree", `移除「${x.branch || x.path}」的資料夾?分支會保留,之後還能合併或重新開。`, "移除"))) return;
		const confirm = {};
		for (;;) {
			try {
				await wtApi(`${x.id}/remove`, { method: "POST", body: JSON.stringify({ confirm }) });
				break;
			} catch (e) {
				const code = e.data?.code;
				if (e.status === 409 && code === "dirty" && !confirm.dirty) {
					// 沒 commit 的改動:列出檔案,讓使用者選捨棄或存進分支(已合併的分支建議捨棄)
					const d = e.data.detail || {};
					const files = (d.files || []).map((f) => `<li>${esc(f)}</li>`).join("") + (d.total > (d.files || []).length ? `<li>…共 ${d.total} 個</li>` : "");
					const choice = await new Promise((resolve) => {
						const btns = [{ label: "捨棄這些改動", primary: d.suggest === "discard", onClick: () => resolve("discard") }];
						if (d.canCommit !== false) btns.push({ label: "存進分支再移除", primary: d.suggest !== "discard", onClick: () => resolve("commit") });
						const w = dialog({ title: "還有沒 commit 的改動", html: `<p>${esc(e.message)}</p><ul class="wt-list">${files}</ul>`, buttons: btns });
						w.querySelector("[data-x]").addEventListener("click", () => resolve(null));
					});
					if (!choice) return;
					confirm.dirty = choice;
					continue;
				}
				if (e.status === 409 && ["alive", "locked"].includes(code) && !confirm[code]) {
					if (!(await confirmBox("還要確認一下", e.message, "繼續移除"))) return;
					confirm[code] = true;
					continue;
				}
				return fail(e);
			}
		}
		toast(`已移除 worktree${x.branch ? `(分支 ${x.branch} 保留)` : ""}`);
		if (cm.wt?.id === x.id) await switchView(cm.pid, null);
		await afterWtChange();
	}
	async function afterWtChange() {
		cm.dirs = {};
		await refreshGit();
		renderFiles();
		for (const t of allTabs()) if (t.kind === "file" && !t.dirty) await reloadTab(t);
		window.refreshWtCounts?.();
	}
	async function wtAct(act, id) {
		const x = id ? wtById(id) : null;
		if (act === "reload") { await loadWts(); return renderGit(); }
		if (act === "map") { if (!cm.wts) await loadWts(); return openWtMap(); }
		if (act === "home") return switchView(cm.pid, null);
		if (!x) return;
		if (act === "chat") return wtChat(x);
		if (act === "files") { await switchView(cm.pid, x); setView("files"); return; }
		if (act === "merge") return wtMerge(x);
		if (act === "remove") return wtRemove(x);
	}
	async function wtFix(kind) {
		const msg = kind === "ignore" ? "在 repo 的 .gitignore 加上 worktree 的資料夾(例如 .claude/worktrees/),之後「全部加入」就不會把它們 commit 進去。只改 .gitignore,不會 commit。" : "把被誤 commit 的 worktree 從版本控制拿掉(git rm --cached,資料夾和檔案都不刪),並加進 .gitignore。會放進暫存區,你再到下面 commit 就完成了。";
		if (!(await confirmBox(kind === "ignore" ? "加入 .gitignore" : "從版本控制移除", msg, "好"))) return;
		try {
			const r = await wtApi(kind, { method: "POST", body: "{}" });
			toast(kind === "ignore" ? (r.added.length ? `已在 .gitignore 加上 ${r.added.join("、")}` : ".gitignore 已經有了") : r.note);
		} catch (e) { fail(e); }
		await afterWtChange();
	}

	// ---------- Git ----------
	async function loadFetchPrefs() {
		try {
			const r = await fetch("/api/code-prefs");
			if (!r.ok) return;
			cm.fetchPrefs = await r.json();
			cm.fetchPrefsAt = Date.now();
			if (cm.view === "git") renderGit();
		} catch {}
	}
	async function autoFetchTick(force = false) {
		if (!document.body.classList.contains("code") || document.hidden || (!document.documentElement.classList.contains("inapp") && !document.hasFocus()) || !cm.pid || cm.fetchPrefs?.autoFetch !== "on" || !cm.git?.repo || !cm.git.upstream) return;
		const key = `${cp()}|${cm.gitRepo || ""}`;
		const now = Date.now(), minutes = cm.fetchPrefs.autoFetchMinutes;
		if (!force && now - (cm.lastAutoFetch.get(key) || 0) < minutes * 60000) return;
		cm.lastAutoFetch.set(key, now);
		try {
			const r = (await gitPost("autofetch", {})).out;
			// 自己抓了,或別的分頁/裝置剛抓過(recent、running):都重新讀狀態,↓ 數字才會跟著更新
			if (r.fetched !== undefined || r.skipped === "recent" || r.skipped === "running") await refreshGit();
		} catch {}
	}
	loadFetchPrefs();
	setInterval(() => {
		if (Date.now() - cm.fetchPrefsAt > 60000) loadFetchPrefs();
		autoFetchTick();
	}, 30000);
	window.addEventListener("focus", () => autoFetchTick());
	document.addEventListener("visibilitychange", () => { if (!document.hidden) autoFetchTick(); });
	async function refreshGit() {
		if (!cm.pid) return;
		// git 狀態很快、分支樹狀資料比較慢:狀態先畫,樹狀資料回來再補上分支區塊;
		// 回來時已經換到別的專案/worktree 就丟掉(不然舊專案的結果會蓋掉新的)
		const key = cp();
		const wts = loadWts();
		const main = await api("git/status").catch((e) => ({ error: e.message }));
		if (cp() !== key) return;
		cm.gitMain = main;
		if (cm.wt) cm.gitRepo = null;
		else {
			const nested = main.nested || [];
			const saved = gitRepoChoice(cm.pid);
			cm.gitRepo = saved === "" ? null : nested.some((x) => x.rel === saved) ? saved : (!main.repo || main.empty) && nested.length ? nested[0].rel : null;
		}
		const st = cm.gitRepo ? await api(`git/status?${gq()}`).catch((e) => ({ error: e.message })) : main;
		if (cp() !== key) return;
		cm.git = st;
		const n = st.repo ? st.staged.length + st.unstaged.length + st.untracked.length + st.conflicted.length : 0;
		$("cvGitCount").hidden = !n;
		$("cvGitCount").textContent = n;
		$("cvGitBehind").hidden = !(st.repo && st.upstream && st.behind > 0);
		$("cvGitBehind").textContent = `↓${st.behind || 0}`;
		if (cm.view === "git") renderGit();
		if (await wts && cp() === key && cm.view === "git") renderGit();
	}
	function gitRow(path, code, which) {
		const acts = which === "staged" ? '<button data-g="unstage" title="取消暫存">−</button>' : `<button data-g="discard" title="捨棄變更">↺</button><button data-g="stage" title="暫存">＋</button>`;
		return `<div class="git-row" data-path="${esc(path)}" data-which="${which}" title="${esc(path)}"><span class="nm">${esc(baseName(path))}<span class="dir">${esc(dirOf(path))}</span></span><span class="ra">${acts}</span><span class="g g-${code === "?" ? "U" : code}">${code === "?" ? "U" : code}</span></div>`;
	}
	const gitRepoChoice = (pid) => { try { return JSON.parse(localStorage.getItem("steward.gitRepo") || "{}")[pid]; } catch { return undefined; } };
	const setGitRepoChoice = (pid, rel) => { try { const o = JSON.parse(localStorage.getItem("steward.gitRepo") || "{}"); o[pid] = rel; localStorage.setItem("steward.gitRepo", JSON.stringify(o)); } catch {} };
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
		const nested = cm.wt ? [] : (cm.gitMain?.nested || []);
		const main = cm.gitMain;
		const mainLabel = main?.repo === false ? "這個資料夾(不是 git repo)" : main?.prefix ? `這個資料夾(在 ${main.repoName} 裡)` : "這個資料夾";
		const repoSelect = nested.length ? `<div class="git-branch"><span class="hint">Git</span><select id="cvGitRepo" title="切換要看的 git repo"><option value="" ${!cm.gitRepo ? "selected" : ""}>${esc(mainLabel + (main?.empty ? ",還沒有 commit" : ""))}</option>${nested.map((x) => `<option value="${esc(x.rel)}" ${cm.gitRepo === x.rel ? "selected" : ""}>${esc(`${x.rel}(${x.branch || "沒有分支"})`)}</option>`).join("")}</select></div>` : "";
		const wireRepo = () => {
			if (!nested.length) return;
			$("cvGitRepo").onchange = (e) => {
				setGitRepoChoice(cm.pid, e.target.value);
				cm.gitRepo = e.target.value || null;
				cm.history = null; cm.openCommit = null;
				refreshGit();
			};
		};
		if (!g.repo) {
			root.innerHTML = nested.length ? `${repoSelect}<div class="hint" style="padding:12px">這個資料夾不是 git repo,可以從上面的選單切到裡面的 repo</div>` : '<div class="empty" style="padding:12px">這個專案不是 git repo</div>';
			wireRepo(); return;
		}
		const repoNote = cm.gitRepo ? `<div class="hint git-sub">下面是「${esc(cm.gitRepo)}」這個 repo 的變更與歷史;分支、拉取、推送、提交都在這個 repo 裡。</div>` : "";
		const wtHtml = cm.gitRepo ? "" : wtSection();
		const changes = [...g.unstaged.map((x) => ({ ...x, which: "unstaged" })), ...g.untracked.map((x) => ({ ...x, code: "?", which: "untracked" }))];
		const anyStaged = g.staged.length > 0;
		const sync = g.upstream ? `↓${g.behind} ↑${g.ahead}` : "尚未連到遠端";
		const minutes = cm.fetchPrefs?.autoFetchMinutes ?? 3;
		const fetchPrompt = cm.fetchPrefs?.autoFetch === "ask" && g.upstream && !cm.askLater ? `<div class="hint git-sub">要讓管家每 ${minutes} 分鐘自動抓取遠端，遠端有新的 commit 時提醒你嗎？（只抓不合併，不會動到檔案）<br><button class="small primary" data-gb="afOn">好</button><button class="small" data-gb="afOff">不要</button><button class="small" data-gb="afLater">之後再問</button></div>` : "";
		const behindNote = g.upstream && g.behind > 0 ? `<div class="hint git-sub"><b>遠端有 ${g.behind} 個新的 commit</b>，按「拉取」更新${g.unstaged.length || g.staged.length ? "（有還沒提交的變更時，拉取可能會失敗）" : ""}</div>` : "";
		const authNote = g.autoFetch?.authFailed ? `<div class="hint git-sub">自動抓取已停止：登入遠端失敗（${esc(g.autoFetch.authFailed)}）。手動按「抓取」成功後會恢復。</div>` : "";
		const fetchedMinutes = g.autoFetch?.at ? Math.floor((Date.now() - new Date(g.autoFetch.at).getTime()) / 60000) : null;
		const syncTitle = fetchedMinutes === null ? "" : `上次抓取：${fetchedMinutes < 1 ? "剛剛" : `${fetchedMinutes} 分鐘前`}`;
		let branches = [];
		const key = cp();
		try { branches = (await gitPost("branches")).out.filter((b) => !b.name.startsWith("origin/") && !b.name.startsWith("remotes/")); } catch {}
		if (cp() !== key || cm.git !== g) return; // 等的時候換了專案或有更新的狀態:交給那一次畫
		const subNote = !cm.gitRepo && g.prefix ? `<div class="hint git-sub" title="git 是以 ${esc(g.repoName)} 整個資料夾為單位">這個專案是 repo「${esc(g.repoName)}」裡的 ${esc(g.prefix)} 資料夾:下面只列 ${esc(g.prefix)} 的變更與歷史,「全部暫存」也只加 ${esc(g.prefix)};分支、拉取、推送是整個 repo 共用的。${g.outsideStaged?.length ? `<br><b>⚠ 暫存區還有 ${g.outsideStaged.length} 個其他資料夾的檔案</b>(提交時會問你要不要一起提交)` : ""}</div>` : "";
		root.innerHTML = `${repoSelect}${repoNote}${wtHtml}${subNote}
			<div class="git-branch"><select id="cvBranch" title="切換分支">${branches.map((b) => `<option ${b.current ? "selected" : ""}>${esc(b.name)}</option>`).join("") || `<option>${esc(g.branch)}</option>`}</select>
				<button class="small" data-gb="new" title="建立新分支">＋分支</button></div>
			${fetchPrompt}${behindNote}${authNote}
			<div class="git-branch"><span class="hint" title="${esc(syncTitle)}">${esc(sync)}</span><span style="flex:1"></span>
				<button class="small" data-gb="fetch" title="抓取遠端">抓取</button><button class="small${g.upstream && g.behind > 0 ? " primary" : ""}" data-gb="pull" title="拉取(只快轉)">拉取${g.upstream && g.behind > 0 ? ` ↓${g.behind}` : ""}</button><button class="small" data-gb="push" title="推送">推送${g.ahead ? ` ${g.ahead}` : ""}</button></div>
			<div class="git-commit"><textarea id="cvMsg" placeholder="提交訊息(⌘/Ctrl+Enter 提交)">${esc(cm.msgDraft || "")}</textarea>
				<div class="row"><button class="small" data-gb="genmsg">產生提交訊息</button><button class="small primary" data-gb="commit">${anyStaged ? "提交" : changes.length ? "全部暫存並提交" : "提交"}</button></div></div>
			${g.conflicted.length ? sec("conflict", "衝突", g.conflicted.length, "", `<div class="hint" style="padding:4px 14px 8px">合併衝突請到終端機處理</div>${g.conflicted.map((x) => gitRow(x.path, "!", "unstaged")).join("")}`) : ""}
			${sec("staged", "已暫存", g.staged.length, anyStaged ? '<button data-ga="unstageAll" title="全部取消暫存">−</button>' : "", g.staged.map((x) => gitRow(x.path, x.code, "staged")).join(""))}
			${sec("changes", "變更", changes.length, changes.length ? '<button data-ga="discardAll" title="捨棄全部變更">↺</button><button data-ga="stageAll" title="全部暫存">＋</button>' : "", changes.map((x) => gitRow(x.path, x.code, x.which)).join(""))}
			<div class="git-sec"><div class="h" data-ga="history">${cm.history ? "▾" : "▸"} 歷史(最近 50 筆)</div>${cm.history ? cm.history.map((c) => `<div class="git-row" data-commit="${c.hash}" title="${esc(c.author)} · ${esc(c.date)}"><span class="nm">${esc(c.subject)}<span class="dir">${c.short}</span></span></div>${cm.openCommit?.hash === c.hash ? cm.openCommit.files.map((f) => `<div class="git-row" data-cfile="${esc(f.path)}" data-commit="${c.hash}" style="padding-left:28px"><span class="nm">${esc(baseName(f.path))}<span class="dir">${esc(dirOf(f.path))}</span></span><span class="g g-${f.code[0]}">${f.code[0]}</span></div>`).join("") : ""}`).join("") : ""}${cm.history?.length === 0 && g.empty ? '<div class="hint" style="padding:4px 14px 8px">這個 repo 還沒有任何 commit</div>' : ""}</div>`;
		wireRepo();
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
		const wa = e.target.closest("[data-wa]")?.dataset.wa;
		if (wa) return wtAct(wa, e.target.closest("[data-wtid]")?.dataset.wtid);
		const wfix = e.target.closest("[data-wfix]")?.dataset.wfix;
		if (wfix) return wtFix(wfix);
		const wf = e.target.closest("[data-wtfold]");
		if (wf && cm.wts?.repo) { toggleWtFold(wf.dataset.wtfold); renderGit(); const mt = wtMapTab(); if (mt?.pv) renderWtMap(mt); return; }
		if (fold) { setGitFold(fold, !gitFold(fold)); return renderGit(); }
		if (gb === "new") { const n = await askName("建立新分支", "", "分支名稱"); if (n) gitDo("checkout", { branch: n, create: true }, `已建立並切換到 ${n}`); return; }
		if (gb === "afOn" || gb === "afOff") {
			try {
				const r = await fetch("/api/code-prefs", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ autoFetch: gb === "afOn" ? "on" : "off" }) });
				const prefs = await r.json();
				if (!r.ok) throw new Error(prefs.error || `錯誤 ${r.status}`);
				cm.fetchPrefs = prefs;
				cm.fetchPrefsAt = Date.now();
				toast(gb === "afOn" ? "已開啟自動抓取，可以在 設定 → 一般 調整" : "不會自動抓取，之後可以在 設定 → 一般 開啟");
				if (gb === "afOn") await autoFetchTick(true);
				renderGit();
			} catch (err) { fail(err); }
			return;
		}
		if (gb === "afLater") { cm.askLater = true; return renderGit(); }
		if (gb === "fetch") return gitDo("fetch", {}, "已抓取");
		if (gb === "pull") return gitDo("pull", {}, "已拉取");
		if (gb === "push") return gitDo("push", {}, "已推送");
		if (gb === "genmsg") {
			const b = e.target; b.disabled = true; b.textContent = "產生中…";
			try { const r = await api(`git/commitmsg${gq() ? `?${gq()}` : ""}`, { method: "POST", body: "{}" }); cm.msgDraft = r.message; $("cvMsg").value = r.message; } catch (err) { fail(err); }
			b.disabled = false; b.textContent = "產生提交訊息";
			return;
		}
		if (gb === "commit") {
			const msg = $("cvMsg").value.trim();
			if (!msg) return toast("先寫提交訊息,或按「產生提交訊息」");
			const done = async () => { cm.msgDraft = ""; cm.history = cm.history ? (await gitPost("log")).out : null; toast("已提交"); };
			try {
				if (!g.staged.length) await gitPost("stage", { all: true });
				await gitPost("commit", { message: msg });
				await done();
			} catch (err) {
				if (err.status === 409 && err.data?.outside) {
					// 同一個 repo 的其他資料夾也有檔案在暫存區:問要只提交這個資料夾,還是一起提交
					const choice = await new Promise((resolve) => {
						const d = dialog({ title: "暫存區有其他資料夾的檔案", html: `<p>${esc(err.message)}</p><p class="hint">「只提交這個資料夾」會先把它們取消暫存(檔案內容不變),留給那個資料夾之後自己提交。</p>`, buttons: [
							{ label: "一起提交", onClick: () => resolve("include") },
							{ label: "只提交這個資料夾", primary: true, onClick: () => resolve("unstage") },
						] });
						d.querySelector("[data-x]").addEventListener("click", () => resolve(null));
					});
					if (choice) {
						try { await gitPost("commit", { message: msg, outside: choice }); await done(); } catch (e2) { fail(e2); }
					}
				} else fail(err);
			}
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
	async function openDiff(path, which, commit, into = null, { quiet = false, view = null, repo = cm.gitRepo } = {}) {
		await loadMonaco().catch(fail);
		if (!cm.monaco) return;
		ensureLayout();
		const key = `diff:${repo || ""}:${which}:${commit || ""}:${path}`;
		const old = findTab(key);
		const g = into || old?.group || cm.activeGroup || allGroups()[0];
		if (old) closeTab(old, true);
		try {
			const d = await api(`git/diff?path=${encodeURIComponent(path)}&which=${which}${commit ? `&commit=${commit}` : ""}${gq(repo) ? `&${gq(repo)}` : ""}`);
			const lang = langOf(path);
			const caption = which === "staged" ? "已暫存的變更:上次提交 ↔ 暫存區" : which === "commit" ? `提交 ${commit.slice(0, 7)} 的變更` : which === "untracked" ? "新檔案" : "未暫存的變更:暫存區 ↔ 工作目錄";
			const target = allGroups().includes(g) ? g : allGroups()[0];
			const t = { key, group: target, kind: "diff", path, which, commit, repo, label: `${baseName(path)}${which === "staged" ? "(已暫存)" : which === "commit" ? `@${commit.slice(0, 7)}` : "(變更)"}`, title: `${path} · ${caption}`, caption, orig: cm.monaco.editor.createModel(d.original, lang), mod: cm.monaco.editor.createModel(d.modified, lang), ...(view ? { viewState: view } : {}) };
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
		if (mobile()) {
			// 手機是單欄(側欄 ↔ 編輯器):側欄停在這一頁時再按一次 = 收起側欄回到編輯器;按另一個 = 切過去
			const editing = document.body.classList.contains("cv-editing");
			if (!editing && cm.view === v) { document.body.classList.add("cv-editing"); return; }
			document.body.classList.remove("cv-editing");
			return setView(v);
		}
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
	function refresh() {
		cm.dirs = {};
		renderFiles();
		// 換專案時 cm.git 已清空:git 面板馬上改成「讀取中」,不要停在上一個專案的內容
		if (cm.view === "git" && !cm.git) renderGit();
		refreshGit();
	}
	// 專案名稱旁的「回主資料夾」(攔在專案清單之前)
	$("cvProject").addEventListener("click", (e) => {
		if (!e.target.closest("[data-wtexit]")) return;
		e.stopPropagation(); e.preventDefault();
		switchView(cm.pid, null);
	}, true);
	window.codeMode = {
		pid: () => cm.pid,
		/** 浮動球用:目前取得焦點的檔案、開著的檔案(目前的排第一)、編輯器裡的最新內容(含沒存的) */
		lastFile: () => currentPath(),
		openFiles() {
			const cur = currentPath();
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
		hasUnsaved: (id) => hasUnsaved(id),
		/**
		 * 圈選提問:圈的範圍落在哪個編輯區。程式碼(Monaco)直接取那幾行原文和前後 30 行;
		 * 其他(Markdown、Notebook、PDF、Word、Excel、圖片)回傳畫面元素,由圈選程式從畫面上取文字或截圖。
		 */
		snapAt(rect) {
			const cx = (rect.left + rect.right) / 2, cy = (rect.top + rect.bottom) / 2;
			const g = cm.cols.flatMap((c) => c.groups).find((x) => { const r = x.stageEl.getBoundingClientRect(); return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom; });
			const t = g?.active;
			if (!t) return null;
			const ed = t.kind === "file" && !g.editorEl.hidden ? g.editor : t.kind === "diff" && !g.diffEl.hidden ? g.diff?.getModifiedEditor() : null;
			const label = t.kind === "diff" ? `${t.path}(差異)` : t.path || t.label || "程式碼頁";
			if (ed?.getModel()) {
				const model = ed.getModel(), box = ed.getDomNode().getBoundingClientRect();
				const lh = ed.getOption(cm.monaco.editor.EditorOption.lineHeight), top = ed.getScrollTop();
				let from = 0, to = 0;
				for (const r of ed.getVisibleRanges()) for (let n = r.startLineNumber; n <= r.endLineNumber; n++) {
					const mid = box.top + ed.getTopForLineNumber(n) - top + lh / 2;
					if (mid >= rect.top && mid <= rect.bottom) { if (!from) from = n; to = n; }
				}
				if (!from) return { kind: "code", path: t.path, label, text: "" };
				const range = (a, b) => model.getValueInRange({ startLineNumber: a, startColumn: 1, endLineNumber: b, endColumn: model.getLineMaxColumn(b) });
				const c0 = Math.max(1, from - 30), c1 = Math.min(model.getLineCount(), to + 30);
				return { kind: "code", path: t.path, label, from, to, text: range(from, to), context: `(第 ${c0}–${c1} 行)\n${range(c0, c1)}` };
			}
			return { kind: "doc", dom: g.stageEl, path: t.path, label };
		},
		refreshPlugins,
		/** 共用入口呼叫:程式碼頁面開著時換到這個專案 */
		async pick(id) {
			if (!projects().some((p) => p.id === id)) return; // 雜務/總覽之類不是程式碼專案:維持原樣
			await pickProject(id);
			render();
		},
		async show() {
			refreshPlugins();
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
	// 只給回歸測試用(test/code-focus.test.mjs 設 __STEWARD_TEST__ 才有),正式頁面不會出現
	if (window.__STEWARD_TEST__) window.codeMode._t = { cm, openFile, openNotebook, closeTab, setActiveGroup, splitWith, pickProject, allGroups, findTab };
	addEventListener("beforeunload", (e) => { if (allTabs().some((t) => t.dirty) || cm.stash.size) { e.preventDefault(); e.returnValue = ""; } });
})();
