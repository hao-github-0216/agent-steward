import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tag = "v9.9.9";
const sources = ["install.sh", "install.ps1", "scripts/install-windows.ps1"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const snapshot = () => new Map(sources.map((file) => [file, readFileSync(join(root, file))]));
const unchanged = (before) => {
	for (const [file, bytes] of before) assert.deepEqual(readFileSync(join(root, file)), bytes, file);
};

function temporary(t) {
	const dir = mkdtempSync(join(tmpdir(), "steward-release-installers-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function generate(args, env = {}) {
	return spawnSync(process.execPath, ["scripts/gen-install.mjs", ...args], {
		cwd: root, env: { ...process.env, ...env }, encoding: "utf8", timeout: 10_000,
	});
}

function fixture(t) {
	const dir = temporary(t);
	for (const format of ["tar.gz", "zip"]) {
		const result = spawnSync("git", [
			"archive", `--format=${format}`, `--prefix=agent-steward-${tag}/`,
			"-o", join(dir, `agent-steward-${tag}.${format}`), "HEAD",
		], { cwd: root, encoding: "utf8", timeout: 30_000 });
		assert.equal(result.status, 0, result.stdout + result.stderr);
	}
	return {
		dir,
		run: (...args) => generate(["--release", tag, "--dist", dir, ...args]),
		read: (name) => readFileSync(join(dir, name)),
	};
}

test("release mode generates three pinned installers without changing repository installers", (t) => {
	const before = snapshot();
	const { dir, run, read } = fixture(t);
	const repo = "release-owner/agent-steward";
	const result = run("--repo", repo);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.deepEqual(readdirSync(dir).sort(), [
		`agent-steward-${tag}.tar.gz`, `agent-steward-${tag}.zip`,
		"install-windows.ps1", "install.ps1", "install.sh",
	].sort());
	const tarSha256 = sha256(read(`agent-steward-${tag}.tar.gz`));
	const zipSha256 = sha256(read(`agent-steward-${tag}.zip`));
	const shell = read("install.sh").toString("utf8");
	const windowsBytes = read("install-windows.ps1");
	const windows = windowsBytes.toString("utf8");
	assert.ok(shell.includes(`APP_PIN_VERSION='${tag}'`));
	assert.ok(shell.includes(`APP_PIN_SHA256='${tarSha256}'`));
	assert.ok(windows.includes(`$AppPinVersion = '${tag}'`));
	assert.ok(windows.includes(`$AppPinZipSha256 = '${zipSha256}'`));
	assert.deepEqual([...windowsBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
	assert.ok(!windows.includes("\r"), "Windows release installer uses LF");
	const bootstrapBytes = read("install.ps1");
	const bootstrap = bootstrapBytes.toString("utf8");
	assert.ok(bootstrapBytes.every((byte) => byte <= 0x7f), "bootstrap is ASCII only");
	assert.ok(bootstrap.includes("\r\n"));
	assert.doesNotMatch(bootstrap, /(?<!\r)\n|\r(?!\n)/, "bootstrap uses CRLF throughout");
	assert.ok(bootstrap.startsWith(`# agent-steward ${tag} release installer for Windows`));
	assert.ok(bootstrap.includes(`https://github.com/${repo}/releases/download/${tag}/install-windows.ps1`));
	assert.ok(bootstrap.includes(`$expectedSha256 = '${sha256(windowsBytes)}'`));
	assert.ok(bootstrap.includes("[Security.Cryptography.SHA256]::Create().ComputeHash($bytes)"));
	assert.match(bootstrap, /if \(\$hash -ne \$expectedSha256\) \{\r\n\s*Write-Host "agent-steward: checksum mismatch for install-windows\.ps1; nothing was installed\."\r\n\s*\$global:LASTEXITCODE = 1\r\n\s*return\r\n\s*\}/);
	assert.doesNotMatch(bootstrap, /STEWARD_REF|STEWARD_REPO|PSScriptRoot|ReadAllBytes|raw\.githubusercontent|\bexit\b/);
	assert.ok(bootstrap.indexOf("ComputeHash($bytes)") < bootstrap.indexOf("UTF8.GetString($bytes)"));
	assert.ok(bootstrap.includes(".TrimStart([char]0xFEFF)"));
	assert.ok(bootstrap.includes("& ([scriptblock]::Create($text)) @args\r\n} @args"));
	unchanged(before);
});

test("release bootstrap repository comes from --repo, GITHUB_REPOSITORY, then the project default", (t) => {
	const { dir, read } = fixture(t);
	for (const [args, env, repo] of [
		[["--repo", "explicit/repo"], { GITHUB_REPOSITORY: "environment/repo" }, "explicit/repo"],
		[[], { GITHUB_REPOSITORY: "environment/repo" }, "environment/repo"],
		[[], { GITHUB_REPOSITORY: "" }, "hao-github-0216/agent-steward"],
	]) {
		const result = generate(["--release", tag, "--dist", dir, ...args], env);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.ok(read("install.ps1").toString("ascii").includes(`https://github.com/${repo}/releases/download/${tag}/install-windows.ps1`));
	}
});

test("release shell installer defaults to its pin offline and keeps --version and --from overrides", { skip: process.platform === "win32" }, (t) => {
	const { dir, run } = fixture(t);
	const generated = run();
	assert.equal(generated.status, 0, generated.stdout + generated.stderr);
	const home = join(dir, "home");
	mkdirSync(home);
	const revision = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" });
	assert.equal(revision.status, 0, revision.stderr);
	for (const [args, version] of [[[], tag], [["--version", "v9.8.7"], "v9.8.7"], [["--from", root], revision.stdout.trim()]]) {
		const result = spawnSync("/usr/bin/env", [
			"-i", `HOME=${home}`, "PATH=/usr/bin:/bin", "LANG=en_US.UTF-8", "STEWARD_REPO=invalid/invalid",
			"sh", join(dir, "install.sh"), "--dry-run", ...args,
		], { cwd: root, encoding: "utf8", timeout: 10_000 });
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.ok(result.stdout.includes(`agent-steward ${version} installer`), result.stdout);
		assert.deepEqual(readdirSync(home), [], "dry run must not write anything to HOME");
	}
});

test("release mode rejects --check and missing required options without writing installers", (t) => {
	const before = snapshot();
	const dir = temporary(t);
	for (const args of [
		["--release", tag, "--dist", dir, "--check"],
		["--release", tag],
		["--release"],
		["--dist", dir],
		["--repo", "owner/repo"],
	]) {
		const result = generate(args);
		assert.notEqual(result.status, 0, args.join(" "));
		assert.deepEqual(readdirSync(dir), []);
	}
	const conflict = generate(["--release", tag, "--dist", dir, "--check"]);
	assert.match(conflict.stderr, /--release and --check cannot be combined/);
	unchanged(before);
});

test("release mode requires both archives before writing any installer", (t) => {
	const { dir } = fixture(t);
	const tar = join(dir, `agent-steward-${tag}.tar.gz`);
	const zip = join(dir, `agent-steward-${tag}.zip`);
	rmSync(zip);
	let result = generate(["--release", tag, "--dist", dir]);
	assert.notEqual(result.status, 0);
	assert.ok(result.stderr.includes(`agent-steward-${tag}.zip`), result.stderr);
	assert.deepEqual(readdirSync(dir), [`agent-steward-${tag}.tar.gz`]);
	rmSync(tar);
	result = generate(["--release", tag, "--dist", dir]);
	assert.notEqual(result.status, 0);
	assert.ok(result.stderr.includes(`agent-steward-${tag}.tar.gz`), result.stderr);
	assert.deepEqual(readdirSync(dir), []);
});

test("release mode refuses destinations that would overwrite repository installers", (t) => {
	const before = snapshot();
	const destinations = [root, join(root, "scripts")];
	if (process.platform !== "win32") {
		const dir = temporary(t);
		symlinkSync(join(root, "install.sh"), join(dir, "install.sh"));
		destinations.push(dir);
	}
	for (const dir of destinations) {
		const result = generate(["--release", tag, "--dist", dir]);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /--dist must not overwrite repository installers/);
		unchanged(before);
	}
});
