// iPhone app(ios-native)的推播:管家直接送 Apple Push Notification service(APNs)。
//
// 設定:~/.agent-steward/apns/ 放 Apple 開發者網站下載的 AuthKey_<KEY ID>.p8,
// 再加 config.json {"teamId": "...", "bundleId": "..."}(keyId 沒寫就從檔名取)。
// 裝置:iPhone app 登入後把 device token 送到 /api/push/register,記在 ~/.agent-steward/push-devices.json。
// Xcode 直接裝的開發版走 sandbox,TestFlight / App Store 版走 production,由 app 自己回報。
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { connect } from "node:http2";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

const DIR = join(DATA_DIR, "apns");
const DEVICES = join(DATA_DIR, "push-devices.json");

export interface PushDevice {
	token: string;
	env: "sandbox" | "production";
	name?: string;
	addedAt: string;
}

interface ApnsConfig {
	teamId: string;
	keyId: string;
	bundleId: string;
	key: KeyObject;
}

function loadConfig(): ApnsConfig | undefined {
	try {
		const p8 = readdirSync(DIR).find((f) => /^AuthKey_[A-Z0-9]+\.p8$/.test(f));
		if (!p8) return undefined;
		const cfg = JSON.parse(readFileSync(join(DIR, "config.json"), "utf8")) as Partial<ApnsConfig>;
		const keyId = cfg.keyId || p8.slice("AuthKey_".length, -".p8".length);
		if (!cfg.teamId || !cfg.bundleId) return undefined;
		return { teamId: cfg.teamId, keyId, bundleId: cfg.bundleId, key: createPrivateKey(readFileSync(join(DIR, p8))) };
	} catch {
		return undefined;
	}
}

export function pushConfigured(): boolean {
	return !!loadConfig();
}

export function listDevices(): PushDevice[] {
	try {
		const v = JSON.parse(readFileSync(DEVICES, "utf8"));
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}

function saveDevices(list: PushDevice[]): void {
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(DEVICES, JSON.stringify(list, null, 2));
	try { chmodSync(DEVICES, 0o600); } catch { /* Windows */ }
}

export function registerDevice(token: string, env: string, name?: string): PushDevice {
	if (!/^[0-9a-f]{32,200}$/i.test(token)) throw new Error("device token 格式不對");
	const d: PushDevice = { token: token.toLowerCase(), env: env === "production" ? "production" : "sandbox", name: name?.slice(0, 80), addedAt: new Date().toISOString() };
	saveDevices([...listDevices().filter((x) => x.token !== d.token), d]);
	return d;
}

export function unregisterDevice(token: string): void {
	saveDevices(listDevices().filter((x) => x.token !== token.toLowerCase()));
}

// APNs 的 JWT:ES256,一小時內要換新(太常換也會被擋),這裡 50 分鐘換一次
let jwtCache: { token: string; at: number; keyId: string } | undefined;
export function jwt(cfg: { teamId: string; keyId: string; key: KeyObject }): string {
	const now = Date.now();
	if (jwtCache && jwtCache.keyId === cfg.keyId && now - jwtCache.at < 50 * 60_000) return jwtCache.token;
	const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
	const unsigned = `${b64({ alg: "ES256", kid: cfg.keyId })}.${b64({ iss: cfg.teamId, iat: Math.floor(now / 1000) })}`;
	const sig = sign("sha256", Buffer.from(unsigned), { key: cfg.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
	jwtCache = { token: `${unsigned}.${sig}`, at: now, keyId: cfg.keyId };
	return jwtCache.token;
}

export interface PushMessage {
	title: string;
	body: string;
	/** 點通知要打開的畫面,例如 agentsteward://project/<id> */
	link?: string;
	/** 同一個專案的通知收在一起 */
	thread?: string;
}

/** 送給一台裝置;回傳 APNs 的結果(gone = 這個 token 已經失效,該刪掉) */
export function sendOne(cfg: ApnsConfig, d: PushDevice, msg: PushMessage): Promise<{ ok: boolean; status: number; reason?: string; gone: boolean }> {
	const host = d.env === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
	const payload = JSON.stringify({
		aps: { alert: { title: msg.title, body: msg.body }, sound: "default", ...(msg.thread ? { "thread-id": msg.thread } : {}) },
		...(msg.link ? { link: msg.link } : {}),
	});
	return new Promise((resolve) => {
		const client = connect(host);
		const done = (r: { ok: boolean; status: number; reason?: string; gone: boolean }) => { client.close(); resolve(r); };
		client.on("error", (e) => done({ ok: false, status: 0, reason: String(e.message ?? e), gone: false }));
		client.setTimeout(10_000, () => done({ ok: false, status: 0, reason: "timeout", gone: false }));
		const req = client.request({
			":method": "POST",
			":path": `/3/device/${d.token}`,
			authorization: `bearer ${jwt(cfg)}`,
			"apns-topic": cfg.bundleId,
			"apns-push-type": "alert",
			"apns-priority": "10",
			"content-type": "application/json",
		});
		let status = 0;
		let data = "";
		req.on("response", (h) => (status = Number(h[":status"]) || 0));
		req.on("data", (c) => (data += c));
		req.on("end", () => {
			let reason: string | undefined;
			try { reason = data ? JSON.parse(data).reason : undefined; } catch { /* 沒內容 */ }
			done({ ok: status === 200, status, reason, gone: status === 410 || reason === "BadDeviceToken" || reason === "Unregistered" });
		});
		req.on("error", (e) => done({ ok: false, status: 0, reason: String(e.message ?? e), gone: false }));
		req.end(payload);
	});
}

/** 送給所有登記的 iPhone;沒設定金鑰或沒有裝置就回 false。失效的 token 自動刪掉 */
export async function pushAll(msg: PushMessage, only?: string): Promise<boolean> {
	const cfg = loadConfig();
	const devices = listDevices().filter((d) => !only || d.token === only.toLowerCase());
	if (!cfg || !devices.length) return false;
	const results = await Promise.all(devices.map((d) => sendOne(cfg, d, msg).then((r) => ({ d, r }))));
	const gone = results.filter((x) => x.r.gone).map((x) => x.d.token);
	if (gone.length) saveDevices(listDevices().filter((d) => !gone.includes(d.token)));
	for (const { d, r } of results) if (!r.ok) console.error(`[apns] ${d.name ?? d.token.slice(0, 8)} 推播失敗 ${r.status} ${r.reason ?? ""}`);
	return results.some((x) => x.r.ok);
}

/** 管家原本的通知文字(第一行是標題)→ 推播:去掉附在最後的看板網址 */
export function messageFromText(text: string, projectId?: string): PushMessage {
	const lines = text.split("\n").filter((l) => !/^(到看板核准:)?https?:\/\/\S+$/.test(l.trim()));
	const title = (lines.shift() ?? "專案管家").trim();
	const body = lines.join("\n").replace(/\n{2,}/g, "\n").trim();
	return { title, body: body || title, ...(projectId ? { link: `agentsteward://project/${projectId}`, thread: projectId } : {}) };
}

export function apnsDir(): string {
	if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
	return DIR;
}
