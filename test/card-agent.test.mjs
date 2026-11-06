import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = mkdtempSync(join(tmpdir(), "steward-card-agent-"));
process.env.STEWARD_DATA_DIR = DATA;
after(() => rmSync(DATA, { recursive: true, force: true }));
const { agentIdOf, chooseCardAgent, dispatchProblem } = await import("../src/agents.ts");

const claude = { id: "claude", name: "Claude Code" };
const pi = { id: "pi", name: "pi" };
const codex = { id: "codex", name: "Codex" };
const available = [claude, pi, codex];
const noAgentsNote = "這台電腦沒有偵測到能派工的 agent";

test("agentIdOf:顯示名稱、id 和大小寫都轉成 canonical id", () => {
	for (const name of ["Claude Code", "claude", "CLAUDE", " claude code "]) assert.equal(agentIdOf(name), "claude");
	assert.equal(agentIdOf("PI"), "pi");
	assert.equal(agentIdOf("nope"), undefined);
	assert.equal(agentIdOf(""), undefined);
});

test("chooseCardAgent:有安裝的預設優先,並說明改交給誰", () => {
	assert.deepEqual(chooseCardAgent("pi", { available, defaultAgent: "CLAUDE" }), {
		agent: "claude", note: "設定固定交給 Claude Code",
	});
});

test("chooseCardAgent:requested 和預設是同一個 agent 的不同名稱,不加 note", () => {
	assert.deepEqual(chooseCardAgent("Claude Code", { available, defaultAgent: "claude" }), { agent: "claude" });
	assert.deepEqual(chooseCardAgent(undefined, { available, defaultAgent: "claude" }), { agent: "claude" });
});

test("chooseCardAgent:預設沒裝時退回 requested", () => {
	assert.deepEqual(chooseCardAgent("Codex", { available: [pi, codex], defaultAgent: "Claude Code" }), { agent: "codex" });
});

test("chooseCardAgent:不認得的預設當作沒設定", () => {
	assert.deepEqual(chooseCardAgent("claude", { available, defaultAgent: "nope" }), { agent: "claude" });
});

test("chooseCardAgent:requested 用顯示名稱,回傳 id", () => {
	assert.deepEqual(chooseCardAgent("Claude Code", { available, defaultAgent: "" }), { agent: "claude" });
});

test("chooseCardAgent:requested 沒裝時優先改成 pi,並加 note", () => {
	assert.deepEqual(chooseCardAgent("Gemini CLI", { available, defaultAgent: "" }), {
		agent: "pi", note: "「Gemini CLI」這台電腦沒有裝或不能派工,改交給 pi",
	});
});

test("chooseCardAgent:沒有 pi 時使用 available 第一項", () => {
	assert.deepEqual(chooseCardAgent("nope", { available: [codex, claude], defaultAgent: "" }), {
		agent: "codex", note: "「nope」這台電腦沒有裝或不能派工,改交給 Codex",
	});
});

test("chooseCardAgent:沒指定 requested 時選 pi 或第一項,不加 note", () => {
	assert.deepEqual(chooseCardAgent(undefined, { available, defaultAgent: "" }), { agent: "pi" });
	assert.deepEqual(chooseCardAgent("", { available: [claude], defaultAgent: "" }), { agent: "claude" });
});

test("chooseCardAgent:available 空時保留 requested 並說明原因", () => {
	assert.deepEqual(chooseCardAgent(" nope ", { available: [], defaultAgent: "claude" }), { agent: "nope", note: noAgentsNote });
});

test("chooseCardAgent:available 空時仍會把認得的 requested 轉成 id", () => {
	assert.deepEqual(chooseCardAgent("Claude Code", { available: [], defaultAgent: "" }), { agent: "claude", note: noAgentsNote });
});

test("chooseCardAgent:available 空又沒指定 requested 時保留 pi 並加 note", () => {
	assert.deepEqual(chooseCardAgent(undefined, { available: [], defaultAgent: "claude" }), { agent: "pi", note: noAgentsNote });
	assert.deepEqual(chooseCardAgent("  ", { available: [], defaultAgent: "" }), { agent: "pi", note: noAgentsNote });
});

test("dispatchProblem:不認得的 agent 清楚要求改選", () => {
	assert.equal(dispatchProblem("nope", available), "不認得「nope」這個 agent,請在工作卡上改選一個再重新派工");
});

test("dispatchProblem:認得但沒裝的 agent 顯示正式名稱", () => {
	assert.equal(dispatchProblem("CLAUDE", [pi]), "這台電腦沒有裝 Claude Code,請在工作卡上改選一個再重新派工");
});

test("dispatchProblem:有安裝的 id 或顯示名稱都能派工", () => {
	for (const agent of ["claude", "Claude Code", "CLAUDE", "PI"]) assert.equal(dispatchProblem(agent, available), undefined);
});
