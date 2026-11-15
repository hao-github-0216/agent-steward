// 手機推播：逐台加密送中繼，或用自己的 APNs 金鑰直接送 iPhone。
//
// 設定:~/.agent-steward/apns/ 放 Apple 開發者網站下載的 AuthKey_<KEY ID>.p8,
// 再加 config.json {"teamId": "...", "bundleId": "..."}(keyId 沒寫就從檔名取)。
// 裝置:iPhone app 登入後把 device token 送到 /api/push/register,記在 ~/.agent-steward/push-devices.json。
// Xcode 直接裝的開發版走 sandbox,TestFlight / App Store 版走 production,由 app 自己回報。
import { tr } from "./i18n.ts";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { connect } from "node:http2";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { settings } from "./settings.ts";
import { collapseFor, encryptPush, validKey } from "./push-crypto.ts";

const DIR = join(DATA_DIR, "apns");
const DEVICES = join(DATA_DIR, "push-devices.json");

export interface PushDevice {
	token: string;
	env: "sandbox" | "production";
	/** 裝置平台;iOS 走直接 APNs 或中繼,Android 只能走中繼 */
	platform: "ios" | "android";
	/** 端對端加密金鑰(32 位元組標準 base64);有金鑰的裝置才走得中繼 */
	key?: string;
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

/** 推播模式:有本機 APNs 金鑰走 direct,有設定中繼網址走 relay,都沒有就是 none */
export function pushMode(): "direct" | "relay" | "none" {
	if (loadConfig()) return "direct";
	if (settings().push.relay) return "relay";
	return "none";
}

export function listDevices(): PushDevice[] {
	try {
		const v = JSON.parse(readFileSync(DEVICES, "utf8"));
		if (!Array.isArray(v)) return [];
		// 舊檔沒有 platform 欄位,一律補成 ios
		return (v as PushDevice[]).map((d) => ({ ...d, platform: d.platform === "android" ? "android" as const : "ios" as const }));
	} catch {
		return [];
	}
}

function saveDevices(list: PushDevice[]): void {
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(DEVICES, JSON.stringify(list, null, 2));
	try { chmodSync(DEVICES, 0o600); } catch { /* Windows */ }
}

export function registerDevice(token: string, env: string, name?: string, platform: "ios" | "android" = "ios", key?: string): PushDevice {
	// 呼叫端傳進來的 platform 是字串,runtime 再守一次
	if (platform !== "ios" && platform !== "android") throw new Error(tr("推播平台必須是 ios 或 android"));
	if (platform === "ios") {
		// iOS token 是十六進位,統一存小寫
		if (!/^[0-9a-f]{32,200}$/i.test(token)) throw new Error(tr("device token 格式不對"));
		token = token.toLowerCase();
	} else if (!/^[A-Za-z0-9_:\-]{1,4096}$/.test(token)) {
		// Android token 保留大小寫
		throw new Error(tr("device token 格式不對"));
	}
	if (key !== undefined && !validKey(key)) throw new Error(tr("推播金鑰必須是 32 位元組的標準 base64"));
	const d: PushDevice = { token, env: env === "production" ? "production" : "sandbox", platform, ...(key !== undefined ? { key } : {}), name: name?.slice(0, 80), addedAt: new Date().toISOString() };
	// 同 token 重新註冊覆蓋舊紀錄
	saveDevices([...listDevices().filter((x) => x.token !== d.token), d]);
	return d;
}

/** 比對 token:iOS 不分大小寫,Android 精確比對 */
function tokenMatches(d: PushDevice, token: string): boolean {
	return d.platform === "ios" ? d.token === token.toLowerCase() : d.token === token;
}

export function unregisterDevice(token: string): void {
	saveDevices(listDevices().filter((x) => !tokenMatches(x, token)));
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
	// 有金鑰:內容端對端加密,alert 只放解不開時的備用文字，明文 link/thread 不放根物件
	const payload = d.key
		? JSON.stringify({
			aps: {
				alert: { "title-loc-key": "PUSH_FALLBACK_TITLE", "loc-key": "PUSH_FALLBACK_BODY" },
				"mutable-content": 1,
				sound: "default",
				...(msg.thread ? { "thread-id": collapseFor(d.key, msg.thread) } : {}),
			},
			e: encryptPush(d.key, msg),
		})
		: JSON.stringify({
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

/** 經推播中繼(Cloudflare Worker)送一台有金鑰的裝置;通知內容加密,中繼看不到文字。失敗不印 token 與內容 */
async function sendRelay(relay: string, d: PushDevice, msg: PushMessage): Promise<{ ok: boolean; status: number; gone: boolean }> {
	try {
		const body: Record<string, unknown> = {
			v: 1,
			platform: d.platform,
			token: d.token,
			payload: encryptPush(d.key!, msg),
		};
		// env 只有 iOS 用;collapse 只有在有 thread 時才帶
		if (d.platform === "ios") body.env = d.env;
		if (msg.thread) body.collapse = collapseFor(d.key!, msg.thread);
		const response = await fetch(`${relay.replace(/\/+$/, "")}/v1/push`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});
		await response.body?.cancel();
		return { ok: response.status === 200, status: response.status, gone: response.status === 410 };
	} catch {
		// 不印例外內容,避免洩漏 token 或通知文字
		return { ok: false, status: 0, gone: false };
	}
}

/** 送給所有登記的裝置:iOS 有本機金鑰走直接 APNs(含舊無金鑰裝置),有金鑰且設定了中繼走 sendRelay;失效的 token 自動刪掉 */
export async function pushAll(msg: PushMessage, only?: string): Promise<boolean> {
	const cfg = loadConfig();
	const relay = settings().push.relay;
	const devices = listDevices().filter((d) => {
		if (only && !tokenMatches(d, only)) return false;
		// 能送的條件：iOS 且有本機 APNs 金鑰,或有加密金鑰且設定了中繼
		return (d.platform === "ios" && !!cfg) || (!!d.key && !!relay);
	});
	if (!devices.length) return false;
	const results = await Promise.all(devices.map(async (d) => {
		if (d.platform === "ios" && cfg) return { d, r: await sendOne(cfg, d, msg), via: "apns" as const };
		return { d, r: await sendRelay(relay, d, msg), via: "relay" as const };
	}));
	const gone = results.filter((x) => x.r.gone).map((x) => x.d.token);
	if (gone.length) saveDevices(listDevices().filter((d) => !gone.includes(d.token)));
	// 只印通道、平台、狀態碼;不印 token、名稱、通知或例外內容
	for (const { d, r, via } of results) if (!r.ok) console.error(`[${via === "relay" ? "push-relay" : "apns"}] ${d.platform} ${r.status}`);
	return results.some((x) => x.r.ok);
}

/** 管家原本的通知文字(第一行是標題)→ 推播:去掉附在最後的看板網址 */
export function messageFromText(text: string, projectId?: string): PushMessage {
	const lines = text.split("\n").filter((l) => !/^(到看板核准:|Approve on board: )?https?:\/\/\S+$/.test(l.trim()));
	const title = (lines.shift() ?? tr("專案管家")).trim();
	const body = lines.join("\n").replace(/\n{2,}/g, "\n").trim();
	return { title, body: body || title, ...(projectId ? { link: `agentsteward://project/${projectId}`, thread: projectId } : {}) };
}

export function apnsDir(): string {
	if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
	return DIR;
}
