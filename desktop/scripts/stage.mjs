#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktop, "..");
const cache = join(desktop, ".cache");
const resources = join(desktop, "resources");
const binaries = join(desktop, "src-tauri", "binaries");
const targets = ["aarch64-apple-darwin", "x86_64-apple-darwin", "universal-apple-darwin", "x86_64-pc-windows-msvc"];
const usage = `Usage: node desktop/scripts/stage.mjs --target <${targets.join("|")}>\nPrepare the bundled app, verified executables, and licenses. Existing staged resources are replaced.\n\nExamples:\n  node desktop/scripts/stage.mjs --target aarch64-apple-darwin\n  node desktop/scripts/stage.mjs --target universal-apple-darwin\n  node desktop/scripts/stage.mjs --target x86_64-pc-windows-msvc`;

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${result.stderr ?? ""}`);
	return result.stdout;
}

async function digest(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function httpsGet(url) {
	for (let redirects = 0; redirects <= 10; redirects++) {
		if (new URL(url).protocol !== "https:") throw new Error(`HTTPS required: ${url}`);
		const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(120_000), headers: { "user-agent": "agent-steward-desktop-stage" } });
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get("location");
			await response.body?.cancel();
			if (!location) throw new Error(`Missing redirect location: ${url}`);
			url = new URL(location, url).href;
			continue;
		}
		if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}: ${url}`); }
		return response;
	}
	throw new Error(`Too many redirects: ${url}`);
}

async function download(file) {
	if (!file || !/^[a-f0-9]{64}$/i.test(file.sha256) || file.name !== file.name?.split(/[\\/]/).pop()) throw new Error("Invalid component file entry");
	if (new URL(file.url).protocol !== "https:") throw new Error(`HTTPS required: ${file.url}`);
	const path = join(cache, file.name);
	const existing = await stat(path).catch((error) => { if (error.code !== "ENOENT") throw error; });
	if (!existing) {
		console.log(`Downloading ${file.name}`);
		const partial = `${path}.part`;
		try {
			const response = await httpsGet(file.url);
			await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
			await copyFile(partial, path);
		} finally { await rm(partial, { force: true }); }
	}
	if (await digest(path) !== file.sha256.toLowerCase()) {
		await rm(path, { force: true });
		throw new Error(`SHA-256 mismatch; deleted ${path}. Run stage again to download a fresh copy.`);
	}
	console.log(`SHA-256 OK ${file.name}${existing ? " (cached)" : ""}`);
	return path;
}

async function entries(dir) {
	const files = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...await entries(path));
		else if (entry.isFile()) files.push(path);
	}
	return files;
}

async function extract(archive, directory) {
	await mkdir(directory, { recursive: true });
	run("tar", ["-xf", archive, "-C", directory]);
	return entries(directory);
}

function one(files, suffix) {
	const found = files.filter((path) => path.replaceAll("\\", "/").endsWith(`/${suffix}`));
	if (found.length !== 1) throw new Error(`Expected one ${suffix}, found ${found.length}`);
	return found[0];
}

async function executable(source, destination) {
	await copyFile(source, destination);
	await chmod(destination, 0o755);
}

async function stage(target) {
	const windows = target.endsWith("windows-msvc");
	const platforms = target.startsWith("universal-") ? ["macos-aarch64", "macos-x86_64"] : [windows ? "windows-x86_64" : target.startsWith("aarch64-") ? "macos-aarch64" : "macos-x86_64"];
	if (platforms.length === 2 && process.platform !== "darwin") throw new Error("Universal staging requires macOS lipo.");
	const manifest = JSON.parse(await readFile(join(root, "components.json"), "utf8"));
	const component = (id) => {
		const result = manifest.components.find((item) => item.id === id);
		if (!result?.files) throw new Error(`Missing component: ${id}`);
		return result;
	};
	await Promise.all([mkdir(cache, { recursive: true }), mkdir(resources, { recursive: true }), mkdir(binaries, { recursive: true })]);
	const work = await mkdtemp(join(cache, "stage-"));
	try {
		const app = join(resources, "app");
		const licenses = join(resources, "licenses");
		await rm(app, { recursive: true, force: true });
		await rm(licenses, { recursive: true, force: true });
		await mkdir(app, { recursive: true });
		await mkdir(licenses, { recursive: true });
		const archive = join(work, "app.tar");
		run("git", ["archive", "--worktree-attributes", "--format=tar", `--output=${archive}`, "HEAD"]);
		await extract(archive, app);
		run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: app, stdio: "inherit", shell: process.platform === "win32" });
		const revision = run("git", ["describe", "--tags", "--match", "v*", "--always"]).trim(); // 只認版本標籤(deps-* 這類相依套件的標籤不算)
		await writeFile(join(app, "REVISION"), `${revision}\n`);
		await copyFile(join(root, "THIRD_PARTY_NOTICES.md"), join(licenses, "THIRD_PARTY_NOTICES.md"));
		await cp(join(root, "licenses"), join(licenses, "licenses"), { recursive: true });

		const nodes = [];
		for (const platform of platforms) {
			const archive = await download(component("node").files[platform]);
			const files = await extract(archive, join(work, `node-${platform}`));
			const node = one(files, windows ? "node.exe" : "bin/node");
			nodes.push(node);
			await copyFile(join(windows ? dirname(node) : dirname(dirname(node)), "LICENSE"), join(licenses, `node-${platform}-LICENSE`));
		}
		const nodeDestination = join(binaries, `node-${target}${windows ? ".exe" : ""}`);
		if (nodes.length === 2) { run("lipo", ["-create", ...nodes, "-output", nodeDestination]); await chmod(nodeDestination, 0o755); }
		else await executable(nodes[0], nodeDestination);

		if (windows) {
			const destination = join(resources, "herdr");
			await rm(destination, { recursive: true, force: true });
			await extract(await download(component("herdr").files[platforms[0]]), destination);
			await cp(join(destination, "THIRD-PARTY-NOTICES"), join(licenses, "herdr", "THIRD-PARTY-NOTICES"), { recursive: true });
		} else {
			const herdrs = [];
			for (const platform of platforms) herdrs.push(await download(component("herdr").files[platform]));
			const destination = join(binaries, `herdr-${target}`);
			if (herdrs.length === 2) { run("lipo", ["-create", ...herdrs, "-output", destination]); await chmod(destination, 0o755); }
			else await executable(herdrs[0], destination);
		}

		const ttyd = await download(component("ttyd").files[windows ? "windows-x86_64" : "macos-universal"]);
		const ttydDestination = join(binaries, `ttyd-${target}${windows ? ".exe" : ""}`);
		if (windows) await executable(ttyd, ttydDestination);
		else {
			const unpacked = join(work, "ttyd");
			const executablePath = one(await extract(ttyd, unpacked), "ttyd");
			await executable(executablePath, ttydDestination);
			await cp(join(dirname(executablePath), "LICENSES"), join(licenses, "ttyd", "LICENSES"), { recursive: true });
		}
		console.log(`Staged ${target}; app revision ${revision}`);
	} finally { await rm(work, { recursive: true, force: true }); }
}

const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h"].includes(args[0])) console.log(usage);
else if (args.length !== 2 || args[0] !== "--target" || !targets.includes(args[1])) { console.error(usage); process.exitCode = 1; }
else { try { await stage(args[1]); } catch (error) { console.error(`stage: ${error.message}`); process.exitCode = 1; } }
