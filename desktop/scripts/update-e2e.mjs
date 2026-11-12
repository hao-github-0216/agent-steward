#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isolatedEnv, pickPorts, isSafePort, isPathInside, safePath, parseMacProcesses } from "./smoke.mjs";
import { sign, manifest } from "./updater-artifacts.mjs";

const exec = promisify(execFile);
export const usage = `Usage: node desktop/scripts/update-e2e.mjs --old-app <old .app or setup.exe> --new <update artifact> --new-version <x.y.z> --key-file <test signing key> --port <manifest HTTP port>

Run an isolated, signed desktop update test on macOS or Windows. No prompts.
All five options are required. Ports 8780–8810 are forbidden.
The old App must already embed this HTTP port's http://127.0.0.1:<port>/latest.json
endpoint and the matching test public key through build --config. There are no
runtime URL or public-key overrides. Use test builds and a test signing key only.
Temporary HOME, copied App, signed artifact, and logs are removed even on failure.

Examples:
  node desktop/scripts/update-e2e.mjs --old-app '/tmp/old/Agent Steward.app' --new /tmp/new/update.tar.gz --new-version 0.4.1 --key-file /tmp/updater-test-signing --port 19341
  node desktop/scripts/update-e2e.mjs --old-app C:\\test\\old-setup.exe --new C:\\test\\new-setup.exe --new-version 0.4.1 --key-file C:\\test\\updater-test-signing --port 19341`;

export function parseArgs(args) {
	if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
	const names = { "--old-app": "oldApp", "--new": "newFile", "--new-version": "newVersion", "--key-file": "keyFile", "--port": "port" };
	const options = {};
	for (let i = 0; i < args.length; i += 2) {
		const name = names[args[i]];
		if (!name || Object.hasOwn(options, name) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Unknown, duplicate, or incomplete option: ${args[i]}. Use --help for examples.`);
		options[name] = args[i + 1];
	}
	for (const [flag, name] of Object.entries(names)) if (!options[name]) throw new Error(`${flag} is required. Use --help for examples.`);
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(options.newVersion)) throw new Error("--new-version must be x.y.z (without a prefix or prerelease)");
	if (!/^\d+$/.test(options.port) || !isSafePort(Number(options.port))) throw new Error("--port must be 1–65535, excluding 8780–8810");
	options.port = Number(options.port);
	return options;
}

const pause = (ms = 250) => new Promise((done) => setTimeout(done, ms));
export async function waitFor(label, timeout, check, cancelled = () => false) {
	const deadline = Date.now() + timeout;
	do {
		if (cancelled()) throw new Error("Update E2E interrupted");
		if (await check()) return;
		await pause();
	} while (Date.now() < deadline);
	throw new Error(`${label} timed out after ${timeout / 1000}s`);
}

async function run(command, args, options) {
	try { return await exec(command, args, options); }
	catch { throw new Error(`${basename(command)} failed (command output suppressed)`); }
}

export function ownsProcess(appRoot, entry, platform = process.platform) {
	if (!Number.isInteger(entry.pid) || entry.pid <= 1 || typeof entry.exe !== "string" || typeof entry.commandLine !== "string" || !isPathInside(appRoot, entry.exe, platform)) return false;
	return platform === "win32" ? entry.commandLine.toLowerCase().includes(appRoot.toLowerCase()) : entry.commandLine.includes(appRoot);
}

async function appProcesses(appRoot, options) {
	let entries;
	if (process.platform === "darwin") {
		const { stdout } = await run("/bin/ps", ["-axo", "pid=,comm="], options);
		entries = parseMacProcesses(stdout).filter((entry) => entry.pid > 1 && isPathInside(appRoot, entry.exe));
		entries = await Promise.all(entries.map(async (entry) => {
			try {
				const { stdout: commandLine } = await exec("/bin/ps", ["-ww", "-p", String(entry.pid), "-o", "command="], options);
				return { ...entry, commandLine: commandLine.trim() };
			} catch { return { ...entry, commandLine: "" }; }
		}));
	} else {
		const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"], options);
		const rows = JSON.parse(stdout.trim() || "[]");
		entries = (Array.isArray(rows) ? rows : [rows]).filter(Boolean).map((row) => ({ pid: Number(row.ProcessId), parentPid: Number(row.ParentProcessId), exe: row.ExecutablePath, commandLine: row.CommandLine }));
	}
	return entries.filter((entry) => entry.pid > 1 && typeof entry.exe === "string" && isPathInside(appRoot, entry.exe));
}

async function stopProcess(appRoot, pid, signal, options) {
	// Recheck both executable and command line immediately before signalling.
	const entry = (await appProcesses(appRoot, options)).find((entry) => entry.pid === pid);
	if (!entry || !ownsProcess(appRoot, entry)) return;
	if (process.platform === "win32") await run("taskkill.exe", ["/PID", String(pid), "/F"], options);
	else {
		try { process.kill(pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
	}
}

export async function portOpen(port) {
	if (!isSafePort(port)) throw new Error("Refusing to inspect an unsafe port");
	return new Promise((done) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		const finish = (value) => { socket.destroy(); done(value); };
		socket.setTimeout(500, () => finish(true));
		socket.once("connect", () => finish(true));
		socket.once("error", (error) => finish(error.code !== "ECONNREFUSED"));
	});
}

async function healthy(port) {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/health`, { redirect: "error", signal: AbortSignal.timeout(1000) });
		if (response.status !== 200) { await response.body?.cancel(); return false; }
		const health = await response.json();
		if (health.ok !== true || health.mode !== "desktop") return false;
		const terminal = await fetch(`http://127.0.0.1:${port}/terminal/`, { redirect: "error", signal: AbortSignal.timeout(1000) });
		await terminal.body?.cancel();
		return terminal.status === 200;
	} catch { return false; }
}

