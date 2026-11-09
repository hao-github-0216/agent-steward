import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function isolated(t) {
	const dir = mkdtempSync(join(tmpdir(), "steward-herdr-receipt-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const config = join(dir, "herdr", "config.toml");
	const src = join(dir, "app", "src");
	mkdirSync(src, { recursive: true });
	mkdirSync(join(dir, "app", "i18n"), { recursive: true });
	for (const name of ["herdr-setup.ts", "install-receipt.ts", "platform.ts"]) copyFileSync(new URL("../src/" + name, import.meta.url), join(src, name));
	copyFileSync(new URL("../i18n/installer.json", import.meta.url), join(dir, "app", "i18n", "installer.json"));
	const script = join(src, "herdr-setup.ts");
	const env = {
		...process.env, HOME: dir, XDG_CONFIG_HOME: dir, USERPROFILE: dir, APPDATA: dir,
		STEWARD_DATA_DIR: dir, STEWARD_LANG: "en",
	};
	const run = (...args) => {
		const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, ...args], { env, encoding: "utf8", timeout: 10_000 });
		assert.equal(result.status, 0, result.stdout + result.stderr);
		return result.stdout;
	};
	return { dir, config, run, receipt: () => JSON.parse(readFileSync(join(dir, "install.json"), "utf8")) };
}

test("herdr setup records its shortcut, respects removal, and supports --readd", (t) => {
	const { dir, config, run, receipt } = isolated(t);
	mkdirSync(join(dir, "herdr"), { recursive: true });
	const original = '[general]\ntheme = "dark"\n';
	writeFileSync(config, original);
	run();
	assert.match(readFileSync(config, "utf8"), /key = "prefix\+e"/);
	assert.match(readFileSync(config, "utf8"), /folder_nav\.mjs/);
	assert.equal(receipt().herdrKeyAdded, true);
	assert.equal(receipt().backups.length, 1);
	assert.equal(readFileSync(receipt().backups[0], "utf8"), original);
	assert.ok(receipt().changes.some((c) => c.type === "modified" && c.path === config));

	writeFileSync(config, original);
	const explanation = run();
	assert.equal(readFileSync(config, "utf8"), original);
	assert.match(explanation, /You removed the herdr folder-navigation shortcut.*--readd-herdr-key/);

	run("--readd");
	assert.match(readFileSync(config, "utf8"), /key = "prefix\+e"/);
	assert.equal(receipt().herdrKeyAdded, true);
	assert.equal(receipt().backups.length, 1);
});

test("herdr setup updates the command without replacing a customized shortcut", (t) => {
	const { config, run, receipt } = isolated(t);
	run();
	const current = readFileSync(config, "utf8");
	writeFileSync(config, current.replace('key = "prefix+e"', 'key = "prefix+g"').replace(/^command = .*$/m, 'command = "node old/folder_nav.mjs"'));
	run();
	const updated = readFileSync(config, "utf8");
	assert.match(updated, /key = "prefix\+g"/);
	assert.doesNotMatch(updated, /old\/folder_nav\.mjs/);
	assert.equal(receipt().herdrKeyAdded, true);
	run("--remove");
	assert.doesNotMatch(readFileSync(config, "utf8"), /\[\[keys\.command\]\]/);
});
