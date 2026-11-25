// 只在有實際工作時記下候選資料夾;所有服務與設定都在隔離的子程序裡測試。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const moduleURL = (name) => JSON.stringify(new URL(`../src/${name}.ts`, import.meta.url).href);

function isolated(code) {
	// HOME 與專案資料都放在隔離的暫存目錄,子程序只使用這個 HOME。
	const home = realpathSync.native(mkdtempSync(join(tmpdir(), "steward-quiet-pending-home-")));
	const data = join(home, "data");
	mkdirSync(data);
	writeFileSync(join(data, "settings.json"), JSON.stringify({
		version: 1, setupDone: true, aiDetected: true,
		paths: { privacy: [], usePiPrivacy: false },
		access: { tailscale: { enabled: false }, lan: { enabled: false } },
		plugins: { notebook: { pythons: [] } }, providers: [], notify: { kind: "none" }, push: { relay: "" },
	}));
	const globalConfig = join(home, "gitconfig");
	writeFileSync(globalConfig, "");
	try {
		execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", `
			import assert from "node:assert/strict";
			import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
			import { tmpdir } from "node:os";
			import { join } from "node:path";
			import { execFileSync } from "node:child_process";
			const { isThrowawayPath, isAgentTempPath, HOME } = await import(${moduleURL("config")});
			const { resolveProject, cleanupPendingProjects, ensureSpecial, MISC_ROOT } = await import(${moduleURL("projects")});
			const { Store } = await import(${moduleURL("store")});
			const dir = (rel) => { const path = join(HOME, rel); mkdirSync(path, { recursive: true }); return path; };
			const store = new Store(join(process.env.STEWARD_DATA_DIR, "state.json"));
			try { ${code} }
			catch (error) { console.error(error); process.exit(1); }
			process.exit(0);
		`], {
			env: {
				...process.env, HOME: home, USERPROFILE: home, STEWARD_DATA_DIR: data,
				XDG_CONFIG_HOME: join(home, "config"), APPDATA: join(home, "appdata"),
				GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: home,
				STEWARD_HOSTS: "127.0.0.1", STEWARD_PORT: "0", STEWARD_TERMINAL_PORT: "0", STEWARD_DESKTOP: "0",
				HERDR_BIN_PATH: join(home, "no-herdr"), HERDR_SOCKET_PATH: join(home, "no-herdr.sock"),
			},
			encoding: "utf8", stdio: "pipe", timeout: 30_000,
		});
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

test("remember:false 不建立或更新 pending;實際工作才建立並更新 seenAt", () => isolated(`
	for (const root of [HOME, "/"]) {
		assert.equal(resolveProject(store, root).kind, "misc");
		assert.equal(store.projectByRoot(root), undefined);
	}
	const cwd = dir("code/plain");
	assert.equal(resolveProject(store, cwd, { remember: false }).kind, "misc");
	assert.equal(store.projectByRoot(cwd), undefined);
	assert.equal(resolveProject(store, cwd).kind, "misc");
	const candidate = store.projectByRoot(cwd);
	assert.equal(candidate.status, "pending");
	assert.ok(Number.isFinite(Date.parse(candidate.seenAt)));
	const old = "2000-01-01T00:00:00.000Z";
	store.updateProject(candidate.id, { seenAt: old });
	resolveProject(store, cwd, { remember: false });
	assert.equal(candidate.seenAt, old);
	resolveProject(store, cwd, { remember: true });
	assert.ok(candidate.seenAt > old);
	assert.equal(store.projects().filter((p) => p.kind === "project").length, 1);
	store.updateProject(candidate.id, { status: "ignored", seenAt: old });
	resolveProject(store, cwd);
	assert.equal(candidate.status, "ignored");
	assert.equal(candidate.seenAt, old);
`));

test("一般 git repo 仍自動登記;暫存、家目錄 dot 資料夾與快取 repo 都不登記", () => isolated(`
	const repo = dir("code/repo");
	execFileSync("git", ["-C", repo, "init", "-q"]);
	assert.equal(resolveProject(store, repo, { remember: false }).status, "active");
	assert.equal(store.projectByRoot(repo).kind, "project");
	for (const cwd of [dir(".config/tool"), dir("Library/Caches/repo"), mkdtempSync(join(tmpdir(), "quiet-repo-"))]) {
		try {
			execFileSync("git", ["-C", cwd, "init", "-q"]);
			for (const remember of [false, true]) {
				assert.equal(resolveProject(store, cwd, { remember }).kind, "misc");
				assert.equal(store.projectByRoot(cwd), undefined);
			}
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	}
`));

test("isThrowawayPath:系統暫存、環境變數、快取、套件與家目錄 dot 資料夾", () => isolated(`
	assert.equal(isAgentTempPath, isThrowawayPath);
	const opts = { platform: "linux", home: "/home/tester", tempDir: "/custom/os-temp", env: {
		TMPDIR: "/custom/tmpdir", TEMP: "/custom/temp", TMP: "/custom/tmp",
		XDG_RUNTIME_DIR: "/custom/runtime", XDG_CACHE_HOME: "/custom/cache",
	} };
	for (const base of ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/custom/os-temp", "/custom/tmpdir", "/custom/temp", "/custom/tmp", "/var/folders", "/private/var/folders", "/run", "/custom/runtime", "/home/tester/Library/Caches", "/home/tester/.cache", "/custom/cache"]) {
		assert.equal(isThrowawayPath(base, opts), true, base);
		assert.equal(isThrowawayPath(base + "/a/b", opts), true, base);
		assert.equal(isThrowawayPath(base + "-project", opts), base.startsWith("/home/tester/."), base + " boundary");
	}
	for (const name of ["node_modules", "site-packages", ".venv", "venv", ".npm", ".pnpm-store", ".cargo", ".rustup", "go/pkg/mod"]) {
		assert.equal(isThrowawayPath("/work/repo/" + name + "/pkg", opts), true, name);
		assert.equal(isThrowawayPath("/work/repo/" + name, opts), true, name);
	}
	for (const rel of [".pi", ".config", ".config/tool", ".claude/jobs/abc/tmp", ".claude/jobs/abc/other", ".something/deep"]) {
		assert.equal(isThrowawayPath("/home/tester/" + rel, opts), true, rel);
	}
	for (const p of ["/", "/home/tester", "/home/tester/code/x", "/home/tester/sample-project", "/work/project/.claude/worktrees/x", "/work/node_modules-extra/pkg", "/work/myvenv/pkg", "/work/go/pkg/module", "/home/tester/Library/Caches-other"]) {
		assert.equal(isThrowawayPath(p, opts), false, p);
	}
	assert.equal(isThrowawayPath("/home/tester/Library/Caches/../Projects", opts), false);
	assert.equal(isThrowawayPath("/work/project", { ...opts, tempDir: "/", env: { TMPDIR: "/home/tester" } }), false);
	assert.equal(isThrowawayPath(HOME), false);
	assert.equal(isThrowawayPath(dir("code/x")), false);
	assert.equal(isThrowawayPath(dir("sample-project")), false);
	assert.equal(isThrowawayPath(tmpdir()), true);
`));

test("isThrowawayPath:暫存或快取區內的 HOME 保留一般專案,其他過濾規則仍生效", () => isolated(`
	const cases = [
		{ platform: "linux", home: "/tmp/ci-home", base: "/tmp", tempDir: "/tmp", env: {} },
		{ platform: "darwin", home: "/var/folders/ci/test/T/home", base: "/var/folders/ci/test/T", tempDir: "/var/folders/ci/test/T", env: {} },
		{ platform: "darwin", home: "/private/var/folders/ci/test/T/home", base: "/private/var/folders/ci/test/T", tempDir: "/private/var/folders/ci/test/T", env: {} },
		{ platform: "linux", home: "/custom/tmp/home", base: "/custom/tmp", tempDir: "/tmp", env: { TMPDIR: "/custom/tmp" } },
		{ platform: "linux", home: "/custom/cache/home", base: "/custom/cache", tempDir: "/tmp", env: { XDG_CACHE_HOME: "/custom/cache" } },
		{ platform: "win32", home: "C:/Users/Runner/AppData/Local/Temp/home", base: "C:/Users/Runner/AppData/Local/Temp", tempDir: "C:/Users/Runner/AppData/Local/Temp", env: { LOCALAPPDATA: "C:/Users/Runner/AppData/Local" } },
	];
	for (const opts of cases) {
		assert.equal(isThrowawayPath(opts.home + "/code/project", opts), false, opts.home);
		assert.equal(isThrowawayPath(opts.home + "/.cache/project", opts), true, opts.home);
		assert.equal(isThrowawayPath(opts.home + "/code/node_modules/pkg", opts), true, opts.home);
		assert.equal(isThrowawayPath(opts.home + "/Library/Caches/project", opts), true, opts.home);
		assert.equal(isThrowawayPath(opts.base + "/sibling-project", opts), true, opts.home);
		assert.equal(isThrowawayPath(opts.home + "-other/project", opts), true, opts.home);
	}
	assert.equal(isThrowawayPath(dir("code/project")), false);
	assert.equal(isThrowawayPath(dir(".cache/project")), true);
	assert.equal(isThrowawayPath(dir("code/node_modules/pkg")), true);
	assert.equal(isThrowawayPath(HOME + "-other/project"), true);
	const tagged = dir("code/home-cache-tag");
	writeFileSync(join(tagged, "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55");
	assert.equal(isThrowawayPath(tagged), true);
	if (process.platform === "darwin") {
		const alias = HOME.replace(/^\\/private(?=\\/)/, "");
		assert.equal(isThrowawayPath(alias + "/code/not-created", { home: alias }), false);
		assert.equal(isThrowawayPath(alias + "/.cache/not-created", { home: alias }), true);
	}
`));

test("isThrowawayPath:Windows 路徑統一分隔符、不分大小寫,不排除整個 LocalAppData", () => isolated(`
	const opts = { platform: "win32", home: "C:/Users/Tester", tempDir: "D:/OS-TEMP", env: {
		LOCALAPPDATA: "C:/Users/Tester/AppData/Local", TEMP: "D:/TEMP", TMP: "E:/TEMP",
	} };
	for (const p of ["c:/WINDOWS/temp/agent", "C:/Users/TESTER/AppData/Local/Temp/session", "c:/users/tester/appdata/local/PACKAGES/app", "d:/temp/run", "E:/TEMP/run", "D:/OS-temp/run", "C:/Work/Node_Modules/pkg", "C:/Users/Tester/.CONFIG/tool", "C:/Users/Tester/.cache/tool"]) {
		assert.equal(isThrowawayPath(p, opts), true, p);
		assert.equal(isThrowawayPath(p.replaceAll("/", String.fromCharCode(92)), opts), true, p);
	}
	for (const p of ["C:/", "c:/users/TESTER", "C:/Users/Tester/code/x", "C:/Users/Tester/sample-project", "C:/Users/Tester/AppData/Local", "C:/Users/Tester/AppData/Local/Programs/my-project", "C:/Users/Tester/AppData/Local/custom-project", "C:/Windows/Temp-other", "C:/Users/Tester/AppData/Local/Packages-other"]) {
		assert.equal(isThrowawayPath(p, opts), false, p);
	}
`));

test("isThrowawayPath:解析 realpath 與 CACHEDIR.TAG 簽章", () => isolated(`
	const tagged = dir("code/tagged");
	const tag = join(tagged, "CACHEDIR.TAG");
	assert.equal(isThrowawayPath(tagged), false);
	writeFileSync(tag, "not a cache tag");
	assert.equal(isThrowawayPath(tagged), false);
	writeFileSync(tag, "Signature: 8a477f597d28d172789f06886806bc55\\n# cache");
	assert.equal(isThrowawayPath(tagged), true);
	const target = dir("Library/Caches/symlink-target");
	const link = join(dir("code"), "linked-cache");
	symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
	assert.equal(isThrowawayPath(link), true);
	assert.equal(resolveProject(store, link).kind, "misc");
	assert.equal(store.projectByRoot(link), undefined);
`));

test("啟動清理:暫存與消失的 pending 改 ignored,既有紀錄不刪除且可重複執行", () => isolated(`
	const add = (root, status = "pending") => store.addProject({ root, status, name: "fixture", kind: "project", private: false });
	const temp = add(mkdtempSync(join(tmpdir(), "quiet-cleanup-")));
	const gone = add(join(HOME, "no-longer-exists"));
	const cached = add(dir(".cache/old-candidate"));
	const replaced = add(dir("code/replaced-with-file"));
	rmSync(replaced.root, { recursive: true });
	writeFileSync(replaced.root, "no longer a folder");
	const normal = add(dir("code/keep"));
	const ignored = add(join(HOME, "already-ignored"), "ignored");
	const active = add(join(HOME, "active-but-missing"), "active");
	store.updateState(temp.id, { progress: "保留原有紀錄" });
	const before = store.projects().length;
	try {
		cleanupPendingProjects(store);
		for (const p of [temp, gone, cached, replaced]) {
			assert.equal(p.status, "ignored");
			assert.ok(Number.isFinite(Date.parse(p.autoIgnoredAt)));
		}
		assert.equal(normal.status, "pending");
		assert.equal(normal.autoIgnoredAt, undefined);
		assert.equal(ignored.autoIgnoredAt, undefined);
		assert.equal(active.status, "active");
		assert.equal(temp.state.progress, "保留原有紀錄");
		const snapshot = JSON.stringify(store.projects());
		cleanupPendingProjects(store);
		assert.equal(JSON.stringify(store.projects()), snapshot);
		const restored = new Store(join(process.env.STEWARD_DATA_DIR, "state.json"));
		assert.equal(restored.projects().length, before);
		assert.equal(restored.project(temp.id).autoIgnoredAt, temp.autoIgnoredAt);
	} finally { rmSync(temp.root, { recursive: true, force: true }); }
`));

test("API:brief/ask 不記候選;report 記候選;board 保留 pending 並自動略過消失資料夾", () => isolated(`
	const http = await import("node:http");
	let listening;
	const ready = new Promise((done) => { listening = done; });
	const originalListen = http.Server.prototype.listen;
	http.Server.prototype.listen = function (...args) {
		this.once("listening", () => listening(this.address().port));
		return originalListen.apply(this, args);
	};
	const { startServer } = await import(${moduleURL("server")});
	const sent = [];
	const steward = { send: async (p) => { sent.push(p.id); return "ok"; }, askAbout: async () => "ok" };
	const stop = startServer(store, steward, { status: () => ({ panes: [] }) });
	const port = await ready;
	assert.ok(![8791, 8792, 8793, 8797, 8807].includes(port));
	http.Server.prototype.listen = originalListen;
	const base = "http://127.0.0.1:" + port;
	const get = async (path) => {
		const r = await fetch(base + path);
		assert.equal(r.status, 200);
		return r.json();
	};
	const post = async (path, body) => {
		const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		assert.equal(r.status, 200);
		return r.json();
	};
	const cwd = dir("code/api-folder");
	const temporary = mkdtempSync(join(tmpdir(), "quiet-api-"));
	const target = store.addProject({ root: dir("code/target"), name: "target", kind: "project", status: "active", private: false });
	try {
		for (const folder of [temporary, cwd]) {
			const query = new URLSearchParams({ cwd: folder, format: "json" });
			assert.equal((await get("/api/brief?" + query)).project.kind, "misc");
			await get("/api/brief?" + query + "&project=target");
			await post("/api/ask", { cwd: folder, question: "hello" });
			await post("/api/ask", { cwd: folder, question: "hello", project: "target" });
			assert.equal(store.projectByRoot(folder), undefined);
		}
		await post("/api/report", { cwd: temporary, text: "done" });
		assert.equal(store.projectByRoot(temporary), undefined);
		await post("/api/report", { cwd, text: "done" });
		const candidate = store.projectByRoot(cwd);
		assert.equal(candidate.status, "pending");
		assert.ok(candidate.seenAt);
		store.updateProject(candidate.id, { seenAt: "2000-01-01T00:00:00.000Z" });
		await get("/api/brief?" + new URLSearchParams({ cwd, format: "json" }));
		await post("/api/ask", { cwd, question: "hello" });
		assert.equal(candidate.seenAt, "2000-01-01T00:00:00.000Z");
		await post("/api/report", { cwd, text: "done again" });
		assert.ok(candidate.seenAt > "2000-01-01T00:00:00.000Z");
		let board = await get("/api/board");
		assert.equal(board.projects.find((p) => p.id === candidate.id).seenAt, candidate.seenAt);
		assert.equal(board.projects.find((p) => p.id === candidate.id).status, "pending");
		await post("/api/projects/" + candidate.id, { status: "active" });
		assert.equal(candidate.status, "active");
		await post("/api/projects/" + candidate.id, { status: "ignored" });
		assert.equal(candidate.status, "ignored");
		const disappearing = dir("code/disappearing");
		await post("/api/report", { cwd: disappearing, text: "done" });
		const missing = store.projectByRoot(disappearing);
		rmSync(disappearing, { recursive: true });
		board = await get("/api/board");
		const cleaned = board.projects.find((p) => p.id === missing.id);
		assert.equal(cleaned.status, "ignored");
		assert.ok(cleaned.autoIgnoredAt);
		assert.equal(store.projects().length, board.projects.length);
	} finally {
		await stop();
		rmSync(temporary, { recursive: true, force: true });
	}
`));

test("啟動處在監看與服務啟動前清理一次", () => {
	const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
	assert.equal(main.match(/cleanupPendingProjects\(store\)/g)?.length, 1);
	assert.ok(main.indexOf("cleanupPendingProjects(store)") > main.indexOf("new Store(STORE_PATH)"));
	assert.ok(main.indexOf("cleanupPendingProjects(store)") < main.indexOf("watcher.start()"));
	assert.ok(main.indexOf("cleanupPendingProjects(store)") < main.indexOf("const stopServer = startServer"));
});

function webView(projects, sel = "misc") {
	const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
	const nodes = { nav: {}, brief: {} };
	const context = vm.createContext({
		state: { projects, cards: [] }, sel, wtCounts: {}, window: {},
		$: (id) => nodes[id] ?? null, byActivity: () => 0,
		esc: (s) => String(s ?? "").replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
		ago: (iso) => "ago:" + iso,
		tr: (s) => s,
	});
	vm.runInContext(html.slice(html.indexOf("function renderNav()"), html.indexOf("async function showSplit(p)")), context);
	vm.runInContext("renderNav(); renderBrief()", context);
	return nodes;
}

test("網頁:候選只出現在雜務頁最下方,依 seenAt/createdAt 排序且最多 20 筆", () => {
	const misc = { id: "misc", kind: "misc", name: "Misc", root: "(Misc)" };
	const project = { id: "project", kind: "project", status: "active", name: "Project", root: "/project" };
	const pending = Array.from({ length: 25 }, (_, i) => ({
		id: `p${i}`, kind: "project", status: "pending", root: `/code/${i}<script>`,
		createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
	}));
	pending[0].seenAt = "2026-02-01T00:00:00.000Z";
	const { nav, brief } = webView([misc, project, ...pending]);
	assert.doesNotMatch(nav.innerHTML, /要登記成專案嗎|data-reg|data-ign|\/code\//);
	assert.match(brief.innerHTML, /最近在這些資料夾工作過/);
	assert.equal((brief.innerHTML.match(/data-reg=/g) ?? []).length, 20);
	assert.ok(brief.innerHTML.indexOf('data-reg="p0"') < brief.innerHTML.indexOf('data-reg="p24"'));
	assert.ok(!brief.innerHTML.includes('data-reg="p5"'));
	assert.match(brief.innerHTML, /ago:2026-02-01/);
	assert.match(brief.innerHTML, /&lt;script&gt;/);
	assert.doesNotMatch(brief.innerHTML, /<script>/);
	assert.match(brief.innerHTML, /登記成專案/);
	assert.match(brief.innerHTML, /data-ign="p0"/);
	assert.doesNotMatch(webView([misc, project, ...pending], "project").brief.innerHTML, /recent-folders/);
	assert.doesNotMatch(webView([misc, project]).brief.innerHTML, /recent-folders/);
});
