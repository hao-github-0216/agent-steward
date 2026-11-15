import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const url = (name) => pathToFileURL(join(ROOT, "src", name)).href;

function isolated(t, source, { relay = true } = {}) {
	const home = mkdtempSync(join(tmpdir(), "steward-push-relay-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const env = {
		...process.env, HOME: home, USERPROFILE: home, APPDATA: home,
		XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, STEWARD_DATA_DIR: join(home, "data"),
		STEWARD_APP_DIR: ROOT, STEWARD_HOSTS: "127.0.0.1", STEWARD_PORT: "0", STEWARD_TERMINAL_PORT: "0",
		HERDR_SOCKET_PATH: join(home, "no-herdr.sock"),
	};
	for (const name of ["STEWARD_DESKTOP", "STEWARD_DESKTOP_TOKEN", "STEWARD_NOTIFY_URL", "STEWARD_TS_USERS"]) delete env[name];
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "--eval", `
		import assert from "node:assert/strict";
		import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
		import { homedir } from "node:os";
		import { join } from "node:path";
		import { createServer } from "node:http";
		const home = process.env.HOME;
		const dataDir = process.env.STEWARD_DATA_DIR;
		assert.equal(homedir(), home);
		mkdirSync(dataDir, { recursive: true });
		const requests = [];
		let replyStatus = 200;
		const relayServer = createServer(async (req, res) => {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const text = Buffer.concat(chunks).toString("utf8");
			requests.push({ method: req.method, path: req.url, headers: req.headers, text, body: JSON.parse(text) });
			res.writeHead(replyStatus, { "content-type": "application/json" });
			res.end(JSON.stringify(replyStatus === 200 ? { ok: true } : replyStatus === 410 ? { ok: false, gone: true } : { ok: false, error: "fixture_error" }));
		});
		await new Promise((done, fail) => { relayServer.once("error", fail); relayServer.listen(0, "127.0.0.1", done); });
		const port = relayServer.address().port;
		assert.ok(![8791, 8792, 8793, 8797, 8807].includes(port));
		const relayURL = "http://127.0.0.1:" + port;
		const initial = { version: 1, setupDone: true, aiDetected: true, ui: { lang: "zh-TW" }, access: { tailscale: { enabled: false } }, plugins: { notebook: { pythons: [] } } };
		// 隔離的測試設定指向本機假中繼；設定 API 仍只接受 HTTPS。
		if (${relay}) initial.push = { relay: relayURL + "/" };
		writeFileSync(join(dataDir, "settings.json"), JSON.stringify(initial));
		const apiProbe = createServer();
		await new Promise((done, fail) => { apiProbe.once("error", fail); apiProbe.listen(0, "127.0.0.1", done); });
		const apiPort = apiProbe.address().port;
		assert.ok(![8791, 8792, 8793, 8797, 8807].includes(apiPort));
		await new Promise((done) => apiProbe.close(done));
		process.env.STEWARD_PORT = String(apiPort);
		const { DEFAULTS, settings, updateSettings } = await import(${JSON.stringify(url("settings.ts"))});
		const { registerDevice, unregisterDevice, listDevices, pushAll, pushMode, messageFromText } = await import(${JSON.stringify(url("apns.ts"))});
		const { decryptPush, collapseFor } = await import(${JSON.stringify(url("push-crypto.ts"))});
		const iosToken = "ab".repeat(32);
		const androidToken = "Fcm_DEVICE-token:123";
		const iosKey = Buffer.alloc(32, 1).toString("base64");
		const androidKey = Buffer.alloc(32, 2).toString("base64");
		try {
			${source}
		} finally {
			relayServer.closeAllConnections();
			await new Promise((done) => relayServer.close(done));
		}
		process.exit(0);
	`], { cwd: ROOT, env, encoding: "utf8", timeout: 35_000, maxBuffer: 4 * 1024 * 1024 });
	if (result.error || result.status !== 0) throw new Error(`Push relay child failed: ${result.error?.message || result.signal || result.status}\n${result.stderr}${result.stdout}`);
}

