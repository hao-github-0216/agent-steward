import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);

function isolatedReceipt(t) {
	const dir = mkdtempSync(join(tmpdir(), "steward-ps1-receipt-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const env = { ...process.env, HOME: dir, USERPROFILE: dir, STEWARD_DATA_DIR: dir, STEWARD_LANG: "en" };
	const run = (...args) => spawnSync(process.execPath, [
		"--experimental-strip-types", "--no-warnings", fileURLToPath(new URL("src/install-receipt.ts", root)), ...args,
	], { env, encoding: "utf8", timeout: 10_000 });
	const cli = (...args) => {
		const result = run(...args);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		return result.stdout;
	};
	return { dir, cli, run, receipt: () => JSON.parse(readFileSync(join(dir, "install.json"), "utf8")) };
}

test("receipt set-file preserves Windows paths, quotes, Unicode and cumulative PATH additions", (t) => {
	const { dir, cli, receipt } = isolatedReceipt(t);
	const path = join(dir, "receipt patch's.json");
	const localBin = "C:\\Users\\王 O'Brien\\.local\\bin";
	const herdrDir = "C:\\Users\\王 O'Brien\\.agent-steward\\bin\\herdr";
	const patch = {
		lang: "zh-TW", without: "autostart,open", app: { version: 'v1-{test}-"quoted"' },
		node: { path: "C:\\Program Files\\nodejs\\node.exe", source: "existing" }, pathAdded: [localBin],
	};
	writeFileSync(path, JSON.stringify(patch));
	cli("set-file", path);
	for (const [key, value] of Object.entries(patch)) assert.deepEqual(receipt()[key], value);
	writeFileSync(path, "\uFEFF" + JSON.stringify({ pathAdded: [localBin, herdrDir], without: "open" }));
	cli("set-file", path);
	writeFileSync(path, JSON.stringify({ pathAdded: [] }));
	cli("set-file", path);
	assert.deepEqual(receipt().pathAdded, [localBin, herdrDir]);
	assert.equal(receipt().without, "open");
	assert.deepEqual(receipt().node, patch.node);
	assert.equal(receipt().app.version, patch.app.version);
});

test("receipt records scheduled tasks and summarizes them in both languages", (t) => {
	const { cli, receipt } = isolatedReceipt(t);
	cli("change", "scheduled-task", "agent-steward");
	cli("change", "scheduled-task", "agent-steward-terminal");
	cli("change", "scheduled-task", "agent-steward");
	assert.deepEqual(receipt().changes, [
		{ type: "scheduled-task", path: "agent-steward" },
		{ type: "scheduled-task", path: "agent-steward-terminal" },
	]);
	assert.match(cli("summary", "en"), /Scheduled task: agent-steward\n/);
	assert.match(cli("summary", "zh-TW", "uninstall_receipt_header"), /安裝時做過的改動（已移除）：[\s\S]*工作排程器：agent-steward-terminal/);
});

test("receipt set-file rejects invalid patches without writing a receipt", (t) => {
	const { dir, run } = isolatedReceipt(t);
	const path = join(dir, "bad.json");
	for (const value of ["{broken", "null", "[]", "false"]) {
		writeFileSync(path, value);
		const result = run("set-file", path);
		assert.notEqual(result.status, 0);
		assert.throws(() => readFileSync(join(dir, "install.json")), { code: "ENOENT" });
	}
	assert.notEqual(run("set-file", join(dir, "missing.json")).status, 0);
});
