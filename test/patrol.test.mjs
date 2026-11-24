import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const DATA = mkdtempSync(join(tmpdir(), "steward-patrol-"));
process.env.HOME = DATA;
process.env.USERPROFILE = DATA;
process.env.STEWARD_DATA_DIR = DATA;
after(() => rmSync(DATA, { recursive: true, force: true }));
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ version: 1, ui: { lang: "zh-TW" }, aiDetected: true, setupDone: true, plugins: { notebook: { pythons: [] } } }));
const { DEFAULTS, settings } = await import("../src/settings.ts");
const { Store } = await import("../src/store.ts");
const { Steward } = await import("../src/steward.ts");
const { collectSignals, patrolDue, patrolMessage, repoGit, repoList, repoRead } = await import("../src/patrol.ts");
const checks = { docs: false, untracked: false, ci: false, state: false };
const cfg = { ...DEFAULTS.patrol };
const NOW = Date.parse("2026-11-20T12:00:00Z");
const DAY = 24 * 3_600_000;

function git(root, ...args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
}
function repo() {
	const root = mkdtempSync(join(DATA, "repo-"));
	git(root, "init", "-q");
	git(root, "config", "user.email", "patrol-test@example.invalid");
	git(root, "config", "user.name", "Patrol Test");
	git(root, "config", "commit.gpgsign", "false");
	writeFileSync(join(root, "README.md"), "# Test\nRead me.\n");
	git(root, "add", "README.md");
	git(root, "commit", "-qm", "initial docs");
	return root;
}
function project(patch = {}) {
	return { id: "test", name: "Test", root: DATA, kind: "project", status: "active", private: false, ...patch };
}

for (const count of [5, 3]) test(`docs:文件之後有 ${count} 個改程式的 commit`, () => {
	const root = repo();
	mkdirSync(join(root, "src"));
	for (let n = 1; n <= count; n++) {
		writeFileSync(join(root, "src", "a.ts"), `export const value = ${n};\n`);
		git(root, "add", "src/a.ts");
		git(root, "commit", "-qm", `change code ${n}`);
	}
	const s = collectSignals(root, { checks: { ...checks, docs: true }, since: "2000-01-01T00:00:00Z" });
	assert.equal(s.isGit, true);
	assert.equal(s.head, git(root, "rev-parse", "HEAD"));
	assert.equal(s.newCommits.length, count + 1);
	if (count < 5) assert.deepEqual(s.docs, []);
	else {
		assert.equal(s.docs.length, 1);
		assert.equal(s.docs[0].file, "README.md");
		assert.equal(s.docs[0].behind, 5);
		assert.match(s.docs[0].lastChanged, /^\d{4}-/);
		assert.deepEqual(s.docs[0].subjects.map((s) => s.slice(s.indexOf(" ") + 1)), [5, 4, 3, 2, 1].map((n) => `change code ${n}`));
	}
});

test("untracked:只列放了至少 3 天的檔案,略過 .DS_Store", () => {
	const root = repo(), now = Date.now();
	for (const f of ["old.txt", "new.txt", ".DS_Store"]) writeFileSync(join(root, f), f);
	for (const f of ["old.txt", ".DS_Store"]) utimesSync(join(root, f), new Date(now - 4 * DAY), new Date(now - 4 * DAY));
	const s = collectSignals(root, { checks: { ...checks, untracked: true }, now });
	assert.deepEqual(s.untracked, [{ path: "old.txt", kind: "untracked", days: 4 }]);
});

test("untracked:辨識已追蹤的改動、空白檔名與舊資料夾", () => {
	const root = repo(), now = Date.now();
	writeFileSync(join(root, "README.md"), "changed\n");
	writeFileSync(join(root, "old file.txt"), "old\n");
	mkdirSync(join(root, "old-dir"));
	writeFileSync(join(root, "old-dir", "file.txt"), "old\n");
	for (const f of ["README.md", "old file.txt", "old-dir"]) utimesSync(join(root, f), new Date(now - 4 * DAY), new Date(now - 4 * DAY));
	const s = collectSignals(root, { checks: { ...checks, untracked: true }, now });
	assert.deepEqual(s.untracked, [
		{ path: "README.md", kind: "modified", days: 4 },
		{ path: "old file.txt", kind: "untracked", days: 4 },
		{ path: "old-dir/", kind: "untracked", days: 4 },
	]);
});

