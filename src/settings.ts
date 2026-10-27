// 使用者設定:~/.agent-steward/settings.json(權限 600,只有自己讀得到)。
// 所有「每個人不一樣」的東西都放這裡,程式碼裡不寫死任何個人資料。
// 第一次執行(檔案不存在)時,從這台電腦自動偵測:Tailscale 帳號與網址、pi 的隱私清單、Hermes 推播路由。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
export const DATA_DIR = process.env.STEWARD_DATA_DIR ?? join(HOME, ".agent-steward");
export const SETTINGS_PATH = join(DATA_DIR, "settings.json");

export type NotifyKind = "none" | "hermes" | "telegram" | "webhook";

/** pi-ai 內建的雲端服務(provider id 固定等於這個名字) */
export const BUILTINS = ["openai", "anthropic", "google", "openrouter", "deepseek", "groq", "mistral", "xai", "github-copilot", "kimi-coding", "meta"] as const;
export type Builtin = (typeof BUILTINS)[number];

/**
 * AI 接口:
 *  - builtin:pi-ai 內建的雲端服務,用 API 金鑰,或沿用 pi 的登入(ChatGPT / Claude 訂閱)
 *  - openai-compatible:任何 OpenAI 相容網址(Ollama、LM Studio、vLLM、自架)
 *  - pi-models:沿用 pi 的模型設定(~/.pi/agent/models.json 裡的某個 provider,pi 改了這裡跟著變)
 */
export interface ProviderConfig {
	id: string;
	type: "builtin" | "openai-compatible" | "pi-models";
	name: string;
	builtin?: Builtin;
	/** apiKey:API 金鑰;pi:沿用 pi 的登入;login:在專案管家裡用訂閱登入(存 ~/.agent-steward/auth.json) */
	auth?: "apiKey" | "pi" | "login";
	apiKey?: string;
	baseUrl?: string;
	models?: string[];
	piProvider?: string;
	/** 本地/自架(隱私專案可以用) */
	local?: boolean;
}
/** 模型代號:「接口 id/模型 id」,空字串 = 沒設定 */
export interface Route { primary: string; fallback: string }
export const ROLES = ["chat", "suggest", "digest", "judge", "commitmsg"] as const;
export type RouteRole = (typeof ROLES)[number];

export interface Settings {
	version: 1;
	/** 管家怎麼稱呼使用者(空白 = 「使用者」) */
	user: { name: string };
	server: {
		port: number;
		terminalPort: number;
		/** 伺服器要聽哪些位址(本機永遠包含 127.0.0.1) */
		hosts: string[];
		/** 給人點的網址(推播訊息、從 http 轉到 https 用);空白 = http://127.0.0.1:port/ */
		publicUrl: string;
	};
	access: {
		/** 管理密碼(scrypt 雜湊;空白 = 還沒設定,只有本機能進來) */
		passwordHash: string;
		/** Tailscale 遠端存取:經 Tailscale serve 的 https 進來 */
		tailscale: { enabled: boolean };
		/** 經 Tailscale 連進來時,這些帳號的個人裝置免密碼 */
		tailscaleUsers: string[];
		/** 區網存取:同一個 Wi-Fi 的裝置用密碼登入(要重新啟動) */
		lan: { enabled: boolean };
	};
	paths: {
		/** 「建立專案」瀏覽資料夾的起點 */
		createRoot: string;
		/** 隱私路徑:這些資料夾底下的專案只用本地模型 */
		privacy: string[];
		/** 同時沿用 pi 的隱私清單(~/.pi/agent/privacy-paths.json) */
		usePiPrivacy: boolean;
	};
	/** 已經自動偵測過 AI 接口(使用者刪光之後不再自動加回來) */
	aiDetected: boolean;
	/** 第一次設定精靈已經走完(或略過) */
	setupDone: boolean;
	providers: ProviderConfig[];
	routing: Record<RouteRole, Route> & { privacy: string };
	notify: {
		kind: NotifyKind;
		hermes: { url: string; route: string };
		telegram: { botToken: string; chatId: string };
		webhook: { url: string };
	};
}

