import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const installer = fileURLToPath(new URL("../install.sh", import.meta.url));
const strings = JSON.parse(readFileSync(new URL("../i18n/installer.json", import.meta.url), "utf8"));
const unix = { skip: process.platform === "win32" };
const hash = (content) => createHash("sha256").update(content).digest("hex");

function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), "steward-install-verify-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const home = join(dir, "home");
	mkdirSync(home);
	const file = join(dir, "download");
	const original = Buffer.from([0, 1, 2, 3, 128, 255]);
	writeFileSync(file, original);
	const run = (path = process.env.PATH, expected = hash(original)) => spawnSync("/bin/sh", [
		"-c", 'STEWARD_SOURCE_ONLY=1 . "$1"; verify_sha256 "$2" "$3" fixture',
		"verify", installer, file, expected,
	], { encoding: "utf8", timeout: 10_000, env: { ...process.env, HOME: home, USERPROFILE: home, PATH: path, STEWARD_LANG: "en" } });
	return { dir, home, file, original, run };
}

test("installer accepts a matching SHA-256 when sourced without running main", unix, (t) => {
	const f = fixture(t);
	const result = f.run();
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.deepEqual(readFileSync(f.file), f.original);
	assert.deepEqual(readdirSync(f.home), [], "Sourcing must not run the installer");
});

test("installer rejects a changed byte and deletes the download", unix, (t) => {
	const f = fixture(t);
	const changed = Buffer.from(f.original);
	changed[2] ^= 1;
	writeFileSync(f.file, changed);
	const result = f.run();
	assert.notEqual(result.status, 0);
	assert.equal(existsSync(f.file), false);
	assert.ok((result.stdout + result.stderr).includes(strings.checksum_failed.en.replace("{0}", "fixture")), result.stderr);
	assert.deepEqual(readdirSync(f.home), []);
});

test("installer stops if PATH has neither sha256sum nor shasum", unix, (t) => {
	const f = fixture(t);
	const bin = join(f.dir, "bin");
	mkdirSync(bin);
	for (const command of ["sh", "cat", "rm"]) symlinkSync(join("/bin", command), join(bin, command));
	const result = f.run(bin);
	assert.notEqual(result.status, 0);
	assert.ok((result.stdout + result.stderr).includes(strings.no_hash_tool.en), result.stderr);
	assert.deepEqual(readdirSync(f.home), []);
});

test("installer rejects empty or invalid expected checksums", unix, (t) => {
	for (const expected of ["", "bad", "g".repeat(64)]) {
		const f = fixture(t);
		const result = f.run(process.env.PATH, expected);
		assert.notEqual(result.status, 0);
		assert.equal(existsSync(f.file), false);
		assert.ok(result.stderr.includes(strings.checksum_failed.en.replace("{0}", "fixture")), result.stderr);
	}
});
