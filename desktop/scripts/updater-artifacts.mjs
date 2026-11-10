#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { readFile, writeFile, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const desktopDir = fileURLToPath(new URL("../", import.meta.url));
export const usage = `Usage: node desktop/scripts/updater-artifacts.mjs <command> [options]
  mac-archive --app <Agent Steward.app> --out <update.tar.gz>
  sign --file <artifact> [--key-file <key>] (or TAURI_SIGNING_PRIVATE_KEY)
  manifest --version <version> --notes-file <notes> --base-url <url> [--mac <tar.gz>] [--win <setup.exe>] --out <latest.json>
  verify --pubkey <base64-public-key-from-tauri.conf.json> --file <artifact> --sig <artifact.sig>
Signing uses TAURI_SIGNING_PRIVATE_KEY_PASSWORD (empty by default). No prompts.

Examples:
  node desktop/scripts/updater-artifacts.mjs mac-archive --app '/tmp/Agent Steward.app' --out /tmp/app.tar.gz
  node desktop/scripts/updater-artifacts.mjs sign --file /tmp/app.tar.gz --key-file /tmp/updater-test-signing
  node desktop/scripts/updater-artifacts.mjs manifest --version 0.4.0 --notes-file /tmp/notes --base-url https://example.org/releases/v0.4.0 --mac /tmp/app.tar.gz --out /tmp/latest.json
  node desktop/scripts/updater-artifacts.mjs verify --pubkey '<base64-public-key>' --file /tmp/app.tar.gz --sig /tmp/app.tar.gz.sig`;
export const exec = promisify(execFile);

export function parseArgs(args) {
	if (!args.length || args.includes("--help") || args.includes("-h")) return { command: "help" };
	const [command, ...rest] = args;
	const allowed = { "mac-archive": ["app", "out"], sign: ["file", "key-file"], manifest: ["version", "notes-file", "base-url", "mac", "win", "out"], verify: ["pubkey", "file", "sig"] }[command];
	if (!allowed) throw new Error(`Unknown command: ${command}`);
	const options = {};
	for (let i = 0; i < rest.length; i += 2) {
		const key = rest[i].replace(/^--/, "");
		if (rest[i] !== `--${key}` || !allowed.includes(key) || Object.hasOwn(options, key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())) || !rest[i + 1] || rest[i + 1].startsWith("--")) throw new Error(`Unknown, duplicate, or incomplete option: ${rest[i]}`);
		options[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = rest[i + 1];
	}
	return { command, ...options };
}

export function required(value, name) {
	if (typeof value !== "string" || !value) throw new Error(`--${name} is required`);
	return value;
}