export function createArtifactServer(manifestFile, artifactFile) {
	const routes = new Map([["/latest.json", manifestFile], [`/${encodeURIComponent(basename(artifactFile))}`, artifactFile]]);
	return createServer((request, response) => {
		const file = routes.get(request.url);
		if (!["GET", "HEAD"].includes(request.method) || !file) { response.writeHead(404); response.end(); return; }
		response.setHeader("Content-Type", request.url === "/latest.json" ? "application/json" : "application/octet-stream");
		response.setHeader("Cache-Control", "no-store");
		if (request.method === "HEAD") { response.end(); return; }
		const stream = createReadStream(file);
		stream.on("error", () => response.destroy());
		response.on("close", () => stream.destroy());
		stream.pipe(response);
	});
}

export function safeLog(text, secrets = []) {
	let clean = String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
	for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) clean = clean.split(secret).join("[redacted]");
	return clean.split(/\r?\n/).map((line) => {
		if (/PRIVATE KEY|TAURI_SIGNING_|\b(?:HOME|USERPROFILE|PATH|STEWARD_\w+|HERDR_\w+)=|[A-Za-z0-9+/=]{80,}/i.test(line)) return "[sensitive log line omitted]";
		return line.replace(/((?:token|password|secret|authorization|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]");
	}).join("\n");
}

async function dumpLogs(home, secrets) {
	for (const name of ["app.stdout.log", "app.stderr.log", ".agent-steward/logs/desktop.log", ".agent-steward/logs/steward.log", ".agent-steward/logs/steward.err.log", ".agent-steward/logs/terminal.log", ".agent-steward/logs/terminal.err.log"]) {
		try {
			const file = safePath(home, name);
			if (!isPathInside(home, await realpath(file))) continue;
			const handle = await open(file, "r");
			let text;
			try {
				const { size } = await handle.stat();
				const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
				text = buffer.subarray(0, bytesRead).toString("utf8");
			} finally { await handle.close(); }
			console.error(`--- ${name} (last 40 lines) ---\n${safeLog(text, secrets).trimEnd().split(/\r?\n/).slice(-40).join("\n")}`);
		} catch { /* Missing logs are normal before the App starts. */ }
	}
}

// On Windows, list what is still running from the App folder or as an installer,
// and read the text of their open windows (a blocked NSIS installer waits on a dialog).
const WINDOWS_DIAGNOSTICS = String.raw`
$root = $env:STEWARD_E2E_ROOT.TrimEnd('\') + '\'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$procs = @(Get-CimInstance Win32_Process | Where-Object {
  ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) -or $_.Name -match 'installer|setup|uninstall'
})
"processes: $($procs.Count)"
foreach ($p in $procs) {
  "- $($p.Name) pid=$($p.ProcessId) parent=$($p.ParentProcessId)"
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$p.ProcessId)
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  foreach ($w in $windows) {
    "  window: $($w.Current.Name)"
    foreach ($e in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
      if ($e.Current.Name) { "    $($e.Current.ControlType.ProgrammaticName): $($e.Current.Name)" }
    }
  }
}
`;

async function windowsDiagnostics(appRoot, options, secrets) {
	if (process.platform !== "win32" || !appRoot || !options) return;
	try {
		const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_DIAGNOSTICS], { ...options, timeout: 30_000, env: { ...options.env, STEWARD_E2E_ROOT: appRoot } });
		console.error(`--- Windows processes and dialogs ---\n${safeLog(stdout, secrets).trimEnd().split(/\r?\n/).slice(0, 80).join("\n")}`);
	} catch { console.error("--- Windows processes and dialogs: unavailable ---"); }
}

