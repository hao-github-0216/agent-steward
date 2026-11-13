// 網頁介面的語言:中文原文當 key,英文表在 web/i18n/en.json。
// 檢查英文表、翻譯呼叫與漏翻的錯誤訊息,並在隔離資料目錄測試伺服器翻譯。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { renderIndex } from "../src/i18n.ts";

// 已經改成用 tr() 的檔案;之後每翻完一個檔就加進來
const FILES = ["web/i18n.js", "web/snap.js", "web/chatmd.js", "web/code.js"];
const SRC_FILES = [
	"src/i18n.ts", "src/server.ts", "src/models.ts", "src/plugins.ts", "src/notebook.ts",
	"src/update.ts", "src/terminal-auth.ts", "src/agents.ts", "src/agent-cli.ts", "src/dispatch.ts",
	"src/spaces.ts", "src/recall.ts", "src/followup.ts", "src/desktop-setup.ts", "src/tailscale.ts",
	"src/apns.ts", "src/office-dav.ts", "src/settings.ts", "src/branch.ts", "src/code.ts",
	"src/worktrees.ts", "src/steward.ts", "src/projects.ts", "src/brief.ts", "src/create.ts",
	"src/code-session.ts", "src/latex.ts", "src/term-paste.ts", "src/worktree.ts", "src/oauth-login.ts",
	"src/main.ts", "src/watcher.ts", "src/snap.ts",
];
// 含 <script>、<style> 和靜態 HTML 的檔案:script 照 JS 檢查;靜態 HTML 的中文要放在有 data-t / data-t-<屬性> 的那一行;<style> 不可以有中文
const HTML_FILES = ["web/index.html"];
const CJK = /[㐀-䶿一-鿿　-〿！-｠]/;
const en = JSON.parse(readFileSync("web/i18n/en.json", "utf8"));
const params = (s) => [...s.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]).sort();

/** 取出 tr( 後面第一個參數的字串字面值:[原文, 開始位置, 結束位置] */
function trCalls(src) {
	const re = /\btr\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\$]|\\.|\$(?!\{))*`)/g;
	return [...src.matchAll(re)].map((m) => {
		const lit = m[1];
		const text = lit[0] === "`" ? lit.slice(1, -1).replace(/\\`/g, "`") : JSON.parse(lit[0] === "'" ? `"${lit.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"` : lit);
		const start = m.index + m[0].length - lit.length;
		return [text, start, start + lit.length];
	});
}

/** 把註解換成空白(保留換行,行號不變)。認得字串、模板字串裡的 ${…}、regex 字面值,裡面的 // 和引號不會被誤判 */
function stripComments(src) {
	let out = "", i = 0, prev = "";
	const stack = []; // 模板字串的 ${ 巢狀:記錄每層 ${ 裡的大括號深度
	const regexCanStart = () => prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev);
	const copyUntil = (close, allowNewline) => {
		while (i < src.length) {
			const c = src[i];
			if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
			out += c; i++;
			if (c === close || (!allowNewline && c === "\n")) return;
		}
	};
	const template = () => { // 從反引號後開始,讀到結尾反引號或 ${
		while (i < src.length) {
			const c = src[i];
			if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
			if (c === "`") { out += c; i++; return; }
			if (c === "$" && src[i + 1] === "{") { out += "${"; i += 2; stack.push(0); return; }
			out += c; i++;
		}
	};
	while (i < src.length) {
		const c = src[i], n = src[i + 1];
		if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") { out += " "; i++; } continue; }
		if (c === "/" && n === "*") {
			const end = src.indexOf("*/", i + 2);
			const stop = end < 0 ? src.length : end + 2;
			out += src.slice(i, stop).replace(/[^\n]/g, " ");
			i = stop;
			continue;
		}
		if (c === '"' || c === "'") { out += c; i++; copyUntil(c, false); prev = "a"; continue; }
		if (c === "`") { out += c; i++; template(); prev = "a"; continue; }
		if (c === "/" && regexCanStart()) { // regex 字面值,字元集合 [...] 裡的 / 不算結尾
			out += c; i++;
			let cls = false;
			while (i < src.length && src[i] !== "\n") {
				const d = src[i];
				if (d === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
				out += d; i++;
				if (d === "[") cls = true; else if (d === "]") cls = false; else if (d === "/" && !cls) break;
			}
			prev = "a";
			continue;
		}
		if (stack.length) {
			if (c === "{") stack[stack.length - 1]++;
			else if (c === "}") {
				if (stack[stack.length - 1] === 0) { stack.pop(); out += c; i++; template(); prev = "a"; continue; }
				stack[stack.length - 1]--;
			}
		}
		out += c; i++;
		if (!/\s/.test(c)) prev = c;
	}
	return out;
}

