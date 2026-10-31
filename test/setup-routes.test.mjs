// 只裝了 agent CLI 的人:整理回報、提案檢查沒接上模型時看板要提醒;聊天用 CLI 時看不懂圖片
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STEWARD_DATA_DIR = mkdtempSync(join(tmpdir(), "setup-routes-"));
const { updateSettings } = await import("../src/settings.ts");
const { chatUsesCli, missingCoreRoutes } = await import("../src/models.ts");

const cli = { id: "claude-cli", type: "agent-cli", name: "Claude Code", cli: "claude" };
const api = { id: "openai", type: "builtin", builtin: "openai", auth: "apiKey", name: "OpenAI" };
const route = (primary) => ({ primary, fallback: "" });

test("沒有任何接口:兩項都缺", () => {
	assert.deepEqual(missingCoreRoutes(), ["整理 agent 回報", "提案檢查"]);
	assert.equal(chatUsesCli(), false);
});

test("只有 agent CLI:聊天用 CLI,整理回報、提案檢查仍然缺", () => {
	updateSettings({ providers: [cli], routing: { chat: route("claude-cli/default"), suggest: route(""), digest: route("claude-cli/default"), judge: route(""), commitmsg: route(""), privacy: "" } });
	assert.deepEqual(missingCoreRoutes(), ["整理 agent 回報", "提案檢查"]);
	assert.equal(chatUsesCli(), true);
});

test("接上可以呼叫工具的接口就不缺;接口被刪掉又算缺", () => {
	updateSettings({ providers: [cli, api], routing: { chat: route("openai/gpt-x"), suggest: route(""), digest: route("openai/gpt-x"), judge: route("openai/gpt-x"), commitmsg: route(""), privacy: "" } });
	assert.deepEqual(missingCoreRoutes(), []);
	assert.equal(chatUsesCli(), false);
	updateSettings({ providers: [cli] });
	assert.deepEqual(missingCoreRoutes(), ["整理 agent 回報", "提案檢查"]);
});