export const DEFAULTS: Settings = {
	version: 1,
	user: { name: "" },
	server: { port: 8791, terminalPort: 8792, hosts: ["127.0.0.1"], publicUrl: "" },
	access: { passwordHash: "", tailscale: { enabled: false }, tailscaleUsers: [], lan: { enabled: false } },
	paths: { createRoot: "~", privacy: [], usePiPrivacy: false },
	aiDetected: false,
	setupDone: false,
	providers: [],
	routing: {
		chat: { primary: "", fallback: "" },
		suggest: { primary: "", fallback: "" },
		digest: { primary: "", fallback: "" },
		judge: { primary: "", fallback: "" },
		commitmsg: { primary: "", fallback: "" },
		privacy: "",
	},
	notify: {
		kind: "none",
		hermes: { url: "", route: "steward" },
		telegram: { botToken: "", chatId: "" },
		webhook: { url: "" },
	},
};

/** 把讀進來的設定補齊預設值(新版本多了欄位時,舊檔也能用) */
function merge<T>(base: T, over: unknown): T {
	if (Array.isArray(base)) return (Array.isArray(over) ? over : base) as T;
	if (base && typeof base === "object") {
		const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
		if (over && typeof over === "object") for (const [k, v] of Object.entries(over)) out[k] = k in out ? merge(out[k], v) : v;
		return out as T;
	}
	return (over === undefined || over === null || typeof over !== typeof base ? base : over) as T;
}

// ---------- 第一次執行:從這台電腦偵測 ----------
export function findTailscale(): string | undefined {
	const candidates = process.platform === "win32"
		? ["C:\\Program Files\\Tailscale\\tailscale.exe"]
		: ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/bin/tailscale"];
	return candidates.find((p) => existsSync(p));
}

function tailscaleJson(args: string[]): any {
	const bin = findTailscale();
	if (!bin) return undefined;
	try {
		return JSON.parse(execFileSync(bin, [...args, "--json"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }));
	} catch {
		return undefined;
	}
}

function detect(): Settings {
	const s: Settings = structuredClone(DEFAULTS);
	// Tailscale:本人帳號、本機 tailnet IP、已經設好的 https 轉接網址
	const st = tailscaleJson(["status"]);
	if (st?.Self) {
		const login = st.User?.[String(st.Self.UserID)]?.LoginName;
		if (login) s.access.tailscaleUsers = [String(login).toLowerCase()];
		s.access.tailscale.enabled = true;
		const ipv4 = (st.Self.TailscaleIPs ?? []).find((ip: string) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
		if (ipv4) s.server.hosts = ["127.0.0.1", ipv4];
		const dns = String(st.Self.DNSName ?? "").replace(/\.$/, "");
		const serve = tailscaleJson(["serve", "status"]);
		// 找出「轉到本機管家埠」的那個 https 入口
		for (const [hostPort, web] of Object.entries<any>(serve?.Web ?? {})) {
			const target = JSON.stringify(web?.Handlers ?? {});
			if (target.includes(`127.0.0.1:${s.server.port}`) || target.includes(`localhost:${s.server.port}`)) {
				const port = hostPort.split(":").pop();
				s.server.publicUrl = `https://${dns || hostPort.split(":")[0]}${port && port !== "443" ? `:${port}` : ""}/`;
				break;
			}
		}
	}
	// pi 的隱私清單
	if (existsSync(join(HOME, ".pi", "agent", "privacy-paths.json"))) s.paths.usePiPrivacy = true;
	// Hermes 推播路由
	try {
		const subs = JSON.parse(readFileSync(join(HOME, ".hermes", "webhook_subscriptions.json"), "utf8"));
		if (subs?.steward || subs?.routes?.steward) s.notify.kind = "hermes";
	} catch {
		/* 沒有 Hermes */
	}
	return s;
}

// ---------- AI 接口:偵測 pi(訂閱登入、模型設定),並給一組合理的預設路由 ----------
const PI_DIR = join(HOME, ".pi", "agent");
function readJson(path: string): any {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}
export function detectPiProviders(): ProviderConfig[] {
	const out: ProviderConfig[] = [];
	const auth = readJson(join(PI_DIR, "auth.json")) ?? {};
	const label: Record<string, string> = { openai: "ChatGPT 訂閱", anthropic: "Claude 訂閱" };
	for (const id of Object.keys(auth)) {
		if ((BUILTINS as readonly string[]).includes(id)) out.push({ id, type: "builtin", builtin: id as Builtin, auth: "pi", name: `${label[id] ?? id}(沿用 pi 的登入)` });
	}
	const models = readJson(join(PI_DIR, "models.json"))?.providers ?? {};
	for (const [id, cfg] of Object.entries<any>(models)) {
		if ((BUILTINS as readonly string[]).includes(id) || !cfg?.baseUrl || !cfg?.models?.length) continue;
		const host = String(cfg.baseUrl);
		const local = /localhost|127\.0\.0\.1|\/\/10\.|\/\/192\.168\.|\/\/172\.(1[6-9]|2\d|3[01])\.|\/\/100\./.test(host);
		out.push({ id, type: "pi-models", piProvider: id, name: `${id}(沿用 pi 的模型設定)`, local });
	}
	return out;
}
/** 依現有接口給預設路由:有本地模型 → 聊天、建議、整理、提交訊息、隱私都用本地;提案檢查用雲端;聊天備用雲端 */
export function defaultRouting(providers: ProviderConfig[], firstModel: (p: ProviderConfig) => string | undefined): Settings["routing"] {
	const ref = (p?: ProviderConfig) => { const m = p && firstModel(p); return p && m ? `${p.id}/${m}` : ""; };
	const local = providers.find((p) => p.local);
	const cloud = providers.find((p) => p.type === "builtin");
	const l = ref(local), c = ref(cloud);
	const main = l || c;
	return {
		chat: { primary: main, fallback: l && c ? c : "" },
		suggest: { primary: main, fallback: "" },
		digest: { primary: main, fallback: l && c ? c : "" },
		judge: { primary: c || l, fallback: c && l ? l : "" },
		commitmsg: { primary: main, fallback: "" },
		privacy: l,
	};
}

// ---------- 讀寫 ----------
let current: Settings | null = null;
const listeners = new Set<(s: Settings) => void>();

function write(s: Settings): void {
	mkdirSync(DATA_DIR, { recursive: true });
	const tmp = `${SETTINGS_PATH}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(s, null, "\t")}\n`, { mode: 0o600 });
	renameSync(tmp, SETTINGS_PATH);
	try { chmodSync(SETTINGS_PATH, 0o600); } catch { /* Windows */ }
}

