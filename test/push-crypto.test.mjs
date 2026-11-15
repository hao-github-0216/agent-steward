import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const cryptoURL = new URL("../src/push-crypto.ts", import.meta.url).href;
const vectorsURL = new URL("../relay/test/vectors.json", import.meta.url).href;

function isolated(t, source) {
	const home = mkdtempSync(join(tmpdir(), "steward-push-crypto-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "--eval", `
		import assert from "node:assert/strict";
		import { readFileSync } from "node:fs";
		import { homedir } from "node:os";
		const { encryptPush, decryptPush, collapseFor, validKey } = await import(${JSON.stringify(cryptoURL)});
		const fixtures = JSON.parse(readFileSync(new URL(${JSON.stringify(vectorsURL)}), "utf8"));
		assert.equal(homedir(), process.env.HOME);
		${source}
	`], {
		cwd: ROOT,
		env: { ...process.env, HOME: home, USERPROFILE: home, STEWARD_DATA_DIR: join(home, "data"), XDG_CONFIG_HOME: home, XDG_DATA_HOME: home },
		encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) throw new Error(`Push crypto child failed: ${result.error?.message || result.signal || result.status}\n${result.stderr}${result.stdout}`);
}

test("所有共用測試向量都能解密，wrongKey 無法解密", (t) => {
	isolated(t, `
		assert.equal(fixtures.aad, "agent-steward-push-v1");
		for (const { name, key, payload, plaintext } of fixtures.vectors) {
			assert.deepEqual(decryptPush(key, payload), JSON.parse(plaintext), name);
		}
		const { key, payload } = fixtures.wrongKey;
		assert.throws(() => decryptPush(key, payload));
	`);
});

test("加解密來回保持文字與選填欄位，每次使用新的 nonce", (t) => {
	isolated(t, `
		const key = Buffer.alloc(32, 7).toString("base64");
		for (const msg of [
			{ title: "標題 🔔", body: "繁體中文\\n第二行", link: "agentsteward://project/p1", thread: "p1" },
			{ title: "No optional fields", body: "" },
		]) {
			const a = encryptPush(key, msg);
			const b = encryptPush(key, msg);
			assert.deepEqual(decryptPush(key, a), msg);
			assert.deepEqual(decryptPush(key, b), msg);
			assert.notDeepEqual(Buffer.from(a, "base64").subarray(0, 12), Buffer.from(b, "base64").subarray(0, 12));
			const damaged = Buffer.from(a, "base64");
			damaged[damaged.length - 1] ^= 1;
			assert.throws(() => decryptPush(key, damaged.toString("base64")));
		}
		for (const payload of ["", "%%%", "AAAA", "AA==\\n", "----", "A".repeat(40)]) assert.throws(() => decryptPush(key, payload));
	`);
});

test("超長 body 逐字截短並加省略號，UTF-8 明文與密文符合上限", (t) => {
	isolated(t, `
		const key = Buffer.alloc(32, 9).toString("base64");
		for (const body of ["通知😀".repeat(1500), "\\n\\\"\\\\".repeat(1600), "a".repeat(5000)]) {
			const msg = { title: "🔔".repeat(230), body, link: "agentsteward://project/p1", thread: "p1" };
			const before = structuredClone(msg);
			const payload = encryptPush(key, msg);
			const plain = decryptPush(key, payload);
			assert.ok(payload.length <= 3000);
			assert.ok(Buffer.byteLength(JSON.stringify(plain), "utf8") <= 2200);
			assert.equal(Array.from(plain.title).length, 200);
			assert.ok(plain.body.endsWith("…"));
			assert.ok(body.startsWith(plain.body.slice(0, -1)));
			assert.equal(plain.link, msg.link);
			assert.equal(plain.thread, msg.thread);
			assert.deepEqual(msg, before);
			const oneMore = Array.from(body)[Array.from(plain.body.slice(0, -1)).length];
			assert.ok(Buffer.byteLength(JSON.stringify({ ...plain, body: plain.body.slice(0, -1) + oneMore + "…" }), "utf8") > 2200);
		}
	`);
});

test("collapse 使用固定 HMAC 向量，裝置或專案不同就不同", (t) => {
	isolated(t, `
		const key = Buffer.alloc(32, 7).toString("base64");
		assert.equal(collapseFor(key, "project-測試"), "ad26e0af81a85326");
		assert.notEqual(collapseFor(key, "other-project"), collapseFor(key, "project-測試"));
		assert.notEqual(collapseFor(Buffer.alloc(32, 8).toString("base64"), "project-測試"), collapseFor(key, "project-測試"));
	`);
});

test("validKey 只接受正好 32 位元組的標準 base64", (t) => {
	isolated(t, `
		const zero = Buffer.alloc(32).toString("base64");
		const slash = Buffer.alloc(32, 255).toString("base64");
		for (const key of [zero, slash, ...fixtures.vectors.map(({ key }) => key)]) assert.equal(validKey(key), true);
		for (const key of [undefined, null, 32, {}, [], "", zero.slice(0, -1), zero + "=", zero + "\\n", " " + zero, slash.replaceAll("/", "_"), Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64"), zero.slice(0, -2) + "B="]) {
			assert.equal(validKey(key), false);
			assert.throws(() => encryptPush(key, { title: "title", body: "body" }));
		}
	`);
});
