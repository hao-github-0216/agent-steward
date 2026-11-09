import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "steward-update-verify-"));
process.env.HOME = dir;
process.env.USERPROFILE = dir;
process.env.STEWARD_DATA_DIR = dir;
process.env.STEWARD_APP_DIR = fileURLToPath(new URL("../", import.meta.url));
after(() => rmSync(dir, { recursive: true, force: true }));
const { applyUpdate, checkSums, REPO } = await import("../src/update.ts");
const content = Buffer.from([239, 187, 191, 35, 32, 0, 255]);
const digest = createHash("sha256").update(content).digest("hex");
const missing = "這個版本沒有檢查碼,請手動更新";
const mismatch = "下載的安裝程式檢查碼不符,沒有更新";

test("checkSums accepts matching raw bytes, CRLF, binary markers and uppercase hashes", () => {
	for (const sums of [digest + "  install.sh\n", digest.toUpperCase() + "\t*install.sh\r\n"]) {
		assert.equal(checkSums(content, sums, "install.sh"), undefined);
	}
	assert.equal(checkSums(content, digest + "  install-windows.ps1\n", "install-windows.ps1"), undefined);
});

test("checkSums rejects a checksum mismatch", () => {
	assert.equal(checkSums(Buffer.from("changed"), digest + "  install.sh\n", "install.sh"), mismatch);
});

test("checkSums rejects missing or malformed checksum entries", () => {
	for (const sums of ["", digest + "  other.sh\n", "bad  install.sh\n", "g".repeat(64) + "  install.sh\n"]) {
		assert.equal(checkSums(content, sums, "install.sh"), missing);
	}
});

test("checkSums matches the whole filename, not install.sh.bak or a directory prefix", () => {
	for (const name of ["install.sh.bak", "prefix-install.sh", "dir/install.sh"]) {
		assert.equal(checkSums(content, digest + "  " + name + "\n", "install.sh"), missing);
	}
	const sums = "0".repeat(64) + "  install.sh.bak\n" + digest + "  install.sh\n";
	assert.equal(checkSums(content, sums, "install.sh"), undefined);
});

test("applyUpdate rejects mismatched release bytes before writing or spawning", async (t) => {
	const calls = [];
	t.mock.method(globalThis, "fetch", async (url) => {
		calls.push(String(url));
		return String(url).endsWith("/SHA256SUMS")
			? new Response("0".repeat(64) + "  " + (process.platform === "win32" ? "install-windows.ps1" : "install.sh") + "\n")
			: new Response(content);
	});
	await assert.rejects(applyUpdate("v0.2.0"), { message: mismatch });
	const name = process.platform === "win32" ? "install-windows.ps1" : "install.sh";
	assert.deepEqual(calls, [
		"https://github.com/" + REPO + "/releases/download/v0.2.0/" + name,
		"https://github.com/" + REPO + "/releases/download/v0.2.0/SHA256SUMS",
	]);
	assert.equal(existsSync(join(dir, "update", name)), false);
	assert.equal(existsSync(join(dir, "update.lock")), false);
});

test("applyUpdate stops when the release has no SHA256SUMS", async (t) => {
	t.mock.method(globalThis, "fetch", async (url) => String(url).endsWith("/SHA256SUMS")
		? new Response("Not Found", { status: 404 }) : new Response(content));
	await assert.rejects(applyUpdate("v0.2.0"), { message: missing });
	assert.equal(existsSync(join(dir, "update.lock")), false);
});

test("applyUpdate rejects HTTPS redirects to HTTP before requesting the target", async (t) => {
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		return new Response(null, { status: 302, headers: { location: "http://example.invalid/install.sh" } });
	});
	await assert.rejects(applyUpdate("v0.2.0"), /HTTPS/);
	assert.equal(calls, 1);
	assert.equal(existsSync(join(dir, "update.lock")), false);
});
