#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
	console.log("Usage: node scripts/pin-components.mjs [--check]\nFetch SHA-256 checksums for the versions in components.json.\n\nExamples:\n  node scripts/pin-components.mjs\n  node scripts/pin-components.mjs --check");
} else if (args.some((arg) => arg !== "--check") || args.length > 1) {
	console.error("Usage: node scripts/pin-components.mjs [--check]");
	process.exitCode = 1;
} else {
	try { await pin(args.includes("--check")); }
	catch (error) { console.error(error.message); process.exitCode = 1; }
}

async function get(url) {
	for (let redirects = 0; redirects <= 10; redirects++) {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:") throw new Error(`HTTPS required: ${url}`);
		const headers = { "user-agent": "agent-steward-pins" };
		if (parsed.hostname === "api.github.com") {
			headers.accept = "application/vnd.github+json";
			if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
		}
		const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(60_000) });
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get("location");
			await response.body?.cancel();
			if (!location) throw new Error(`Missing redirect location: ${url}`);
			url = new URL(location, url).href;
			continue;
		}
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
		return response;
	}
	throw new Error(`Too many redirects: ${url}`);
}

function checksum(text, name) {
	for (const line of text.split(/\r?\n/)) {
		const match = line.match(/^([a-fA-F0-9]{64})[ \t]+\*?(.+)$/);
		if (match?.[2] === name) return match[1].toLowerCase();
	}
}

function filenames(component) {
	const version = component.version ?? component.tag;
	switch (component.id) {
		case "node": return Object.fromEntries([
			["macos-aarch64", "darwin-arm64.tar.gz"], ["macos-x86_64", "darwin-x64.tar.gz"],
			["linux-aarch64", "linux-arm64.tar.gz"], ["linux-x86_64", "linux-x64.tar.gz"],
			["windows-x86_64", "win-x64.zip"], ["windows-aarch64", "win-arm64.zip"],
		].map(([platform, suffix]) => [platform, `node-v${version}-${suffix}`]));
		case "herdr": return Object.fromEntries(["linux-aarch64", "linux-x86_64", "macos-aarch64", "macos-x86_64", "windows-x86_64"].map((platform) => [platform, `herdr-${platform}${platform.startsWith("windows") ? ".zip" : ""}`]));
		case "ttyd": return { "linux-x86_64": "ttyd.x86_64", "linux-aarch64": "ttyd.aarch64", "windows-x86_64": "ttyd.win32.exe" };
		case "uv": return Object.fromEntries([
			["macos-aarch64", "aarch64-apple-darwin.tar.gz"], ["macos-x86_64", "x86_64-apple-darwin.tar.gz"],
			["linux-aarch64", "aarch64-unknown-linux-gnu.tar.gz"], ["linux-x86_64", "x86_64-unknown-linux-gnu.tar.gz"],
			["windows-x86_64", "x86_64-pc-windows-msvc.zip"],
		].map(([platform, suffix]) => [platform, `uv-${suffix}`]));
		case "tinytex": return Object.fromEntries(["darwin", "linux-arm64", "linux-x86_64", "windows"].map((platform) => [platform, `TinyTeX-1-${platform}-${version}${platform === "windows" ? ".exe" : ".tar.xz"}`]));
		default: return undefined;
	}
}

async function officialFiles(component, names) {
	const files = {};
	if (component.id === "node") {
		const base = `https://nodejs.org/dist/v${component.version}`;
		const sums = await (await get(`${base}/SHASUMS256.txt`)).text();
		for (const [platform, name] of Object.entries(names)) {
			const sha256 = checksum(sums, name);
			if (!sha256) throw new Error(`node/${platform}: missing ${name} in SHASUMS256.txt`);
			files[platform] = { name, url: `${base}/${name}`, sha256 };
		}
		return files;
	}
	const tag = component.tag ?? component.version;
	const release = await (await get(`https://api.github.com/repos/${component.repo}/releases/tags/${encodeURIComponent(tag)}`)).json();
	let sums;
	for (const [platform, name] of Object.entries(names)) {
		const asset = release.assets.find((item) => item.name === name);
		if (!asset) throw new Error(`${component.id}/${platform}: release ${tag} has no ${name}`);
		let sha256 = /^sha256:([a-f0-9]{64})$/.exec(asset.digest ?? "")?.[1];
		if (!sha256) {
			if (sums === undefined) {
				const sumsAsset = release.assets.find((item) => item.name === "SHA256SUMS");
				sums = sumsAsset ? await (await get(sumsAsset.browser_download_url)).text() : "";
			}
			sha256 = checksum(sums, name);
		}
		if (!sha256) {
			const hash = createHash("sha256");
			const response = await get(asset.browser_download_url);
			for await (const chunk of response.body) hash.update(chunk);
			sha256 = hash.digest("hex");
		}
		const url = asset.browser_download_url;
		if (new URL(url).protocol !== "https:") throw new Error(`${component.id}/${platform}: HTTPS required`);
		files[platform] = { name, url, sha256 };
	}
	return files;
}

async function pin(check) {
	const path = new URL("../components.json", import.meta.url);
	const original = readFileSync(path, "utf8");
	const manifest = JSON.parse(original);
	const results = await Promise.all(manifest.components.map(async (component) => {
		const names = filenames(component);
		if (!names) return undefined;
		const files = await officialFiles(component, names);
		if (component.id === "ttyd") {
			Object.assign(files, await officialFiles({ ...component, repo: "hao-github-0216/agent-steward", tag: `deps-ttyd-${component.version}-1` }, {
				"macos-universal": `ttyd-${component.version}-macos-universal.tar.gz`,
			}));
		}
		return { component, files };
	}));
	let changed = false;
	for (const result of results) {
		if (!result) continue;
		const { component, files } = result;
		for (const platform of new Set([...Object.keys(component.files ?? {}), ...Object.keys(files)])) {
			if (JSON.stringify(component.files?.[platform]) === JSON.stringify(files[platform])) continue;
			console[check ? "error" : "log"](`${component.id}/${platform}: ${check ? "pin differs from official source" : "pinned"}`);
			changed = true;
		}
		component.files = files;
	}
	if (check) {
		if (changed) process.exitCode = 1;
		else console.log("Component pins match official sources.");
	} else {
		const content = `${JSON.stringify(manifest, null, 2)}\n`;
		if (content !== original) writeFileSync(path, content);
	}
}
