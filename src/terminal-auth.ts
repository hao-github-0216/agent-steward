// 登入檢查(整個專案管家共用;終端機在轉接層也用這個,ttyd 只信任我們加上的 X-Steward-User 標頭)。
//
// 放行的方式:
//  1. 經 Tailscale serve 的 https 進來(連線來自本機,而且帶 Tailscale 身分標頭):帳號在設定的允許清單、
//     來源是個人裝置(Windows/macOS/iOS/Android)就免密碼;Linux 伺服器一律不免密碼。
//     只有連線真的來自本機時才相信這些標頭(區網直連的人可以偽造標頭)。
//  2. 管理密碼登入後的 cookie(30 天)。密碼錯 5 次鎖 5 分鐘。
//  3. 還沒設定管理密碼時:只有這台電腦本身(本機直連)能進來,用來設定密碼。
//  4. 本機的 agent 整合(開工簡報、提問、回報):本機直連免登入,讓 hook / MCP 照常運作。
import { execFile } from "node:child_process";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { DATA_DIR, findTailscale, settings, updateSettings } from "./settings.ts";

const PERSONAL_OS = new Set(["windows", "macos", "ios", "android"]);
const FAIL_LIMIT = 5;
const LOCK_MS = 5 * 60_000;
const SESSION_MS = 30 * 24 * 3600_000;
export const COOKIE = "steward_session";

export type AuthResult = { ok: true; user: string; how: "tailscale" | "password" | "local" } | { ok: false; status: 401 | 403; reason: string; login?: boolean };

// 允許的 Tailscale 帳號:設定頁「存取」填的(第一次執行自動帶入本人帳號)
const allowedLogins = () => (process.env.STEWARD_TS_USERS ? process.env.STEWARD_TS_USERS.split(",") : settings().access.tailscaleUsers).map((s) => s.trim().toLowerCase()).filter(Boolean);

// ---------- Tailscale 裝置清單(IP → 擁有者、作業系統),每分鐘更新 ----------
let peers = new Map<string, { login: string; os: string; host: string }>();
let peersAt = 0;
function refreshPeers(): Promise<void> {
	return new Promise((resolve) => {
		const bin = findTailscale();
		if (!bin) return resolve();
		execFile(bin, ["status", "--json"], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
			if (!err) {
				try {
					const d = JSON.parse(out);
					const next = new Map<string, { login: string; os: string; host: string }>();
					for (const node of [d.Self, ...Object.values(d.Peer ?? {})] as any[]) {
						const login = String(d.User?.[String(node.UserID)]?.LoginName ?? "").toLowerCase();
						for (const ip of node.TailscaleIPs ?? []) next.set(ip, { login, os: String(node.OS ?? "").toLowerCase(), host: node.HostName });
					}
					peers = next;
					peersAt = Date.now();
				} catch {
					/* 保留舊清單 */
				}
			}
			resolve();
		});
	});
}
async function device(ip: string) {
	if (Date.now() - peersAt > 60_000 || !peers.has(ip)) await refreshPeers();
	return peers.get(ip);
}

function header(req: IncomingMessage, name: string): string | undefined {
	const v = req.headers[name];
	return Array.isArray(v) ? v[0] : v;
}
const loopback = (a?: string) => !!a && /^(127\.|::1$|::ffff:127\.)/.test(a);
/** 連線來自本機 */
export function fromLoopback(req: IncomingMessage): boolean {
	return loopback(req.socket.remoteAddress);
}
/** 本機的程式直接連(不是經 Tailscale serve 轉進來的瀏覽器) */
export function isPureLocal(req: IncomingMessage): boolean {
	return fromLoopback(req) && !header(req, "tailscale-user-login") && !header(req, "x-forwarded-for");
}

