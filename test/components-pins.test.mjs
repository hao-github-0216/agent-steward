import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const components = JSON.parse(readFileSync(new URL("../components.json", import.meta.url), "utf8")).components;
const component = (id) => components.find((c) => c.id === id);
const platforms = {
	node: ["macos-aarch64", "macos-x86_64", "linux-aarch64", "linux-x86_64", "windows-x86_64", "windows-aarch64"],
	herdr: ["linux-aarch64", "linux-x86_64", "macos-aarch64", "macos-x86_64", "windows-x86_64"],
	ttyd: ["linux-x86_64", "linux-aarch64", "windows-x86_64", "macos-universal"],
	uv: ["macos-aarch64", "macos-x86_64", "linux-aarch64", "linux-x86_64", "windows-x86_64"],
	tinytex: ["darwin", "linux-arm64", "linux-x86_64", "windows"],
};

test("each binary component pins all supported platforms to HTTPS and SHA-256", () => {
	for (const [id, required] of Object.entries(platforms)) {
		const c = component(id);
		assert.ok(c, id);
		assert.deepEqual(Object.keys(c.files).sort(), [...required].sort(), id);
		for (const [platform, file] of Object.entries(c.files)) {
			const label = id + "/" + platform;
			assert.equal(typeof file.name, "string", label);
			assert.ok(file.name.length > 0, label);
			assert.match(file.sha256, /^[0-9a-f]{64}$/, label);
			assert.equal(new URL(file.url).protocol, "https:", label);
			assert.equal(decodeURIComponent(new URL(file.url).pathname.split("/").at(-1)), file.name, label);
			assert.doesNotMatch(file.url, /latest|refs\/heads/, label);
		}
	}
});

test("Node and GitHub assets use their pinned release versions", () => {
	const node = component("node");
	assert.equal(node.version, "24.22.2");
	for (const file of Object.values(node.files)) {
		assert.ok(file.name.startsWith("node-v" + node.version + "-"));
		assert.ok(file.url.includes("/dist/v" + node.version + "/"));
	}
	for (const id of ["herdr", "ttyd", "uv", "tinytex"]) {
		const c = component(id);
		for (const [platform, file] of Object.entries(c.files)) {
			const tag = id === "ttyd" && platform === "macos-universal" ? "deps-ttyd-1.7.7-1" : (c.tag ?? c.version);
			assert.ok(file.url.includes("/releases/download/" + tag + "/"), id + "/" + platform);
		}
	}
	assert.equal(component("ttyd").version, "1.7.7");
	assert.equal(component("ttyd").source.macos, "brew");
});

test("Python direct packages have the approved Python 3.12 version pins", () => {
	assert.deepEqual(component("python-packages").packages, {
		ipykernel: "7.4.0", numpy: "2.5.4", pandas: "3.1.1", matplotlib: "3.11.2",
	});
});

test("generated installer pins and messages are current", () => {
	const result = spawnSync(process.execPath, ["scripts/gen-install.mjs", "--check"], { cwd: root, encoding: "utf8", timeout: 10_000 });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	for (const file of ["install.sh", "uninstall.sh", "scripts/install-windows.ps1", "uninstall.ps1"]) {
		const text = readFileSync(new URL("../" + file, import.meta.url), "utf8");
		for (const c of components.filter((c) => c.files)) for (const asset of Object.values(c.files)) assert.ok(text.includes(asset.sha256), file + ": " + asset.name);
		if (file.endsWith(".sh")) {
			assert.ok(text.includes("APP_PIN_VERSION=''"));
			assert.ok(text.includes("APP_PIN_SHA256=''"));
		} else {
			assert.ok(text.includes("$AppPinVersion = ''"));
			assert.ok(text.includes("$AppPinSha256 = ''"));
			assert.ok(text.includes("$AppPinZipSha256 = ''"));
		}
	}
});
