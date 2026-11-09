import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../src/install-receipt.ts", import.meta.url));
const FLAGS = ["--experimental-strip-types", "--no-warnings"];
function isolated(t) {
	const dir = mkdtempSync(join(tmpdir(), "steward-receipt-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const env = { ...process.env, HOME: dir, USERPROFILE: dir, STEWARD_DATA_DIR: dir, STEWARD_LANG: "en" };
	const cli = (...args) => {
		const result = spawnSync(process.execPath, [...FLAGS, SCRIPT, ...args], { env, encoding: "utf8", timeout: 10_000 });
		assert.equal(result.status, 0, result.stdout + result.stderr);
		return result.stdout.trimEnd();
	};
	return { dir, env, cli, receipt: () => JSON.parse(readFileSync(join(dir, "install.json"), "utf8")) };
}

test("receipt set shallowly merges fields and preserves installedAt", (t) => {
	const { cli, receipt } = isolated(t);
	cli("set", JSON.stringify({ lang: "en", without: "open", app: { version: "v0.1.0", old: true } }));
	const first = receipt();
	cli("set", JSON.stringify({ app: { version: "v0.2.0" }, installedAt: "should not replace" }));
	const next = receipt();
	assert.equal(next.version, 1);
	assert.equal(next.lang, "en");
	assert.equal(next.without, "open");
	assert.deepEqual(next.app, { version: "v0.2.0" });
	assert.equal(next.installedAt, first.installedAt);
	assert.notEqual(next.updatedAt, first.updatedAt);
	assert.ok(Number.isFinite(Date.parse(next.updatedAt)));
});

test("receipt changes are deduplicated by type and path", (t) => {
	const { cli, receipt } = isolated(t);
	cli("change", "file", "/example/app", "first");
	cli("change", "file", "/example/app", "updated");
	cli("change", "modified", "/example/app");
	assert.deepEqual(receipt().changes, [
		{ type: "file", path: "/example/app", note: "updated" },
		{ type: "modified", path: "/example/app" },
	]);
	cli("set", JSON.stringify({ changes: [{ type: "file", path: "/example/app", note: "set" }] }));
	assert.equal(receipt().changes.length, 2);
	assert.equal(receipt().changes[0].note, "set");
});

test("receipt backup paths are deduplicated across backup and set", (t) => {
	const { cli, receipt } = isolated(t);
	cli("backup", "/example/config.bak");
	cli("backup", "/example/config.bak");
	cli("set", JSON.stringify({ backups: ["/example/config.bak", "/example/other.bak"] }));
	assert.deepEqual(receipt().backups, ["/example/config.bak", "/example/other.bak"]);
});

test("receipt get reads nested fields and prints an empty string for missing fields", (t) => {
	const { cli } = isolated(t);
	assert.equal(cli("get", "node.path"), "");
	cli("set", JSON.stringify({ node: { path: "/example/node", source: "download" }, herdrKeyAdded: false }));
	assert.equal(cli("get", "node.path"), "/example/node");
	assert.equal(cli("get", "node.source"), "download");
	assert.equal(cli("get", "herdrKeyAdded"), "false");
	assert.equal(cli("get", "app.version"), "");
});

test("receipt lang and without are single-line strings with tab indentation", (t) => {
	const { dir, cli } = isolated(t);
	cli("set", JSON.stringify({ lang: "zh-TW", without: "herdr-config,open" }));
	const text = readFileSync(join(dir, "install.json"), "utf8");
	assert.match(text, /^\t"lang": "zh-TW",?$/m);
	assert.match(text, /^\t"without": "herdr-config,open",?$/m);
	assert.equal(text, JSON.stringify(JSON.parse(text), null, "\t") + "\n");
});

test("receipt summary uses the requested language", (t) => {
	const { cli } = isolated(t);
	cli("change", "file", "/example/app", "example");
	cli("backup", "/example/config.bak");
	assert.match(cli("summary", "en"), /Changes made by the installer \(recorded in install\.json\):[\s\S]*File: \/example\/app — example[\s\S]*Backup:/);
	assert.match(cli("summary", "zh-TW"), /安裝程式做過的改動（記在 install\.json）：[\s\S]*檔案：[\s\S]*備份：/);
});

test("receipt summary abbreviates home paths without changing stored paths", (t) => {
	const { dir, cli, receipt } = isolated(t);
	const app = join(dir, ".agent-steward", "app");
	const backup = join(dir, ".config", "herdr", "config.toml.bak");
	const sibling = dir + "-other";
	cli("change", "file", dir);
	cli("change", "file", app);
	cli("change", "symlink", sibling);
	cli("backup", backup);
	const before = readFileSync(join(dir, "install.json"), "utf8");
	const summary = cli("summary", "en");
	assert.match(summary, /File: ~\n/);
	assert.ok(summary.includes(`File: ~${sep}.agent-steward${sep}app`));
	assert.ok(summary.includes(`Backup: ~${sep}.config${sep}herdr${sep}config.toml.bak`));
	assert.ok(summary.includes(`Symlink: ${sibling}`));
	assert.equal(receipt().changes[1].path, app);
	assert.equal(receipt().backups[0], backup);
	assert.equal(readFileSync(join(dir, "install.json"), "utf8"), before);
});

test("receipt summary accepts a custom header key", (t) => {
	const { cli } = isolated(t);
	assert.equal(cli("summary", "en"), "Changes made by the installer (recorded in install.json):");
	assert.equal(cli("summary", "en", "uninstall_receipt_header"), "Changes made at install time (now removed):");
	assert.equal(cli("summary", "zh-TW", "uninstall_receipt_header"), "安裝時做過的改動（已移除）：");
});

test("receipt module can be imported without executing its CLI or writing settings", (t) => {
	const { dir, env } = isolated(t);
	const result = spawnSync(process.execPath, [...FLAGS, "--input-type=module", "--eval",
		`const m = await import(${JSON.stringify(new URL("../src/install-receipt.ts", import.meta.url).href)}); console.log(m.readReceipt());`],
		{ env, encoding: "utf8", timeout: 10_000 });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), "null");
	assert.throws(() => readFileSync(join(dir, "settings.json")), { code: "ENOENT" });
});

test("settings inherit receipt language only when ui.lang is empty", (t) => {
	for (const [configured, expected] of [["", "en"], ["zh-TW", "zh-TW"]]) {
		const { dir, env, cli } = isolated(t);
		cli("set", JSON.stringify({ lang: "en", without: "" }));
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ version: 1, ui: { lang: configured }, plugins: {}, access: { tailscale: { enabled: false } }, setupDone: true }));
		const result = spawnSync(process.execPath, [...FLAGS, "--input-type=module", "--eval",
			`const {settings} = await import(${JSON.stringify(new URL("../src/settings.ts", import.meta.url).href)});console.log(settings().ui.lang);`],
			{ env, encoding: "utf8", timeout: 10_000 });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), expected);
		assert.equal(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).ui.lang, expected);
	}
});
