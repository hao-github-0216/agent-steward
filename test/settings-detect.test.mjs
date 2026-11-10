import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = mkdtempSync(join(tmpdir(), "steward-settings-detect-"));
process.env.HOME = DATA;
process.env.USERPROFILE = DATA;
process.env.STEWARD_DATA_DIR = DATA;
after(() => rmSync(DATA, { recursive: true, force: true }));
writeFileSync(join(DATA, "settings.json"), JSON.stringify({ version: 1, access: { tailscale: { enabled: false } }, plugins: {}, setupDone: true }));
const { DEFAULTS, detect, settings, updateSettings } = await import("../src/settings.ts");

const status = {
	Self: { UserID: 1, TailscaleIPs: ["100.101.102.103", "fd7a:115c::1"], DNSName: "box.example.ts.net." },
	User: { "1": { LoginName: "Someone@Example.com" } },
};
const serve = { Web: { "box.example.ts.net:8793": { Handlers: { "/": { Proxy: "http://127.0.0.1:8791" } } } } };

test("偵測已有 Serve:只聽本機,沿用帳號與 https 網址", () => {
	const calls = [];
	const s = detect((args) => { calls.push(args); return args[0] === "status" ? status : serve; });
	assert.deepEqual(calls, [["status"], ["serve", "status"]]);
	assert.deepEqual(s.server.hosts, ["127.0.0.1"]);
	assert.deepEqual(s.access.tailscaleUsers, ["someone@example.com"]);
	assert.equal(s.access.tailscale.enabled, true);
	assert.equal(s.server.publicUrl, "https://box.example.ts.net:8793/");
});

test("只有 Tailscale 帳號、沒有 Serve:不開遠端存取", () => {
	const s = detect((args) => args[0] === "status" ? status : {});
	assert.deepEqual(s.server.hosts, ["127.0.0.1"]);
	assert.deepEqual(s.access.tailscaleUsers, ["someone@example.com"]);
	assert.equal(s.access.tailscale.enabled, false);
	assert.equal(s.server.publicUrl, "");
});

test("沒有 Tailscale:只聽本機,不開遠端存取", () => {
	const s = detect(() => undefined);
	assert.deepEqual(s.server.hosts, ["127.0.0.1"]);
	assert.equal(s.access.tailscale.enabled, false);
	assert.equal(s.server.publicUrl, "");
});

test("舊設定會補上尚未確認 tailnet 監聽的預設值", () => {
	assert.equal(DEFAULTS.server.tailnetBindReviewed, false);
	assert.equal(settings().server.tailnetBindReviewed, false);
});

test("desktop.autoUpdate defaults to true for new and legacy settings and rejects wrong types", () => {
	assert.equal(DEFAULTS.desktop.autoUpdate, true);
	assert.equal(detect(() => undefined).desktop.autoUpdate, true);
	assert.equal(settings().desktop.autoUpdate, true);
	assert.equal(updateSettings({ desktop: { autoUpdate: false } }).desktop.autoUpdate, false);
	for (const value of ["true", 0, null, [], {}]) {
		assert.throws(() => updateSettings({ desktop: { autoUpdate: value } }), /desktop.autoUpdate must be a boolean/);
		assert.equal(settings().desktop.autoUpdate, false);
	}
	assert.equal(updateSettings({ desktop: { autoUpdate: true } }).desktop.autoUpdate, true);
});
