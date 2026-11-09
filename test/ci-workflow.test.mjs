// GitHub Actions 把 `shell: powershell` 的步驟寫成沒有 BOM 的 .ps1,Windows PowerShell 5.1 不會用 UTF-8 讀它:
// 中文會變成亂碼,有些亂碼位元組還會被當成換行或引號,整段腳本就解析失敗。這些步驟只能有 ASCII。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Windows PowerShell 5.1 steps in CI workflows contain only ASCII", () => {
	const bad = [];
	for (const file of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
		let shell = null;
		readFileSync(file, "utf8").split("\n").forEach((line, i) => {
			if (/^\s+- (name|uses):/.test(line)) shell = null;
			const m = /^\s+shell:\s*(\S+)/.exec(line);
			if (m) shell = m[1];
			if (shell === "powershell" && /[^\x00-\x7f]/.test(line)) bad.push(`${file}:${i + 1}`);
		});
	}
	assert.deepEqual(bad, [], `PowerShell 5.1 步驟裡有非 ASCII 字元:${bad.join(", ")}`);
});
