import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = fileURLToPath(new URL("../", import.meta.url));
const AGENTS_URL = new URL("../src/agents.ts", import.meta.url).href;

// agents.ts 在載入時固定 HOME,只能在已隔離環境的子程序載入。
function runIsolated(t, source) {
	const home = mkdtempSync(join(tmpdir(), "steward-agents-refresh-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "--eval", `
		import assert from "node:assert/strict";
		import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
		import { homedir } from "node:os";
		import { join } from "node:path";
		const home = process.env.HOME;
		assert.equal(process.env.USERPROFILE, home);
		assert.equal(process.env.STEWARD_DATA_DIR, home);
		assert.equal(realpathSync(homedir()), realpathSync(home));
		const { AGENTS, agentStatus, setAgent, refreshIntegrated, removeAll } = await import(${JSON.stringify(AGENTS_URL)});
		const status = (id) => agentStatus(AGENTS.find((def) => def.id === id));
		${source}
	`], {
		cwd: APP_DIR,
		env: { ...process.env, HOME: home, USERPROFILE: home, STEWARD_DATA_DIR: home, STEWARD_APP_DIR: APP_DIR },
		encoding: "utf8",
		timeout: 30_000,
	});
}

test("agents.refreshIntegrated: codex 不會重新啟用已拿掉的 instructions,removeAll 仍移除所有部分", (t) => {
	runIsolated(t, `
		assert.deepEqual(setAgent("codex", true).status.on, { brief: true, mcp: true, instructions: true });
		const instructions = join(home, ".codex", "AGENTS.md");
		unlinkSync(instructions);
		assert.deepEqual(status("codex").on, { brief: true, mcp: true, instructions: false });

		const refreshed = refreshIntegrated();
		assert.deepEqual(status("codex").on, { brief: true, mcp: true, instructions: false });
		assert.equal(existsSync(instructions), false);
		assert.equal(refreshed.includes(instructions), false);

		removeAll();
		assert.deepEqual(status("codex").on, { brief: false, mcp: false, instructions: false });
		assert.equal(status("codex").integrated, false);
	`);
});

test("agents.refreshIntegrated: pi 只啟用 MCP 時不建立 brief extension 或 instructions", (t) => {
	runIsolated(t, `
		const agentDir = join(home, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		const mcp = join(agentDir, "mcp.json");
		writeFileSync(mcp, JSON.stringify({ mcpServers: { steward: { command: "old-steward", args: ["mcp"] } } }));
		assert.deepEqual(status("pi").on, { brief: false, mcp: true, instructions: false });

		refreshIntegrated();
		assert.deepEqual(status("pi").on, { brief: false, mcp: true, instructions: false });
		const link = join(agentDir, "extensions", "steward-brief.ts");
		assert.throws(() => lstatSync(link), { code: "ENOENT" });
		assert.equal(existsSync(join(agentDir, "AGENTS.md")), false);
		const entry = JSON.parse(readFileSync(mcp, "utf8")).mcpServers.steward;
		assert.notEqual(entry.command, "old-steward");
		assert.equal(entry.env.STEWARD_AGENT, "pi");
	`);
});