test("notify 與 pushAll 逐台加密，iOS/Android 送出符合協定的 JSON", (t) => {
	isolated(t, `
		registerDevice(iosToken.toUpperCase(), "production", "iPhone", "ios", iosKey);
		registerDevice(androidToken, "sandbox", "Android", "android", androidKey);
		assert.equal(pushMode(), "relay");
		const text = "加密標題 🔔\\n只有手機能讀到的內容\\nhttps://board.example/";
		const projectId = "private-project-id";
		const expected = messageFromText(text, projectId);
		const { notify } = await import(${JSON.stringify(url("notify.ts"))});
		assert.equal(await notify(text, { projectId, iphoneOnly: true }), true);
		assert.equal(requests.length, 2);
		for (const { token, platform, env, key } of listDevices()) {
			const request = requests.find((r) => r.body.token === token);
			assert.equal(request.method, "POST");
			assert.equal(request.path, "/v1/push");
			assert.equal(request.headers["content-type"], "application/json");
			assert.ok(Buffer.byteLength(request.text) <= 4096);
			const body = request.body;
			assert.deepEqual(Object.keys(body).sort(), (platform === "ios" ? ["v", "platform", "token", "env", "payload", "collapse"] : ["v", "platform", "token", "payload", "collapse"]).sort());
			assert.equal(body.v, 1);
			assert.equal(body.platform, platform);
			if (platform === "ios") assert.equal(body.env, env);
			assert.match(body.payload, /^[A-Za-z0-9+/]+=*$/);
			assert.ok(body.payload.length <= 3000);
			assert.equal(body.collapse, collapseFor(key, projectId));
			assert.match(body.collapse, /^[a-f0-9]{16}$/);
			assert.deepEqual(decryptPush(key, body.payload), expected);
			assert.throws(() => decryptPush(key === iosKey ? androidKey : iosKey, body.payload));
			for (const plain of [expected.title, expected.body, projectId, key]) assert.ok(!request.text.includes(plain));
		}
		requests.length = 0;
		const plain = { title: "無專案", body: "不應帶 collapse" };
		assert.equal(await pushAll(plain), true);
		assert.equal(requests.length, 2);
		for (const { body } of requests) {
			assert.equal(Object.hasOwn(body, "collapse"), false);
			assert.deepEqual(decryptPush(body.platform === "ios" ? iosKey : androidKey, body.payload), plain);
		}
	`);
});

test("410 刪除失效裝置，非 200 只記錄平台與狀態碼", (t) => {
	isolated(t, `
		registerDevice(iosToken, "sandbox", "iPhone", "ios", iosKey);
		registerDevice(androidToken, "production", "Android", "android", androidKey);
		const legacyToken = "cc".repeat(32);
		registerDevice(legacyToken, "sandbox", "old app");
		replyStatus = 503;
		const logs = [];
		const previous = console.error;
		console.error = (...args) => logs.push(args.join(" "));
		try {
			assert.equal(await pushAll({ title: "機密標題", body: "機密內文" }), false);
			assert.equal(listDevices().length, 3);
			assert.equal(requests.length, 2);
			assert.equal(logs.length, 2);
			assert.ok(logs.every((line) => /^\\[push-relay\\] (ios|android) 503$/.test(line)));
			for (const value of [iosToken, androidToken, legacyToken, "機密", "iPhone", "old app"]) assert.ok(!logs.join("\\n").includes(value));
			logs.length = 0;
			requests.length = 0;
			replyStatus = 410;
			assert.equal(await pushAll({ title: "失效", body: "刪除" }), false);
			assert.equal(requests.length, 2);
			assert.deepEqual(listDevices().map((d) => d.token), [legacyToken]);
		} finally { console.error = previous; }
	`);
});

test("無金鑰的舊裝置不送中繼；空網址 mode none 且不送出", (t) => {
	isolated(t, `
		registerDevice(iosToken, "sandbox", "old iPhone");
		registerDevice(androidToken, "production", "old Android", "android");
		assert.equal(pushMode(), "relay");
		assert.equal(await pushAll({ title: "略過", body: "沒有裝置能解密" }), false);
		assert.equal(requests.length, 0);
		registerDevice(iosToken, "production", "new iPhone", "ios", iosKey);
		updateSettings({ push: { relay: "" } });
		assert.equal(pushMode(), "none");
		assert.equal(await pushAll({ title: "沒有中繼", body: "不送" }), false);
		assert.equal(requests.length, 0);
	`);
});

