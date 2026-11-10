// GitHub Actions 把 `shell: powershell` 的步驟寫成沒有 BOM 的 .ps1,Windows PowerShell 5.1 不會用 UTF-8 讀它:
// 中文會變成亂碼,有些亂碼位元組還會被當成換行或引號,整段腳本就解析失敗。這些步驟只能有 ASCII。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

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

function workflowJob(file, name) {
	const job = workflowJobs(readFileSync(file, "utf8")).find((job) => job.name === name);
	assert.ok(job, `${file}: ${name}`);
	return job;
}

function workflowSteps(job) {
	return [...job.text.matchAll(/^      - ([^\n]+)\n([\s\S]*?)(?=^      - |$(?![\s\S]))/gm)].map((match) => ({ name: match[1].replace(/^name: /, ""), text: match[0] }));
}

function workflowStep(job, name) {
	const step = workflowSteps(job).find((step) => step.name === name);
	assert.ok(step, `${job.name}: ${name}`);
	return step.text;
}

function inlineNode(step) {
	const source = /node <<'NODE'\n([\s\S]*?)^          NODE$/m.exec(step)?.[1]
		?? /node -e '\n([\s\S]*?)^          '$/m.exec(step)?.[1];
	assert.ok(source, "Expected an inline Node script");
	return source;
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

test("desktop and release workflows never enable shell tracing", () => {
	for (const file of [".github/workflows/desktop.yml", ".github/workflows/release.yml"]) {
		assert.doesNotMatch(readFileSync(file, "utf8"), /set\s+-[a-zA-Z]*x/, file);
	}
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
	const builds = workflowJobs(text).flatMap(workflowSteps).filter((step) => /npx tauri build/.test(step.text));
	assert.equal(builds.length, 5);
	for (const build of builds) {
		assert.match(build.text, /^        working-directory: desktop$/m);
		assert.match(build.text, /--config "[^"\n]*tauri-(?:version|e2e)\.json"/);
	}
	const macos = workflowJob(".github/workflows/desktop.yml", "macos");
	for (const name of ["Build the ad-hoc App bundle", "Create and verify the ad-hoc DMG"]) {
		const step = workflowStep(macos, name);
		assert.match(step, /^        if: needs\.version\.outputs\.mode != 'signed'$/m);
		assert.doesNotMatch(step, /APPLE_/);
	}
});

const signingSecrets = [
	"APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_P8",
	"TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
];

test("both workflows check all seven signing secrets and releases cannot omit the App", () => {
	const version = workflowJob(".github/workflows/desktop.yml", "version");
	const signing = workflowJob(".github/workflows/release.yml", "signing");
	for (const job of [version, signing]) {
		const presence = [...job.text.matchAll(/HAS_\w+: \$\{\{ secrets\.([A-Z0-9_]+) != '' \}\}/g)].map((match) => match[1]);
		const missing = [...job.text.matchAll(/missing\+=\(([A-Z0-9_]+)\)/g)].map((match) => match[1]);
		assert.deepEqual(presence.sort(), [...signingSecrets].sort(), job.name);
		assert.deepEqual(missing.sort(), [...signingSecrets].sort(), job.name);
		assert.match(job.text, /Missing signing secrets:/);
		assert.match(job.text, /exit 1/);
	}
	assert.match(version.text, /^      mode: \$\{\{ steps\.mode\.outputs\.mode \}\}$/m);
	assert.match(version.text, /\[ "\$\{#missing\[@\]\}" -lt 7 \] \|\| \[ -n "\$CALL_TAG" \]/);
	assert.match(version.text, /GITHUB_EVENT_NAME.*workflow_dispatch.*REQUEST_SIGN.*true.*missing.*-eq 0/);
	assert.match(signing.text, /if \[ "\$\{#missing\[@\]\}" -gt 0 \]; then/);
	assert.match(signing.text, /Every future release needs App updater artifacts or installed Apps cannot find updates/);
	assert.doesNotMatch(signing.text, /::warning::|ready=false/);
	for (const file of [".github/workflows/desktop.yml", ".github/workflows/release.yml"]) {
		assert.doesNotMatch(readFileSync(file, "utf8"), /^\s+if:.*secrets\./m);
	}
});

test("production updater endpoints are written only into tag-build configs", () => {
	const file = ".github/workflows/desktop.yml";
	const endpoint = "https://github.com/hao-github-0216/agent-steward/releases/latest/download/latest.json";
	const base = JSON.parse(readFileSync("desktop/src-tauri/tauri.conf.json", "utf8"));
	assert.equal(base.plugins.updater.endpoints, undefined);
	const endpointSteps = workflowJobs(readFileSync(file, "utf8")).flatMap((job) => workflowSteps(job).filter((step) => step.text.includes(endpoint)).map((step) => `${job.name}:${step.name}`));
	assert.deepEqual(endpointSteps, [
		"macos:Build, sign, and notarize the App bundle", "macos:Check the embedded production updater endpoint",
		"windows:Build the unsigned NSIS installer", "windows:Check the embedded production updater endpoint",
	]);
	for (const [jobName, stepName] of [["macos", "Build, sign, and notarize the App bundle"], ["windows", "Build the unsigned NSIS installer"]]) {
		const step = workflowStep(workflowJob(file, jobName), stepName);
		assert.match(step, /CALL_TAG: \$\{\{ inputs\.tag \}\}/);
		for (const tag of ["", "v0.4.0"]) {
			let config;
			runInNewContext(inlineNode(step), {
				process: { env: { CALL_TAG: tag, VERSION: "0.4.0", SIGNING_IDENTITY: "Developer ID test", RUNNER_TEMP: "/runner-temp" } },
				require(name) {
					if (name === "path") return { join: (...parts) => parts.join("/") };
					assert.equal(name, "fs");
					return {
						readFileSync(file) { assert.equal(file, "src-tauri/tauri.conf.json"); return JSON.stringify(base); },
						writeFileSync(file, contents) { assert.equal(file, "/runner-temp/tauri-version.json"); config = JSON.parse(contents); },
					};
				},
			});
			assert.equal(config.version, "0.4.0");
			assert.deepEqual(config.plugins?.updater?.endpoints, tag ? [endpoint] : undefined);
			if (tag) assert.equal(config.plugins.updater.pubkey, base.plugins.updater.pubkey);
		}
	}
});

test("both main executables must contain the production endpoint exactly for tag builds", () => {
	for (const [jobName, binary] of [
		["macos", "desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/Agent Steward.app/Contents/MacOS/agent-steward-desktop"],
		["windows", "desktop/src-tauri/target/x86_64-pc-windows-msvc/release/agent-steward-desktop.exe"],
	]) {
		const job = workflowJob(".github/workflows/desktop.yml", jobName);
		const step = workflowStep(job, "Check the embedded production updater endpoint");
		assert.match(step, /CALL_TAG: \$\{\{ inputs\.tag \}\}/);
		assert.ok(job.text.indexOf(step) < job.text.indexOf(jobName === "macos" ? "Install the DMG" : "Install, smoke-test"));
		for (const tag of ["", "v0.4.0"]) for (const hasEndpoint of [false, true]) {
			const check = () => runInNewContext(inlineNode(step), {
				process: { env: { CALL_TAG: tag } }, Buffer,
				require(name) {
					assert.equal(name, "fs");
					return { readFileSync(file) { assert.equal(file, binary); return Buffer.from(hasEndpoint ? "https://github.com/hao-github-0216/agent-steward/releases/latest/download/latest.json" : "development build"); } };
				},
			});
			if (Boolean(tag) === hasEndpoint) assert.doesNotThrow(check);
			else assert.throws(check, /Unexpected production updater endpoint presence/);
		}
	}
});

test("only dedicated signed updater steps receive the private signing secrets", () => {
	for (const file of [".github/workflows/desktop.yml", ".github/workflows/release.yml"]) {
		const text = readFileSync(file, "utf8");
		const signing = workflowJobs(text).flatMap((job) => workflowSteps(job).filter((step) => /updater-artifacts\.mjs sign --file/.test(step.text)).map((step) => ({ job: job.name, ...step })));
		assert.deepEqual(signing.map((step) => step.job), file.endsWith("desktop.yml") ? ["macos", "windows"] : []);
		const declarations = [...text.matchAll(/^\s+TAURI_SIGNING_PRIVATE_KEY(?:_PASSWORD)?:/gm)];
		assert.equal(declarations.length, signing.length * 2);
		for (const step of signing) {
			assert.match(step.text, /^        if: needs\.version\.outputs\.mode == 'signed'$/m);
			assert.match(step.text, /^        env:\n          TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}\n          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}$/m);
		}
		for (const line of text.split("\n").filter((line) => /secrets\.TAURI_SIGNING_/.test(line))) {
			assert.match(line, /^\s+(?:HAS_\w+: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY(?:_PASSWORD)? != '' \}\}|TAURI_SIGNING_PRIVATE_KEY(?:_PASSWORD)?: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY(?:_PASSWORD)? \}\})$/);
		}
	}
});

