#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktop, "..");
const usage = `Usage: node desktop/scripts/rust-notices.mjs --target <triple> [--target <triple> ...] --out <dir>
Generate notices for normal, transitive Rust dependencies. Replaces <out>/rust/.

Examples:
  node desktop/scripts/rust-notices.mjs --target aarch64-apple-darwin --target x86_64-apple-darwin --out desktop/resources/licenses
  node desktop/scripts/rust-notices.mjs --target x86_64-pc-windows-msvc --out desktop/resources/licenses`;

function cargoMetadata(target) {
	const args = ["metadata", "--format-version", "1", "--locked", "--manifest-path", "desktop/src-tauri/Cargo.toml", "--filter-platform", target];
	const result = spawnSync("cargo", args, { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
	if (result.error || result.status !== 0) throw new Error(`cargo ${args.join(" ")} failed (${result.status}): ${result.error?.message ?? ""}\n${result.stderr ?? ""}`);
	return JSON.parse(result.stdout);
}

function normalDependencies(metadata) {
	const rootPackage = metadata.packages.find((pkg) => pkg.name === "agent-steward-desktop");
	if (!rootPackage) throw new Error("Missing package: agent-steward-desktop");
	const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
	const visited = new Set();
	const pending = [rootPackage.id];
	while (pending.length) {
		const id = pending.pop();
		if (visited.has(id)) continue;
		visited.add(id);
		const node = nodes.get(id);
		if (!node) throw new Error(`Missing resolve node: ${id}`);
		for (const dependency of node.deps) {
			// 只沿一般相依邊遍歷，排除 build/dev。
			if (dependency.dep_kinds?.some((kind) => kind.kind === null)) pending.push(dependency.pkg);
		}
	}
	visited.delete(rootPackage.id);
	return visited;
}

function tableCell(value) {
	return value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

export async function writeRustNotices({ targets, out }) {
	if (!targets?.length || !out) throw new Error(usage);
	const packages = new Map();
	for (const target of targets) {
		const metadata = cargoMetadata(target);
		const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
		for (const id of normalDependencies(metadata)) {
			const pkg = packagesById.get(id);
			if (!pkg) throw new Error(`Missing package: ${id}`);
			packages.set(id, pkg);
		}
	}

	const notices = join(out, "rust");
	// 重建 Rust 清單，避免留下上一次目標平台的套件。
	await rm(notices, { recursive: true, force: true });
	await mkdir(notices, { recursive: true });
	const lines = [
		"# Rust 套件授權清單",
		"",
		"這是 App 內附 Rust 套件的授權清單，由腳本自動產生。授權檔取自各套件目錄；若套件未附授權檔，僅列出套件標示的授權。",
		"",
		"| 套件名稱 | 版本 | 授權 | 原始碼儲存庫 | 授權檔 |",
		"| --- | --- | --- | --- | --- |",
	];
	const sortedPackages = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
	for (const pkg of sortedPackages) {
		const directory = dirname(pkg.manifest_path);
		const files = (await readdir(directory, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && /^(LICEN[CS]E|COPYING|NOTICE|COPYRIGHT|UNLICENSE)/i.test(entry.name))
			.map((entry) => entry.name).sort();
		if (files.length) {
			const destination = join(notices, `${pkg.name}-${pkg.version}`);
			await rm(destination, { recursive: true, force: true });
			await mkdir(destination, { recursive: true });
			for (const file of files) await copyFile(join(directory, file), join(destination, file));
		}
		const license = pkg.license || "未標示";
		const fileSummary = files.length ? files.join(", ") : `套件裡沒有授權檔，授權：${license}`;
		lines.push(`| ${[pkg.name, pkg.version, license, pkg.repository || "-", fileSummary].map(tableCell).join(" | ")} |`);
	}
	await writeFile(join(notices, "README.md"), `${lines.join("\n")}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const targets = [];
	let out;
	let valid = true;
	for (let index = 0; index < args.length; index += 2) {
		const option = args[index];
		const value = args[index + 1];
		if (!value || value.startsWith("--")) { valid = false; break; }
		if (option === "--target") targets.push(value);
		else if (option === "--out" && !out) out = value;
		else { valid = false; break; }
	}
	if (args.length === 1 && ["--help", "-h"].includes(args[0])) console.log(usage);
	else if (!valid || !targets.length || !out) { console.error(usage); process.exitCode = 1; }
	else { try { await writeRustNotices({ targets, out }); } catch (error) { console.error(`rust-notices: ${error.message}`); process.exitCode = 1; } }
}
