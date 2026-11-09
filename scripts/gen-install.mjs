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

function shellOutput(path) {
	const source = read(path);
	const start = source.indexOf(begin), stop = source.indexOf(end);
	if (start < 0 || stop < start || source.indexOf(begin, start + begin.length) >= 0) throw new Error(`${path}: missing or duplicate generated block`);
	return source.slice(0, start) + renderShell() + source.slice(stop + end.length);
}

// 每種輸出各自產生內容，最後統一比對或寫入。
const outputs = [
	...['install.sh', 'uninstall.sh'].map((path) => [path, () => shellOutput(path)]),
	["herdr.json", () => {
		const { repo, tag, note } = components.find((c) => c.id === "herdr");
		return `${JSON.stringify({ repo, tag, note: note["zh-TW"] }, null, 2)}\n`;
	}],
];
let stale = false;
for (const [path, render] of outputs) {
	const content = render();
	if (read(path) === content) continue;
	if (check) {
		console.error(`Out of date: ${path}`);
		stale = true;
	} else writeFileSync(fileURLToPath(new URL(path, root)), content);
}
if (stale) process.exitCode = 1;
