(() => {
	window.LANG = window.STEWARD_LANG;
	const en = window.STEWARD_EN;
	const warned = new Set();
	// 主程式在頁面載入前就用 tr() 填過的文字,applyI18n 再讀到時已經是英文,不算漏翻
	const done = new Set(en ? Object.values(en) : []);
	const originals = new WeakMap();

	window.tr = (zh, vars) => {
		let text = zh;
		if (window.LANG === "en") {
			if (en && Object.hasOwn(en, zh) && typeof en[zh] === "string") text = en[zh];
			else if (!done.has(zh) && !warned.has(zh)) {
				warned.add(zh);
				console.warn("[i18n] Missing English translation:", zh);
			}
		}
		return text.replace(/\{([^{}]+)\}/g, (match, name) => vars && Object.hasOwn(vars, name) ? String(vars[name]) : match);
	};

	function original(el, key, value) {
		let values = originals.get(el);
		if (!values) { values = {}; originals.set(el, values); }
		if (!Object.hasOwn(values, key)) values[key] = value;
		return values[key];
	}

	window.applyI18n = (root = document) => {
		const selector = "[data-t],[data-t-title],[data-t-placeholder],[data-t-aria-label]";
		const elements = [...root.querySelectorAll(selector)];
		if (root.matches?.(selector)) elements.unshift(root);
		for (const el of elements) {
			if (el.hasAttribute("data-t") && [...el.childNodes].every((node) => node.nodeType === 3)) {
				el.textContent = window.tr(original(el, "text", el.getAttribute("data-t") || el.textContent.trim()));
			}
			for (const attr of ["title", "placeholder", "aria-label"]) {
				const marker = `data-t-${attr}`;
				if (el.hasAttribute(marker)) el.setAttribute(attr, window.tr(original(el, attr, el.getAttribute(marker) || (el.getAttribute(attr) || "").trim())));
			}
		}
	};

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => window.applyI18n(), { once: true });
	else window.applyI18n();
})();
