import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WIN = process.platform === "win32";

function fixture(t, desktop = {}) {
	const dir = mkdtempSync(join(tmpdir(), "steward-desktop-setup-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const home = join(dir, "home with spaces");
	const data = join(home, "data");
	const bin = join(home, ".local", "bin");
	const configDir = join(home, "herdr");
	const config = join(configDir, "config.toml");
	const herdr = join(dir, WIN ? "fake herdr.cmd" : "fake herdr");
	const log = join(dir, "herdr.log");
	mkdirSync(data, { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(data, "settings.json"), JSON.stringify({
		version: 1, access: { tailscale: { enabled: false } }, plugins: {}, setupDone: true, aiDetected: true, desktop,
	}));
	writeFileSync(herdr, WIN ? `@echo off\r\necho %*>>"${log}"\r\necho {}\r\n` : `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nprintf '{}\\n'\n`, { mode: 0o755 });
	const env = {
		...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, APPDATA: home,
		STEWARD_DATA_DIR: data, STEWARD_APP_DIR: ROOT, STEWARD_NODE: process.execPath, HERDR_BIN_PATH: herdr,
		HERDR_SOCKET_PATH: join(dir, "no-herdr.sock"), STEWARD_LANG: "zh-TW", STEWARD_DESKTOP: "1",
	};
	const args = ["--experimental-strip-types", "--no-warnings"];
	if (WIN) {
		// 暫存 HOME 不會隔離 Windows 的使用者登錄檔,測試不真的修改使用者 PATH。
		const preload = join(dir, "isolate-powershell.mjs");
		writeFileSync(preload, `
			import cp from "node:child_process";
			import { syncBuiltinESMExports } from "node:module";
			import { appendFileSync } from "node:fs";
			const original = cp.execFileSync;
			cp.execFileSync = (command, args, options) => {
				if (command !== "powershell.exe") return original(command, args, options);
				appendFileSync(${JSON.stringify(join(dir, "path.log"))}, JSON.stringify({ args, bin: options.env.STEWARD_LOCALBIN }) + "\\n");
				return Buffer.alloc(0);
			};
			syncBuiltinESMExports();
		`);
		args.push("--import", pathToFileURL(preload).href);
	}
	const run = () => {
		const result = spawnSync(process.execPath, [...args, join(ROOT, "src", "desktop-setup.ts")], { cwd: ROOT, env, encoding: "utf8", timeout: 30_000 });
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const last = result.stdout.trimEnd().split(/\r?\n/).at(-1);
		assert.match(last, /^@@desktop /);
		const signal = JSON.parse(last.slice("@@desktop ".length));
		assert.equal(signal.cmd, "setup");
		assert.equal(signal.ok, true);
		assert.ok(Array.isArray(signal.notes));
		return { ...result, signal };
	};
	return { dir, home, data, bin, configDir, config, herdr, log, run };
}

test("desktop setup installs commands, plugins, shortcuts and existing agent integrations; reruns are idempotent", (t) => {
	const f = fixture(t);
	mkdirSync(f.configDir, { recursive: true });
	const before = '[general]\ntheme = "dark"\n';
	writeFileSync(f.config, before);
	const plugins = join(f.configDir, "plugins-local");
	const sentinel = join(plugins, "folder-nav", "user-file.txt");
	mkdirSync(join(plugins, "folder-nav"), { recursive: true });
	writeFileSync(sentinel, "keep this file");
	const piDir = join(f.home, ".pi", "agent");
	mkdirSync(piDir, { recursive: true });
	const mcp = join(piDir, "mcp.json");
	writeFileSync(mcp, JSON.stringify({ mcpServers: { steward: { command: "old-steward", args: ["mcp"] } } }));

	assert.deepEqual(f.run().signal.notes, []);
	const steward = join(f.bin, WIN ? "steward.cmd" : "steward");
	const wrapper = readFileSync(steward, "utf8");
	assert.equal(wrapper, WIN
		? `@echo off\r\n"${process.execPath}" "${join(ROOT, "bin", "steward.mjs")}" %*\r\n`
		: `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "bin", "steward.mjs")}" "$@"\n`);
	if (!WIN) {
		assert.equal(statSync(steward).mode & 0o777, 0o755);
		assert.equal(readlinkSync(join(f.bin, "herdr")), f.herdr);
	} else {
		assert.ok(readFileSync(join(f.bin, "herdr.cmd"), "utf8").includes(`@"${f.herdr}" %*`));
		const pathCall = JSON.parse(readFileSync(join(f.dir, "path.log"), "utf8").trim());
		assert.equal(pathCall.bin, f.bin);
		assert.equal(pathCall.args[0], "-NoProfile");
		assert.ok(pathCall.args.at(-1).includes("[Environment]::SetEnvironmentVariable"));
		assert.ok(readFileSync(join(f.data, "bin", "folder-nav.cmd"), "utf8").includes(process.execPath));
	}
	const copied = [];
	for (const plugin of ["folder-nav", "current-space-agents"]) {
		const toml = join(plugins, plugin, "herdr-plugin.toml");
		const text = readFileSync(toml, "utf8");
		assert.ok(text.includes(JSON.stringify(process.execPath)));
		assert.doesNotMatch(text, /"node"/);
		copied.push([toml, text]);
		const script = plugin === "folder-nav" ? "folder_nav.mjs" : "agent_view.mjs";
		assert.equal(readFileSync(join(plugins, plugin, script), "utf8"), readFileSync(join(ROOT, "herdr-plugins", plugin, script), "utf8"));
	}
	const config = readFileSync(f.config, "utf8");
	assert.match(config, /key = "prefix\+e"/);
	assert.match(config, /folder[_-]nav\.(mjs|cmd)/);
	const receipt = JSON.parse(readFileSync(join(f.data, "install.json"), "utf8"));
	assert.equal(readFileSync(receipt.backups[0], "utf8"), before);
	const commands = readFileSync(f.log, "utf8");
	assert.match(commands, /plugin link/);
	assert.match(commands, /server reload-config/);
	assert.equal(readFileSync(sentinel, "utf8"), "keep this file");
	const entry = JSON.parse(readFileSync(mcp, "utf8")).mcpServers.steward;
	assert.equal(entry.command, WIN ? process.execPath : steward);
	assert.deepEqual(entry.args, WIN ? [join(ROOT, "bin", "steward.mjs"), "mcp"] : ["mcp"]);
	assert.equal(existsSync(join(piDir, "extensions", "steward-brief.ts")), false);

	const stamp = statSync(steward).mtimeMs;
	const agentBefore = readFileSync(mcp, "utf8");
	assert.deepEqual(f.run().signal.notes, []);
	assert.equal(statSync(steward).mtimeMs, stamp, "identical steward wrapper is not rewritten");
	assert.equal(readFileSync(f.config, "utf8"), config);
	assert.equal(readFileSync(mcp, "utf8"), agentBefore);
	assert.equal(readFileSync(sentinel, "utf8"), "keep this file");
	for (const [path, text] of copied) assert.equal(readFileSync(path, "utf8"), text);
});

test("desktop setup preserves a user's own herdr file and explains why", (t) => {
	const f = fixture(t);
	const file = join(f.bin, WIN ? "herdr.cmd" : "herdr");
	const before = WIN ? `@"${f.herdr}" %*\r\n` : "user's own herdr\n";
	writeFileSync(file, before);
	const result = f.run();
	assert.equal(readFileSync(file, "utf8"), before);
	assert.ok(result.signal.notes.some((note) => note.includes("你自己的檔案") && note.includes("沒有動")));
});

for (const owned of ["legacy", "app"]) test(`desktop setup replaces an owned ${owned} herdr symlink, including dangling links`, { skip: WIN }, (t) => {
	const f = fixture(t, { herdrConfig: false });
	const target = owned === "legacy" ? join(f.home, ".agent-steward", "bin", "herdr") : join(f.dir, "Old Steward.app", "Contents", "Resources", "herdr");
	symlinkSync(target, join(f.bin, "herdr"));
	f.run();
	assert.equal(readlinkSync(join(f.bin, "herdr")), f.herdr);
});

test("desktop setup preserves a herdr symlink to an unrelated installation", { skip: WIN }, (t) => {
	const f = fixture(t, { herdrConfig: false });
	const target = join(f.dir, "user-herdr");
	symlinkSync(target, join(f.bin, "herdr"));
	const result = f.run();
	assert.equal(readlinkSync(join(f.bin, "herdr")), target);
	assert.ok(result.signal.notes.some((note) => note.includes("你自己的連結")));
});

test("desktop.herdrCli=false skips the herdr command but still installs steward", (t) => {
	const f = fixture(t, { herdrCli: false, herdrConfig: false });
	f.run();
	assert.equal(existsSync(join(f.bin, WIN ? "steward.cmd" : "steward")), true);
	assert.throws(() => lstatSync(join(f.bin, WIN ? "herdr.cmd" : "herdr")), { code: "ENOENT" });
});

test("desktop setup tolerates a stopped herdr server during reload-config", (t) => {
	const f = fixture(t);
	writeFileSync(f.herdr, WIN
		? '@echo off\r\nif "%1"=="server" exit /b 1\r\necho {}\r\n'
		: '#!/bin/sh\n[ "$1" = server ] && exit 1\nprintf \'{}\\n\'\n', { mode: 0o755 });
	assert.deepEqual(f.run().signal.notes, []);
	assert.match(readFileSync(f.config, "utf8"), /key = "prefix\+e"/);
});

test("desktop.herdrConfig=false neither copies plugins nor changes config.toml", (t) => {
	const f = fixture(t, { herdrConfig: false });
	mkdirSync(f.configDir, { recursive: true });
	const before = '[general]\ntheme = "custom"\n';
	writeFileSync(f.config, before);
	f.run();
	assert.equal(existsSync(join(f.configDir, "plugins-local")), false);
	assert.equal(readFileSync(f.config, "utf8"), before);
	assert.equal(existsSync(f.log), false);
	assert.equal(existsSync(join(f.data, "install.json")), false);
});