test("updater archives and signatures are verified and uploaded only after signed builds", () => {
	const file = ".github/workflows/desktop.yml";
	assert.match(workflowJob(file, "version").text, /macos-update-file=agent-steward-desktop-\$LABEL-macos-universal\.app\.tar\.gz/);
	for (const [platform, artifact] of [["macos", "desktop-macos"], ["windows", "desktop-windows"]]) {
		const job = workflowJob(file, platform);
		const steps = workflowSteps(job);
		const signed = steps.filter((step) => /updater-artifacts\.mjs (?:mac-archive|sign|verify) /.test(step.text));
		assert.equal(signed.length, platform === "macos" ? 3 : 2);
		for (const step of signed) assert.match(step.text, /^        if: needs\.version\.outputs\.mode == 'signed'$/m);
		const verify = signed.at(-1).text;
		assert.match(verify, /tauri\.conf\.json/);
		assert.match(verify, /plugins\.updater\.pubkey/);
		assert.match(verify, /updater-artifacts\.mjs verify --pubkey/);
		const upload = steps.find((step) => /uses: actions\/upload-artifact@/.test(step.text)).text;
		assert.ok(upload.includes(`name: ${artifact}`));
		assert.match(upload, /needs\.version\.outputs\.(?:macos-update-file|windows-file) \}\}\.sig/);
		if (platform === "macos") {
			assert.match(signed[0].text, /xcrun stapler validate[\s\S]*updater-artifacts\.mjs mac-archive/);
			assert.match(upload, /needs\.version\.outputs\.macos-update-file \}\}$/m);
		} else {
			assert.ok(job.text.indexOf("Name the installer") < job.text.indexOf(signed[0].text));
		}
	}
});

