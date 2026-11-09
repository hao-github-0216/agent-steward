import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const strings = JSON.parse(readFileSync(new URL("../i18n/installer.json", import.meta.url), "utf8"));

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

test("generated Unix installers and herdr.json are current", () => {
	const result = spawnSync(process.execPath, ["scripts/gen-install.mjs", "--check"], { cwd: ROOT, encoding: "utf8" });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const components = JSON.parse(readFileSync(new URL("../components.json", import.meta.url), "utf8")).components;
	const herdr = components.find((c) => c.id === "herdr");
	assert.deepEqual(JSON.parse(readFileSync(new URL("../herdr.json", import.meta.url), "utf8")), {
		repo: herdr.repo, tag: herdr.tag, note: herdr.note["zh-TW"],
	});
});

test("literal message keys in both Unix installers exist", () => {
	for (const file of ["install.sh", "uninstall.sh"]) {
		const source = readFileSync(new URL("../" + file, import.meta.url), "utf8");
		const keys = [...source.matchAll(/\b(?:msg|t|tl|say|warn|die)\s+['"]?([a-z][a-z0-9_-]*)(?=['"\s;]|$)/g)].map((m) => m[1]);
		assert.ok(keys.length > 0, file);
		for (const key of keys) assert.ok(Object.hasOwn(strings, key), `${file}: missing ${key}`);
	}
});

test("component sizes are localized", () => {
	const components = JSON.parse(readFileSync(new URL("../components.json", import.meta.url), "utf8")).components;
	for (const c of components) {
		const sizes = c.size.download ? [c.size.download, c.size.deps] : [c.size];
		for (const size of sizes) for (const lang of ["zh-TW", "en"]) assert.equal(typeof size[lang], "string", c.id + ": " + lang);
	}
});
