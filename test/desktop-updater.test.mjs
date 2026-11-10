import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { desktopDir, macArchive, manifest, parseArgs, sign, verify, verifyMinisign } from "../desktop/scripts/updater-artifacts.mjs";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../desktop/scripts/updater-artifacts.mjs", import.meta.url));
const hasTauri = existsSync(join(desktopDir, "node_modules", "@tauri-apps", "cli", "tauri.js"));
const npx = process.platform === "win32" ? [process.execPath, [resolve(dirname(process.execPath), "node_modules/npm/bin/npx-cli.js")]] : ["npx", []];

async function temporary(t) {
	const root = await mkdtemp(join(tmpdir(), "steward-updater-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

// The pure verifier must support both original-message Ed and prehashed ED packets.
for (const algorithm of ["Ed", "ED"]) test(`verifyMinisign validates ${algorithm} and its trusted comment`, () => {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const keyId = Buffer.from("0102030405060708", "hex");
	const rawKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
	const file = Buffer.from("updater test fixture\n");
	const signature = cryptoSign(null, algorithm === "ED" ? createHash("blake2b512").update(file).digest() : file, privateKey);
	const trusted = "timestamp:12345\tfile:app.tar.gz";
	const global = cryptoSign(null, Buffer.concat([signature, Buffer.from(trusted)]), privateKey);
	const key = Buffer.from(`untrusted comment: test public key\n${Buffer.concat([Buffer.from("Ed"), keyId, rawKey]).toString("base64")}\n`).toString("base64");
	const packet = Buffer.concat([Buffer.from(algorithm), keyId, signature]).toString("base64");
	const text = `untrusted comment: signature\n${packet}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
	const encoded = Buffer.from(text).toString("base64");
	assert.equal(verifyMinisign({ publicKey: key, file, signature: encoded }), true);
	assert.throws(() => verifyMinisign({ publicKey: key, file: Buffer.from("UpdatER test fixture\n"), signature: encoded }), /Artifact signature/);
	assert.throws(() => verifyMinisign({ publicKey: key, file, signature: Buffer.from(text.replace("timestamp:12345", "timestamp:92345")).toString("base64") }), /Trusted comment global signature/);
	const wrongId = Buffer.from(keyId); wrongId[0] ^= 1;
	const wrongKey = Buffer.from(`untrusted comment: test public key\n${Buffer.concat([Buffer.from("Ed"), wrongId, rawKey]).toString("base64")}\n`).toString("base64");
	assert.throws(() => verifyMinisign({ publicKey: wrongKey, file, signature: encoded }), /key id mismatch/);
	assert.throws(() => verifyMinisign({ publicKey: key, file, signature: text }), /base64/);
});

test("updater-artifacts is import safe and has noninteractive help/examples", async () => {
	const imported = await exec(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(new URL("../desktop/scripts/updater-artifacts.mjs", import.meta.url).href)})`]);
	assert.equal(imported.stdout, ""); assert.equal(imported.stderr, "");
	const help = await exec(process.execPath, [script, "--help"]);
	assert.match(help.stdout, /Examples:/);
	for (const command of ["mac-archive", "sign", "manifest", "verify"]) assert.match(help.stdout, new RegExp(command));
	assert.throws(() => parseArgs(["sign", "--file"]), /incomplete/);
	assert.throws(() => parseArgs(["bad-command"]), /Unknown command/);
});

test("manifest writes all three platform URLs and preserves signature bytes", async (t) => {
	const root = await temporary(t);
	const mac = join(root, "Agent Steward.tar.gz"), win = join(root, "Agent Steward-setup.exe"), notesFile = join(root, "notes.txt"), out = join(root, "latest.json");
	await writeFile(notesFile, "測試 release notes\n");
	await writeFile(`${mac}.sig`, "mac-signature\n"); await writeFile(`${win}.sig`, "windows-signature\r\n");
	const result = await manifest({ version: "0.4.0", notesFile, baseUrl: "https://example.invalid/releases/v0.4.0", mac, win, out });
	assert.deepEqual(Object.keys(result.platforms), ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"]);
	assert.deepEqual(result.platforms["darwin-aarch64"], result.platforms["darwin-x86_64"]);
	assert.equal(result.platforms["darwin-aarch64"].url, "https://example.invalid/releases/v0.4.0/Agent%20Steward.tar.gz");
	assert.equal(result.platforms["windows-x86_64"].url, "https://example.invalid/releases/v0.4.0/Agent%20Steward-setup.exe");
	assert.equal(result.platforms["darwin-aarch64"].signature, "mac-signature\n");
	assert.equal(result.platforms["windows-x86_64"].signature, "windows-signature\r\n");
	assert.equal(result.notes, "測試 release notes\n"); assert.equal(result.version, "0.4.0"); assert.ok(Number.isFinite(Date.parse(result.pub_date)));
	assert.deepEqual(JSON.parse(await readFile(out, "utf8")), result);
	assert.deepEqual(Object.keys((await manifest({ version: "0.4.0", notesFile, baseUrl: "http://127.0.0.1:19999/", win, out })).platforms), ["windows-x86_64"]);
	assert.deepEqual(Object.keys((await manifest({ version: "0.4.0", notesFile, baseUrl: "https://example.invalid/", mac, out })).platforms), ["darwin-aarch64", "darwin-x86_64"]);
	await assert.rejects(manifest({ version: "0.4.0", notesFile, baseUrl: "https://example.invalid/", out }), /--mac or --win/);
});

test("mac-archive contains only the top-level Agent Steward.app", { skip: process.platform !== "darwin" ? "mac-archive requires macOS" : false }, async (t) => {
	const root = await temporary(t), app = join(root, "Agent Steward.app"), out = join(root, "update.tar.gz");
	await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
	await writeFile(join(app, "Contents", "MacOS", "fixture"), "fixture");
	await writeFile(join(root, "not-in-archive"), "excluded");
	await exec("xattr", ["-w", "com.apple.updater-test", "archive metadata fixture", app]);
	await macArchive({ app, out });
	const listing = (await exec("tar", ["-tzf", out])).stdout.trim().split("\n");
	assert.ok(listing.length >= 3); assert.ok(listing.every((entry) => entry === "Agent Steward.app" || entry.startsWith("Agent Steward.app/")), listing.join("\n"));
});

test("Tauri-generated signatures verify and reject modified file, public key, and trusted comment", { skip: !hasTauri ? "desktop node_modules has no npx tauri; run npm ci in desktop to enable signer integration" : false, timeout: 120_000 }, async (t) => {
	const root = await temporary(t), file = join(root, "artifact.bin"), keyFile = join(root, "signer-private"), otherKey = join(root, "other-private");
	const password = "test-only-noninteractive-password";
	const env = { ...process.env, CI: "true", TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password };
	delete env.TAURI_SIGNING_PRIVATE_KEY; delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
	for (const output of [keyFile, otherKey]) {
		try { await exec(npx[0], [...npx[1], "--no-install", "tauri", "signer", "generate", "--ci", "--password", password, "--write-keys", output], { cwd: desktopDir, env, encoding: "utf8", timeout: 45_000, windowsHide: true }); }
		catch { assert.fail("Tauri test key generation failed (output suppressed to protect private keys)"); }
	}
	const original = Buffer.from("signed updater artifact\n"); await writeFile(file, original);
	const sig = await sign({ file, keyFile, env });
	const pubkey = (await readFile(`${keyFile}.pub`, "utf8")).trim();
	const otherPubkey = (await readFile(`${otherKey}.pub`, "utf8")).trim();
	assert.equal(await verify({ pubkey, file, sig }), true);
	const cli = await exec(process.execPath, [script, "verify", "--pubkey", pubkey, "--file", file, "--sig", sig]);
	assert.match(cli.stdout, /verify: OK/);
	const changed = Buffer.from(original); changed[0] ^= 1; await writeFile(file, changed);
	await assert.rejects(verify({ pubkey, file, sig }), /Artifact signature/);
	await assert.rejects(exec(process.execPath, [script, "verify", "--pubkey", pubkey, "--file", file, "--sig", sig]), (error) => error.code === 1 && /signature verification failed/.test(error.stderr));
	await writeFile(file, original);
	await assert.rejects(verify({ pubkey: otherPubkey, file, sig }), /key id mismatch/);
	const signature = await readFile(sig, "utf8");
	const decoded = Buffer.from(signature.trim(), "base64").toString("utf8");
	await writeFile(sig, Buffer.from(decoded.replace(/^trusted comment: /m, "trusted comment: tampered ")).toString("base64"));
	await assert.rejects(verify({ pubkey, file, sig }), /Trusted comment global signature/);
});
