// 支線:分叉出來的紀錄檔會複製主線的歷史,管家只能讀到「支線自己的內容」
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offsetSince, transcriptSince } from "../src/transcripts.ts";

const FORK_AT = Date.parse("2026-10-28T23:21:19.727Z");
const msg = (type, ts, text) => JSON.stringify({ type, timestamp: ts, message: { role: type, content: [{ type: "text", text }] } });

function forkFile() {
	const dir = mkdtempSync(join(tmpdir(), "steward-branch-"));
	const path = join(dir, "fork.jsonl");
	const rows = [
		// Claude Code 分叉:開頭先寫幾行設定(沒有或有新的時間戳)
		JSON.stringify({ type: "ai-title", aiTitle: "x" }),
		JSON.stringify({ type: "mode", mode: "auto", timestamp: "2026-10-28T23:21:20.000Z" }),
		// 從主線複製過來的歷史,時間戳保留原本的
		msg("user", "2026-10-28T04:01:14.000Z", "主線的舊問題"),
		msg("assistant", "2026-10-28T04:05:00.000Z", "主線的舊回答"),
		// 新版 Claude Code 記下的整包請求(含全部舊訊息、沒有時間戳)
		JSON.stringify({ type: "api-request-blob", message: { role: "user", content: [{ type: "text", text: "主線的舊問題(請求內容)" }] } }),
		// 支線自己的內容
		msg("user", "2026-10-28T23:21:30.000Z", "支線的新問題"),
		msg("assistant", "2026-10-28T23:21:34.000Z", "支線的新回答"),
	];
	writeFileSync(path, rows.join("\n") + "\n");
	return path;
}

test("只讀到分叉之後支線自己的對話", () => {
	const text = transcriptSince(forkFile(), FORK_AT);
	assert.match(text, /支線的新問題/);
	assert.match(text, /支線的新回答/);
	assert.doesNotMatch(text, /主線的舊/);
});

test("讀取起點在最後一行舊紀錄之後(開頭的新時間戳設定行不算)", () => {
	const path = forkFile();
	const text = transcriptSince(path, FORK_AT);
	assert.ok(offsetSince(path, FORK_AT) > 0);
	assert.doesNotMatch(text, /請求內容/);
});

test("沒有複製歷史的紀錄檔(Codex 分叉)從頭讀", () => {
	const dir = mkdtempSync(join(tmpdir(), "steward-branch-"));
	const path = join(dir, "codex.jsonl");
	writeFileSync(path, [msg("user", "2026-10-28T23:22:00.000Z", "支線問題"), msg("assistant", "2026-10-28T23:22:05.000Z", "支線回答")].join("\n") + "\n");
	assert.equal(offsetSince(path, FORK_AT), 0);
	assert.match(transcriptSince(path, FORK_AT), /支線問題/);
});

test("管家塞給節錄支線的開場訊息不算進支線內容", () => {
	const dir = mkdtempSync(join(tmpdir(), "steward-branch-"));
	const path = join(dir, "excerpt.jsonl");
	writeFileSync(path, [msg("user", "2026-10-28T23:22:00.000Z", "【專案管家支線】你是從主線開出來的支線 agent。請先讀…"), msg("user", "2026-10-28T23:23:00.000Z", "真正的問題")].join("\n") + "\n");
	const text = transcriptSince(path, FORK_AT);
	assert.doesNotMatch(text, /專案管家支線/);
	assert.match(text, /真正的問題/);
});