test("register 驗證金鑰與 Android token，同 token 覆蓋，Android 大小寫不混用", (t) => {
	isolated(t, `
		for (const key of ["", null, 123, {}, Buffer.alloc(31).toString("base64"), iosKey.slice(0, -1), iosKey + "\\n"]) assert.throws(() => registerDevice(iosToken, "sandbox", "bad", "ios", key));
		for (const token of ["", "has space", "has/slash", "has+plus", "has.dot", "a".repeat(4097)]) assert.throws(() => registerDevice(token, "production", "bad", "android", androidKey));
		assert.throws(() => registerDevice(iosToken, "sandbox", "bad", "windows", iosKey));
		assert.equal(listDevices().length, 0);
		registerDevice("z", "production", "minimum", "android", androidKey);
		registerDevice("a".repeat(4096), "production", "maximum", "android", androidKey);
		assert.equal(listDevices().length, 2);
		unregisterDevice("z");
		unregisterDevice("a".repeat(4096));
		registerDevice(iosToken.toUpperCase(), "sandbox", "old", "ios", iosKey);
		registerDevice(iosToken, "production", "updated", "ios", androidKey);
		assert.equal(listDevices().length, 1);
		assert.equal(listDevices()[0].name, "updated");
		const [{ key: saved }] = listDevices();
		assert.equal(saved, androidKey);
		unregisterDevice(iosToken.toUpperCase());
		registerDevice(androidToken, "production", "Android", "android", androidKey);
		assert.equal(await pushAll({ title: "case", body: "exact" }, androidToken.toLowerCase()), false);
		assert.equal(requests.length, 0);
		assert.equal(await pushAll({ title: "case", body: "exact" }, androidToken), true);
		unregisterDevice(androidToken.toLowerCase());
		assert.equal(listDevices().length, 1);
		unregisterDevice(androidToken);
		assert.equal(listDevices().length, 0);
	`);
});

test("status/register/test 路由使用新格式，保留舊 configured 並隱藏金鑰與完整 token", (t) => {
	isolated(t, `
		const legacy = { token: "cc".repeat(32), env: "sandbox", name: "legacy", addedAt: "2025-01-01T00:00:00.000Z" };
		writeFileSync(join(dataDir, "push-devices.json"), JSON.stringify([legacy]));
		assert.equal(listDevices()[0].platform, "ios");
		const { Store } = await import(${JSON.stringify(url("store.ts"))});
		const { startServer } = await import(${JSON.stringify(url("server.ts"))});
		const stop = startServer(new Store(join(home, "state.json")), {}, {});
		await new Promise((done) => setImmediate(done));
		const request = async (path, body) => {
			const response = await fetch("http://127.0.0.1:" + apiPort + "/api/push/" + path, {
				method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", connection: "close" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
			});
			return { status: response.status, body: await response.json() };
		};
		try {
			assert.equal((await request("register", { token: iosToken, env: "production", name: "iPhone", platform: "ios", key: iosKey })).status, 200);
			assert.equal((await request("register", { token: androidToken, name: "Android", platform: "android", key: androidKey })).status, 200);
			for (const body of [{ token: iosToken, key: "bad" }, { token: "bad/token", platform: "android", key: androidKey }, { token: iosToken, platform: "other" }]) assert.equal((await request("register", body)).status, 400);
			const status = await request("status");
			assert.equal(status.status, 200);
			assert.deepEqual(Object.keys(status.body).sort(), ["configured", "devices", "mode"]);
			assert.equal(status.body.mode, "relay");
			assert.equal(status.body.configured, true);
			assert.equal(status.body.devices.length, 3);
			for (const device of status.body.devices) {
				assert.deepEqual(Object.keys(device).sort(), ["addedAt", "encrypted", "env", "name", "platform", "token"]);
				assert.equal(device.token.length, 9);
				assert.ok(device.token.endsWith("…"));
				assert.ok(Number.isFinite(Date.parse(device.addedAt)));
				assert.equal(device.encrypted, device.name !== "legacy");
				assert.equal(device.platform, device.name === "Android" ? "android" : "ios");
			}
			const serialized = JSON.stringify(status.body);
			for (const secret of [iosKey, androidKey, iosToken, androidToken]) assert.ok(!serialized.includes(secret));
			assert.equal((await request("test", {})).status, 200);
			assert.equal(requests.length, 2);
			updateSettings({ push: { relay: "" } });
			const none = await request("status");
			assert.equal(none.body.mode, "none");
			assert.equal(none.body.configured, false);
			const result = await request("test", {});
			assert.equal(result.status, 400);
			assert.equal(result.body.error, "還沒設定推播:沒有推播中繼也沒有 APNs 金鑰");
			assert.equal(requests.length, 2);
		} finally { await stop(); }
	`);
});