async function appVersion(appRoot, exe, options) {
	if (process.platform === "darwin") {
		const { stdout } = await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", safePath(appRoot, "Contents", "Info.plist")], options);
		return stdout.trim();
	}
	const script = "$v = (Get-Item -LiteralPath $env:STEWARD_E2E_EXE).VersionInfo; '{0}.{1}.{2}' -f $v.FileMajorPart,$v.FileMinorPart,$v.FileBuildPart";
	const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { ...options, env: { ...options.env, STEWARD_E2E_EXE: exe } });
	const version = stdout.trim();
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Could not read the App file version");
	return version;
}

export async function updateE2E({ oldApp, newFile, newVersion, keyFile, port }) {
	// Validate direct callers as well as CLI users before creating any files.
	({ oldApp, newFile, newVersion, keyFile, port } = parseArgs(["--old-app", oldApp, "--new", newFile, "--new-version", newVersion, "--key-file", keyFile, "--port", String(port)]));
	if (!["darwin", "win32"].includes(process.platform)) throw new Error("Update E2E requires macOS or Windows");
	oldApp = await realpath(resolve(oldApp));
	newFile = await realpath(resolve(newFile));
	keyFile = await realpath(resolve(keyFile));
	if (!(await stat(newFile)).isFile() || !(await stat(keyFile)).isFile()) throw new Error("--new and --key-file must be regular files");
	if (process.platform === "darwin" ? !oldApp.endsWith(".app") || !(await stat(oldApp)).isDirectory() : !oldApp.toLowerCase().endsWith(".exe") || !(await stat(oldApp)).isFile()) throw new Error("--old-app must be a macOS .app directory or a Windows setup.exe");
	const repoRoot = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
	const home = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "steward-update-e2e-")));
	let appRoot;
	let exe;
	let ports = [];
	let options;
	let server;
	let interrupted = false;
	let failure;
	let launched = false;
	let oldPid;
	let newPid;
	let secrets = [];
	const controller = new AbortController();
	const onSignal = () => { interrupted = true; controller.abort(); };
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		if (home === repoRoot || isPathInside(repoRoot, home)) throw new Error("Temporary HOME must be outside the repository");
		secrets = (await readFile(keyFile, "utf8")).trim().split(/\r?\n/).filter(Boolean);
		secrets.push(...Object.entries(process.env).filter(([name]) => /TAURI_SIGNING_|TOKEN|PASSWORD|SECRET|API_KEY/i.test(name)).map(([, value]) => value));
		do { ports = await pickPorts(); } while (ports.includes(port));
		if ((await Promise.all([...ports, port].map(portOpen))).some(Boolean)) throw new Error("A selected test port is already occupied; no process was stopped");
		const env = isolatedEnv(process.env, home, ports);
		for (const name of Object.keys(env)) if (/^TAURI_SIGNING_/i.test(name)) delete env[name];
		Object.assign(env, { STEWARD_DESKTOP_UPDATE: "accept", STEWARD_DESKTOP_TAKEOVER: "decline" });
		options = { cwd: home, env, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal: controller.signal };
		for (const directory of [".agent-steward", "tmp", ".config", ".cache", ".local/share", ".local/state", "AppData/Roaming", "AppData/Local", "artifacts", "app"]) await mkdir(safePath(home, directory), { recursive: true });
		await writeFile(safePath(home, ".agent-steward", "settings.json"), `${JSON.stringify({
			desktop: { autostart: false, autoUpdate: true, herdrCli: false, herdrConfig: false },
			server: { port: ports[0], terminalPort: ports[1], hosts: ["127.0.0.1"], publicUrl: "", tailnetBindReviewed: false },
			access: { tailscale: { enabled: false }, lan: { enabled: false }, tailscaleUsers: [] },
		})}\n`, { mode: 0o600 });
		const artifact = safePath(home, "artifacts", process.platform === "darwin" ? "update.tar.gz" : "update-setup.exe");
		const latest = safePath(home, "artifacts", "latest.json");
		const notes = safePath(home, "artifacts", "notes");
		await copyFile(newFile, artifact);
		try { await sign({ file: artifact, keyFile, env: process.env }); }
		catch { throw new Error("Test artifact signing failed (signer output suppressed to protect private keys)"); }
		if (interrupted) throw new Error("Update E2E interrupted");
		await writeFile(notes, "Isolated desktop updater E2E test\n", { mode: 0o600 });
		await manifest({ version: newVersion, notesFile: notes, baseUrl: `http://127.0.0.1:${port}/`, [process.platform === "darwin" ? "mac" : "win"]: artifact, out: latest });
		server = createArtifactServer(latest, artifact);
		await new Promise((yes, no) => { server.once("error", no); server.listen(port, "127.0.0.1", yes); });
		if (process.platform === "darwin") {
			appRoot = safePath(home, "app", "Agent Steward.app");
			await run("/bin/cp", ["-R", oldApp, appRoot], { ...options, timeout: 120_000 });
			exe = safePath(appRoot, "Contents", "MacOS", "agent-steward-desktop");
		} else {
			appRoot = safePath(home, "app", "Agent Steward");
			// NSIS requires /D to be the final argument, without added quotes. Node quotes
			// arguments that contain spaces, so pass them verbatim and run a copy of the
			// installer from a path without spaces.
			const installer = safePath(home, "artifacts", "old-setup.exe");
			if (/\s/.test(installer)) throw new Error("Temporary installer path must not contain spaces");
			await copyFile(oldApp, installer);
			await run(installer, ["/S", `/D=${appRoot}`], { ...options, timeout: 120_000, windowsVerbatimArguments: true });
			exe = safePath(appRoot, "agent-steward-desktop.exe");
		}
		if (interrupted) throw new Error("Update E2E interrupted");
		if (!isPathInside(appRoot, await realpath(exe))) throw new Error("Installed main executable escaped the temporary App root");
		if ((await appProcesses(appRoot, options)).length) throw new Error("Temporary App already has running processes");
		if (await appVersion(appRoot, exe, options) === newVersion) throw new Error("Old App already has --new-version; an actual version change is required");
		const out = await open(safePath(home, "app.stdout.log"), "a", 0o600);
		const err = await open(safePath(home, "app.stderr.log"), "a", 0o600);
		let child;
		let spawnError;
		try {
			child = spawn(exe, ["--autostart"], { cwd: home, env, stdio: ["ignore", out.fd, err.fd], windowsHide: true });
			child.once("error", () => { spawnError = true; });
		} finally { await Promise.all([out.close(), err.close()]); }
		launched = true;
		oldPid = child.pid;
		console.log(`Update E2E: old PID ${oldPid}, service ports ${ports.join(", ")}, manifest port ${port}`);
		// The App checks for updates after health is ready; do not trigger a second check.
		await waitFor("updated App restart, version, isolated HOME, health, and terminal", 240_000, async () => {
			if (spawnError) throw new Error("Old App failed to spawn");
			const entries = await appProcesses(appRoot, options);
			const mainName = process.platform === "darwin" ? "agent-steward-desktop" : "agent-steward-desktop.exe";
			const main = entries.find((entry) => entry.pid !== oldPid && basename(entry.exe).toLowerCase() === mainName && ownsProcess(appRoot, entry));
			if (!main || entries.some((entry) => entry.pid === oldPid)) return false;
			try {
				if (await appVersion(appRoot, exe, options) !== newVersion) return false;
				const log = await readFile(safePath(home, ".agent-steward", "logs", "desktop.log"), "utf8");
				if ((log.match(/App starting/g) || []).length < 2) return false;
				if (process.platform === "darwin") {
					// Inspect inherited HOME without printing any process environment.
					const { stdout } = await run("/bin/ps", ["eww", "-p", String(main.pid), "-o", "command="], options);
					if (!stdout.includes(` HOME=${home} `) && !stdout.trimEnd().endsWith(` HOME=${home}`)) return false;
				}
				if (!await healthy(ports[0])) return false;
				if (!(await appProcesses(appRoot, options)).some((entry) => entry.pid === main.pid && ownsProcess(appRoot, entry))) return false;
				newPid = main.pid;
				return true;
			} catch { return false; }
		}, () => interrupted);
	} catch (error) {
		failure = error;
		console.error(`update-e2e: ${safeLog(error.message, secrets)}`);
		await dumpLogs(home, secrets);
		await windowsDiagnostics(appRoot, options, secrets);
	} finally {
		// Cleanup must run even when a signal cancelled a setup command.
		if (options) { options = { ...options }; delete options.signal; }
		try {
			if (appRoot && options) {
				if (process.platform === "darwin") {
					for (const entry of await appProcesses(appRoot, options)) if (basename(entry.exe) === "agent-steward-desktop") await stopProcess(appRoot, entry.pid, "SIGTERM", options);
					if (launched) {
						try { await waitFor("graceful App shutdown", 15_000, async () => !(await appProcesses(appRoot, options)).length); }
						catch { /* Force only revalidated processes inside this App root below. */ }
					}
				}
				let quietSince = 0;
				await waitFor("temporary App process cleanup", 35_000, async () => {
					const entries = await appProcesses(appRoot, options);
					if (entries.length) {
						quietSince = 0;
						for (const entry of entries) await stopProcess(appRoot, entry.pid, "SIGKILL", options);
						return false;
					}
					quietSince ||= Date.now();
					return Date.now() - quietSince >= 2000;
				});
			}
		} catch (error) {
			failure ||= error;
			console.error(`update-e2e cleanup: ${safeLog(error.message, secrets)}`);
			await dumpLogs(home, secrets);
		} finally {
			try {
				if (server) {
					const closed = new Promise((yes, no) => server.close((error) => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? no(error) : yes()));
					server.closeAllConnections();
					await closed;
				}
				if (options) await waitFor("all three test ports closed and no App processes", 10_000, async () => {
					const entries = appRoot ? await appProcesses(appRoot, options) : [];
					return !entries.length && !(await Promise.all([...ports, port].map(portOpen))).some(Boolean);
				});
			} catch (error) {
				failure ||= error;
				console.error(`update-e2e residual check: ${safeLog(error.message, secrets)}`);
				await dumpLogs(home, secrets);
			} finally {
				try { await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); }
				catch { failure ||= new Error("Could not remove the temporary HOME"); }
				process.off("SIGINT", onSignal);
				process.off("SIGTERM", onSignal);
			}
		}
	}
	if (interrupted) failure ||= new Error("Update E2E interrupted");
	if (failure) throw new Error("Update E2E failed; see sanitized diagnostics above");
	console.log(`PASS: updated to ${newVersion}; old PID ${oldPid}, new PID ${newPid}; isolated HOME, desktop health, terminal ready; no App processes, all three ports closed, temporary files removed`);
	return { version: newVersion, oldPid, newPid };
}

export async function main(args = process.argv.slice(2)) {
	const options = parseArgs(args);
	if (options.help) { console.log(usage); return; }
	await updateE2E(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => { console.error(`update-e2e: ${error.message}`); process.exitCode = 1; });
}
