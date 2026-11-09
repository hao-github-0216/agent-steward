import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const files = ["scripts/install-windows.ps1", "uninstall.ps1"];
const strings = JSON.parse(readFileSync(new URL("i18n/installer.json", root), "utf8"));
const components = JSON.parse(readFileSync(new URL("components.json", root), "utf8")).components;
const begin = "# ---- generated: begin (scripts/gen-install.mjs) ----";
const end = "# ---- generated: end ----";
const source = (file) => readFileSync(new URL(file, root), "utf8");
const block = (file) => {
	const text = source(file);
	assert.equal(text.split(begin).length, 2, file);
	assert.equal(text.split(end).length, 2, file);
	return text.slice(text.indexOf(begin) + begin.length + 1, text.indexOf(end));
};

function quoted(text, start) {
	assert.equal(text[start], "'", `Expected a single-quoted string at ${start}`);
	let value = "";
	for (let i = start + 1; i < text.length; i++) {
		if (text[i] !== "'") { value += text[i]; continue; }
		if (text[i + 1] === "'") { value += "'"; i++; continue; }
		return { value, next: i + 1 };
	}
	assert.fail(`Unterminated single-quoted string at ${start}`);
}

function messageTable(text, messages = strings) {
	let cursor = 0;
	const consume = (expected) => {
		assert.equal(text.slice(cursor, cursor + expected.length), expected, `Unexpected PowerShell at ${cursor}`);
		cursor += expected.length;
	};
	const literal = () => {
		const result = quoted(text, cursor);
		cursor = result.next;
		return result.value;
	};
	const table = {};
	consume("$Msg = @{\n");
	for (const lang of ["zh-TW", "en"]) {
		consume("\t");
		assert.equal(literal(), lang);
		consume(" = @{\n");
		table[lang] = {};
		for (const key of Object.keys(messages)) {
			consume("\t\t");
			assert.equal(literal(), key);
			consume(" = ");
			table[lang][key] = literal();
			consume("\n");
		}
		consume("\t}\n");
	}
	consume("}\n");
	assert.ok(text.slice(cursor).startsWith("function T([string]$k)"));
	return table;
}

test("generated PowerShell blocks preserve UTF-8 BOM, LF and their positions after param", () => {
	for (const file of files) {
		const bytes = readFileSync(new URL(file, root));
		assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], file);
		const text = bytes.toString("utf8");
		assert.ok(!text.includes("\r"), `${file}: expected LF`);
		assert.ok(text.indexOf(begin) > text.indexOf("param("), file);
		block(file);
	}
	assert.equal(block(files[0]), block(files[1]));
	const bootstrap = source("install.ps1");
	assert.ok(bootstrap.includes("\r\n"));
	assert.doesNotMatch(bootstrap, /(?<!\r)\n|\r(?!\n)/, "install.ps1: expected CRLF throughout");
});

test("generated PowerShell messages escape apostrophes and non-placeholder braces", () => {
	for (const file of files) {
		const table = messageTable(block(file));
		for (const [key, translations] of Object.entries(strings)) {
			for (const lang of ["zh-TW", "en"]) {
				const value = table[lang][key];
				assert.doesNotMatch(value.replace(/\{\d+\}|\{\{|\}\}/g, ""), /[{}]/, `${file}: ${lang}:${key}`);
				assert.equal(value.replace(/\{\{|\}\}/g, (pair) => pair[0]), translations[lang], `${file}: ${lang}:${key}`);
			}
		}
	}
	assert.ok(block(files[0]).includes("agent-steward''s herdr folder"));
	assert.ok(block(files[0]).includes("$s -f $args"));
	assert.ok(block(files[0]).includes("$s -replace '\\{\\{','{' -replace '\\}\\}','}'"));
});

test("PowerShell component data includes the Windows ttyd source and uses the caller scope", () => {
	const generated = block(files[0]);
	const ttyd = components.find((c) => c.id === "ttyd");
	const herdr = components.find((c) => c.id === "herdr");
	assert.ok(generated.includes(`$TtydSourceWindows = '${ttyd.source.windows}'`));
	assert.ok(generated.includes(`$HerdrRepo = '${herdr.repo}'`));
	assert.ok(generated.includes(`$HerdrTag = '${herdr.tag}'`));
	assert.match(source(files[0]), /^\t\. Set-ComponentData$/m);
	for (const lang of ["zh-TW", "en"]) {
		const start = generated.indexOf(`\t\t'${lang}' {`, generated.indexOf("function Set-ComponentData"));
		assert.ok(start >= 0, lang);
		const localized = generated.slice(start, generated.indexOf("\n\t\t}", start));
		for (const [name, value] of [
			["SizeApp", components.find((c) => c.id === "app").size.download[lang]],
			["SizeAppDeps", components.find((c) => c.id === "app").size.deps[lang]],
			["HerdrNote", herdr.note[lang]],
		]) {
			const prefix = `$${name} = `;
			const position = localized.indexOf(prefix);
			assert.ok(position >= 0, `${lang}: ${name}`);
			const parsed = quoted(localized, position + prefix.length);
			assert.equal(parsed.value, value);
			assert.ok(parsed.next === localized.length || localized[parsed.next] === "\n");
		}
	}
});