export function settings(): Settings {
	if (current) return current;
	if (existsSync(SETTINGS_PATH)) {
		try {
			const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
			current = merge(DEFAULTS, raw);
			// 舊設定檔沒有 Tailscale 開關:有允許帳號就當作已開啟(維持原本的行為)
			if (!raw.access?.tailscale) {
				current.access.tailscale.enabled = current.access.tailscaleUsers.length > 0;
				write(current);
			}
			// 有精靈之前就在用的人:不再跳出第一次設定
			if (raw.setupDone === undefined) {
				current.setupDone = true;
				write(current);
			}
		} catch (e) {
			console.error(new Date().toISOString(), "[settings] 讀不了設定檔,先用預設值", e);
			current = structuredClone(DEFAULTS);
		}
	} else {
		current = detect();
		write(current);
		console.error(new Date().toISOString(), "[settings] 第一次執行:已建立", SETTINGS_PATH);
	}
	return current;
}

/** 部分更新(深層合併)並存檔;回傳新設定 */
export function updateSettings(patch: unknown): Settings {
	const next = merge(settings(), patch);
	next.version = 1;
	if (!next.server.hosts.includes("127.0.0.1")) next.server.hosts = ["127.0.0.1", ...next.server.hosts];
	write(next);
	current = next;
	for (const fn of listeners) fn(next);
	return next;
}

export function onSettingsChange(fn: (s: Settings) => void): void {
	listeners.add(fn);
}

/** 給網頁看的版本:密碼、token 只露出後四碼 */
export function publicSettings(s: Settings = settings()): Settings {
	const out = structuredClone(s);
	const mask = (v: string) => (v ? `••••${v.slice(-4)}` : "");
	out.access.passwordHash = out.access.passwordHash ? "set" : "";
	out.notify.telegram.botToken = mask(out.notify.telegram.botToken);
	for (const p of out.providers) if (p.apiKey) p.apiKey = mask(p.apiKey);
	return out;
}

/** 從網頁送回來的更新:遮罩過的欄位(••••開頭)代表「沒改」,不要覆蓋 */
export function stripMasked(patch: any): any {
	if (patch && typeof patch === "object") {
		for (const [k, v] of Object.entries(patch)) {
			if (typeof v === "string" && v.startsWith("••••")) delete patch[k];
			else stripMasked(v);
		}
	}
	return patch;
}

export function expandHome(p: string): string {
	return p === "~" ? HOME : p.startsWith("~/") ? join(HOME, p.slice(2)) : p;
}
