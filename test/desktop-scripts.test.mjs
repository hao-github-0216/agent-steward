import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedEnv, isPathInside, isSafePort, parseArgs, parseMacProcesses, pickPorts, safePath } from "../desktop/scripts/smoke.mjs";

test("desktop smoke accepts an executable path and optional keep flag", () => {
	assert.deepEqual(parseArgs(["--exe", "/tmp/Agent Steward.app/exe"]), { exe: "/tmp/Agent Steward.app/exe", keep: false });
	assert.deepEqual(parseArgs(["--keep", "--exe", "C:\\App\\agent-steward-desktop.exe"]), { exe: "C:\\App\\agent-steward-desktop.exe", keep: true });
});

test("desktop smoke rejects missing, duplicate, and unknown arguments", () => {
	for (const args of [[], ["--exe"], ["--exe", "--keep"], ["--exe", "one", "--exe", "two"], ["--exe", "one", "--keep", "--keep"], ["--exe", "one", "--other"]]) assert.throws(() => parseArgs(args));
});

test("desktop smoke excludes the complete reserved port range", () => {
	for (let port = 8780; port <= 8810; port++) assert.equal(isSafePort(port), false, String(port));
	for (const port of [0, -1, 65536, 1.5, "9000", NaN]) assert.equal(isSafePort(port), false);
	for (const port of [1, 8779, 8811, 65535]) assert.equal(isSafePort(port), true);
});

test("desktop smoke picks two different ephemeral loopback ports", async () => {
	const ports = await pickPorts();
	assert.equal(ports.length, 2);
	assert.notEqual(ports[0], ports[1]);
	assert.ok(ports.every(isSafePort));
});

test("desktop smoke confines POSIX paths to descendants, not sibling prefixes", () => {
	assert.equal(isPathInside("/tmp/app", "/tmp/app/Contents/MacOS/node", "darwin"), true);
	for (const candidate of ["/tmp/app", "/tmp/app-other/node", "/tmp/app/../other/node", "relative"]) assert.equal(isPathInside("/tmp/app", candidate, "darwin"), false);
});

test("desktop smoke handles Windows drive letters and case without matching siblings", () => {
	assert.equal(isPathInside("C:\\App", "c:\\app\\node.exe", "win32"), true);
	for (const candidate of ["C:\\Application\\node.exe", "D:\\App\\node.exe", "C:\\App", "C:\\App\\..\\other\\node.exe"]) assert.equal(isPathInside("C:\\App", candidate, "win32"), false);
});

test("desktop smoke rejects writes outside its temporary HOME", async () => {
	const home = await mkdtemp(join(tmpdir(), "steward-smoke-unit-"));
	try {
		assert.equal(safePath(home, ".agent-steward", "settings.json"), join(home, ".agent-steward", "settings.json"));
		assert.throws(() => safePath(home, "..", "outside"));
		assert.throws(() => safePath(home, home));
	} finally { await rm(home, { recursive: true, force: true }); }
});

test("desktop smoke removes inherited service configuration and isolates all data directories", () => {
	const home = process.platform === "win32" ? "C:\\scratch\\smoke" : "/tmp/smoke";
	const source = { PATH: "/usr/bin", HOME: "/real/home", USERPROFILE: "/real/home", STEWARD_PORT: "8791", STEWARD_OTHER: "old", HERDR_CONFIG: "old", NODE_OPTIONS: "--require /real/home/code.js", XDG_CONFIG_HOME: "/real/config" };
	const env = isolatedEnv(source, home, [30001, 30002]);
	assert.equal(env.PATH, source.PATH);
	assert.equal(env.HOME, home);
	assert.equal(env.STEWARD_DESKTOP_TAKEOVER, "decline");
	assert.equal(env.STEWARD_PORT, "30001");
	assert.equal(env.STEWARD_TERMINAL_PORT, "30002");
	assert.equal(env.HERDR_CONFIG, undefined);
	assert.equal(env.STEWARD_OTHER, undefined);
	assert.equal(env.NODE_OPTIONS, undefined);
	assert.equal(source.HOME, "/real/home");
	for (const key of ["STEWARD_DATA_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR", "TMP", "TEMP"]) assert.ok(isPathInside(home, env[key]), key);
});

test("desktop smoke requires distinct, non-reserved ports before constructing child environments", () => {
	for (const ports of [[8791, 30000], [30000, 30000], [30000], [30000, 30001, 30002]]) assert.throws(() => isolatedEnv({}, "/tmp/smoke", ports));
});

test("desktop smoke preserves spaces in macOS executable paths", () => {
	assert.deepEqual(parseMacProcesses("   12 /tmp/Agent Steward.app/Contents/MacOS/node\n 34 /usr/bin/other\ninvalid\n"), [
		{ pid: 12, exe: "/tmp/Agent Steward.app/Contents/MacOS/node" },
		{ pid: 34, exe: "/usr/bin/other" },
	]);
});
