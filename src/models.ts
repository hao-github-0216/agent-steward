// 模型接線:全部依設定頁的「AI 接口」與「路由」。
//  - 內建雲端服務(OpenAI、Anthropic、Gemini、OpenRouter…):API 金鑰,或沿用 pi 的登入(ChatGPT / Claude 訂閱,
//    用 pi 自己的 AuthStorage 讀寫,帶檔案鎖,token 更新會寫回 pi)
//  - OpenAI 相容網址(Ollama、LM Studio、vLLM、自架)
//  - 沿用 pi 的模型設定(~/.pi/agent/models.json,每次讀,pi 改了這裡跟著變)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { deviceId, stewardAuth } from "./auth-store.ts";
import { CLI_KINDS, CLI_ROLES, detectCliProviders, isCliKind } from "./agent-cli.ts";
import { BUILTINS, type Builtin, defaultRouting, detectPiProviders, type ProviderConfig, type RouteRole, settings, updateSettings } from "./settings.ts";

const PI_DIR = join(homedir(), ".pi", "agent");

// ---------- pi 的登入(有裝 pi 才有) ----------
let piStore: any;
async function piAuthStorage(): Promise<any> {
	if (piStore !== undefined) return piStore;
	try {
		const version = readFileSync(join(PI_DIR, "install", "current-version"), "utf8").trim();
		const mod = join(PI_DIR, "install", "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "auth-storage.js");
		const { AuthStorage } = await import(pathToFileURL(mod).href);
		piStore = AuthStorage.create(join(PI_DIR, "auth.json"));
	} catch {
		piStore = null; // 沒有 pi
	}
	return piStore;
}

/** 金鑰來源:設定檔的 API 金鑰,或(選了「沿用 pi 的登入」時)問 pi */
class SettingsCredentials {
	private cfg(id: string) { return settings().providers.find((p) => p.id === id && p.type === "builtin"); }
	async read(id: string, o?: unknown) {
		const c = this.cfg(id);
		if (!c) return undefined;
		if (c.auth === "pi") return (await piAuthStorage())?.read(id, o);
		if (c.auth === "login") return stewardAuth.read(id) as Promise<any>;
		return c.apiKey ? { type: "api_key" as const, key: c.apiKey } : undefined;
	}
	async list(o?: unknown) {
		const out: { providerId: string; type: "api_key" | "oauth" }[] = [];
		for (const c of settings().providers) if (c.type === "builtin" && (await this.read(c.id, o))) out.push({ providerId: c.id, type: c.auth === "pi" || c.auth === "login" ? "oauth" : "api_key" });
		return out;
	}
	async modify(id: string, fn: (cur: any) => Promise<any>, o?: unknown) {
		const c = this.cfg(id);
		if (c?.auth === "pi") return (await piAuthStorage())?.modify(id, fn, o); // OAuth 更新 token 寫回 pi
		if (c?.auth === "login") return stewardAuth.modify(id, fn as any);
		return fn(await this.read(id, o));
	}
	async delete(id: string, o?: unknown) {
		if (this.cfg(id)?.auth === "pi") return (await piAuthStorage())?.delete(id, o);
		if (this.cfg(id)?.auth === "login") return stewardAuth.delete(id);
	}
}

// ---------- 建立各種接口 ----------
const builtinFactory: Record<Builtin, () => Promise<any>> = {
	openai: async () => (await import("@earendil-works/pi-ai/providers/openai")).openaiProvider(),
	anthropic: async () => (await import("@earendil-works/pi-ai/providers/anthropic")).anthropicProvider(),
	google: async () => (await import("@earendil-works/pi-ai/providers/google")).googleProvider(),
	openrouter: async () => (await import("@earendil-works/pi-ai/providers/openrouter")).openrouterProvider(),
	deepseek: async () => (await import("@earendil-works/pi-ai/providers/deepseek")).deepseekProvider(),
	groq: async () => (await import("@earendil-works/pi-ai/providers/groq")).groqProvider(),
	mistral: async () => (await import("@earendil-works/pi-ai/providers/mistral")).mistralProvider(),
	xai: async () => (await import("@earendil-works/pi-ai/providers/xai")).xaiProvider(),
	"github-copilot": async () => (await import("@earendil-works/pi-ai/providers/github-copilot")).githubCopilotProvider(),
	"kimi-coding": async () => (await import("@earendil-works/pi-ai/providers/kimi-coding")).kimiCodingProvider(),
	meta: async () => (await import("@earendil-works/pi-ai/providers/meta")).metaProvider(),
};

/** OpenAI 相容 / pi 模型設定:網址、金鑰、模型清單 */
export function compatInfo(c: ProviderConfig): { baseUrl: string; apiKey: string; models: string[] } | undefined {
	if (c.type === "openai-compatible") return { baseUrl: c.baseUrl ?? "", apiKey: c.apiKey ?? "", models: c.models ?? [] };
	if (c.type === "pi-models") {
		try {
			const cfg = JSON.parse(readFileSync(join(PI_DIR, "models.json"), "utf8")).providers?.[c.piProvider ?? c.id];
			if (!cfg) return undefined;
			return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey ?? "", models: (cfg.models ?? []).map((m: { id: string }) => m.id) };
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function compatProvider(c: ProviderConfig) {
	const info = compatInfo(c);
	if (!info?.baseUrl) return undefined;
	// pi-models:沿用 pi 的模型欄位(上下文長度、推理設定…);openai-compatible:只有 id
	let raw: Record<string, unknown>[] = info.models.map((id) => ({ id, name: id }));
	if (c.type === "pi-models") {
		try { raw = JSON.parse(readFileSync(join(PI_DIR, "models.json"), "utf8")).providers[c.piProvider ?? c.id].models; } catch { /* 用 id 清單 */ }
	}
	const models = raw.map((m) => ({ contextWindow: 128000, maxTokens: 16384, input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...m, api: "openai-completions", provider: c.id, baseUrl: info.baseUrl, type: "chat" }));
	return createProvider({
		id: c.id,
		name: c.name || c.id,
		baseUrl: info.baseUrl,
		auth: { apiKey: { name: c.name || c.id, resolve: async () => ({ auth: { apiKey: compatInfo(c)?.apiKey || "local" }, source: "settings" }) } },
		models: models as never,
		api: openAICompletionsApi(),
	});
}

let models: MutableModels | undefined;
let registered = new Set<string>();

/** 依設定重建接口(新增/修改/刪除都在執行中生效) */
export async function syncProviders(): Promise<void> {
	if (!models) return;
	const want = new Set<string>();
	for (const c of settings().providers) {
		try {
			const p = c.type === "builtin" && c.builtin ? await builtinFactory[c.builtin]() : compatProvider(c);
			if (!p) continue;
			models.setProvider(p);
			want.add(c.id);
		} catch (e) {
			console.error(new Date().toISOString(), "[models] 建立接口失敗", c.id, e);
		}
	}
	for (const id of registered) if (!want.has(id)) models.deleteProvider(id);
	registered = want;
}

/** pi 存的登入是不是訂閱(oauth);ChatGPT 訂閱只能用部分模型 */
function piLoginType(id: string): string | undefined {
	try { return JSON.parse(readFileSync(join(PI_DIR, "auth.json"), "utf8"))[id]?.type; } catch { return undefined; }
}
/** ChatGPT 訂閱登入能用的模型(pi-ai 的 openai-codex 清單);API 金鑰不受限 */
const CHATGPT_MODELS = new Set(Object.values(OPENAI_CODEX_MODELS as Record<string, { id: string }>).map((m) => m.id));

/** 某個接口的模型清單 */
export function modelIds(c: ProviderConfig): string[] {
	if (c.type === "agent-cli") return isCliKind(c.cli) ? CLI_KINDS[c.cli].models : [];
	if (c.type !== "builtin") return compatInfo(c)?.models ?? [];
	const ids = models?.getModels(c.id).map((m) => m.id) ?? [];
	const chatgpt = c.auth === "login" || (c.auth === "pi" && piLoginType("openai") === "oauth");
	if (c.builtin === "openai" && chatgpt) return ids.filter((id) => CHATGPT_MODELS.has(id));
	return ids;
}

/** 預設路由用的模型:該家主力系列裡版本最新的(清單是照字母排,第一個常是舊模型) */
const MAIN_FAMILY: Partial<Record<Builtin, RegExp>> = { openai: /^gpt-\d/, anthropic: /sonnet/, google: /^gemini-.*flash/, openrouter: /sonnet/, deepseek: /flash|chat/, groq: /70b|120b/, mistral: /medium|large/, xai: /^grok/, "github-copilot": /sonnet|^gpt-\d/, "kimi-coding": /kimi|k\d/ };
const NOT_MAIN = /(^|[-/:])(preview|mini|nano|lite|research|computer|audio|realtime|image|tts|search|embedding|instruct|codex|batch|live|latest|\d{4,8})(?=[-:]|$)/;
function versionKey(id: string): number[] {
	return (id.match(/\d+(\.\d+)?/g) ?? []).map(Number);
}
export function pickModel(p: ProviderConfig): string | undefined {
	const ids = modelIds(p);
	const fam = p.builtin ? MAIN_FAMILY[p.builtin] : undefined;
	if (!fam) return ids[0];
	const cand = ids.filter((id) => fam.test(id) && !NOT_MAIN.test(id));
	if (!cand.length) return ids[0];
	return cand.sort((a, b) => {
		const x = versionKey(a), y = versionKey(b);
		for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
		return a.length - b.length;
	})[0];
}
/** 能在專案管家裡用訂閱登入的服務 */
export const LOGIN_PROVIDERS: Partial<Record<Builtin, string>> = {
	openai: "ChatGPT 訂閱",
	anthropic: "Claude 訂閱(Pro / Max)",
	"github-copilot": "GitHub Copilot 訂閱",
	xai: "Grok 訂閱(SuperGrok / X Premium)",
	"kimi-coding": "Kimi Code 訂閱",
	meta: "Meta 訂閱",
	openrouter: "OpenRouter(登入)",
};
/** 跑訂閱登入流程(登入結果經 SettingsCredentials 存進 ~/.agent-steward/auth.json) */
export async function loginProvider(id: string, interaction: unknown): Promise<void> {
	if (!models) throw new Error("模型還沒準備好,稍後再試");
	await (models as any).login(id, "oauth", interaction, { agentName: "agent-steward", getDeviceId: deviceId });
}
export function signedIn(c: ProviderConfig): boolean {
	return c.auth === "login" && stewardAuth.has(c.id);
}

/** 測試連線用的模型:路由裡這個接口用到的模型優先,沒有就挑主力模型 */
export function testModelFor(c: ProviderConfig): string | undefined {
	const ids = modelIds(c);
	const r = settings().routing;
	const refs = [r.chat, r.suggest, r.digest, r.judge, r.commitmsg].flatMap((x) => [x.primary, x.fallback]).concat(r.privacy);
	for (const ref of refs) {
		const p = parseRef(ref);
		if (p?.provider === c.id && ids.includes(p.modelId)) return p.modelId;
	}
	return pickModel(c);
}

/** 還沒指定模型的工作,用現有接口自動填上(已經設好的不動);回傳有沒有改 */
export function fillEmptyRouting(): boolean {
	const s = settings();
	if (!s.providers.length) return false;
	const def = defaultRouting(s.providers, pickModel);
	const r = structuredClone(s.routing);
	let changed = false;
	for (const role of Object.keys(def) as (keyof typeof def)[]) {
		if (role === "privacy") { if (!r.privacy && def.privacy) { r.privacy = def.privacy; changed = true; } continue; }
		if (!r[role].primary && def[role].primary) { r[role] = { primary: def[role].primary, fallback: r[role].fallback || def[role].fallback }; changed = true; }
	}
	// 只有 agent CLI 的人:聊天、建議問題、提交訊息先用 CLI(優先 Claude Code)
	const cli = [...s.providers].filter((p) => p.type === "agent-cli").sort((a, b) => (a.cli === "claude" ? -1 : b.cli === "claude" ? 1 : 0))[0];
	if (cli) for (const role of CLI_ROLES) if (!r[role].primary) { r[role] = { primary: `${cli.id}/default`, fallback: r[role].fallback }; changed = true; }
	if (changed) updateSettings({ routing: r });
	return changed;
}

export async function buildModels(): Promise<MutableModels> {
	models = createModels({ credentials: new SettingsCredentials() as never });
	// 第一次:從 pi 偵測接口,給一組預設路由(使用者之後刪光也不會再自動加回來)
	const s = settings();
	if (!s.aiDetected && !s.providers.length) {
		// 這台電腦上的 pi 登入/模型設定,加上已登入的 agent CLI(Claude Code、Codex…)
		const providers = [...detectPiProviders(), ...detectCliProviders()];
		updateSettings({ aiDetected: true, providers });
		await syncProviders();
		if (providers.length) updateSettings({ routing: defaultRouting(providers, pickModel) });
		fillEmptyRouting();
	} else {
		if (!s.aiDetected) updateSettings({ aiDetected: true });
		await syncProviders();
	}
	return models;
}

// ---------- 路由:某項工作用哪個模型 ----------
export function parseRef(ref: string): { provider: string; modelId: string } | undefined {
	const i = ref.indexOf("/");
	return i > 0 ? { provider: ref.slice(0, i), modelId: ref.slice(i + 1) } : undefined;
}
export class NoModelError extends Error {}
const ROLE_LABEL: Record<RouteRole | "privacy", string> = { chat: "聊天室", suggest: "建議問題", digest: "整理 agent 回報", judge: "提案檢查", commitmsg: "產生提交訊息", privacy: "隱私專案" };

/** 依路由挑模型;private=隱私專案(只用隱私模型);fallback=用備用 */
export function routeFor(role: RouteRole, opts: { private?: boolean; fallback?: boolean } = {}): { provider: string; modelId: string } {
	const r = settings().routing;
	if (opts.private) {
		const ref = parseRef(r.privacy);
		if (!ref) throw new NoModelError(`還沒設定「${ROLE_LABEL.privacy}」要用哪個模型(設定 → 路由)`);
		return ref;
	}
	const ref = parseRef(opts.fallback ? r[role].fallback : r[role].primary);
	if (!ref) throw new NoModelError(opts.fallback ? `「${ROLE_LABEL[role]}」沒有設定備用模型` : `還沒設定「${ROLE_LABEL[role]}」要用哪個模型(設定 → 路由)`);
	return ref;
}
export function hasFallback(role: RouteRole): boolean {
	return !!parseRef(settings().routing[role].fallback);
}
export function modelLabel(ref: { provider: string; modelId: string }): string {
	const c = settings().providers.find((p) => p.id === ref.provider);
	return `${c?.name.replace(/[((]沿用 pi 的(登入|模型設定)[))]/, "").trim() || ref.provider} · ${ref.modelId}`;
}
/** 這個模型看不看得懂圖片(agent CLI 一律不行) */
export function supportsImages(ref: { provider: string; modelId: string }): boolean {
	const c = settings().providers.find((x) => x.id === ref.provider);
	if (!c || c.type === "agent-cli" || !models) return false;
	const m = (models as unknown as { getModel(p: string, id: string): { input?: string[] } | undefined }).getModel(ref.provider, ref.modelId);
	return !!m?.input?.includes("image");
}
/** 有圖片的問題用哪個模型:聊天主要 → 聊天備用 → 提案檢查主要 → 提案檢查備用;隱私專案只能用隱私模型 */
export function imageRoute(privateProject: boolean): { provider: string; modelId: string } | undefined {
	const r = settings().routing;
	const refs = privateProject ? [r.privacy] : [r.chat.primary, r.chat.fallback, r.judge.primary, r.judge.fallback];
	for (const ref of refs) { const p = parseRef(ref); if (p && supportsImages(p)) return p; }
	return undefined;
}

/** 這個模型代號是不是 agent CLI(只能用在聊天、建議問題、提交訊息) */
export function isCliRef(ref: string): boolean {
	const p = parseRef(ref);
	return !!p && settings().providers.some((c) => c.id === p.provider && c.type === "agent-cli");
}
export function providerExists(id: string): boolean {
	return settings().providers.some((p) => p.id === id);
}
export { BUILTINS };