test("push.relay 預設空字串，只接受無帳密、query、fragment 的 HTTPS 網址", (t) => {
	isolated(t, `
		assert.equal(DEFAULTS.push.relay, "");
		assert.equal(settings().push.relay, "");
		assert.equal(pushMode(), "none");
		for (const relay of ["https://relay.example", "https://relay.example/v1-root/", ""]) {
			assert.equal(updateSettings({ push: { relay } }).push.relay, relay);
			for (const invalid of [undefined, null, 5, {}, [], "http://relay.example", "file:///tmp/relay", "relay.example", "https://", "https://user:pass@relay.example", "https://user@relay.example", "https://relay.example?x=1", "https://relay.example#fragment", "https://relay.example?", "https://relay.example#"]) {
				assert.throws(() => updateSettings({ push: { relay: invalid } }), TypeError);
				assert.equal(settings().push.relay, relay);
			}
		}
	`, { relay: false });
});

test("直接 APNs 優先且使用相同加密格式，舊 iOS 仍送明文，Android 仍走中繼", (t) => {
	isolated(t, `
		const { generateKeyPairSync } = await import("node:crypto");
		const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
		mkdirSync(join(dataDir, "apns"));
		writeFileSync(join(dataDir, "apns", "AuthKey_TEST123.p8"), privateKey.export({ type: "pkcs8", format: "pem" }));
		writeFileSync(join(dataDir, "apns", "config.json"), JSON.stringify({ teamId: "TESTTEAM", bundleId: "io.github.test.steward" }));
		assert.equal(pushMode(), "direct");
		registerDevice(iosToken, "production", "iPhone", "ios", iosKey);
		const legacyToken = "cc".repeat(32);
		registerDevice(legacyToken, "sandbox", "legacy");
		registerDevice(androidToken, "production", "Android", "android", androidKey);
		const { default: http2 } = await import("node:http2");
		const { syncBuiltinESMExports } = await import("node:module");
		const { EventEmitter } = await import("node:events");
		const directRequests = [];
		const connect = http2.connect;
		http2.connect = (host) => {
			const client = new EventEmitter();
			client.close = () => {};
			client.setTimeout = () => client;
			client.request = (headers) => {
				const req = new EventEmitter();
				req.end = (payload) => {
					directRequests.push({ host, headers, body: JSON.parse(payload) });
					queueMicrotask(() => { req.emit("response", { ":status": 200 }); req.emit("end"); });
				};
				return req;
			};
			return client;
		};
		syncBuiltinESMExports();
		const msg = { title: "direct encrypted", body: "only this device", link: "agentsteward://project/private-project", thread: "private-project" };
		try {
			assert.equal(await pushAll(msg), true);
			assert.equal(directRequests.length, 2);
			const encrypted = directRequests.find((r) => r.headers[":path"].endsWith(iosToken));
			assert.equal(encrypted.host, "https://api.push.apple.com");
			assert.equal(encrypted.headers["apns-push-type"], "alert");
			assert.equal(encrypted.headers["apns-priority"], "10");
			assert.deepEqual(Object.keys(encrypted.body).sort(), ["aps", "e"]);
			assert.deepEqual(encrypted.body.aps, { alert: { "title-loc-key": "PUSH_FALLBACK_TITLE", "loc-key": "PUSH_FALLBACK_BODY" }, "mutable-content": 1, sound: "default", "thread-id": collapseFor(iosKey, msg.thread) });
			assert.deepEqual(decryptPush(iosKey, encrypted.body.e), msg);
			const legacy = directRequests.find((r) => r.headers[":path"].endsWith(legacyToken));
			assert.equal(legacy.host, "https://api.sandbox.push.apple.com");
			assert.deepEqual(legacy.body, { aps: { alert: { title: msg.title, body: msg.body }, sound: "default", "thread-id": msg.thread }, link: msg.link });
			assert.equal(requests.length, 1);
			assert.equal(requests[0].body.platform, "android");
			assert.deepEqual(decryptPush(androidKey, requests[0].body.payload), msg);
		} finally { http2.connect = connect; syncBuiltinESMExports(); }
	`);
});
