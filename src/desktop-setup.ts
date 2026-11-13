// 桌面 App 啟動前套用指令、herdr 設定與既有 agent 整合。
import { tr } from "./i18n.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { refreshIntegrated } from "./agents.ts";
import { batSafe, herdrConfigDir, IS_WIN, pathInside } from "./platform.ts";
import { settings } from "./settings.ts";

function requiredPath(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(tr("請設定 {name} 的絕對路徑後再執行 desktop-setup.ts", { name }));
	return resolve(value);
}

function stat(path: string): ReturnType<typeof lstatSync> | undefined {
	try { return lstatSync(path); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
}

function writeChanged(path: string, content: string): void {
	const existing = stat(path);
	if (existing?.isFile() && readFileSync(path, "utf8") === content) return;
	if (existing?.isSymbolicLink()) unlinkSync(path);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

const shQuote = (value: string) => `"${value.replace(/["\\$`]/g, "\\$&")}"`;
const ownedHerdrPath = (path: string) => pathInside(path, join(homedir(), ".agent-steward")) || /[\\/][^\\/]+\.app[\\/]Contents[\\/]/i.test(path);
const HERDR_CMD_MARK = "@rem agent-steward desktop herdr\r\n";

function installHerdr(bin: string, herdr: string, notes: string[]): void {
	const file = join(bin, IS_WIN ? "herdr.cmd" : "herdr");
	const existing = stat(file);
	if (IS_WIN) {
		const content = `${HERDR_CMD_MARK}@"${herdr}" %*\r\n`;
		if (existing) {
			const before = existing.isFile() ? readFileSync(file, "utf8") : "";
			if (!before.startsWith(HERDR_CMD_MARK)) {
				notes.push(tr("%USERPROFILE%\\.local\\bin\\herdr.cmd 是你自己的檔案，沒有動"));
				return;
			}
		}
		writeChanged(file, content);
	} else {
		if (existing?.isSymbolicLink()) {
			const target = resolve(bin, readlinkSync(file));
			if (target === herdr) return;
			if (ownedHerdrPath(target)) unlinkSync(file);
			else { notes.push(tr("~/.local/bin/herdr 是你自己的連結，沒有動")); return; }
		} else if (existing) {
			notes.push(tr("~/.local/bin/herdr 是你自己的檔案，沒有動"));
			return;
		}
		symlinkSync(herdr, file);
	}
}

function setup(): string[] {
	const app = requiredPath("STEWARD_APP_DIR");
	const node = requiredPath("STEWARD_NODE");
	const herdr = requiredPath("HERDR_BIN_PATH");
	const options = settings().desktop;
	const notes: string[] = [];
	const bin = join(homedir(), ".local", "bin");
	mkdirSync(bin, { recursive: true });
	const steward = join(bin, IS_WIN ? "steward.cmd" : "steward");
	writeChanged(steward, IS_WIN
		? `@echo off\r\n"${node}" "${join(app, "bin", "steward.mjs")}" %*\r\n`
		: `#!/bin/sh\nexec ${shQuote(node)} ${shQuote(join(app, "bin", "steward.mjs"))} "$@"\n`);
	if (!IS_WIN) chmodSync(steward, 0o755);
	if (options.herdrCli) installHerdr(bin, herdr, notes);

	if (IS_WIN) {
		const command = `$bin = $env:STEWARD_LOCALBIN; $parts = @(([Environment]::GetEnvironmentVariable('Path', 'User') -split ';') | Where-Object { $_ }); if (-not ($parts | Where-Object { $_.TrimEnd('\\') -ieq $bin.TrimEnd('\\') })) { [Environment]::SetEnvironmentVariable('Path', (($parts + $bin) -join ';'), 'User') }`;
		execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
			env: { ...process.env, STEWARD_LOCALBIN: bin }, stdio: "pipe", timeout: 15_000, windowsHide: true,
		});
	}

	const run = (command: string, args: string[]) => {
		const safe = batSafe(command, args);
		const result = spawnSync(safe.cmd, safe.args, { ...safe.opts, env: { ...process.env, STEWARD_NODE: node }, encoding: "utf8", timeout: 20_000, windowsHide: true });
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		return result;
	};
	if (options.herdrConfig) {
		const plugins = join(herdrConfigDir(), "plugins-local");
		for (const dir of readdirSync(join(app, "herdr-plugins"), { withFileTypes: true })) {
			if (!dir.isDirectory()) continue;
			const source = join(app, "herdr-plugins", dir.name);
			const destination = join(plugins, dir.name);
			mkdirSync(destination, { recursive: true });
			for (const file of readdirSync(source)) {
				if (file !== "herdr-plugin.toml") cpSync(join(source, file), join(destination, file), { recursive: true });
			}
			const toml = readFileSync(join(source, "herdr-plugin.toml"), "utf8").replaceAll('"node"', () => JSON.stringify(node));
			writeChanged(join(destination, "herdr-plugin.toml"), toml);
			const linked = run(herdr, ["plugin", "link", destination]);
			if (linked.status !== 0) notes.push(tr("herdr 外掛 {name} 連結失敗：{error}", { name: dir.name, error: linked.error?.message ?? linked.stderr.trim() }));
		}
		const configured = run(node, ["--experimental-strip-types", "--no-warnings", join(app, "src", "herdr-setup.ts")]);
		if (configured.status !== 0) throw new Error(tr("herdr 快捷鍵設定失敗：{error}", { error: configured.error?.message ?? configured.stderr.trim() }));
		run(herdr, ["server", "reload-config"]);
	}
	for (const path of refreshIntegrated()) console.log(`已更新 agent 整合：${path}`);
	return notes;
}

try {
	const notes = setup();
	console.log(`@@desktop ${JSON.stringify({ cmd: "setup", ok: true, notes })}`);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`[desktop-setup] ${message}`);
	console.log(`@@desktop ${JSON.stringify({ cmd: "setup", ok: false, notes: [message] })}`);
	process.exitCode = 1;
}
