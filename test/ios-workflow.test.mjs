import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readText(file) {
	return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

const workflow = readText(new URL("../.github/workflows/ios.yml", import.meta.url));
const exportOptions = readText(new URL("../ios-native/ExportOptions.plist", import.meta.url));
const steps = [...workflow.matchAll(/^      - ([^\n]+)\n([\s\S]*?)(?=^      - |$(?![\s\S]))/gm)]
	.map((match) => ({ name: match[1].replace(/^name: /, ""), text: match[0] }));

function step(name) {
	const found = steps.find((entry) => entry.name === name);
	assert.ok(found, `找不到 workflow 步驟：${name}`);
	return found.text;
}

test("iOS workflow only accepts manual dispatch with ref and upload inputs", () => {
	const triggers = /^on:\n([\s\S]*?)(?=^\S)/m.exec(workflow)?.[1];
	assert.ok(triggers);
	assert.deepEqual([...triggers.matchAll(/^  ([\w-]+):/gm)].map((match) => match[1]), ["workflow_dispatch"]);
	assert.match(triggers, /^      ref:\n        description: [^\n]+\n        type: string\n        default: main$/m);
	assert.match(triggers, /^      upload:\n        description: [^\n]+\n        type: boolean\n        default: true$/m);
	assert.match(workflow, /^          ref: \$\{\{ inputs\.ref \}\}$/m);
});

test("iOS workflow limits permissions and serializes builds of the same ref", () => {
	assert.match(workflow, /^permissions:\n  contents: read\n\n/m);
	assert.match(workflow, /^concurrency:\n  group: ios-\$\{\{ inputs\.ref \}\}\n  cancel-in-progress: false$/m);
	const desktop = readText(new URL("../.github/workflows/desktop.yml", import.meta.url));
	const runner = /^  macos:\n[\s\S]*?^    runs-on: (\S+)$/m.exec(desktop)?.[1];
	assert.ok(runner);
	assert.match(workflow, new RegExp(`^    runs-on: ${runner}$`, "m"));
});

test("iOS workflow rejects missing signing secrets before checkout", () => {
	assert.equal(steps[0].name, "Check signing secrets");
	const check = step("Check signing secrets");
	const secrets = ["APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_P8"];
	const presence = [...check.matchAll(/HAS_\w+: \$\{\{ secrets\.([A-Z0-9_]+) != '' \}\}/g)].map((match) => match[1]);
	const missing = [...check.matchAll(/missing\+=\(([A-Z0-9_]+)\)/g)].map((match) => match[1]);
	assert.deepEqual(presence.sort(), [...secrets].sort());
	assert.deepEqual(missing.sort(), [...secrets].sort());
	assert.match(check, /if \[ "\$\{#missing\[@\]\}" -gt 0 \]; then/);
	assert.match(check, /printf '::error::Missing signing secrets: %s\\n' "\$\{missing\[\*\]\}"/);
	assert.match(check, /exit 1/);
	assert.doesNotMatch(workflow, /APPLE_CERTIFICATE|\bsecurity\s|\.p12\b/);
});

test("iOS workflow never prints secrets or the p8 contents", () => {
	assert.doesNotMatch(workflow, /set\s+-[a-zA-Z]*x|set\s+-o\s+xtrace/);
	const environment = /^\s+[A-Z0-9_]+: \$\{\{ secrets\.[A-Z0-9_]+(?: != '')? \}\}$/;
	const missingName = /^\s+\[ "\$HAS_API_KEY_P8" = true \] \|\| missing\+=\(APPLE_API_KEY_P8\)$/;
	const fileWrite = /^\s+fs\.writeFileSync\(file, process\.env\.APPLE_API_KEY_P8, \{mode:0o600\}\);$/;
	workflow.split("\n").forEach((line, index) => {
		const location = `.github/workflows/ios.yml:${index + 1}`;
		if (line.includes("secrets.")) assert.match(line, environment, location);
		if (line.includes("APPLE_API_KEY_P8")) {
			// 缺少金鑰時只記錄 secret 名稱；金鑰全文只能由環境變數直接寫入檔案。
			assert.ok(environment.test(line) || missingName.test(line) || fileWrite.test(line), location);
		}
		if (/\b(?:echo|cat|printf)\b/.test(line)) {
			assert.doesNotMatch(line, /secrets\.|\$(?:\{)?APPLE_API_|process\.env\.APPLE_API_|\.p8\b/, location);
		}
	});
});

test("iOS API keys are private files in runner temp and the altool search path and always removed", () => {
	const prepare = step("Prepare the App Store Connect API key");
	assert.match(prepare, /umask 077/);
	assert.match(prepare, /path\.join\(process\.env\.RUNNER_TEMP, "ios-private-keys", name\)/);
	assert.match(prepare, /path\.join\(process\.env\.HOME, "\.appstoreconnect", "private_keys", name\)/);
	assert.match(prepare, /AuthKey_\$\{process\.env\.APPLE_API_KEY\}\.p8/);
	assert.match(prepare, /fs\.writeFileSync\(file, process\.env\.APPLE_API_KEY_P8, \{mode:0o600\}\)/);
	assert.match(prepare, /fs\.chmodSync\(file, 0o600\)/);
	const cleanup = step("Remove the temporary API keys");
	assert.match(cleanup, /^        if: always\(\)$/m);
	assert.match(cleanup, /rm -rf "\$RUNNER_TEMP\/ios-private-keys"/);
	assert.match(cleanup, /rm -f "\$HOME\/\.appstoreconnect\/private_keys\/AuthKey_\$\{APPLE_API_KEY\}\.p8"/);
});

test("iOS tests use a dynamically selected iPhone simulator and only run unit tests", () => {
	const xcode = step("Select the latest Xcode");
	assert.match(xcode, /\/Applications\/Xcode_\*\.app/);
	assert.match(xcode, /max\(candidates/);
	assert.match(xcode, /sudo xcode-select -s "\$XCODE_APP\/Contents\/Developer"/);
	assert.match(xcode, /xcodebuild -version/);
	assert.match(step("Install XcodeGen"), /brew install xcodegen/);
	assert.match(step("Generate the Xcode project"), /working-directory: ios-native[\s\S]*xcodegen generate/);
	const simulator = step("Select the latest available iPhone simulator");
	assert.match(simulator, /xcrun simctl list devices available --json/);
	assert.match(simulator, /device\["name"\]\.startswith\("iPhone"\)/);
	assert.match(simulator, /max\(candidates\)/);
	const tests = step("Run iOS unit tests");
	assert.match(tests, /xcodebuild test [^\n]*-scheme Steward/);
	assert.match(tests, /-only-testing:StewardTests/);
	assert.match(tests, /-destination "\$SIMULATOR_DESTINATION"/);
});

test("iOS archive and export use automatic provisioning with all API authentication arguments", () => {
	const archive = step("Archive the iOS App");
	const exported = step("Export the App Store IPA");
	assert.match(archive, /xcodebuild archive [^\n]*-scheme Steward/);
	assert.match(archive, /-configuration Release -destination 'generic\/platform=iOS'/);
	assert.match(exported, /xcodebuild -exportArchive/);
	assert.match(exported, /-exportOptionsPlist ios-native\/ExportOptions\.plist/);
	assert.match(exported, /-exportPath "\$RUNNER_TEMP\/export"/);
	for (const command of [archive, exported]) {
		assert.match(command, /-archivePath "\$RUNNER_TEMP\/Steward\.xcarchive"/);
		assert.match(command, /-allowProvisioningUpdates\b/);
		assert.match(command, /-authenticationKeyPath "\$APPLE_API_KEY_PATH"/);
		assert.match(command, /-authenticationKeyID "\$APPLE_API_KEY"/);
		assert.match(command, /-authenticationKeyIssuerID "\$APPLE_API_ISSUER"/);
	}
	assert.match(step("Set the build number"), /\$\(\(GITHUB_RUN_NUMBER \+ 100\)\)/);
	assert.match(archive, /CURRENT_PROJECT_VERSION="\$BUILD_NUMBER"/);
	assert.doesNotMatch(workflow, /MARKETING_VERSION=/);
});

test("iOS upload is optional and IPA and dSYMs artifacts are retained for fourteen days", () => {
	const upload = step("Upload to TestFlight");
	assert.match(upload, /^        if: inputs\.upload$/m);
	assert.match(upload, /xcrun altool --upload-app -f "\$\{ipas\[0\]\}" -t ios/);
	assert.match(upload, /--apiKey "\$APPLE_API_KEY" --apiIssuer "\$APPLE_API_ISSUER"/);
	const artifact = step("Save the IPA and debug symbols");
	assert.match(artifact, /uses: actions\/upload-artifact@v4/);
	assert.match(artifact, /if: \$\{\{ !cancelled\(\) && steps\.export\.outcome == 'success' \}\}/);
	assert.match(artifact, /\$\{\{ runner\.temp \}\}\/export\/\*\.ipa/);
	assert.match(artifact, /\$\{\{ runner\.temp \}\}\/Steward\.xcarchive\/dSYMs/);
	assert.match(artifact, /retention-days: 14/);
});

test("iOS export options use App Store Connect and the expected automatic signing team", () => {
	assert.match(exportOptions, /<key>method<\/key>\s*<string>app-store-connect<\/string>/);
	assert.match(exportOptions, /<key>teamID<\/key>\s*<string>N8XLCRL5GL<\/string>/);
	assert.match(exportOptions, /<key>signingStyle<\/key>\s*<string>automatic<\/string>/);
	assert.match(exportOptions, /<key>uploadSymbols<\/key>\s*<true\/>/);
	assert.match(exportOptions, /<key>destination<\/key>\s*<string>export<\/string>/);
});
