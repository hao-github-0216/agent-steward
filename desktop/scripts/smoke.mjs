#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { tmpdir } from "node:os";
import path, { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const usage = `Usage: node desktop/scripts/smoke.mjs --exe <installed App executable> [--keep]
Run isolated startup and shutdown checks. --keep preserves the temporary HOME and logs.

Examples:
  node desktop/scripts/smoke.mjs --exe "/tmp/Agent Steward.app/Contents/MacOS/agent-steward-desktop"
  node desktop/scripts/smoke.mjs --exe "C:\\test\\Agent Steward\\agent-steward-desktop.exe"`;

export function parseArgs(args) {
	let exe;
	let keep = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--keep" && !keep) keep = true;
		else if (args[i] === "--exe" && !exe && args[i + 1] && !args[i + 1].startsWith("--")) exe = args[++i];
		else throw new Error(`Unknown, duplicate, or incomplete argument: ${args[i]}\n${usage}`);
	}
	if (!exe) throw new Error(`--exe is required.\n${usage}`);
	return { exe, keep };
}

export function isPathInside(root, candidate, platform = process.platform) {
	const paths = platform === "win32" ? path.win32 : path.posix;
	if (!paths.isAbsolute(root) || !paths.isAbsolute(candidate)) return false;
	if (platform === "win32") { root = root.toLowerCase(); candidate = candidate.toLowerCase(); }
	const relative = paths.relative(root, candidate);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
}

export function safePath(root, ...parts) {
	const result = resolve(root, ...parts);
	if (!isPathInside(root, result)) throw new Error(`Refusing a path outside the temporary HOME: ${result}`);
	return result;
}

export function isSafePort(port) {
	return Number.isInteger(port) && port > 0 && port <= 65535 && (port < 8780 || port > 8810);
}

function checkPort(port) {
	if (!isSafePort(port)) throw new Error(`Refusing reserved or invalid port: ${port}`);
}

export async function pickPorts() {
	const reservations = [];
	try {
		while (reservations.length < 2) {
			const server = createServer();
			await new Promise((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
			if (isSafePort(server.address().port)) reservations.push(server);
			else await new Promise((yes, no) => server.close((error) => error ? no(error) : yes()));
		}
		return reservations.map((server) => server.address().port);
	} finally {
		await Promise.all(reservations.map((server) => new Promise((yes, no) => server.close((error) => error ? no(error) : yes()))));
	}
}

export function isolatedEnv(source, home, ports, platform = process.platform) {
	if (ports.length !== 2 || ports[0] === ports[1] || !ports.every(isSafePort)) throw new Error("Two different safe ports are required");
	const env = Object.fromEntries(Object.entries(source).filter(([key]) => !/^(HERDR_|STEWARD_)/i.test(key)));
	for (const key of Object.keys(env)) {
		if (["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP", "NODE_OPTIONS"].includes(key.toUpperCase())) delete env[key];
	}
	Object.assign(env, {
		HOME: home,
		STEWARD_DATA_DIR: safePath(home, ".agent-steward"),
		STEWARD_DESKTOP_TAKEOVER: "decline",
		STEWARD_PORT: String(ports[0]),
		STEWARD_TERMINAL_PORT: String(ports[1]),
		XDG_CONFIG_HOME: safePath(home, ".config"),
		XDG_CACHE_HOME: safePath(home, ".cache"),
		XDG_DATA_HOME: safePath(home, ".local", "share"),
		XDG_STATE_HOME: safePath(home, ".local", "state"),
		TMPDIR: safePath(home, "tmp"), TMP: safePath(home, "tmp"), TEMP: safePath(home, "tmp"),
	});
	if (platform === "win32") Object.assign(env, {
		USERPROFILE: home,
		APPDATA: safePath(home, "AppData", "Roaming"),
		LOCALAPPDATA: safePath(home, "AppData", "Local"),
	});
	return env;
}

export function parseMacProcesses(output) {
	return output.split(/\r?\n/).flatMap((line) => {
		const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
		return match ? [{ pid: Number(match[1]), exe: match[2] }] : [];
	});
}

async function processes(appRoot, options) {
	let entries;
	if (process.platform === "darwin") {
		const { stdout } = await exec("ps", ["-axo", "pid=,comm="], options);
		entries = parseMacProcesses(stdout);
	} else {
		const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select ProcessId,ExecutablePath | ConvertTo-Json -Compress"], options);
		const rows = JSON.parse(stdout.trim() || "[]");
		entries = (Array.isArray(rows) ? rows : [rows]).filter(Boolean).map((row) => ({ pid: Number(row.ProcessId), exe: row.ExecutablePath }));
	}
	return entries.filter(({ pid, exe }) => pid > 1 && typeof exe === "string" && isPathInside(appRoot, exe));
}

async function portOpen(port) {
	checkPort(port);
	return new Promise((done) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		const finish = (value) => { socket.destroy(); done(value); };
		socket.setTimeout(500, () => finish(true));
		socket.once("connect", () => finish(true));
		socket.once("error", (error) => finish(error.code !== "ECONNREFUSED"));
	});
}

async function get(port, endpoint, json = false) {
	checkPort(port);
	const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { redirect: "error", signal: AbortSignal.timeout(1000) });
	if (response.status !== 200) { await response.body?.cancel(); return false; }
	if (json) return (await response.json()).mode === "desktop";
	await response.body?.cancel();
	return true;
}