/** 把 HTML 拆成三種片段,其他部分換成空白(保留換行,行號不變) */
function splitHtml(raw) {
	const blank = (s) => s.replace(/[^\n]/g, " ");
	let js = "", css = "", html = "", last = 0;
	for (const m of raw.matchAll(/(<script>)([\s\S]*?)(<\/script>)|(<style>)([\s\S]*?)(<\/style>)/g)) {
		const before = raw.slice(last, m.index);
		html += before; js += blank(before); css += blank(before);
		const open = m[1] ?? m[4], body = m[2] ?? m[5], close = m[3] ?? m[6];
		html += blank(open) + blank(body) + blank(close);
		js += blank(open) + (m[1] ? body : blank(body)) + blank(close);
		css += blank(open) + (m[4] ? body : blank(body)) + blank(close);
		last = m.index + m[0].length;
	}
	const rest = raw.slice(last);
	html += rest; js += blank(rest); css += blank(rest);
	html = html.replace(/<!--[\s\S]*?-->/g, blank);
	css = css.replace(/\/\*[\s\S]*?\*\//g, blank);
	return { js, css, html };
}

/** 靜態 HTML 裡要翻的字:data-t 元素的文字、data-t-<屬性> 對應的屬性值 */
function dataTKeys(html) {
	const keys = [];
	for (const m of html.matchAll(/<[a-z][^>]*\bdata-t(?:-[a-z-]+)?\b[^>]*>/gi)) {
		const tag = m[0];
		if (/\bdata-t(?=[\s>=])/.test(tag)) {
			const own = tag.match(/\bdata-t="([^"]+)"/);
			const text = own ? own[1] : html.slice(m.index + tag.length).split("<")[0].trim();
			if (text) keys.push(text);
		}
		for (const a of tag.matchAll(/\bdata-t-([a-z-]+)(?:="([^"]*)")?/g)) {
			const v = a[2] || tag.match(new RegExp(`\\s${a[1]}="([^"]*)"`))?.[1]?.trim();
			if (v) keys.push(v);
		}
	}
	return keys;
}

