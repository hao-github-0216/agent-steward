#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const components = JSON.parse(read("components.json")).components;
const strings = JSON.parse(read("i18n/installer.json"));
const languages = ["zh-TW", "en"];
const begin = "# ---- generated: begin (scripts/gen-install.mjs) ----";
const end = "# ---- generated: end ----";
const check = process.argv.includes("--check");
if (process.argv.slice(2).some((arg) => arg !== "--check")) throw new Error("Usage: node scripts/gen-install.mjs [--check]");

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

function renderShell() {
	const lines = [begin, "msg() {", '\tcase "$L:$1" in'];
	for (const [key, values] of Object.entries(strings)) {
		for (const lang of languages) lines.push(`\t\t${shellQuote(`${lang}:${key}`)}) printf '%s' ${shellQuote(format(values[lang]))} ;;`);
	}
	lines.push('\t\t*) printf \'%s\' "$1" ;;', "\tesac", "}", 't() { _key=$1; shift; printf "$(msg "$_key")" "$@"; }', 'tl() { t "$@"; printf \'\\n\'; }');
	const localized = [];
	for (const component of components) {
		const id = shellName(component.id);
		for (const field of ["repo", "tag", "version", "license", "home"]) {
			if (component[field] !== undefined) lines.push(`${id}_${shellName(field)}=${shellQuote(component[field])}`);
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

function renderPowerShell() {
	const lines = [begin, "$Msg = @{"];
	for (const lang of languages) {
		lines.push(`\t${powerShellQuote(lang)} = @{`);
		for (const [key, values] of Object.entries(strings)) {
			lines.push(`\t\t${powerShellQuote(key)} = ${powerShellQuote(powerShellFormat(values[lang]))}`);
		}
		lines.push("\t}");
	}
	lines.push("}", "function T([string]$k) { $s = $Msg[$L][$k]; if ($null -eq $s) { $s = $k }; if ($args.Count) { $s -f $args } else { $s -replace '\\{\\{','{' -replace '\\}\\}','}' } }");
	const localized = [];
	for (const component of components) {
		const id = powerShellName(component.id);
		for (const field of ["repo", "tag", "version", "license", "home"]) {
			if (component[field] !== undefined) lines.push(`$${id}${powerShellName(field)} = ${powerShellQuote(component[field])}`);
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