test("native update E2E jobs depend on signed artifacts and use disposable test keys", () => {
	for (const [platform, target, runner, bundle] of [
		["macos", "aarch64-apple-darwin", "macos-latest", "app"],
		["windows", "x86_64-pc-windows-msvc", "windows-latest", "nsis"],
	]) {
		const job = workflowJob(".github/workflows/desktop.yml", `update-e2e-${platform}`);
		assert.ok(job.text.includes(`needs: [version, ${platform}]`));
		assert.match(job.text, /^    if: needs\.version\.outputs\.mode == 'signed'$/m);
		assert.ok(job.text.includes(`runs-on: ${runner}`));
		assert.doesNotMatch(job.text, /secrets\.|TAURI_SIGNING_PRIVATE_KEY|continue-on-error/);
		assert.match(job.text, /ref: \$\{\{ inputs\.tag \|\| inputs\.ref \|\| github\.sha \}\}/);
		assert.match(job.text, /node-version: 22\.x/);
		assert.match(job.text, /npm ci --prefix desktop/);
		assert.ok(job.text.includes(`stage.mjs --target ${target}`));
		assert.ok(job.text.includes(`tauri build --target ${target} --bundles ${bundle}`));
		assert.match(job.text, /version: "0\.0\.1"/);
		assert.match(job.text, /updater-test-signing\.pub.*"utf8"\)\.trim\(\)/);
		assert.match(job.text, /endpoints: \["http:\/\/127\.0\.0\.1:19341\/latest\.json"\], dangerousInsecureTransportProtocol: true/);
		assert.match(job.text, /update-e2e\.mjs --old-app .+ --new .+ --new-version .+ --key-file .+updater-test-signing" --port 19341/);
		assert.match(job.text, new RegExp(`name: desktop-${platform}`));
		const generate = workflowStep(job, "Generate an ephemeral updater test key");
		if (platform === "macos") {
			assert.match(generate, /tauri signer generate --ci -p "" -w "\$RUNNER_TEMP\/updater-test-signing" >\/dev\/null 2>&1/);
			assert.match(job.text, /signingIdentity: "-"/);
		} else {
			assert.match(generate, /"tauri", "signer", "generate", "--ci", "-p", "", "-w"/);
			assert.match(generate, /stdio: "ignore"/);
		}
		const cleanup = workflowStep(job, "Remove the ephemeral updater test key");
		assert.match(cleanup, /^        if: always\(\)$/m);
		assert.match(cleanup, /updater-test-signing"/);
		assert.match(cleanup, /updater-test-signing\.pub"/);
		assert.equal(workflowSteps(job).at(-1).text, cleanup);
	}
});

test("publishing requires desktop E2E success and includes a pinned manifest in checksums and provenance", () => {
	const file = ".github/workflows/release.yml";
	const publish = workflowJob(file, "publish");
	assert.match(publish.text, /^    needs: \[build, signing, desktop\]$/m);
	assert.match(publish.text, /needs\.desktop\.result == 'success'/);
	assert.match(publish.text, /github\.event_name != 'workflow_dispatch' \|\| !inputs\.dry_run/);
	assert.doesNotMatch(publish.text, /HAS_DESKTOP|skipped/);
	const steps = workflowSteps(publish);
	assert.match(steps[0].text, /uses: actions\/checkout@/);
	assert.match(steps[0].text, /ref: \$\{\{ needs\.build\.outputs\.tag \}\}/);
	for (const step of steps.filter((step) => /uses: actions\/download-artifact@/.test(step.text))) assert.doesNotMatch(step.text, /if:/);
	const manifest = workflowStep(publish, "Verify updater signatures and generate the update manifest");
	assert.equal((manifest.match(/updater-artifacts\.mjs verify --pubkey/g) || []).length, 2);
	assert.match(manifest, /tauri\.conf\.json/);
	assert.match(manifest, /manifest --version "\$\{TAG#v\}" --notes-file/);
	assert.match(manifest, /See https:\/\/github\.com\/%s\/releases\/tag\/%s/);
	assert.match(manifest, /--base-url "https:\/\/github\.com\/\$GITHUB_REPOSITORY\/releases\/download\/\$TAG"/);
	assert.match(manifest, /--mac "dist\/\$MAC" --win "dist\/\$WIN" --out dist\/latest\.json/);
	for (const platform of ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"]) assert.ok(manifest.includes(platform));
	assert.match(manifest, /assert\.equal\(manifest\.version, tag\.replace/);
	assert.match(manifest, /assert\.equal\(manifest\.platforms\[platform\]\.url, base \+ asset\)/);
	assert.match(manifest, /assert\.equal\(manifest\.platforms\[platform\]\.signature, readFileSync/);
	const assets = workflowStep(publish, "Check the exact release asset list");
	for (const suffix of ["macos-universal.dmg", "macos-universal.app.tar.gz", "macos-universal.app.tar.gz.sig", "windows-x64-setup.exe", "windows-x64-setup.exe.sig", "latest.json"]) assert.ok(assets.includes(suffix), suffix);
	assert.match(publish.text, /sha256sum[^\n]*latest\.json > SHA256SUMS/);
	assert.match(publish.text, /subject-path: dist\/\*/);
	assert.doesNotMatch(workflowJob(file, "desktop").text, /continue-on-error/);
});

test("published updater assets are mandatory and checked against the tag public key and manifest", () => {
	const file = ".github/workflows/release.yml";
	for (const name of ["verify", "verify-windows"]) {
		const job = workflowJob(file, name);
		assert.doesNotMatch(job.text, /when present|skipping\.|No desktop/);
		assert.match(job.text, /uses: actions\/checkout@[\s\S]*ref: \$\{\{ needs\.build\.outputs\.tag \}\}/);
		assert.match(job.text, /updater-artifacts\.mjs verify --pubkey/);
		assert.match(job.text, /tauri\.conf\.json/);
		assert.match(job.text, /-p "\$(?:UPDATE|asset)\.sig" -p latest\.json -p SHA256SUMS/);
	}
	const macos = workflowJob(file, "verify").text;
	assert.match(macos, /for FILE in "\$ASSET" "\$UPDATE" "\$UPDATE\.sig" latest\.json/);
	assert.match(macos, /gh attestation verify "\$T\/\$UPDATE"/);
	assert.match(macos, /gh attestation verify "\$T\/latest\.json"/);
	assert.match(macos, /manifest\.platforms\[platform\]\.signature, signature/);
	assert.match(macos, /tar -xzf "\$T\/\$UPDATE"/);
	for (const command of ["codesign --verify --deep --strict", "spctl -a -vv -t exec", "xcrun stapler validate"]) assert.ok(macos.includes(`${command} "$T/updater/Agent Steward.app"`));
	const windows = workflowJob(file, "verify-windows").text;
	assert.match(windows, /foreach \(\$name in @\(\$asset, "\$asset\.sig", 'latest\.json'\)\)/);
	assert.match(windows, /Get-FileHash \(Join-Path \$temp \$name\) -Algorithm SHA256/);
	assert.match(windows, /manifest\.platforms\.'windows-x86_64'\.signature -cne \$signature/);
});