test("非 git 資料夾與失敗的外部指令不會丟錯", () => {
	assert.equal(collectSignals(DATA, { checks: DEFAULTS.patrol.checks }).isGit, false);
	assert.equal(collectSignals(join(DATA, "missing"), { checks: DEFAULTS.patrol.checks }).isGit, false);
});

test("patrolDue:依序排除未啟用、特殊類型、隱私與不存在的專案", () => {
	for (const patch of [{ private: true }, { kind: "misc" }, { kind: "overview" }, { status: "closed" }, { status: "pending" }, { status: "ignored" }]) {
		assert.equal(patrolDue(project(patch), "head", cfg, NOW, true).due, false);
	}
	assert.equal(patrolDue(project(), "head", { ...cfg, enabled: false }, NOW, true).due, false);
	assert.equal(patrolDue(project(), "head", cfg, NOW, false).due, false);
	assert.equal(patrolDue(project(), "head", cfg, NOW, true).due, true);
});

test("patrolDue:間隔、HEAD、活動與 7 天保底", () => {
	const last = (age) => ({ at: new Date(NOW - age).toISOString(), head: "same", summary: "none", proposed: 0 });
	assert.equal(patrolDue(project({ lastPatrol: last(1 * 3_600_000) }), "changed", cfg, NOW, true).due, false);
	assert.equal(patrolDue(project({ lastPatrol: last(2 * DAY) }), "same", cfg, NOW, true).due, false);
	assert.equal(patrolDue(project({ lastPatrol: last(2 * DAY) }), "changed", cfg, NOW, true).due, true);
	assert.equal(patrolDue(project({ lastPatrol: last(8 * DAY) }), "same", cfg, NOW, true).due, true);
	assert.equal(patrolDue(project({ lastPatrol: last(2 * DAY), lastActivityAt: new Date(NOW - DAY).toISOString() }), "same", cfg, NOW, true).due, true);
});

test("repoGit:只接受唯讀指令,不能指定外部執行或輸出檔案", () => {
	const root = repo();
	for (const args of [["push"], ["-c", "core.pager=sh", "log"], ["log", "--output=/tmp/x"], ["diff", "--ext-diff"], ["show", "--textconv"], ["log", "--exec=sh"], ["log", "-o/tmp/x"], ["diff", "--no-index", "/etc/hosts", "/dev/null"]]) assert.throws(() => repoGit(root, args));
	assert.match(repoGit(root, ["log", "--oneline"]), /initial docs/);
});

