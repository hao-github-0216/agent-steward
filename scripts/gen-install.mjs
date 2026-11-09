#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const components = JSON.parse(read("components.json")).components;
const strings = JSON.parse(read("i18n/installer.json"));
const languages = ["zh-TW", "en"];
const begin = "# ---- generated: begin (scripts/gen-install.mjs) ----";
const end = "# ---- generated: end ----";
const usage = "Usage: node scripts/gen-install.mjs [--check]\n       node scripts/gen-install.mjs --release <tag> --dist <dir> [--repo owner/name]";
const { values: options } = parseArgs({ options: {
	check: { type: "boolean" },
	release: { type: "string" },
	dist: { type: "string" },
	repo: { type: "string" },
	help: { type: "boolean", short: "h" },
} });
if (options.help) {
	console.log(`${usage}\n\nExamples:\n  node scripts/gen-install.mjs --check\n  node scripts/gen-install.mjs --release v0.2.0 --dist dist`);
	process.exit(0);
}
const check = options.check;
const release = options.release;
if (check && release !== undefined) throw new Error("--release and --check cannot be combined");
if (release !== undefined ? !release || !options.dist : options.dist !== undefined || options.repo !== undefined) throw new Error(usage);

for (const [key, values] of Object.entries(strings)) {
	let expected;
	for (const lang of languages) {
		if (typeof values[lang] !== "string") throw new Error(`${key}: missing ${lang}`);
		const placeholders = [...values[lang].matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]));
		if (placeholders.some((n, i) => n !== i)) throw new Error(`${key}: placeholders must appear in order from {0}`);
		if (expected !== undefined && expected !== placeholders.length) throw new Error(`${key}: placeholder counts differ`);
		expected = placeholders.length;
	}
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const shellName = (s) => s.replace(/-/g, "_").toUpperCase();
const format = (s) => s.replace(/%/g, "%%").replace(/\{\d+\}/g, "%s");

function renderShell(version = "", sha256 = "") {
	const lines = [begin, "msg() {", '\tcase "$L:$1" in'];
	for (const [key, values] of Object.entries(strings)) {
		for (const lang of languages) lines.push(`\t\t${shellQuote(`${lang}:${key}`)}) printf '%s' ${shellQuote(format(values[lang]))} ;;`);
	}
	lines.push('\t\t*) printf \'%s\' "$1" ;;', "\tesac", "}", 't() { _key=$1; shift; printf "$(msg "$_key")" "$@"; }', 'tl() { t "$@"; printf \'\\n\'; }');
	lines.push(`APP_PIN_VERSION=${shellQuote(version)}`, `APP_PIN_SHA256=${shellQuote(sha256)}`);
	const localized = [];
	for (const component of components) {
		const id = shellName(component.id);
		for (const field of ["repo", "tag", "version", "license", "home"]) {
			if (component[field] !== undefined) lines.push(`${id}_${shellName(field)}=${shellQuote(component[field])}`);
		}
		for (const [platform, file] of Object.entries(component.files ?? {})) {
			for (const [field, value] of Object.entries(file)) lines.push(`${id}_${shellName(platform)}_${shellName(field)}=${shellQuote(value)}`);
		}
		if (typeof component.source === "string") lines.push(`${id}_SOURCE=${shellQuote(component.source)}`);
		else if (component.source) for (const [platform, source] of Object.entries(component.source)) lines.push(`${id}_SOURCE_${shellName(platform)}=${shellQuote(source)}`);
		for (const field of ["name", "note"]) if (component[field]) localized.push([`${id}_${shellName(field)}`, component[field]]);
		if (component.size?.download) {
			localized.push([`SIZE_${id}`, component.size.download], [`SIZE_${id}_DEPS`, component.size.deps]);
		} else if (component.size) localized.push([`SIZE_${id}`, component.size]);
	}
	lines.push("component_data() {", '\tcase "$L" in');
	for (const lang of languages) {
		lines.push(`\t\t${shellQuote(lang)})`);
		for (const [name, values] of localized) {
			if (typeof values[lang] !== "string") throw new Error(`${name}: missing ${lang}`);
			lines.push(`\t\t\t${name}=${shellQuote(values[lang])}`);
		}
		lines.push("\t\t\t;;");
	}
	lines.push("\tesac", "}", end);
	return lines.join("\n");
}

const powerShellQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const powerShellName = (s) => s.split(/[-_]/).map((part) => part[0].toUpperCase() + part.slice(1)).join("");
const powerShellFormat = (s) => s.replace(/\{\d+\}|[{}]/g, (part) => part.length === 1 ? part + part : part);

function renderPowerShell(version = "", zipSha256 = "") {
	const lines = [begin, "$Msg = @{"];
	for (const lang of languages) {
		lines.push(`\t${powerShellQuote(lang)} = @{`);
		for (const [key, values] of Object.entries(strings)) {
			lines.push(`\t\t${powerShellQuote(key)} = ${powerShellQuote(powerShellFormat(values[lang]))}`);
		}
		lines.push("\t}");
	}
	lines.push("}", "function T([string]$k) { $s = $Msg[$L][$k]; if ($null -eq $s) { $s = $k }; if ($args.Count) { $s -f $args } else { $s -replace '\\{\\{','{' -replace '\\}\\}','}' } }");
	lines.push(`$AppPinVersion = ${powerShellQuote(version)}`, "$AppPinSha256 = ''", `$AppPinZipSha256 = ${powerShellQuote(zipSha256)}`);
	const localized = [];
	for (const component of components) {
		const id = powerShellName(component.id);
		for (const field of ["repo", "tag", "version", "license", "home"]) {
			if (component[field] !== undefined) lines.push(`$${id}${powerShellName(field)} = ${powerShellQuote(component[field])}`);
		}
		for (const [platform, file] of Object.entries(component.files ?? {})) {
			for (const [field, value] of Object.entries(file)) lines.push(`$${id}${powerShellName(platform)}${powerShellName(field)} = ${powerShellQuote(value)}`);
		}
		if (typeof component.source === "string") lines.push(`$${id}Source = ${powerShellQuote(component.source)}`);
		else if (component.source) for (const [platform, source] of Object.entries(component.source)) lines.push(`$${id}Source${powerShellName(platform)} = ${powerShellQuote(source)}`);
		for (const field of ["name", "note"]) if (component[field]) localized.push([`${id}${powerShellName(field)}`, component[field]]);
		if (component.size?.download) {
			localized.push([`Size${id}`, component.size.download], [`Size${id}Deps`, component.size.deps]);
		} else if (component.size) localized.push([`Size${id}`, component.size]);
	}
	lines.push("function Set-ComponentData {", "\tswitch ($L) {");
	for (const lang of languages) {
		lines.push(`\t\t${powerShellQuote(lang)} {`);
		for (const [name, values] of localized) {
			if (typeof values[lang] !== "string") throw new Error(`${name}: missing ${lang}`);
			lines.push(`\t\t\t$${name} = ${powerShellQuote(values[lang])}`);
		}
		lines.push("\t\t}");
	}
	lines.push("\t}", "}", end);
	return lines.join("\n");
}