test("PowerShell generation escapes literal braces and --check detects either stale ps1", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "steward-ps1-generator-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const folder of ["scripts", "i18n"]) mkdirSync(join(dir, folder));
	writeFileSync(join(dir, "scripts", "gen-install.mjs"), source("scripts/gen-install.mjs"));
	writeFileSync(join(dir, "components.json"), JSON.stringify({ components }));
	const messages = { example: {
		"zh-TW": "{literal}、'quoted'、{0}，結尾大括號 }",
		en: "{literal}, 'quoted', {0}, closing brace }",
	} };
	writeFileSync(join(dir, "i18n", "installer.json"), JSON.stringify(messages));
	for (const file of ["install.sh", "uninstall.sh", ...files]) {
		writeFileSync(join(dir, file), (file.endsWith(".ps1") ? "\uFEFF" : "") + begin + "\n" + end + "\n");
	}
	writeFileSync(join(dir, "herdr.json"), "{}\n");
	const generate = (...args) => spawnSync(process.execPath, ["scripts/gen-install.mjs", ...args], { cwd: dir, encoding: "utf8", timeout: 10_000 });
	assert.equal(generate().status, 0);
	assert.equal(generate("--check").status, 0);
	for (const file of files) {
		const path = join(dir, file);
		const text = readFileSync(path, "utf8");
		const table = messageTable(text.slice(text.indexOf(begin) + begin.length + 1, text.indexOf(end)), messages);
		for (const lang of ["zh-TW", "en"]) {
			assert.ok(table[lang].example.startsWith("{{literal}}"));
			assert.ok(table[lang].example.endsWith("}}"));
			assert.ok(table[lang].example.includes("{0}"));
		}
		assert.ok(text.startsWith("\uFEFF"));
		assert.ok(text.includes("''quoted''"));
		writeFileSync(path, text.replace("''quoted''", "broken"));
		const result = generate("--check");
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.ok(result.stderr.includes(`Out of date: ${file}`), result.stderr);
		assert.equal(generate().status, 0);
	}
});

function isolatedReceipt(t) {
	const dir = mkdtempSync(join(tmpdir(), "steward-ps1-receipt-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const env = { ...process.env, HOME: dir, USERPROFILE: dir, STEWARD_DATA_DIR: dir, STEWARD_LANG: "en" };
	const run = (...args) => spawnSync(process.execPath, [
		"--experimental-strip-types", "--no-warnings", fileURLToPath(new URL("src/install-receipt.ts", root)), ...args,
	], { env, encoding: "utf8", timeout: 10_000 });
	const cli = (...args) => {
		const result = run(...args);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		return result.stdout;
	};
	return { dir, cli, run, receipt: () => JSON.parse(readFileSync(join(dir, "install.json"), "utf8")) };
}

test("receipt set-file preserves Windows paths, quotes, Unicode and cumulative PATH additions", (t) => {
	const { dir, cli, receipt } = isolatedReceipt(t);
	const path = join(dir, "receipt patch's.json");
	const localBin = "C:\\Users\\王 O'Brien\\.local\\bin";
	const herdrDir = "C:\\Users\\王 O'Brien\\.agent-steward\\bin\\herdr";
	const patch = {
		lang: "zh-TW", without: "autostart,open", app: { version: 'v1-{test}-"quoted"' },
		node: { path: "C:\\Program Files\\nodejs\\node.exe", source: "existing" }, pathAdded: [localBin],
	};
	writeFileSync(path, JSON.stringify(patch));
	cli("set-file", path);
	for (const [key, value] of Object.entries(patch)) assert.deepEqual(receipt()[key], value);
	writeFileSync(path, "\uFEFF" + JSON.stringify({ pathAdded: [localBin, herdrDir], without: "open" }));
	cli("set-file", path);
	writeFileSync(path, JSON.stringify({ pathAdded: [] }));
	cli("set-file", path);
	assert.deepEqual(receipt().pathAdded, [localBin, herdrDir]);
	assert.equal(receipt().without, "open");
	assert.deepEqual(receipt().node, patch.node);
	assert.equal(receipt().app.version, patch.app.version);
});

test("receipt records scheduled tasks and summarizes them in both languages", (t) => {
	const { cli, receipt } = isolatedReceipt(t);
	cli("change", "scheduled-task", "agent-steward");
	cli("change", "scheduled-task", "agent-steward-terminal");
	cli("change", "scheduled-task", "agent-steward");
	assert.deepEqual(receipt().changes, [
		{ type: "scheduled-task", path: "agent-steward" },
		{ type: "scheduled-task", path: "agent-steward-terminal" },
	]);
	assert.match(cli("summary", "en"), /Scheduled task: agent-steward\n/);
	assert.match(cli("summary", "zh-TW", "uninstall_receipt_header"), /安裝時做過的改動（已移除）：[\s\S]*工作排程器：agent-steward-terminal/);
});

test("receipt set-file rejects invalid patches without writing a receipt", (t) => {
	const { dir, run } = isolatedReceipt(t);
	const path = join(dir, "bad.json");
	for (const value of ["{broken", "null", "[]", "false"]) {
		writeFileSync(path, value);
		const result = run("set-file", path);
		assert.notEqual(result.status, 0);
		assert.throws(() => readFileSync(join(dir, "install.json")), { code: "ENOENT" });
	}
	assert.notEqual(run("set-file", join(dir, "missing.json")).status, 0);
});
