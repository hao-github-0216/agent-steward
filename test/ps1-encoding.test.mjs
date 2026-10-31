// Windows 安裝程式的編碼:Windows PowerShell 5.1 讀檔預設用系統編碼(繁中 Windows 是 Big5),
// UTF-8 的中文會變亂碼、JSON 解析失敗(「傳入了未結束的字串」)。讀 JSON 一定要 -Encoding UTF8;一行安裝的 install.ps1 只能有 ASCII
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ps1 = execFileSync("git", ["ls-files", "*.ps1"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);

test("PowerShell 讀 JSON 檔一律指定 -Encoding UTF8", () => {
	const bad = [];
	for (const f of ps1) {
		readFileSync(f, "utf8").split("\n").forEach((line, i) => {
			if (/Get-Content\b/i.test(line) && /ConvertFrom-Json/i.test(line) && !/-Encoding\s+UTF8/i.test(line)) bad.push(`${f}:${i + 1}`);
		});
	}
	assert.deepEqual(bad, [], `沒指定 UTF-8 的地方:${bad.join(", ")}`);
});

test("一行安裝用的 install.ps1 只有 ASCII(irm 下載的內容不會用 UTF-8 解)", () => {
	const text = readFileSync("install.ps1", "utf8");
	const i = [...text].findIndex((c) => c.charCodeAt(0) > 127);
	assert.equal(i, -1, `install.ps1 有非 ASCII 字元(第 ${i} 個字)`);
});