const pause = () => new Promise((done) => setTimeout(done, 250));
async function waitFor(label, timeout, check, cancelled) {
	const deadline = Date.now() + timeout;
	let detail = "";
	do {
		if (cancelled()) throw new Error("Smoke test interrupted");
		const result = await check();
		if (result === true) return;
		detail = typeof result === "string" ? result : "not ready";
		await pause();
	} while (Date.now() < deadline);
	throw new Error(`${label} timed out after ${timeout / 1000}s: ${detail}`);
}

async function tailLogs(home) {
	const logs = safePath(home, ".agent-steward", "logs");
	async function visit(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const file = safePath(home, directory, entry.name);
			if (entry.isDirectory()) await visit(file);
			else if (entry.isFile() && isPathInside(home, await realpath(file))) {
				const text = await readFile(file, "utf8");
				console.error(`--- ${path.relative(home, file)} (last 40 lines) ---\n${text.trimEnd().split(/\r?\n/).slice(-40).join("\n")}`);
			}
		}
	}
	try { await visit(logs); } catch (error) { console.error(`Cannot read smoke logs: ${error.message}`); }
}

export async function smoke({ exe, keep }) {
	if (!["darwin", "win32"].includes(process.platform)) throw new Error("Smoke tests require macOS or Windows");
	exe = await realpath(resolve(exe));
	let appRoot = dirname(exe);
	if (process.platform === "darwin") {
		if (basename(exe) !== "agent-steward-desktop" || basename(appRoot) !== "MacOS" || basename(dirname(appRoot)) !== "Contents" || !dirname(dirname(appRoot)).endsWith(".app")) throw new Error("--exe must be the main executable inside Agent Steward.app/Contents/MacOS/");
		appRoot = dirname(dirname(appRoot));
	} else if (basename(exe).toLowerCase() !== "agent-steward-desktop.exe") throw new Error("--exe must point to the installed agent-steward-desktop.exe");
	const home = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "steward-smoke-")));
	let launched = false;
	let interrupted = false;
	let options;
	let failed = false;
	const onSignal = () => { interrupted = true; };
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		const ports = await pickPorts();
		const env = isolatedEnv(process.env, home, ports);
		options = { cwd: home, env, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true };
		for (const directory of [".agent-steward", "tmp", ".config", ".cache", ".local/share", ".local/state", "AppData/Roaming", "AppData/Local"]) await mkdir(safePath(home, directory), { recursive: true });
		await writeFile(safePath(home, ".agent-steward", "settings.json"), '{"desktop":{"autostart":false}}\n', { mode: 0o600 });
		const existing = await processes(appRoot, options);
		if (existing.length) throw new Error(`Refusing to test an App with existing processes: ${JSON.stringify(existing)}`);
		const kill = async (pid, signal) => {
			if (!(await processes(appRoot, options)).some((entry) => entry.pid === pid)) return;
			if (process.platform === "win32") await exec("taskkill.exe", ["/PID", String(pid), "/F"], options);
			else { try { process.kill(pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } }
		};
		const rounds = process.platform === "darwin" ? ["normal", "forced"] : ["forced"];
		for (const round of rounds) {
			const out = await open(safePath(home, `${round}.stdout.log`), "a", 0o600);
			const err = await open(safePath(home, `${round}.stderr.log`), "a", 0o600);
			let child;
			let spawnError;
			try {
				child = spawn(exe, ["--autostart"], { cwd: home, env, stdio: ["ignore", out.fd, err.fd], windowsHide: true });
				child.once("error", (error) => { spawnError = error; });
			} finally { await Promise.all([out.close(), err.close()]); }
			launched = true;
			console.log(`Smoke ${round}: PID ${child.pid}, ports ${ports.join(", ")}`);
			await waitFor(`${round} startup`, 90_000, async () => {
				if (spawnError) throw spawnError;
				if (child.exitCode !== null || child.signalCode !== null) throw new Error(`App exited during startup (${child.exitCode ?? child.signalCode})`);
				try {
					if (!await get(ports[0], "/api/health", true)) return "health is not desktop mode";
					if (!await get(ports[0], "/terminal/")) return "terminal route is not ready";
					const command = await readFile(safePath(home, ".local", "bin", process.platform === "win32" ? "steward.cmd" : "steward"), "utf8");
					const node = join(dirname(exe), process.platform === "win32" ? "node.exe" : "node");
					const quotedNode = process.platform === "win32" ? node : node.replace(/["\\$`]/g, "\\$&");
					if (!command.includes(`"${quotedNode}"`)) return "steward command does not point to the bundled node";
					const entries = await processes(appRoot, options);
					const count = (name) => entries.filter((entry) => basename(entry.exe).toLowerCase() === name).length;
					if (count(process.platform === "win32" ? "node.exe" : "node") < 2 || count(process.platform === "win32" ? "ttyd.exe" : "ttyd") < 1) return `bundled processes missing: ${JSON.stringify(entries)}`;
					return true;
				} catch (error) { return error.message; }
			}, () => interrupted);
			console.log(`PASS: ${round} startup, health, terminal, command, and bundled processes`);
			await kill(child.pid, round === "normal" ? "SIGTERM" : "SIGKILL");
			await waitFor(`${round} shutdown`, round === "normal" ? 15_000 : 20_000, async () => {
				const entries = await processes(appRoot, options);
				const openPorts = (await Promise.all(ports.map(portOpen))).some(Boolean);
				return (child.exitCode !== null || child.signalCode !== null) && !entries.length && !openPorts ? true : `processes=${JSON.stringify(entries)}, portsOpen=${openPorts}`;
			}, () => interrupted);
			console.log(`PASS: ${round} shutdown, no App processes or listening ports`);
		}
	} catch (error) {
		failed = true;
		console.error(`smoke: ${error.message}`);
		await tailLogs(home);
	} finally {
		try {
			if (launched) {
				await waitFor("cleanup", 10_000, async () => {
					const entries = await processes(appRoot, options);
					for (const { pid } of entries) {
						if (!failed) { failed = true; console.error(`smoke: unexpected remaining App process ${pid}`); }
						if (process.platform === "win32") await exec("taskkill.exe", ["/PID", String(pid), "/F"], options).catch(() => {});
						else { try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
					}
					return entries.length === 0;
				}, () => false);
			}
		} catch (error) { failed = true; console.error(`smoke cleanup: ${error.message}`); }
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		if (keep) console.log(`Smoke temporary HOME retained: ${home}`);
		else await rm(home, { recursive: true, force: true });
	}
	return !failed;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const args = process.argv.slice(2);
		if (args.length === 1 && ["--help", "-h"].includes(args[0])) console.log(usage);
		else if (!await smoke(parseArgs(args))) process.exitCode = 1;
	} catch (error) { console.error(`smoke: ${error.message}`); process.exitCode = 1; }
}