test("英文表沒有重複的鍵", () => {
	const keys = [...readFileSync("web/i18n/en.json", "utf8").matchAll(/^\s*("(?:[^"\\]|\\.)*")\s*:/gm)].map((m) => JSON.parse(m[1]));
	assert.equal(new Set(keys).size, keys.length);
});

test("英文表:值都是不含中文的非空字串", () => {
	for (const [k, v] of Object.entries(en)) {
		assert.equal(typeof v, "string", k);
		assert.ok(v.trim(), `空的英文:${k}`);
		assert.ok(!CJK.test(v), `英文裡還有中文:${k} → ${v}`);
	}
});

test("每個 tr() 的原文都有英文,而且 {參數} 一樣", () => {
	const missing = [], badParams = [];
	for (const f of [...FILES, ...SRC_FILES]) {
		for (const [text] of trCalls(readFileSync(f, "utf8"))) {
			if (!Object.hasOwn(en, text)) missing.push(`${f}: ${text}`);
			else if (params(text).join() !== params(en[text]).join()) badParams.push(`${f}: ${text} → ${en[text]}`);
		}
	}
	for (const f of HTML_FILES) {
		const raw = readFileSync(f, "utf8"), { js, html } = splitHtml(raw);
		for (const text of [...trCalls(js).map(([t]) => t), ...dataTKeys(html)]) {
			if (!Object.hasOwn(en, text)) missing.push(`${f}: ${text}`);
			else if (params(text).join() !== params(en[text]).join()) badParams.push(`${f}: ${text} → ${en[text]}`);
		}
	}
	assert.deepEqual(missing, [], "英文表少了這些");
	assert.deepEqual(badParams, [], "參數對不上");
});

test("網頁程式裡的中文都包在 tr() 裡(註解與標了 i18n-ok 的行除外)", () => {
	const leaks = [];
	for (const f of FILES) {
		const raw = readFileSync(f, "utf8");
		let src = raw;
		for (const [, s, e] of trCalls(raw).reverse()) src = src.slice(0, s) + " ".repeat(e - s) + src.slice(e);
		const rawLines = raw.split("\n");
		stripComments(src).split("\n").forEach((line, i) => {
			if (CJK.test(line) && !rawLines[i].includes("i18n-ok")) leaks.push(`${f}:${i + 1}: ${rawLines[i].trim().slice(0, 120)}`);
		});
	}
	for (const f of HTML_FILES) {
		const raw = readFileSync(f, "utf8"), rawLines = raw.split("\n"), { js, css, html } = splitHtml(raw);
		let src = js;
		for (const [, s, e] of trCalls(js).reverse()) src = src.slice(0, s) + " ".repeat(e - s) + src.slice(e);
		const flag = (text, why, ok) => text.split("\n").forEach((line, i) => {
			if (CJK.test(line) && !rawLines[i].includes("i18n-ok") && !ok(rawLines[i])) leaks.push(`${f}:${i + 1} (${why}): ${rawLines[i].trim().slice(0, 120)}`);
		});
		flag(stripComments(src), "script", () => false);
		flag(css, "style", () => false);
		flag(html, "html", (line) => /\bdata-t\b/.test(line));
	}
	assert.deepEqual(leaks, [], "這些中文沒有包 tr()");
});

test("伺服器回傳的中文錯誤都包在 tr() 裡", () => {
	const leaks = [];
	const literal = '("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)';
	const re = new RegExp(`(?:\\berror\\s*:\\s*|\\bnew\\s+(?:Type)?Error\\(\\s*)${literal}`, "g");
	for (const f of SRC_FILES) {
		const raw = readFileSync(f, "utf8"), lines = raw.split("\n");
		for (const m of stripComments(raw).matchAll(re)) {
			const line = raw.slice(0, m.index).split("\n").length;
			if (CJK.test(m[1]) && !/\/\/ i18n-ok\b/.test(lines[line - 1])) leaks.push(`${f}:${line}: ${lines[line - 1].trim()}`);
		}
	}
	assert.deepEqual(leaks, []);
});

test("管家與建議問題的提示詞即時跟著語言設定", () => {
	const steward = readFileSync("src/steward.ts", "utf8"), server = readFileSync("src/server.ts", "utf8");
	const persona = steward.slice(steward.indexOf("const PERSONA ="), steward.indexOf("/** 管家對話裡"));
	const suggest = server.match(/^\tconst SUGGEST_SYS = .*;$/m)[0];
	const handoff = steward.split("\n").find((line) => line.startsWith("- 寫給主線 agent 看"));
	let lang = "zh-TW";
	const context = { settings: () => ({ user: { name: "" } }), isEn: () => lang === "en" };
	assert.match(runInNewContext(persona + "\nPERSONA()", { ...context }), /全程使用繁體中文。/);
	assert.match(runInNewContext(suggest + "\nSUGGEST_SYS()", { ...context }), /每題 30 字以內/);
	assert.match(runInNewContext("`" + handoff + "`", { ...context }), /繁體中文。/);
	lang = "en";
	assert.match(runInNewContext(persona + "\nPERSONA()", { ...context }), /Always write in English\./);
	const questions = runInNewContext(suggest + "\nSUGGEST_SYS()", { ...context });
	assert.match(questions, /必須用英文,每題 15 個英文字以內/);
	assert.ok(!questions.includes("台灣用字") && !questions.includes("簡體字"));
	assert.match(runInNewContext("`" + handoff + "`", { ...context }), /English\./);
});

test("伺服器 tr() 即時跟著語言設定,參數只替換一輪", () => {
	const home = mkdtempSync(join(tmpdir(), "steward-i18n-"));
	try {
		writeFileSync(join(home, "settings.json"), JSON.stringify({ ui: { lang: "zh-TW" }, access: { tailscale: { enabled: false } }, plugins: { notebook: { pythons: [] } }, setupDone: true }));
		const script = `
			import assert from "node:assert/strict";
			import { tr, isEn, readEnTable } from ${JSON.stringify(new URL("../src/i18n.ts", import.meta.url).href)};
			import { updateSettings } from ${JSON.stringify(new URL("../src/settings.ts", import.meta.url).href)};
			import { copyFileSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
			import { join } from "node:path";
			import { pathToFileURL } from "node:url";
			import { displayProject, MISC_ROOT, OVERVIEW_ROOT } from ${JSON.stringify(new URL("../src/projects.ts", import.meta.url).href)};
			import { brief } from ${JSON.stringify(new URL("../src/brief.ts", import.meta.url).href)};
			import { providerLabel, publicSettings, settings } from ${JSON.stringify(new URL("../src/settings.ts", import.meta.url).href)};
			const p = { root: MISC_ROOT, name: "雜務", kind: "misc", id: "misc", state: { goal: "goal", progress: "原本的中文進度", nextSteps: ["next"], blockers: ["wait"], decisions: ["decision"], recent: [], updatedAt: new Date().toISOString() } };
			const original = JSON.stringify(p);
			const store = { cards: () => [] };
			assert.equal(displayProject(p).name, "雜務");
			assert.equal(displayProject(p).root, "(雜務)");
			assert.equal(brief(store, p), '# 專案管家簡報:雜務\\n\\n**目標**:goal\\n\\n**目前進度**(更新於 0 分鐘前):原本的中文進度\\n\\n**下一步**\\n- next\\n\\n**卡住的地方**\\n- wait\\n\\n**重要決定**\\n- decision\\n\\n(要問細節可用 \`steward ask "…"\`;做完一段落管家會自動記錄,不必手動回報。)');
			assert.equal(isEn(), false);
			assert.equal(tr("已複製 {n} 字", { n: 3 }), "已複製 3 字");
			updateSettings({ ui: { lang: "en" } });
			assert.equal(isEn(), true);
			assert.equal(tr("關閉"), "Close");
			assert.equal(displayProject(p).name, "Misc");
			assert.equal(displayProject(p).root, "(Misc)");
			assert.equal(displayProject({ ...p, root: OVERVIEW_ROOT, name: "總覽" }).name, "Overview");
			assert.equal(displayProject({ ...p, root: "/project", name: "雜務", kind: "project" }).name, "雜務");
			assert.equal(JSON.stringify(p), original);
			assert.match(brief(store, p), /# Agent Steward brief: Misc/);
			assert.match(brief(store, p), /Current progress/);
			assert.match(brief(store, p), /原本的中文進度/);
			assert.equal(providerLabel({ type: "pi-models", name: "local(沿用 pi 的模型設定)" }), "local (using pi model settings)");
			assert.equal(providerLabel({ type: "agent-cli", name: "Claude Code(電腦上的 CLI)" }), "Claude Code (CLI on this computer)");
			updateSettings({ providers: [{ id: "openai", type: "builtin", name: "ChatGPT 訂閱" }] });
			assert.equal(publicSettings().providers[0].name, "ChatGPT subscription");
			assert.equal(settings().providers[0].name, "ChatGPT 訂閱");
			assert.equal(tr("已複製 {n} 字", { n: 3 }), "Copied characters: 3");
			assert.equal(tr("已複製 {n} 字", { n: "{next}", next: "again" }), "Copied characters: {next}");
			assert.equal(tr("已複製 {n} 字"), "Copied characters: {n}");
			assert.equal(tr("沒有這個鍵 {name}", { name: "test" }), "沒有這個鍵 test");
			assert.equal(tr("{toString}", {}), "{toString}");
			updateSettings({ ui: { lang: "zh-TW" } });
			assert.equal(tr("關閉"), "關閉");
			const file = join(process.env.HOME, "en.json");
			writeFileSync(file, '{"a":"first"}');
			const first = readEnTable(file);
			assert.equal(first.a, "first");
			assert.equal(readEnTable(file), first);
			writeFileSync(file, '{"a":"second"}');
			utimesSync(file, new Date(), new Date(Date.now() + 2000));
			assert.equal(readEnTable(file).a, "second");
			writeFileSync(file, 'broken');
			utimesSync(file, new Date(), new Date(Date.now() + 4000));
			assert.equal(readEnTable(file), null);
			assert.equal(readEnTable(join(process.env.HOME, "missing.json")), null);
			const fixture = join(process.env.HOME, "module");
			mkdirSync(join(fixture, "src"), { recursive: true });
			for (const name of ["i18n", "settings"]) copyFileSync(new URL(name + ".ts", ${JSON.stringify(new URL("../src/", import.meta.url).href)}), join(fixture, "src", name + ".ts"));
			updateSettings({ ui: { lang: "en" } });
			const { tr: fixtureTr } = await import(pathToFileURL(join(fixture, "src", "i18n.ts")).href);
			assert.equal(fixtureTr("關閉"), "關閉");
			const table = join(fixture, "web", "i18n", "en.json");
			mkdirSync(join(fixture, "web", "i18n"), { recursive: true });
			writeFileSync(table, '{"關閉":"Fixture close"}');
			assert.equal(fixtureTr("關閉"), "Fixture close");
			writeFileSync(table, '{"關閉":"Updated close"}');
			utimesSync(table, new Date(), new Date(Date.now() + 6000));
			assert.equal(fixtureTr("關閉"), "Updated close");
			writeFileSync(table, 'broken');
			utimesSync(table, new Date(), new Date(Date.now() + 8000));
			assert.equal(fixtureTr("關閉"), "關閉");
			updateSettings({ ui: { lang: "fr" } });
			assert.equal(isEn(), false);
			assert.equal(tr("關閉"), "關閉");
		`;
		execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], {
			env: { ...process.env, HOME: home, USERPROFILE: home, STEWARD_DATA_DIR: home }, stdio: "pipe", timeout: 15000,
		});
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test("送出 index.html 時依語言填入語言與英文表", () => {
	const html = '<html lang="zh-Hant"><head><script>window.STEWARD_LANG="__STEWARD_LANG__";window.STEWARD_EN=__STEWARD_EN__;</script>';
	const out = renderIndex(html, "en", { "關閉": "Close", "x": "</script><script>alert(1)</script>" });
	assert.match(out, /<html lang="en">/);
	assert.match(out, /STEWARD_LANG="en"/);
	assert.ok(!out.includes("</script><script>alert"), "表裡的 </script> 要跳脫");
	const table = JSON.parse(out.match(/STEWARD_EN=(.*?);<\/script>/)[1]);
	assert.equal(table["關閉"], "Close");
	for (const lang of ["zh-TW", "", "fr"]) {
		const zh = renderIndex(html, lang, { "關閉": "Close" });
		assert.match(zh, /<html lang="zh-Hant">/);
		assert.match(zh, /STEWARD_LANG="zh-TW"/);
		assert.match(zh, /STEWARD_EN=null;/);
	}
});

test("真的 index.html 有語言佔位,而且 i18n.js 在其他程式之前載入", () => {
	const html = readFileSync("web/index.html", "utf8");
	assert.ok(html.includes("__STEWARD_LANG__") && html.includes("__STEWARD_EN__"));
	const i18n = html.indexOf('<script src="/web/i18n.js">');
	assert.ok(i18n > 0 && i18n < html.indexOf("<script>", html.indexOf("__STEWARD_EN__")) , "i18n.js 要在第一個主程式 <script> 之前");
});

test("英文表不會多出或弄丟 HTML:原文沒有的 < \" & 英文也不能有;原文的標籤英文要一樣", () => {
	const tags = (s) => [...s.matchAll(/<\/?[a-z][^>]*>/gi)].map((m) => m[0].replace(/'/g, "\"")).sort().join("\n"); // 屬性用單引號或雙引號都可以
	const bad = [];
	for (const [k, v] of Object.entries(en)) {
		for (const ch of ["<", '"', "&"]) if (!k.includes(ch) && v.includes(ch)) bad.push(`多了 ${ch}:${k} → ${v}`);
		if (tags(k) !== tags(v)) bad.push(`標籤不同:${k} → ${v}`);
	}
	assert.deepEqual(bad, []);
});