// ---------- 管理密碼 ----------
export function hasPassword(): boolean {
	return !!settings().access.passwordHash;
}
function hashPassword(pw: string): string {
	const salt = randomBytes(16);
	const hash = scryptSync(pw, salt, 32);
	return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
function checkPassword(pw: string): boolean {
	const [kind, salt, hash] = settings().access.passwordHash.split("$");
	if (kind !== "scrypt" || !salt || !hash) return false;
	const got = scryptSync(pw, Buffer.from(salt, "hex"), 32);
	const want = Buffer.from(hash, "hex");
	return got.length === want.length && timingSafeEqual(got, want);
}
export function setPassword(current: string, next: string): { ok: true } | { ok: false; error: string } {
	if (next.length < 8) return { ok: false, error: "密碼至少 8 個字" };
	if (hasPassword() && !checkPassword(current)) return { ok: false, error: "目前的密碼不對" };
	updateSettings({ access: { passwordHash: hashPassword(next) } });
	sessions.clear(); // 改密碼:所有裝置要重新登入
	saveSessions();
	return { ok: true };
}

// ---------- 登入狀態(cookie) ----------
const SESS_FILE = join(DATA_DIR, "sessions.json");
const sessions = new Map<string, { until: number; who: string }>();
try {
	if (existsSync(SESS_FILE)) for (const [k, v] of Object.entries<any>(JSON.parse(readFileSync(SESS_FILE, "utf8")))) if (v.until > Date.now()) sessions.set(k, v);
} catch { /* 從頭來 */ }
function saveSessions() {
	try {
		writeFileSync(`${SESS_FILE}.tmp`, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
		renameSync(`${SESS_FILE}.tmp`, SESS_FILE);
	} catch { /* 寫不了就只留在記憶體 */ }
}
function cookieToken(req: IncomingMessage): string | undefined {
	const c = header(req, "cookie") ?? "";
	return c.split(/;\s*/).find((x) => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
}
const fails = new Map<string, { n: number; until: number }>();
const clientKey = (req: IncomingMessage) => (fromLoopback(req) ? (header(req, "x-forwarded-for") ?? "local").split(",")[0].trim() : req.socket.remoteAddress ?? "?");

/** 密碼登入:成功回傳要設的 cookie */
export function login(req: IncomingMessage, password: string): { ok: true; cookie: string } | { ok: false; status: 401 | 403; error: string } {
	if (!hasPassword()) return { ok: false, status: 403, error: "還沒設定管理密碼(到設定 → 存取)" };
	const key = clientKey(req);
	const f = fails.get(key);
	if (f && f.until > Date.now()) return { ok: false, status: 403, error: `密碼錯太多次,${Math.ceil((f.until - Date.now()) / 60000)} 分鐘後再試` };
	if (!checkPassword(password)) {
		const n = (f?.n ?? 0) + 1;
		fails.set(key, { n: n >= FAIL_LIMIT ? 0 : n, until: n >= FAIL_LIMIT ? Date.now() + LOCK_MS : 0 });
		return { ok: false, status: 401, error: "密碼不對" };
	}
	fails.delete(key);
	const token = randomBytes(32).toString("hex");
	sessions.set(token, { until: Date.now() + SESSION_MS, who: key });
	saveSessions();
	const secure = header(req, "x-forwarded-proto") === "https" || !!header(req, "tailscale-user-login");
	return { ok: true, cookie: `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure ? "; Secure" : ""}` };
}
export function logout(req: IncomingMessage): string {
	const t = cookieToken(req);
	if (t && sessions.delete(t)) saveSessions();
	return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** 這個請求是誰、能不能進來 */
export async function authorize(req: IncomingMessage): Promise<AuthResult> {
	const viaServe = fromLoopback(req) && !!header(req, "tailscale-user-login");
	// 1. Tailscale serve:它會把自己設的身分標頭加上(用戶端傳來的同名標頭會被它蓋掉)
	if (viaServe && settings().access.tailscale.enabled) {
		const login = header(req, "tailscale-user-login")!.toLowerCase();
		const ip = (header(req, "x-forwarded-for") ?? "").split(",")[0].trim();
		const dev = ip ? await device(ip) : undefined;
		if (allowedLogins().includes(login) && dev && dev.login === login && PERSONAL_OS.has(dev.os)) return { ok: true, user: `${login}@${dev.host}`, how: "tailscale" };
	}
	// 2. 密碼登入的 cookie
	const t = cookieToken(req);
	const s = t ? sessions.get(t) : undefined;
	if (s && s.until > Date.now()) return { ok: true, user: s.who, how: "password" };
	// 3. 還沒設密碼:只有本機直連可以進來(設定密碼用)
	if (!hasPassword()) {
		if (isPureLocal(req)) return { ok: true, user: "local", how: "local" };
		return { ok: false, status: 403, reason: "還沒設定管理密碼:請在這台電腦上打開專案管家,到「設定 → 存取」設定密碼", login: false };
	}
	return { ok: false, status: 401, reason: "請先登入", login: true };
}
/** 舊名稱(終端機、程式碼頁沿用) */
export const authorizeTerminal = authorize;