test("repoRead:拒絕路徑越界與 symlink,加上行號", () => {
	const root = repo();
	writeFileSync(join(DATA, "x"), "outside\n");
	assert.throws(() => repoRead(root, "../x"));
	assert.throws(() => repoRead(root, "/etc/hosts"));
	const outside = mkdtempSync(join(DATA, "outside-"));
	writeFileSync(join(outside, "x"), "outside\n");
	symlinkSync(outside, join(root, "outside"), process.platform === "win32" ? "junction" : "dir");
	assert.throws(() => repoRead(root, "outside/x"));
	assert.match(repoRead(root, "README.md"), /^1: # Test\n2: Read me\./);
	assert.equal(repoRead(root, "README.md", 1, 1), "2: Read me.");
	assert.throws(() => repoRead(root, "missing"), /找不到/);
});

test("repoRead:拒絕二進位與大檔案,最多讀 800 行", () => {
	const root = repo();
	writeFileSync(join(root, "binary"), Buffer.from([65, 0, 66]));
	writeFileSync(join(root, "large"), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
	writeFileSync(join(root, "lines"), Array.from({ length: 900 }, (_, i) => String(i)).join("\n"));
	assert.throws(() => repoRead(root, "binary"), /二進位/);
	assert.throws(() => repoRead(root, "large"), /2MB/);
	assert.equal(repoRead(root, "lines", 0, 900).split("\n").length, 800);
});

test("repoList:只列一層,略過 .git 與 node_modules", () => {
	const root = repo();
	mkdirSync(join(root, "node_modules"));
	mkdirSync(join(root, "src"));
	assert.deepEqual(repoList(root).split("\n").sort(), ["README.md", "src/"]);
	assert.throws(() => repoList(root, ".."));
});

test("設定:新設定與沒有 patrol 的舊設定都補上巡檢預設值", () => {
	const expected = { enabled: true, everyHours: 24, maxCards: 2, checks: { docs: true, untracked: true, ci: true, state: true }, extra: "" };
	assert.deepEqual(DEFAULTS.patrol, expected);
	assert.deepEqual(settings().patrol, expected);
});

test("patrolMessage:限制未處理的提案,記住被拒絕的標題", () => {
	const empty = { isGit: true, newCommits: [], docs: [], untracked: [], ci: [] };
	const msg = patrolMessage(project(), empty, { ...cfg, extra: "新 API 要有測試" }, ["被拒絕的文件重寫"], 3);
	assert.match(msg, /^【巡檢】/);
	assert.match(msg, /不要開新卡/);
	assert.match(msg, /被拒絕的文件重寫/);
	assert.match(msg, /新 API 要有測試/);
	assert.match(msg, /總結:/);
	assert.ok(!msg.includes("文件可能落後:"));
	assert.match(patrolMessage(project(), empty, cfg, [], 0), /最多提案 2 張/);
});

function stewardFixture() {
	const dir = mkdtempSync(join(DATA, "store-"));
	const store = new Store(join(dir, "state.json"));
	const p = store.addProject({ root: repo(), name: "Patrol", kind: "project", status: "active", private: false });
	return { store, p, steward: new Steward({ store }) };
}

test("patrol:記錄摘要與實際提案數,成功或失敗都清除預算", async () => {
	const { steward, store, p } = stewardFixture();
	steward.send = async (_p, message, opts) => {
		assert.equal(opts.role, "patrol");
		assert.equal(opts.timeoutMs, 600_000);
		assert.match(message, /^【巡檢】/);
		steward.patrolBudget.set(p.id, steward.patrolBudget.get(p.id) - 1);
		return "已查證 README.md。\n總結:文件需要更新。";
	};
	const result = await steward.patrol(p);
	assert.equal(result.summary, "文件需要更新。");
	assert.equal(result.proposed, 1);
	assert.equal(steward.patrolBudget.size, 0);
	assert.equal(store.project(p.id).lastPatrol.head, git(p.root, "rev-parse", "HEAD"));
	assert.equal(store.project(p.id).lastPatrol.proposed, 1);
	assert.match((await steward.patrol(p)).skipped, /還沒到巡檢時間/);
	const before = { ...p.lastPatrol };
	steward.send = async () => { throw new Error("test patrol failure"); };
	await assert.rejects(steward.patrol(p, { force: true }), /test patrol failure/);
	assert.equal(steward.patrolBudget.size, 0);
	assert.equal(steward.patrolLastError, "test patrol failure");
	assert.deepEqual(p.lastPatrol, before);
});

test("patrol:已有三張提案時預算與本次張數都是 0,只帶最近拒絕的標題", async () => {
	const { steward, store, p } = stewardFixture();
	const card = (title) => ({ projectId: p.id, title, agent: "pi", instructions: "test", doneCriteria: "test" });
	for (let i = 0; i < 3; i++) store.addCard(card(`open ${i}`));
	store.addCard({ ...card("recent rejected"), column: "rejected" });
	const old = store.addCard({ ...card("old rejected"), column: "rejected" });
	old.updatedAt = new Date(Date.now() - 31 * DAY).toISOString();
	steward.send = async (_p, message) => {
		assert.equal(steward.patrolBudget.get(p.id), 0);
		assert.match(message, /不要開新卡/);
		assert.match(message, /recent rejected/);
		assert.ok(!message.includes("old rejected"));
		return "無";
	};
	const result = await steward.patrol(p);
	assert.equal(result.proposed, 0);
	assert.equal(result.summary, "無");
});

test("patrol:手動也不巡隱私專案、雜務與總覽", async () => {
	const { steward, p } = stewardFixture();
	steward.send = async () => assert.fail("不應送出模型請求");
	for (const patch of [{ private: true }, { kind: "misc" }, { kind: "overview" }]) {
		assert.ok((await steward.patrol({ ...p, ...patch }, { force: true })).skipped);
	}
});

test("modelFor:巡檢沿用 judge 路由,其他角色移除 repo 工具,快取會跟著工具變化", async () => {
	const { steward, p } = stewardFixture();
	const routing = settings().routing;
	const before = structuredClone(routing);
	try {
		for (const role of ["judge", "digest", "chat"]) routing[role] = { primary: "test/main", fallback: "test/backup" };
		routing.privacy = "test/private";
		steward.proposeTool = { name: "propose_card" };
		steward.repoTools = [{ name: "repo_list" }, { name: "repo_read" }, { name: "repo_git" }];
		assert.equal(steward.modelFor(p, "patrol").modelTools, null);
		assert.equal(steward.modelFor(p, "patrol", true).model.modelId, "backup");
		assert.deepEqual(steward.modelFor(p, "judge").modelTools.remove, steward.repoTools);
		for (const role of ["chat", "digest"]) assert.deepEqual(steward.modelFor(p, role).modelTools.remove, [steward.proposeTool, ...steward.repoTools]);
		assert.ok(steward.modelFor({ ...p, private: true }, "patrol").modelTools.remove.includes(steward.proposeTool));
		const calls = [];
		const conv = { id: "test", configure: async (change) => calls.push(change) };
		await steward.ensureConfigured(p, conv, "judge");
		await steward.ensureConfigured(p, conv, "patrol");
		await steward.ensureConfigured(p, conv, "patrol");
		await steward.ensureConfigured(p, conv, "judge");
		assert.equal(calls.length, 3);
	} finally { Object.assign(routing, before); }
});

test("send:巡檢的主要模型失敗時改用 judge 的備用模型", async () => {
	const { steward, p } = stewardFixture();
	const oldJudge = settings().routing.judge;
	settings().routing.judge = { primary: "test/main", fallback: "test/backup" };
	const calls = [];
	steward.sendOnce = async (_p, _message, opts) => {
		calls.push(opts);
		if (!opts.fallback) throw new Error("primary failed");
		return "backup answer";
	};
	try {
		assert.equal(await steward.send(p, "test", { role: "patrol" }), "backup answer");
		assert.equal(calls.length, 2);
		assert.equal(calls[1].role, "patrol");
		assert.equal(calls[1].fallback, true);
	} finally { settings().routing.judge = oldJudge; }
});

test("onPatrolTick:一次只巡一個專案,重疊的 tick 不會再送出請求", async () => {
	const { steward, store, p } = stewardFixture();
	store.addProject({ root: p.root + "-private", name: "Private", kind: "project", status: "active", private: true });
	store.addProject({ root: repo(), name: "Second", kind: "project", status: "active", private: false });
	const calls = [];
	let release;
	steward.patrol = async (target) => { calls.push(target.id); await new Promise((resolve) => { release = resolve; }); };
	const first = steward.onPatrolTick();
	await steward.onPatrolTick();
	assert.deepEqual(calls, [p.id]);
	release();
	await first;
	assert.equal(steward.patrolRunning, false);
	assert.ok(steward.patrolLastTickAt);
});

test("durable 鬧鐘只建一次,repo 工具可重播,提案工具確實執行張數上限", async () => {
	const { steward, store, p } = stewardFixture();
	const oldCfg = settings().patrol;
	const oldJudge = settings().routing.judge;
	settings().patrol = { ...oldCfg, enabled: false, maxCards: 1 };
	settings().routing.judge = { primary: "test/main", fallback: "" };
	try {
		await steward.open();
		assert.equal((await steward.patrolStatus()).clock, 1);
		await steward.ensurePatrolClock();
		assert.equal((await steward.patrolStatus()).clock, 1);
		const conv = await steward.conversation(p);
		const api = { conversationId: conv.id };
		assert.deepEqual(steward.repoTools.map((t) => t.name), ["repo_list", "repo_read", "repo_git"]);
		assert.ok(steward.repoTools.every((t) => t.replay === "safe"));
		assert.match((await steward.repoTools[1].execute({ path: "README.md" }, api)).output[0].text, /^1: # Test/);
		steward.send = async () => {
			const args = { title: "Update docs", agent: "pi", instructions: "Update README.md", done_criteria: "Docs match the repo" };
			// 真正的 send 輪到巡檢這一題時才標記專案正在巡檢
			steward.patrolActive.add(p.id);
			try {
				await steward.proposeTool.execute(args, api);
				assert.match((await steward.proposeTool.execute(args, api)).output[0].text, /提案已達上限/);
			} finally {
				steward.patrolActive.delete(p.id);
			}
			// 不在巡檢這一題時(例如排在前面的提案檢查),張數上限不套用
			assert.doesNotMatch((await steward.proposeTool.execute(args, api)).output[0].text, /提案已達上限/);
			return "總結:開了一張提案。";
		};
		assert.equal((await steward.patrol(p, { force: true })).proposed, 1);
		assert.equal(store.cards(p.id).length, 2);
	} finally {
		if (steward.harness) await steward.close();
		settings().patrol = oldCfg;
		settings().routing.judge = oldJudge;
	}
});

test("Agent 設定頁:呈現巡檢紀錄並安全跳脫專案名稱與摘要", () => {
	const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
	const source = html.match(/^function agentsPane\(\) \{[\s\S]*?^\}/m)[0];
	const state = { projects: [] };
	const context = {
		setAgents: [], setState: { s: { cards: { defaultAgent: "" }, patrol: cfg } }, state,
		agentIdOf: () => "", agentRow: () => "",
		tr: (text, vars = {}) => text.replace(/\{([^{}]+)\}/g, (_m, key) => String(vars[key])),
		esc: (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
	};
	const render = runInNewContext(source + "\nagentsPane", context);
	assert.match(render(), /還沒有巡檢紀錄/);
	for (const key of ["enabled", "everyHours", "maxCards", "checks.docs", "checks.untracked", "checks.ci", "checks.state", "extra"]) assert.ok(render().includes(`data-k="patrol.${key}"`));
	state.projects.push({ name: "<project>", lastPatrol: { at: new Date(NOW).toISOString(), proposed: 2, summary: "<script>test</script>" } });
	const out = render();
	assert.match(out, /&lt;project&gt;/);
	assert.match(out, /開了 2 張提案卡/);
	assert.match(out, /&lt;script&gt;test&lt;\/script&gt;/);
	assert.ok(!out.includes("<script>test</script>"));
});

test("設定頁存檔:巡檢數字維持 number,checkbox 是 boolean,textarea 保留文字", () => {
	const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
	const source = html.match(/^function collectSettings\(\) \{[\s\S]*?^\}/m)[0];
	const s = { patrol: structuredClone(cfg) };
	const input = (key, value, type, numeric = false) => ({ dataset: { k: `patrol.${key}` }, value, type, checked: false, hasAttribute: (attr) => attr === "data-num" && numeric });
	const inputs = [input("everyHours", "48", "number", true), input("maxCards", "0", "number", true), input("enabled", "on", "checkbox"), input("extra", "注意測試\n與文件", "textarea")];
	const modal = { querySelectorAll: (selector) => selector === "[data-k]" ? inputs : [] };
	runInNewContext(source + "\ncollectSettings()", { $: () => modal, setState: { s } });
	assert.equal(s.patrol.everyHours, 48);
	assert.equal(s.patrol.maxCards, 0);
	assert.equal(s.patrol.enabled, false);
	assert.equal(s.patrol.extra, "注意測試\n與文件");
});

test("patrol.ts 的所有 tr() 字串都有英文,參數名稱一致", () => {
	const source = readFileSync(new URL("../src/patrol.ts", import.meta.url), "utf8");
	const en = JSON.parse(readFileSync(new URL("../web/i18n/en.json", import.meta.url), "utf8"));
	const params = (text) => [...text.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]).sort();
	for (const m of source.matchAll(/\btr\("((?:\\.|[^"\\])*)"/g)) {
		const key = JSON.parse('"' + m[1] + '"');
		assert.equal(typeof en[key], "string", key);
		assert.deepEqual(params(en[key]), params(key), key);
	}
});

for (const response of [{ skipped: "隱私專案不巡檢" }, { summary: "需要補文件", proposed: 2 }]) test(`CLI patrol:${response.skipped ? "略過" : "完成"}`, () => {
	const preload = join(DATA, response.skipped ? "cli-skipped.mjs" : "cli-done.mjs");
	writeFileSync(preload, `import assert from "node:assert/strict";
		globalThis.fetch = async (url, init) => {
			assert.ok(url.endsWith("/api/patrol/run"));
			assert.equal(init.method, "POST");
			assert.equal(JSON.parse(init.body).cwd, ${JSON.stringify(DATA)});
			return new Response(${JSON.stringify(JSON.stringify(response))});
		};`);
	const out = execFileSync(process.execPath, ["--import", pathToFileURL(preload).href, fileURLToPath(new URL("../bin/steward.mjs", import.meta.url)), "patrol", "--cwd", DATA], { encoding: "utf8", timeout: 5000 });
	if (response.skipped) assert.equal(out, "沒有巡檢:隱私專案不巡檢\n");
	else assert.equal(out, "需要補文件\n開了 2 張提案卡\n");
});
