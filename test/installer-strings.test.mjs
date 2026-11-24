import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const strings = JSON.parse(readFileSync(new URL("../i18n/installer.json", import.meta.url), "utf8"));
const handwritten = (source) => source.replace(/# ---- generated: begin \(scripts\/gen-install\.mjs\) ----[\s\S]*?# ---- generated: end ----/, "");

test("installer strings have both languages and ordered, matching placeholders", () => {
	for (const [key, translations] of Object.entries(strings)) {
		const counts = [];
		for (const lang of ["zh-TW", "en"]) {
			assert.equal(typeof translations[lang], "string", `${key}: ${lang}`);
			const indices = [...translations[lang].matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]));
			assert.deepEqual(indices, indices.map((_, i) => i), `${key}: ${lang} placeholder order`);
			counts.push(indices.length);
		}
		assert.equal(counts[0], counts[1], `${key}: placeholder count`);
	}
});

test("generated developer Unix installers are current", () => {
	const result = spawnSync(process.execPath, ["scripts/gen-install.mjs", "--check"], { cwd: ROOT, encoding: "utf8" });
	assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("herdr.json matches the component pin", () => {
	const components = JSON.parse(readFileSync(new URL("../components.json", import.meta.url), "utf8")).components;
	const herdr = components.find((c) => c.id === "herdr");
	assert.deepEqual(JSON.parse(readFileSync(new URL("../herdr.json", import.meta.url), "utf8")), {
		repo: herdr.repo, tag: herdr.tag, note: herdr.note["zh-TW"],
	});
});

test("literal message keys in both Unix installers exist", () => {
	for (const file of ["scripts/dev/install.sh", "scripts/dev/uninstall.sh"]) {
		const source = readFileSync(new URL("../" + file, import.meta.url), "utf8");
		const keys = [...handwritten(source).matchAll(/\b(?:msg|t|tl|say|warn|die)\s+['"]?([a-z][a-z0-9_-]*)(?=['"\s;]|$)/g)].map((m) => m[1]);
		assert.ok(keys.length > 0, file);
		for (const key of keys) assert.ok(Object.hasOwn(strings, key), `${file}: missing ${key}`);
	}
});

test("developer installer requires --from and includes the exact bilingual refusal messages", () => {
	const source = handwritten(readFileSync(new URL("../scripts/dev/install.sh", import.meta.url), "utf8"));
	assert.match(source, /if \[ -z "\$FROM" \]; then\s+L=zh-TW tl local_source_required >&2\s+L=en tl local_source_required >&2\s+exit 1\s+fi/);
	assert.deepEqual(strings.local_source_required, {
		"zh-TW": "一行指令安裝已停止支援。請到 https://github.com/hao-github-0216/agent-steward/releases/latest 下載桌面 App。這個腳本只給開發者部署用：sh scripts/dev/install.sh --from <repo 資料夾>",
		en: "The one-line installer is no longer supported. Download the desktop app from https://github.com/hao-github-0216/agent-steward/releases/latest. This script is only for developer deployments: sh scripts/dev/install.sh --from <repo folder>",
	});
	for (const lang of ["zh-TW", "en"]) assert.ok(strings.local_source_required[lang].includes("releases/latest"));
});

for (const lang of ["zh-TW", "en"]) test(`developer installer refuses --yes without --from in ${lang} without writing HOME`, { skip: process.platform === "win32" }, (t) => {
	const home = mkdtempSync(join(tmpdir(), "steward-missing-from-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const result = spawnSync("/usr/bin/env", [
		"-i", `HOME=${home}`, `USERPROFILE=${home}`, "PATH=/usr/bin:/bin", "LANG=en_US.UTF-8",
		"sh", "scripts/dev/install.sh", "--yes", "--lang", lang,
	], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
	assert.equal(result.error, undefined);
	assert.equal(result.signal, null);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, strings.local_source_required["zh-TW"] + "\n" + strings.local_source_required.en + "\n");
	assert.deepEqual(readdirSync(home), [], "Refusal must not write to HOME");
});

test("--skip-herdr only skips the herdr download without omitting components", { skip: process.platform === "win32" }, (t) => {
	const home = mkdtempSync(join(tmpdir(), "steward-skip-herdr-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const result = spawnSync("/usr/bin/env", [
		"-i", `HOME=${home}`, "PATH=/usr/bin:/bin", "LANG=en_US.UTF-8",
		"sh", "scripts/dev/install.sh", "--from", ".", "--dry-run", "--skip-herdr",
	], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.ok(result.stdout.includes(strings.plan_herdr_skipped.en), result.stdout);
	assert.doesNotMatch(result.stdout, /這次不裝|Omitted this time/);
	assert.ok(result.stdout.includes("Two herdr plugins"), result.stdout);
	assert.ok(result.stdout.includes(process.platform === "darwin" ? "com.agent-steward.terminal" : "agent-steward-terminal"), result.stdout);
	assert.deepEqual(readdirSync(home), [], "Dry run must not write to HOME");
});

test("component sizes are localized", () => {
	const components = JSON.parse(readFileSync(new URL("../components.json", import.meta.url), "utf8")).components;
	for (const c of components) {
		const sizes = c.size.download ? [c.size.download, c.size.deps] : [c.size];
		for (const size of sizes) for (const lang of ["zh-TW", "en"]) assert.equal(typeof size[lang], "string", c.id + ": " + lang);
	}
});
