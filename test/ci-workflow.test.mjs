// GitHub Actions 把 `shell: powershell` 的步驟寫成沒有 BOM 的 .ps1,Windows PowerShell 5.1 不會用 UTF-8 讀它:
// 中文會變成亂碼,有些亂碼位元組還會被當成換行或引號,整段腳本就解析失敗。這些步驟只能有 ASCII。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Windows PowerShell 5.1 steps in CI workflows contain only ASCII", () => {
	const bad = [];
	for (const file of [".github/workflows/ci.yml", ".github/workflows/release.yml", ".github/workflows/desktop.yml"]) {
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

function workflowJobs(text) {
	return [...text.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm)].map((match) => ({ name: match[1], text: match[2] }));
}

test("release delegates desktop builds and inherits signing secrets", () => {
	const release = readFileSync(".github/workflows/release.yml", "utf8");
	const desktop = workflowJobs(release).find((job) => job.name === "desktop");
	assert.ok(desktop);
	assert.match(desktop.text, /^    uses: \.\/\.github\/workflows\/desktop\.yml$/m);
	assert.match(desktop.text, /^    secrets: inherit$/m);
});

test("only the publish job generates release checksums and provenance", () => {
	const jobs = workflowJobs(readFileSync(".github/workflows/release.yml", "utf8"));
	const generating = jobs.filter((job) => /sha256sum[^\n]*>\s*SHA256SUMS/.test(job.text));
	const attesting = jobs.filter((job) => /uses: actions\/attest-build-provenance@/.test(job.text));
	assert.deepEqual(generating.map((job) => job.name), ["publish"]);
	assert.deepEqual(attesting.map((job) => job.name), ["publish"]);
	assert.equal(jobs.find((job) => job.name === "publish").text.match(/uses: actions\/attest-build-provenance@/g).length, 1);
});

test("desktop workflow never enables shell tracing", () => {
	assert.doesNotMatch(readFileSync(".github/workflows/desktop.yml", "utf8"), /set\s+-x/);
});

test("desktop and release workflows only use official actions or the local desktop workflow", () => {
	for (const file of [".github/workflows/desktop.yml", ".github/workflows/release.yml"]) {
		const text = readFileSync(file, "utf8");
		const uses = [...text.matchAll(/^\s+(?:-\s+)?uses:\s*(\S+)/gm)].map((match) => match[1]);
		assert.ok(uses.length > 0, file);
		for (const action of uses) assert.ok(action.startsWith("actions/") || action === "./.github/workflows/desktop.yml", `${file}: ${action}`);
	}
});

test("desktop Tauri builds run inside desktop and Windows uses pwsh", () => {
	const text = readFileSync(".github/workflows/desktop.yml", "utf8");
	assert.doesNotMatch(text, /shell:\s*powershell\b/);
	const builds = [...text.matchAll(/^      - name: [^\n]+\n([\s\S]*?)(?=^      - |$(?![\s\S]))/gm)].filter((match) => /npx tauri build/.test(match[1]));
	assert.equal(builds.length, 3);
	for (const build of builds) {
		assert.match(build[1], /^        working-directory: desktop$/m);
		assert.match(build[1], /--config "[^"\n]*tauri-version\.json"/);
	}
	for (const name of ["Build the ad-hoc App bundle", "Create and verify the ad-hoc DMG"]) {
		const step = text.match(new RegExp(`^      - name: ${name}\\n([\\s\\S]*?)(?=^      - |$(?![\\s\\S]))`, "m"));
		assert.ok(step, name);
		assert.match(step[1], /^        if: steps\.mode\.outputs\.mode != 'signed'$/m);
		assert.doesNotMatch(step[1], /APPLE_/);
	}
});