export async function macArchive({ app, out }) {
	if (process.platform !== "darwin") throw new Error("mac-archive requires macOS");
	app = await realpath(resolve(required(app, "app")));
	if (basename(app) !== "Agent Steward.app") throw new Error("--app must be named Agent Steward.app");
	await exec("tar", ["-C", dirname(app), "-czf", resolve(required(out, "out")), "Agent Steward.app"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
	return out;
}

export async function sign({ file, keyFile, env = process.env }) {
	file = resolve(required(file, "file"));
	const key = keyFile ? await readFile(resolve(keyFile), "utf8") : env.TAURI_SIGNING_PRIVATE_KEY;
	if (!key) throw new Error("--key-file or TAURI_SIGNING_PRIVATE_KEY is required");
	// Never forward signer output/errors: the CLI can print secret key material.
	try {
		// Invoke npx through Node on Windows, avoiding cmd.exe interpolation of paths.
		const npx = process.platform === "win32" ? [process.execPath, [resolve(dirname(process.execPath), "node_modules/npm/bin/npx-cli.js")]] : ["npx", []];
		await exec(npx[0], [...npx[1], "--no-install", "tauri", "signer", "sign", file], {
			cwd: desktopDir, env: { ...env, CI: "true", TAURI_SIGNING_PRIVATE_KEY: key.trim(), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "" },
			encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true,
		});
	} catch { throw new Error("Tauri signing failed (signer output suppressed to protect private keys)"); }
	return `${file}.sig`;
}

export async function manifest({ version, notesFile, baseUrl, mac, win, out }) {
	required(version, "version"); required(notesFile, "notes-file"); required(baseUrl, "base-url"); required(out, "out");
	if (!mac && !win) throw new Error("--mac or --win is required");
	const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
	if (!["https:", "http:"].includes(base.protocol) || base.search || base.hash) throw new Error("--base-url must be an HTTP(S) directory URL");
	const platforms = {};
	for (const [file, targets] of [[mac, ["darwin-aarch64", "darwin-x86_64"]], [win, ["windows-x86_64"]]]) {
		if (!file) continue;
		const entry = { signature: await readFile(`${file}.sig`, "utf8"), url: new URL(encodeURIComponent(basename(file)), base).href };
		for (const target of targets) platforms[target] = entry;
	}
	const data = { version, notes: await readFile(notesFile, "utf8"), pub_date: new Date().toISOString(), platforms };
	await writeFile(out, `${JSON.stringify(data, null, 2)}\n`);
	return data;
}

export function decodeBase64(text, label) {
	const clean = text.trim();
	if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length % 4 === 1) throw new Error(`Invalid ${label} base64`);
	const decoded = Buffer.from(clean, "base64");
	if (decoded.toString("base64").replace(/=+$/, "") !== clean.replace(/=+$/, "")) throw new Error(`Invalid ${label} base64`);
	return decoded;
}

export function verifyMinisign({ publicKey, file, signature }) {
	const keyText = decodeBase64(publicKey, "public key").toString("utf8").trimEnd().split(/\r?\n/);
	const sigText = decodeBase64(signature, "signature").toString("utf8").trimEnd().split(/\r?\n/);
	if (keyText.length !== 2 || !keyText[0].startsWith("untrusted comment: ")) throw new Error("Invalid minisign public key structure");
	if (sigText.length !== 4 || !sigText[0].startsWith("untrusted comment: ") || !sigText[2].startsWith("trusted comment: ")) throw new Error("Invalid minisign signature structure");
	const key = decodeBase64(keyText[1], "public key packet");
	const sig = decodeBase64(sigText[1], "signature packet");
	const global = decodeBase64(sigText[3], "global signature");
	if (key.length !== 42 || key.subarray(0, 2).toString() !== "Ed" || sig.length !== 74 || global.length !== 64) throw new Error("Invalid minisign packet");
	if (!key.subarray(2, 10).equals(sig.subarray(2, 10))) throw new Error("Minisign key id mismatch");
	const algorithm = sig.subarray(0, 2).toString();
	if (!["Ed", "ED"].includes(algorithm)) throw new Error("Unsupported minisign algorithm");
	const edKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]), format: "der", type: "spki" });
	const message = algorithm === "ED" ? createHash("blake2b512").update(file).digest() : file;
	if (!verifySignature(null, message, edKey, sig.subarray(10))) throw new Error("Artifact signature verification failed");
	const trustedComment = Buffer.from(sigText[2].slice("trusted comment: ".length), "utf8");
	if (!verifySignature(null, Buffer.concat([sig.subarray(10), trustedComment]), edKey, global)) throw new Error("Trusted comment global signature verification failed");
	return true;
}

export async function verify({ pubkey, file, sig }) {
	return verifyMinisign({ publicKey: required(pubkey, "pubkey"), file: await readFile(required(file, "file")), signature: await readFile(required(sig, "sig"), "utf8") });
}

export async function main(args = process.argv.slice(2)) {
	const options = parseArgs(args);
	if (options.command === "help") { console.log(usage); return; }
	await ({ "mac-archive": macArchive, sign, manifest, verify })[options.command](options);
	console.log(`${options.command}: OK`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => { console.error(`updater-artifacts: ${error.message}`); process.exitCode = 1; });
}