function generatedOutput(path, render) {
	const source = read(path);
	const start = source.indexOf(begin), stop = source.indexOf(end);
	if (start < 0 || stop < start || source.indexOf(begin, start + begin.length) >= 0 || source.indexOf(end, stop + end.length) >= 0) throw new Error(`${path}: missing or duplicate generated block`);
	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	return source.slice(0, start) + render().replace(/\n/g, newline) + source.slice(stop + end.length);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function releaseBootstrap(tag, repo, installerSha256) {
	const base = `https://github.com/${repo}/releases/download/${tag}`;
	const content = `# agent-steward ${tag} release installer for Windows (bootstrap).
#
#   irm ${base}/install.ps1 | iex
#
# This file is ASCII only for Windows PowerShell 5.1.
# It verifies the real installer as bytes before decoding it as UTF-8 and running it.
# Options: -From DIR -Version TAG -Yes -DryRun -Without a,b -Lang zh-TW|en
# -ReaddHerdrKey -SkipHerdr -NoOpen -NoService (use -Help for details).
# With irm | iex use STEWARD_FROM, STEWARD_VERSION, STEWARD_YES, STEWARD_DRY_RUN,
# STEWARD_WITHOUT, STEWARD_LANG, STEWARD_READD_HERDR_KEY, STEWARD_SKIP_HERDR,
# STEWARD_NO_OPEN and STEWARD_NO_SERVICE instead.
& {
\t$ErrorActionPreference = "Stop"
\ttry { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
\t$bytes = (New-Object Net.WebClient).DownloadData(${powerShellQuote(`${base}/install-windows.ps1`)})
\t$expectedSha256 = '${installerSha256}'
\t$hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace("-", "").ToLowerInvariant()
\tif ($hash -ne $expectedSha256) {
\t\tWrite-Host "agent-steward: checksum mismatch for install-windows.ps1; nothing was installed."
\t\t$global:LASTEXITCODE = 1
\t\treturn
\t}
\t$text = [Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xFEFF)
\t& ([scriptblock]::Create($text)) @args
} @args
`;
	if (/[^\x00-\x7f]/.test(content)) throw new Error("Release bootstrap must contain only ASCII");
	return content.replace(/\n/g, "\r\n");
}

function writeRelease(tag, dist, repo) {
	const directory = realpathSync(dist);
	const sources = new Set(["install.sh", "install.ps1", "scripts/install-windows.ps1"].map((path) => realpathSync(new URL(path, root))));
	for (const name of ["install.sh", "install-windows.ps1", "install.ps1"]) {
		const path = join(directory, name);
		if (sources.has(existsSync(path) ? realpathSync(path) : path)) throw new Error("--dist must not overwrite repository installers");
	}
	const tarSha256 = sha256(readFileSync(join(dist, `agent-steward-${tag}.tar.gz`)));
	const zipSha256 = sha256(readFileSync(join(dist, `agent-steward-${tag}.zip`)));
	const shell = generatedOutput("install.sh", () => renderShell(tag, tarSha256)).replace(/\r\n/g, "\n");
	const windows = "\uFEFF" + generatedOutput("scripts/install-windows.ps1", () => renderPowerShell(tag, zipSha256))
		.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	const bootstrap = releaseBootstrap(tag, repo, sha256(Buffer.from(windows, "utf8")));
	for (const [name, content] of [["install.sh", shell], ["install-windows.ps1", windows], ["install.ps1", bootstrap]]) {
		writeFileSync(join(dist, name), content);
	}
}

if (release !== undefined) {
	writeRelease(release, options.dist, options.repo || process.env.GITHUB_REPOSITORY || "hao-github-0216/agent-steward");
} else {
	// 每種輸出各自產生內容，最後統一比對或寫入。
	const outputs = [
		...['install.sh', 'uninstall.sh'].map((path) => [path, () => generatedOutput(path, renderShell)]),
		...['scripts/install-windows.ps1', 'uninstall.ps1'].map((path) => [path, () => generatedOutput(path, renderPowerShell)]),
		["herdr.json", () => {
			const { repo, tag, note } = components.find((c) => c.id === "herdr");
			return `${JSON.stringify({ repo, tag, note: note["zh-TW"] }, null, 2)}\n`;
		}],
	];
	let stale = false;
	for (const [path, render] of outputs) {
		const content = render();
		// Windows 取出的檔案可能是 CRLF:比對時統一成 LF
		if (read(path).replace(/\r\n/g, "\n") === content.replace(/\r\n/g, "\n")) continue;
		if (check) {
			console.error(`Out of date: ${path}`);
			stale = true;
		} else writeFileSync(fileURLToPath(new URL(path, root)), content);
	}
	if (stale) process.exitCode = 1;
}
