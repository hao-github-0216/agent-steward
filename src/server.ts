// HTTP API + 看板網頁 + SSE 即時更新。只綁本機與 tailnet IP。
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { pathInside, serviceHint } from "./platform.ts";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import { appendFileSync, mkdirSync, statSync as fileStat } from "node:fs";
import { authorize, authorizeTerminal, hasPassword, isPureLocal, login, logout, setPassword } from "./terminal-auth.ts";
import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { getCurrent, getSession, putCurrent, putSession } from "./code-session.ts";
import { expandHome, findTailscale, publicSettings, settings, stripMasked, updateSettings } from "./settings.ts";
import { hermesSecret, notify } from "./notify.ts";
import { listAgents, setAgent } from "./agents.ts";
import { applyUpdate, checkUpdate, updateLog } from "./update.ts";
import { cancelLogin, loginStatus, startLogin, submitCode } from "./oauth-login.ts";
import { stewardAuth } from "./auth-store.ts";
import { installKernel, kernelInfo, pythonEnvs, sendKernel, startKernel, stopKernelFor, subscribe as subscribeKernel } from "./notebook.ts";
import { CLI_KINDS, detectCliProviders, isCliKind } from "./agent-cli.ts";
import { compatInfo, fillEmptyRouting, LOGIN_PROVIDERS, signedIn, testModelFor, hasFallback, modelIds, modelLabel, parseRef, routeFor, syncProviders } from "./models.ts";
import { BUILTINS, detectPiProviders, type ProviderConfig } from "./settings.ts";
import { appendChat, clearChat, getSuggestions, putSuggestions, readChat, recentChat, type ChatQuote } from "./chat-log.ts";
import { CodeError, diffSides, fileForChat, fileStamps, findFiles, fsOp, gitAction, isRepo, listDir, rawFile, readFile, status as gitStatus, uploadFile, writeFile } from "./code.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { brief } from "./brief.ts";
import { DATA_DIR, HOME, HOSTS, isPrivatePath, MISC_ROOTS, PORT, publicUrl, TERMINAL_PORT } from "./config.ts";
import { dispatchCard, focusProject } from "./dispatch.ts";
import { herdrCli, listPanes, listWorkspaces } from "./herdr.ts";
import { boundSpace, movePane, projectOfSpace, runTidy, strayPanes, tidyPlan } from "./spaces.ts";
import { createProject } from "./create.ts";
import { ensureSpecial, MISC_ROOT, OVERVIEW_ROOT, ownerOf, resolveProject } from "./projects.ts";
import type { Steward } from "./steward.ts";
import type { Card, CardColumn, Project, Store } from "./store.ts";
import type { Watcher } from "./watcher.ts";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const MOVABLE: CardColumn[] = ["proposed", "approved", "running", "blocked", "done", "rejected"];

/** OpenAI 相容接口的模型清單(GET {baseUrl}/models) */
async function fetchCompatModels(c: ProviderConfig): Promise<string[]> {
	const base = (c.baseUrl ?? "").replace(/\/$/, "");
	let r: Response;
	try {
		r = await fetch(`${base}/models`, { headers: c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}, signal: AbortSignal.timeout(10_000) });
	} catch (e) {
		throw new Error(`連不上 ${base}:${(e as Error).message}`);
	}
	if (!r.ok) throw new Error(`${base}/models 回應 ${r.status}`);
	return (((await r.json()) as { data?: { id: string }[] }).data ?? []).map((m) => m.id).filter(Boolean);
}

async function body(req: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	if (!chunks.length) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * 卡片移動規則:每種拖法都要有明確意義,沒有意義的直接拒絕(看板會彈回原欄位並顯示原因)。
 *   提案 → 已核准:派工        卡住/完成 → 已核准:重新派工(附上次結果)
 *   進行中:只能由派工產生     進行中/已核准 ↔ 卡住/完成:手動標記
 *   任何 → 提案:退回重新考慮  任何 → 不要:不做了
 */
function moveRule(from: CardColumn, to: CardColumn): { ok: true; action?: "dispatch" | "redispatch" } | { ok: false; reason: string } {
	if (from === to) return { ok: false, reason: "已經在這一欄" };
	if (to === "running") return { ok: false, reason: "「進行中」只能由派工產生:要派工請拖到「已核准」" };
	if (to === "approved") {
		if (from === "proposed") return { ok: true, action: "dispatch" };
		if (from === "blocked" || from === "done") return { ok: true, action: "redispatch" };
		return { ok: false, reason: "這張卡已經在派工中" };
	}
	if (to === "blocked" || to === "done") {
		if (from === "running" || from === "approved" || from === "blocked" || from === "done") return { ok: true };
		return { ok: false, reason: "還沒派工的提案不能直接標成卡住/完成:不要的話請按「不要」" };
	}
	if (to === "proposed" || to === "rejected") return { ok: true };
	return { ok: false, reason: "不支援這種移動" };
}

function header(req: IncomingMessage, name: string): string | undefined {
	const v = req.headers[name];
	return Array.isArray(v) ? v[0] : v;
}

function send(res: ServerResponse, status: number, data: unknown, type = "application/json; charset=utf-8") {
	res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
	res.end(typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}

export function startServer(store: Store, steward: Steward, watcher: Watcher): void {
	const clients = new Set<ServerResponse>();
	store.onChange((what) => {
		for (const c of clients) c.write(`data: ${JSON.stringify({ what })}\n\n`);
	});

	const projectFrom = (q: URLSearchParams | Record<string, string | undefined>): Project | undefined => {
		const get = (k: string) => (q instanceof URLSearchParams ? (q.get(k) ?? undefined) : q[k]);
		const id = get("project");
		if (id) return store.project(id) ?? store.projects().find((p) => p.name === id);
		const cwd = get("cwd");
		if (cwd) return resolveProject(store, cwd);
		return undefined;
	};

	// herdr 目前停在哪個專案(側欄跟著切換用;多個瀏覽器同時輪詢,快取 1.5 秒)
	let currentCache: { at: number; value: unknown } | null = null;
	const terminalCurrent = () => {
		if (currentCache && Date.now() - currentCache.at < 1500) return currentCache.value;
		const ws = listWorkspaces().find((w) => w.focused);
		let value: { project: string | null; via?: string; space?: string } = { project: null };
		if (ws) {
			const pane = (listPanes() ?? []).find((x) => x.workspace_id === ws.workspace_id && x.focused);
			const cwd = pane?.foreground_cwd || pane?.cwd;
			const byPane = cwd ? ownerOf(store, cwd) : undefined;
			const bySpace = projectOfSpace(store, ws.workspace_id);
			const p = byPane ?? bySpace;
			value = { project: p?.id ?? null, via: byPane ? "pane" : bySpace ? "space" : undefined, space: ws.label };
		}
		currentCache = { at: Date.now(), value };
		return value;
	};

	// ---------- 聊天室的三個建議問題(路由「建議問題」指定的模型產生) ----------
	const suggesting = new Set<string>();
	const SUGGEST_SYS = "你幫使用者想「接下來可以問專案管家的問題」。根據專案狀態和最近的問答,產生 3 個簡短、具體、彼此不同的問題,必須用繁體中文(台灣用字,不可以出現任何簡體字),每題 30 字以內。有最近問答時,順著那個方向往下問(追問細節、下一步、風險);沒有時依專案的下一步和卡住的地方。不要問管家做不到的事(它只能回答,不能改檔或派工)。只輸出 JSON 陣列,例如 [\"…\",\"…\",\"…\"],不要其他文字。";
	const makeSuggestions = async (p: Project) => {
		if (suggesting.has(p.id)) return getSuggestions(p.id);
		suggesting.add(p.id);
		try {
			const st = (p.state ?? {}) as { goal?: string; progress?: string; nextSteps?: string[]; blockers?: string[] };
			const recent = recentChat(p.id, 6).map((e) => `${e.role === "me" ? "使用者" : "管家"}:${e.text.slice(0, 400)}`).join("\n");
			const ask = () => steward.oneShot(SUGGEST_SYS, `專案:${p.name}\n目標:${st.goal || "(未記錄)"}\n進度:${st.progress || "(未記錄)"}\n下一步:${(st.nextSteps ?? []).join(";") || "(無)"}\n卡住:${(st.blockers ?? []).join(";") || "(無)"}\n\n最近問答:\n${recent || "(還沒有)"}`, "suggest");
			// 有些模型偶爾混簡體字:看到常見簡體字就重問一次
			const SIMPLIFIED = /[这们为么备条认续时间会没还进开关应该从说过对现发问题项单证据读写样钟头无产业东车门见长难风险]/;
			let out = await ask();
			if (SIMPLIFIED.test(out)) out = await ask();
			let items: string[] = [];
			try { items = JSON.parse(out.match(/\[[\s\S]*\]/)?.[0] ?? "[]"); } catch { items = out.split("\n"); }
			items = [...new Set(items.filter((x) => typeof x === "string").map((x) => x.replace(/^\s*(\d+[.、)]|[-*•])\s*/, "").replace(/^["「]|["」]$/g, "").trim()).filter((x) => x && x.length <= 80))].slice(0, 3);
			return items.length ? putSuggestions(p.id, items) : getSuggestions(p.id);
		} finally {
			suggesting.delete(p.id);
		}
	};

	/** 檢查接口清單:id 不重複、格式正確;內建服務的 id 要等於服務名稱 */
	const checkProviders = (list: ProviderConfig[]): string | null => {
		const seen = new Set<string>();
		for (const p of list) {
			if (!p.id || !/^[a-z0-9][a-z0-9_-]{0,30}$/.test(p.id)) return `接口代號「${p.id}」只能用小寫英文、數字、- 和 _`;
			if (seen.has(p.id)) return `接口代號「${p.id}」重複了`;
			seen.add(p.id);
			if (p.type === "builtin") {
				if (!p.builtin || !(BUILTINS as readonly string[]).includes(p.builtin)) return `「${p.name}」不是支援的服務`;
				if (p.id !== p.builtin) return `「${p.name}」的代號必須是 ${p.builtin}`;
			} else if (p.type === "openai-compatible") {
				if (!/^https?:\/\//.test(p.baseUrl ?? "")) return `「${p.name}」的網址要以 http:// 或 https:// 開頭`;
			} else if (p.type === "agent-cli") {
				if (!isCliKind(p.cli)) return `「${p.name}」不是支援的 agent CLI`;
			} else if (p.type !== "pi-models") return `不支援的接口類型 ${p.type}`;
		}
		return null;
	};

	const codeRoute = async (p: Project, sub: string, req: IncomingMessage, res: ServerResponse, url: URL) => {
		const q = (k: string) => url.searchParams.get(k) ?? "";
		try {
			if (req.method === "GET" && sub === "find") return send(res, 200, { files: findFiles(p, q("q")) });
			if (req.method === "GET" && sub === "tree") return send(res, 200, { entries: await listDir(p, q("dir"), q("hidden") === "1"), repo: await isRepo(p) });
			if (req.method === "GET" && sub === "file") return send(res, 200, readFile(p, q("path"), { more: Number(q("more")) || 0 }));
			if (req.method === "GET" && sub === "raw") {
				const { buf, type } = rawFile(p, q("path"));
				// SVG 可能夾帶指令碼:沙箱化;PDF 不能加 sandbox(瀏覽器的 PDF 檢視器會被擋)
				res.writeHead(200, { "content-type": type, "cache-control": "no-store", ...(type === "image/svg+xml" ? { "content-security-policy": "sandbox" } : {}) });
				return res.end(buf);
			}
			if (req.method === "PUT" && sub === "file") {
				const b = await body(req);
				return send(res, 200, writeFile(p, String(b.path ?? ""), String(b.content ?? ""), b.baseHash, !!b.force));
			}
			if (req.method === "POST" && sub === "fs") {
				const b = await body(req);
				return send(res, 200, await fsOp(p, String(b.op ?? ""), String(b.path ?? ""), b.to ? String(b.to) : undefined));
			}
			if (req.method === "POST" && sub === "stamps") {
				const b = await body(req);
				return send(res, 200, fileStamps(p, Array.isArray(b.paths) ? b.paths.map(String) : []));
			}
			// 上傳:請求本文就是檔案內容(串流寫入,不經 JSON)
			if (req.method === "PUT" && sub === "upload") return send(res, 200, await uploadFile(p, q("path"), req, q("overwrite") === "1", Number(req.headers["content-length"]) || 0));
			// ---------- Notebook 執行(Jupyter kernel) ----------
			if (sub.startsWith("nb/")) {
				const op = sub.slice(3);
				if (req.method === "GET" && op === "events") return subscribeKernel(p, q("path"), res);
				if (req.method === "GET" && op === "pythons") return send(res, 200, { envs: await pythonEnvs(p, q("path")), kernel: kernelInfo(p, q("path")) });
				if (req.method === "POST") {
					const b = await body(req);
					const rel = String(b.path ?? "");
					if (!/\.ipynb$/i.test(rel)) return send(res, 400, { error: "只能執行 .ipynb" });
					// 只能用偵測到的 Python(不接受任意執行檔路徑)
					const pick = async () => (await pythonEnvs(p, rel)).find((e) => e.python === String(b.python ?? ""));
					if (op === "install") {
						const env = await pick();
						if (!env) return send(res, 400, { error: "找不到這個 Python 環境" });
						try { return send(res, 200, { python: await installKernel(env.python, !!env.own) }); }
						catch (e) { return send(res, 500, { error: `安裝失敗:${(e as Error).message}` }); }
					}
					if (op === "start") {
						const env = await pick();
						if (!env) return send(res, 400, { error: "找不到這個 Python 環境" });
						if (!env.ready) return send(res, 400, { error: "這個 Python 環境還沒有 ipykernel" });
						return send(res, 200, startKernel(p, rel, env.python));
					}
					if (op === "exec") return sendKernel(p, rel, { op: "execute", id: String(b.id ?? ""), code: String(b.code ?? "") }) ? send(res, 200, { ok: true }) : send(res, 409, { error: "kernel 沒有在跑" });
					if (op === "interrupt" || op === "restart") return sendKernel(p, rel, { op }) ? send(res, 200, { ok: true }) : send(res, 409, { error: "kernel 沒有在跑" });
					if (op === "stop") { stopKernelFor(p, rel); return send(res, 200, { ok: true }); }
				}
				return send(res, 404, { error: "not found" });
			}
			if (req.method === "GET" && sub === "session") return send(res, 200, getSession(p.id) ?? {});
			if (req.method === "PUT" && sub === "session") {
				const b = await body(req);
				return send(res, 200, putSession(p.id, b.layout));
			}
			if (req.method === "GET" && sub === "git/status") return send(res, 200, await gitStatus(p));
			if (req.method === "GET" && sub === "git/diff") return send(res, 200, await diffSides(p, q("path"), (q("which") || "unstaged") as never, q("commit") || undefined));
			if (req.method === "POST" && sub === "git/commitmsg") {
				const diff = String(await gitAction(p, "diffText", {}));
				if (!diff.trim()) return send(res, 400, { error: "沒有變更" });
				const msg = await steward.oneShot(
					"你是 git 提交訊息產生器。根據 diff 寫一則提交訊息:第一行 50 字以內的摘要,必要時空一行後用條列補充重點。只輸出提交訊息本身,不要加說明、不要用 markdown 程式碼框。語言跟著專案既有的提交習慣;看不出來就用繁體中文。",
					`專案:${p.name}\n最近的提交:\n${((await gitAction(p, "log", {})) as { subject: string }[]).slice(0, 8).map((c) => `- ${c.subject}`).join("\n")}\n\n變更:\n${diff}`,
				);
				return send(res, 200, { message: msg.replace(/^```\w*\n?|```$/g, "").trim() });
			}
			const ga = sub.match(/^git\/(\w+)$/);
			if (req.method === "POST" && ga) {
				const b = await body(req);
				const out = await gitAction(p, ga[1], b);
				if (ga[1] === "commit") {
					// 提交後讓管家記一筆(用本地模型整理,不等它)
					const headHash = ((await gitAction(p, "log", {})) as { hash: string }[])[0]?.hash ?? "";
					const head = (await gitAction(p, "show", { commit: headHash })) as { hash: string; body?: string; files: { code: string; path: string }[] };
					void steward
						.send(p, `【回報】agent=使用者(網頁) 來源=git 提交\n提交 ${head.hash.slice(0, 7)}:${head.body ?? ""}\n改了 ${head.files.length} 個檔案:\n${head.files.slice(0, 40).map((f) => `${f.code} ${f.path}`).join("\n")}`, { role: "digest" })
						.catch(() => undefined);
				}
				return send(res, 200, { ok: true, out });
			}
			return send(res, 404, { error: "not found" });
		} catch (e) {
			const err = e as CodeError & { disk?: unknown; exists?: boolean };
			if (err instanceof CodeError) return send(res, err.status, { error: err.message, ...(err.disk ? { disk: err.disk } : {}), ...(err.exists ? { exists: true } : {}) });
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return send(res, 404, { error: "檔案不存在" });
			throw e;
		}
	};

	const handler = async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://x");
		const path = url.pathname;
		try {
			// ---------- 登入 ----------
			if (path.startsWith("/api/auth/")) {
				if (req.method === "GET" && path === "/api/auth/status") {
					const a = await authorize(req);
					return send(res, 200, { authed: a.ok, how: a.ok ? a.how : undefined, user: a.ok ? a.user : undefined, hasPassword: hasPassword(), local: isPureLocal(req), reason: a.ok ? undefined : a.reason });
				}
				if (req.method === "POST" && path === "/api/auth/login") {
					const r = login(req, String((await body(req)).password ?? ""));
					if (!r.ok) return send(res, r.status, { error: r.error });
					res.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": r.cookie, "cache-control": "no-store" });
					return res.end(JSON.stringify({ ok: true }));
				}
				if (req.method === "POST" && path === "/api/auth/logout") {
					res.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": logout(req), "cache-control": "no-store" });
					return res.end(JSON.stringify({ ok: true }));
				}
				if (req.method === "POST" && path === "/api/auth/password") {
					const a = await authorize(req);
					if (!a.ok) return send(res, a.status, { error: a.reason });
					const b = await body(req);
					const r = setPassword(String(b.current ?? ""), String(b.next ?? ""));
					if (!r.ok) return send(res, 400, { error: r.error });
					// 改完密碼:這個瀏覽器直接登入
					const l = login(req, String(b.next));
					res.writeHead(200, { "content-type": "application/json; charset=utf-8", ...(l.ok ? { "set-cookie": l.cookie } : {}), "cache-control": "no-store" });
					return res.end(JSON.stringify({ ok: true }));
				}
				return send(res, 404, { error: "not found" });
			}
			// 所有 /api 都要登入;例外:健康檢查、網頁回報錯誤、本機 agent 整合(開工簡報、提問、回報)
			const OPEN = new Set(["/api/health", "/api/clientlog"]);
			const LOCAL_INTEGRATION = new Set(["/api/brief", "/api/ask", "/api/report"]);
			if (path.startsWith("/api/") && !OPEN.has(path) && !(LOCAL_INTEGRATION.has(path) && isPureLocal(req))) {
				const a = await authorize(req);
				if (!a.ok) return send(res, a.status, { error: a.reason, login: a.login });
			}
			// ---------- 程式碼模式(檔案 + git):會讀寫專案,套用和終端機一樣的身分檢查 ----------
			const mc = path.match(/^\/api\/code\/([^/]+)\/(.+)$/);
			if (mc) {
				const auth = await authorizeTerminal(req);
				if (!auth.ok) {
					const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
					res.writeHead(auth.status, headers);
					res.end(JSON.stringify({ error: auth.reason }));
					return;
				}
				const p = store.project(mc[1]);
				if (!p || p.kind !== "project") return send(res, 404, { error: "找不到專案" });
				return await codeRoute(p, mc[2], req, res, url);
			}
			// ---------- 設定頁:讀寫設定(要登入,和終端機同一套身分檢查) ----------
			if (path === "/api/settings" || path.startsWith("/api/settings/")) {
				const auth = await authorizeTerminal(req);
				if (!auth.ok) {
					const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
					res.writeHead(auth.status, headers);
					res.end(JSON.stringify({ error: auth.reason }));
					return;
				}
				if (req.method === "GET" && path === "/api/settings") {
					const lanIps = Object.values(networkInterfaces()).flat().filter((n) => n && n.family === "IPv4" && !n.internal && !n.address.startsWith("100.")).map((n) => n!.address);
					return send(res, 200, { settings: publicSettings(), platform: process.platform, detected: { tailscale: !!findTailscale(), piPrivacy: existsSync(join(HOME, ".pi", "agent", "privacy-paths.json")), hermes: !!hermesSecret(settings().notify.hermes.route), lanIps, port: PORT } });
				}
				if (req.method === "PUT" && path === "/api/settings") {
					const before = settings();
					const prevServer = JSON.stringify({ port: before.server.port, terminalPort: before.server.terminalPort, hosts: before.server.hosts, lan: before.access.lan.enabled });
					const incoming = stripMasked((await body(req)).settings ?? {});
					// agent CLI 不能呼叫管家的工具:整理回報、提案檢查不能用;它也不是本地模型,隱私專案不能用
					{
						const provs: ProviderConfig[] = Array.isArray(incoming.providers) ? incoming.providers : before.providers;
						const cliIds = new Set(provs.filter((p) => p.type === "agent-cli").map((p) => p.id));
						const isCli = (ref?: string) => !!ref && cliIds.has(ref.split("/")[0]);
						const r = incoming.routing ?? {};
						for (const [role, label] of [["digest", "整理 agent 回報"], ["judge", "提案檢查"]] as const) {
							if (isCli(r[role]?.primary) || isCli(r[role]?.fallback)) return send(res, 400, { error: `「${label}」需要呼叫管家的工具,不能用電腦上的 agent CLI` });
						}
						if (isCli(r.privacy)) return send(res, 400, { error: "「隱私專案」只能用本地模型,不能用 agent CLI" });
					}
					if (incoming.access) delete incoming.access.passwordHash; // 密碼只能用 /api/auth/password 改
					// 接口清單整份取代(刪除才會生效);被遮罩的金鑰沿用原本的
					if (Array.isArray(incoming.providers)) {
						const err = checkProviders(incoming.providers);
						if (err) return send(res, 400, { error: err });
						incoming.providers = incoming.providers.map((p: ProviderConfig) => ({ ...p, apiKey: p.apiKey ?? before.providers.find((o) => o.id === p.id)?.apiKey }));
						updateSettings({ providers: [] }); // 先清空,避免合併時留下已刪除的
					}
					// OpenAI 相容接口還沒有模型清單:先抓一次(抓不到就算了,「測試連線」會說原因)
					for (const p of (incoming.providers ?? []) as ProviderConfig[]) {
						if (p.type === "openai-compatible" && p.baseUrl && !p.models?.length) p.models = await fetchCompatModels(p).catch(() => []);
					}
					let next = updateSettings(incoming);
					await syncProviders();
					if (fillEmptyRouting()) next = settings();
					steward.resetModels();
					const restart = JSON.stringify({ port: next.server.port, terminalPort: next.server.terminalPort, hosts: next.server.hosts, lan: next.access.lan.enabled }) !== prevServer;
					return send(res, 200, { settings: publicSettings(next), restartNeeded: restart });
				}
				// 訂閱登入(ChatGPT / Claude):在伺服器跑登入流程,網頁輪詢進度
				if (req.method === "POST" && path === "/api/settings/login") {
					const id = String((await body(req)).provider ?? "");
					const label = (LOGIN_PROVIDERS as Record<string, string>)[id];
					if (!label) return send(res, 400, { error: "這個服務不支援訂閱登入" });
					// 先把接口切成「在專案管家登入」;登入失敗或取消就還原
					const before = settings().providers;
					const prev = before.find((p) => p.id === id);
					const next = prev
						? before.map((p) => (p.id === id ? { ...p, auth: "login" as const, name: label } : p))
						: [...before, { id, type: "builtin" as const, builtin: id as ProviderConfig["builtin"], auth: "login" as const, name: label }];
					updateSettings({ providers: [] });
					updateSettings({ providers: next });
					await syncProviders();
					const s = startLogin(id, async (ok) => {
						if (ok) { fillEmptyRouting(); steward.resetModels(); return; }
						if (stewardAuth.has(id)) return; // 之前登入過的保留
						updateSettings({ providers: [] });
						updateSettings({ providers: before });
						await syncProviders();
					});
					return send(res, 200, { session: s.id });
				}
				const ml = path.match(/^\/api\/settings\/login\/([0-9a-f]{24})(\/code|\/cancel)?$/);
				if (ml) {
					if (req.method === "GET" && !ml[2]) { const st = loginStatus(ml[1]); return st ? send(res, 200, st) : send(res, 404, { error: "登入流程已經結束,請重新開始" }); }
					if (req.method === "POST" && ml[2] === "/code") return submitCode(ml[1], String((await body(req)).code ?? "")) ? send(res, 200, { ok: true }) : send(res, 409, { error: "現在不需要貼網址" });
					if (req.method === "POST" && ml[2] === "/cancel") { cancelLogin(ml[1]); return send(res, 200, { ok: true }); }
				}
				if (req.method === "POST" && path === "/api/settings/logout-provider") {
					const id = String((await body(req)).provider ?? "");
					await stewardAuth.delete(id);
					steward.resetModels();
					return send(res, 200, { ok: true });
				}
				// 更新:檢查 GitHub 最新版、一鍵更新、看進度
				if (req.method === "GET" && path === "/api/settings/update") return send(res, 200, await checkUpdate(url.searchParams.has("force")));
				if (req.method === "GET" && path === "/api/settings/update/log") return send(res, 200, { log: updateLog() });
				if (req.method === "POST" && path === "/api/settings/update") {
					const info = await checkUpdate(true);
					if (!info.hasUpdate || !info.latest) return send(res, 400, { error: info.error ?? (info.dev ? "開發版不能自動更新" : "已經是最新版") });
					try { await applyUpdate(info.latest); } catch (e) { return send(res, 400, { error: (e as Error).message }); }
					return send(res, 200, { ok: true, tag: info.latest });
				}
				// Agent:偵測與接上 / 拿掉專案管家
				if (req.method === "GET" && path === "/api/settings/agents") return send(res, 200, { agents: listAgents() });
				const ma = path.match(/^\/api\/settings\/agents\/([a-z0-9-]+)$/);
				if (req.method === "POST" && ma) {
					try {
						const r = setAgent(ma[1], !!(await body(req)).enable);
						return send(res, 200, r);
					} catch (e) {
						return send(res, 400, { error: String((e as Error).message ?? e) });
					}
				}
				// 路由下拉選單用:每個接口有哪些模型
				if (req.method === "GET" && path === "/api/settings/models") {
					return send(res, 200, {
						providers: settings().providers.map((c) => ({ id: c.id, name: c.name, type: c.type, local: !!c.local || (c.type !== "builtin" && c.type !== "agent-cli"), models: modelIds(c), signedIn: signedIn(c), cli: c.type === "agent-cli" ? c.cli : undefined })),
						loginProviders: LOGIN_PROVIDERS,
						cliProviders: detectCliProviders(),
						cliNotes: Object.fromEntries(Object.entries(CLI_KINDS).map(([k, v]) => [k, v.note ?? ""])),
						piProviders: detectPiProviders(),
						builtins: BUILTINS,
					});
				}
				// 測試連線:列出模型(OpenAI 相容的會即時抓 /models),再對一個模型問一句
				if (req.method === "POST" && path === "/api/settings/test-provider") {
					const b = await body(req);
					const c = settings().providers.find((x) => x.id === b.id);
					if (!c) return send(res, 404, { error: "找不到這個接口(先儲存)" });
					let list = modelIds(c);
					if (c.type === "openai-compatible" && c.baseUrl) {
						try {
							const ids = await fetchCompatModels(c);
							if (ids.length) {
								updateSettings({ providers: settings().providers.map((x) => (x.id === c.id ? { ...x, models: ids } : x)) });
								await syncProviders();
								list = ids;
							}
						} catch (e) {
							return send(res, 200, { ok: false, error: (e as Error).message });
						}
					}
					const model = b.model && list.includes(b.model) ? b.model : (testModelFor(c) ?? list[0]);
					if (!model) return send(res, 200, { ok: false, models: list, error: "這個接口沒有可用的模型" });
					const t0 = Date.now();
					try {
						const reply = await Promise.race([
							steward.oneShotWith("你是連線測試。只回覆「OK」。", "ping", { provider: c.id, modelId: model }, 200),
							new Promise<string>((_, no) => setTimeout(() => no(new Error("60 秒沒有回應")), 60_000)),
						]);
						return send(res, 200, { ok: true, models: list, model, latencyMs: Date.now() - t0, reply: reply.slice(0, 80) });
					} catch (e) {
						return send(res, 200, { ok: false, models: list, model, error: String((e as Error).message ?? e).slice(0, 300) });
					}
				}
				// Tailscale 遠端存取:開啟時自動設定 https 網址(tailscale serve),關閉時移除
				if (req.method === "POST" && path === "/api/settings/tailscale") {
					const bin = findTailscale();
					if (!bin) return send(res, 400, { error: "這台電腦沒有 Tailscale" });
					const { enable } = await body(req);
					const run = (args: string[]) => execFileSync(bin, args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
					try {
						const st = JSON.parse(run(["status", "--json"]));
						const dns = String(st.Self?.DNSName ?? "").replace(/\.$/, "");
						let serve: any = {};
						try { serve = JSON.parse(run(["serve", "status", "--json"])); } catch { /* 還沒設定 */ }
						const web = Object.entries<any>(serve?.Web ?? {});
						const mine = web.find(([, w]) => JSON.stringify(w?.Handlers ?? {}).includes(`127.0.0.1:${PORT}`));
						if (enable) {
							let port = mine?.[0].split(":").pop();
							if (!port) {
								const used = new Set(web.map(([hp]) => hp.split(":").pop()));
								port = ["443", "8443", "8793", "9443"].find((p) => !used.has(p)) ?? "10443";
								run(["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${PORT}`]);
							}
							const url = `https://${dns}${port === "443" ? "" : `:${port}`}/`;
							const login = String(st.User?.[String(st.Self?.UserID)]?.LoginName ?? "").toLowerCase();
							const users = settings().access.tailscaleUsers;
							updateSettings({ server: { publicUrl: url }, access: { tailscale: { enabled: true }, tailscaleUsers: users.length ? users : login ? [login] : [] } });
							return send(res, 200, { ok: true, url, settings: publicSettings() });
						}
						if (mine) run(["serve", `--https=${mine[0].split(":").pop()}`, "off"]);
						updateSettings({ access: { tailscale: { enabled: false } }, server: { publicUrl: "" } });
						return send(res, 200, { ok: true, settings: publicSettings() });
					} catch (e) {
						return send(res, 500, { error: `Tailscale 設定失敗:${String((e as { stderr?: string }).stderr || (e as Error).message).slice(0, 300)}` });
					}
				}
				if (req.method === "POST" && path === "/api/settings/test-notify") {
					const ok = await notify(`🔔 專案管家測試推播\n設定成功,之後的提案和卡住提醒會從這裡送來。\n${publicUrl()}`);
					return send(res, ok ? 200 : 400, ok ? { ok: true } : { error: "推播沒有送出去:檢查設定(Hermes 路由、Telegram token / chat ID、webhook 網址)" });
				}
			}
			// ---------- 網頁 ----------
			if (req.method === "GET" && (path === "/" || path === "/index.html")) {
				// 從 http 打開時要轉去的 https 網址(設定檔裡的對外網址)
				return send(res, 200, readFileSync(join(WEB_DIR, "index.html"), "utf8").replace("__STEWARD_PUBLIC_URL__", JSON.stringify(publicUrl()).slice(1, -1)), "text/html; charset=utf-8");
			}
			if (req.method === "GET" && path.startsWith("/web/")) {
				const f = join(WEB_DIR, path.slice(5).replace(/\.\./g, ""));
				if (!existsSync(f)) return send(res, 404, { error: "not found" });
				const type = f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : "application/octet-stream";
				return send(res, 200, readFileSync(f), type);
			}
			if (path === "/api/events") {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
				res.write(": hi\n\n");
				clients.add(res);
				const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
				req.on("close", () => {
					clearInterval(ping);
					clients.delete(res);
				});
				return;
			}

			// ---------- 給 agent 用 ----------
			if (req.method === "GET" && path === "/api/brief") {
				const p = projectFrom(url.searchParams) ?? ensureSpecial(store, MISC_ROOT);
				const text = brief(store, p);
				return url.searchParams.get("format") === "json" ? send(res, 200, { project: p, text }) : send(res, 200, text, "text/plain; charset=utf-8");
			}
			if (req.method === "POST" && path === "/api/ask") {
				const b = await body(req);
				const p = projectFrom(b) ?? ensureSpecial(store, OVERVIEW_ROOT);
				const who = b.agent ? `(提問者:${b.agent})` : "";
				const answer = await steward.send(p, `【提問】${who}${b.question}`);
				return send(res, 200, { project: p.name, answer });
			}
			if (req.method === "POST" && path === "/api/report") {
				const b = await body(req);
				const p = projectFrom(b) ?? ensureSpecial(store, MISC_ROOT);
				const answer = await steward.send(p, `【回報】agent=${b.agent ?? "?"} 來源=主動回報\n\n${b.text}`, { role: "digest" });
				return send(res, 200, { project: p.name, answer });
			}

			// ---------- 看板 ----------
			if (req.method === "GET" && path === "/api/board") {
				// 每個專案附上 space 綁定資訊(名稱、是否不同名、有幾個窗格跑到別的 space)
				const spaces = listWorkspaces();
				const panes = listPanes() ?? [];
				const spaceInfo: Record<string, { label?: string; nameDiffers: boolean; strays: number }> = {};
				for (const p of store.projects()) {
					if (p.kind !== "project" || p.status !== "active") continue;
					const w = boundSpace(store, p, spaces);
					spaceInfo[p.id] = { label: w?.label, nameDiffers: !!w && (w.label ?? "").trim() !== p.name.trim(), strays: w ? strayPanes(store, p, panes).length : 0 };
				}
				return send(res, 200, { projects: store.projects(), cards: store.cards(), spaceInfo, watcher: watcher.status() });
			}
			// ---------- 建立專案 / space ----------
			if (req.method === "GET" && path === "/api/fs") {
				const root = expandHome(settings().paths.createRoot || "~");
				const start = existsSync(root) ? root : HOME;
				const dir = resolvePath((url.searchParams.get("path") || start).replace(/^~(?=\/|$)/, HOME));
				if (!pathInside(dir, HOME)) return send(res, 400, { error: "只能瀏覽家目錄底下的資料夾" });
				let entries: { name: string; path: string; project?: string; git: boolean }[] = [];
				try {
					entries = readdirSync(dir, { withFileTypes: true })
						.filter((d) => d.isDirectory() && !d.name.startsWith(".") && !["node_modules", "__pycache__", "Library"].includes(d.name))
						.map((d) => {
							const full = join(dir, d.name);
							const p = store.projectByRoot(full);
							return { name: d.name, path: full, project: p?.status === "active" ? p.name : undefined, git: existsSync(join(full, ".git")) };
						})
						.sort((a, b) => a.name.localeCompare(b.name));
				} catch (e) {
					return send(res, 400, { error: `讀不到這個資料夾:${String(e).slice(0, 120)}` });
				}
				const here = store.projectByRoot(dir);
				return send(res, 200, { path: dir, parent: dir === HOME ? null : dirname(dir), home: HOME, project: here?.status === "active" ? { id: here.id, name: here.name } : null, dirs: entries });
			}
			if (req.method === "POST" && path === "/api/projects/create") {
				const b = await body(req);
				const result = createProject(store, steward, watcher, b);
				return send(res, result.status, result.body);
			}
			if (req.method === "GET" && path === "/api/spaces/plan") return send(res, 200, { rows: tidyPlan(store) });
			if (req.method === "POST" && path === "/api/spaces/tidy") {
				// 只接受使用者勾選的專案;內容一律用剛重算的計畫,不信任前端傳來的搬移清單
				const { accept } = await body(req);
				const fresh = tidyPlan(store).filter((r) => Array.isArray(accept) && accept.includes(r.projectId));
				const log = await runTidy(store, fresh);
				return send(res, 200, { log });
			}
			if (req.method === "POST" && path === "/api/chat") {
				const b = await body(req);
				const p = store.project(b.project);
				if (!p) return send(res, 404, { error: "unknown project" });
				// 「改用備用模型回答這一題」(舊版網頁送 cloud)
				const useFallback = b.fallback === true || b.cloud === true;
				if (useFallback && p.private) return send(res, 400, { error: "隱私專案只用指定的模型,沒有備用" });
				const message = String(b.message ?? "").trim();
				const q = b.quote && typeof b.quote.text === "string" ? (b.quote as ChatQuote) : undefined;
				const quote = q ? { path: q.path ? String(q.path) : undefined, from: Number(q.from) || undefined, to: Number(q.to) || undefined, text: q.text.slice(0, 20000) } : undefined;
				// 浮動球加進來的檔案:網頁有給內容(編輯器裡還沒存的版本)就用它,否則讀磁碟
				const fileReqs: { path: string; content?: string }[] = (Array.isArray(b.files) ? b.files : []).slice(0, 10).filter((f: { path?: unknown }) => typeof f?.path === "string" && f.path);
				if (!message && !quote && !fileReqs.length) return send(res, 400, { error: "請輸入問題" });
				// 先記下問題(回答還沒回來時重新整理也看得到);「改用雲端重問」不重複記問題
				const mine = b.retry ? null : appendChat(p.id, { role: "me", text: message, quote, ...(fileReqs.length ? { files: fileReqs.map((f) => f.path) } : {}) });
				let snippet = quote ? `\n\n檔案 ${quote.path ?? ""}${quote.from ? ` 第 ${quote.from}${quote.to && quote.to !== quote.from ? `–${quote.to}` : ""} 行` : ""}:\n\`\`\`\n${quote.text}\n\`\`\`` : "";
				let budget = 300_000;
				for (const f of fileReqs) {
					let item: { path: string; text?: string; note?: string };
					try { item = fileForChat(p, f.path, typeof f.content === "string" ? f.content : undefined); }
					catch (e) { item = { path: f.path, note: (e as Error).message || "讀不到" }; }
					if (item.text && item.text.length > budget) item = { path: item.path, note: "這次帶的檔案太多,這個檔案沒有附上內容" };
					if (item.text) budget -= item.text.length;
					snippet += item.text ? `\n\n使用者附上的檔案 ${item.path}:\n\`\`\`\n${item.text}\n\`\`\`` : `\n\n(使用者附上的檔案 ${item.path}:${item.note})`;
				}
				try {
					// 聊天室用路由「聊天室」的主要模型(純問答,不能開卡);使用者按「改用備用模型」才用備用
					const answer = await steward.send(p, `【提問】(使用者)${message}${snippet}`, { role: "chat", fallback: useFallback, timeoutMs: 180_000 });
					const bot = appendChat(p.id, { role: "bot", text: answer, ...(useFallback ? { alt: modelLabel(routeFor("chat", { fallback: true })) } : {}) });
					void makeSuggestions(p).catch(() => undefined); // 回答完換一組建議問題(背景)
					return send(res, 200, { answer, me: mine, bot });
				} catch (e) {
					const why = String((e as Error).message ?? e).replace(/^管家沒有回答:/, "");
					let who = "模型";
					try { who = `「${modelLabel(routeFor("chat", { private: p.private, fallback: useFallback }))}」`; } catch { /* 沒設定路由 */ }
					const bot = appendChat(p.id, { role: "bot", text: `${who}沒有回應:${why}`, error: true, retryable: !useFallback && !p.private && hasFallback("chat") });
					return send(res, 200, { error: bot.text, me: mine, bot });
				}
			}
			// 建議問題:GET 讀(ensure=1 且還沒有就先產生)、POST 重新產生
			const msug = path.match(/^\/api\/chat\/([^/]+)\/suggest$/);
			if (msug && (req.method === "GET" || req.method === "POST")) {
				const p = store.project(decodeURIComponent(msug[1]));
				if (!p) return send(res, 404, { error: "unknown project" });
				let v = getSuggestions(p.id);
				if (req.method === "POST" || (!v && url.searchParams.get("ensure") === "1")) v = (await makeSuggestions(p).catch(() => null)) ?? v;
				return send(res, 200, { items: v?.items ?? [], at: v?.at ?? null, pending: suggesting.has(p.id) });
			}
			// 對話紀錄:分段讀(往上捲載入更早的)、清除
			const mchat = path.match(/^\/api\/chat\/([^/]+)$/);
			if (mchat && (req.method === "GET" || req.method === "DELETE")) {
				const p = store.project(decodeURIComponent(mchat[1]));
				if (!p) return send(res, 404, { error: "unknown project" });
				if (req.method === "DELETE") { clearChat(p.id); return send(res, 200, { ok: true }); }
				return send(res, 200, readChat(p.id, url.searchParams.get("before") || undefined, Number(url.searchParams.get("limit")) || 30));
			}
			// 登記一個資料夾成獨立專案(拆分用:子資料夾會優先於它所在的 git 根目錄)
			if (req.method === "POST" && path === "/api/projects") {
				const b = await body(req);
				const root = typeof b.root === "string" ? resolvePath(b.root.trim().replace(/^~(?=\/|$)/, HOME)).replace(/\/$/, "") : "";
				if (!root || !existsSync(root) || !statSync(root).isDirectory()) return send(res, 400, { error: "資料夾不存在" });
				if (MISC_ROOTS.includes(root)) return send(res, 400, { error: "家目錄、桌面、下載這類資料夾不能當專案" });
				const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : basename(root);
				const existing = store.projectByRoot(root);
				const project = existing
					? store.updateProject(existing.id, { status: "active", kind: "project", name })
					: store.addProject({ root, name, kind: "project", status: "active", private: isPrivatePath(root) });
				// 新專案還沒有紀錄:背景從上層專案與開著的 agent 補建
				if (!project.state.updatedAt) watcher.bootstrap(project.id).catch((e) => console.error("[bootstrap]", project.name, e));
				return send(res, 200, project);
			}
			let ms = path.match(/^\/api\/projects\/([^/]+)\/strays$/);
			if (req.method === "POST" && ms) {
				// 把跑到別的 space 的窗格搬回綁定的 space
				const p = store.project(ms[1]);
				if (!p) return send(res, 404, { error: "unknown project" });
				const w = boundSpace(store, p);
				if (!w) return send(res, 409, { error: "這個專案還沒有綁定 space" });
				const moved: string[] = [];
				for (const pane of strayPanes(store, p)) moved.push(await movePane(store, pane, w.workspace_id));
				return send(res, 200, { moved: moved.length, space: w.label });
			}
			ms = path.match(/^\/api\/projects\/([^/]+)\/space-name$/);
			if (req.method === "POST" && ms) {
				// space 名稱和專案不同時:use=space 用 space 的名字改專案;use=project 把 space 改回專案名
				const p = store.project(ms[1]);
				const w = p ? boundSpace(store, p) : undefined;
				if (!p || !w) return send(res, 404, { error: "沒有綁定的 space" });
				const { use } = await body(req);
				if (use === "space" && w.label) store.updateProject(p.id, { name: w.label });
				else herdrCli(["workspace", "rename", w.workspace_id, p.name]);
				store.updateProject(p.id, { spaceLabel: use === "space" ? w.label : p.name });
				return send(res, 200, store.project(p.id));
			}
			let mb = path.match(/^\/api\/projects\/([^/]+)\/bootstrap$/);
			if (req.method === "POST" && mb) {
				const answer = await watcher.bootstrap(mb[1]);
				return send(res, 200, { answer });
			}
			let m = path.match(/^\/api\/projects\/([^/]+)\/subdirs$/);
			if (req.method === "GET" && m) {
				const p = store.project(m[1]);
				if (!p || p.kind !== "project") return send(res, 404, { error: "unknown project" });
				const dirs = readdirSync(p.root, { withFileTypes: true })
					.filter((d) => d.isDirectory() && !d.name.startsWith(".") && !["node_modules", "__pycache__", "venv", ".venv", "dist", "build"].includes(d.name))
					.map((d) => {
						const full = join(p.root, d.name);
						return { name: d.name, root: full, project: store.projectByRoot(full)?.status === "active" };
					})
					.sort((a, b) => a.name.localeCompare(b.name));
				return send(res, 200, { dirs });
			}
			m = path.match(/^\/api\/projects\/([^/]+)$/);
			if (req.method === "POST" && m) {
				const p = store.project(m[1]);
				if (!p) return send(res, 404, { error: "unknown project" });
				const b = await body(req);
				const patch: Partial<Project> = {};
				if (b.status === "active" || b.status === "ignored") patch.status = b.status;
				if (typeof b.private === "boolean") patch.private = b.private;
				if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim();
				// 停止追蹤:只解除綁定,space 和窗格都不動
				if (patch.status === "ignored") Object.assign(patch, { spaceId: undefined, spaceLabel: undefined });
				const updated = store.updateProject(p.id, patch);
				if (typeof b.goal === "string") store.updateState(p.id, { goal: b.goal });
				if ("private" in patch && updated.conversationId) await steward.syncModel(updated);
				// 改專案名稱時,綁定的 space 跟著改(除非是從 space 同步過來的)
				if (patch.name && !b.fromSpace) {
					const w = boundSpace(store, updated);
					if (w && w.label !== patch.name) {
						herdrCli(["workspace", "rename", w.workspace_id, patch.name]);
						store.updateProject(p.id, { spaceLabel: patch.name });
					}
				}
				return send(res, 200, store.project(p.id));
			}
			// 使用者自己建的工作卡(例如在編輯器選一段程式碼「建立工作卡」):一律進「提案」,等核准
			if (req.method === "POST" && path === "/api/cards") {
				const b = await body(req);
				const p = store.project(String(b.projectId ?? ""));
				if (!p || p.kind !== "project") return send(res, 404, { error: "找不到專案" });
				const title = String(b.title ?? "").trim();
				if (!title) return send(res, 400, { error: "請填標題" });
				return send(res, 200, store.addCard({ projectId: p.id, title, agent: String(b.agent ?? "pi"), instructions: String(b.instructions ?? ""), doneCriteria: String(b.doneCriteria ?? "完成上述要求並說明改了什麼") }));
			}
			// 資訊卡「在終端機看這個窗格」:用 terminalId 找(窗格搬過 space 也找得到)
			m = path.match(/^\/api\/cards\/([^/]+)\/focus$/);
			if (req.method === "POST" && m) {
				const card = store.card(m[1]);
				if (!card) return send(res, 404, { error: "unknown card" });
				const panes = listPanes() ?? [];
				const pane = panes.find((x) => card.terminalId && x.terminal_id === card.terminalId) ?? panes.find((x) => x.pane_id === card.paneId);
				if (!pane) return send(res, 404, { error: "這張卡的窗格已經不在了" });
				const r = pane.agent ? herdrCli(["agent", "focus", pane.pane_id]) : herdrCli(["tab", "focus", pane.tab_id]);
				if (r?.error) return send(res, 500, { error: String(r.error.message ?? "herdr 拒絕切換") });
				currentCache = null;
				return send(res, 200, { ok: true, pane: pane.pane_id });
			}
			m = path.match(/^\/api\/cards\/([^/]+)\/move$/);
			if (req.method === "POST" && m) {
				const card = store.card(m[1]);
				if (!card) return send(res, 404, { error: "unknown card" });
				const { column } = await body(req);
				if (!MOVABLE.includes(column)) return send(res, 400, { error: "bad column" });
				const rule = moveRule(card.column, column);
				if (!rule.ok) return send(res, 409, { error: rule.reason, column: card.column });
				if (rule.action === "dispatch" || rule.action === "redispatch") {
					// 核准(提案→已核准)= 派工;卡住/完成→已核准 = 重新派工,把上次結果附進指示
					const previous = rule.action === "redispatch" ? { column: card.column, note: card.note, paneId: card.paneId } : undefined;
					store.updateCard(card.id, { column: "approved", note: previous ? "重新派工中…" : "派工中…", paneId: undefined });
					send(res, 202, store.card(card.id));
					dispatchCard(store, watcher, store.card(card.id)!, previous)
						.then((c) => (c.column === "running" && c.paneId ? steward.watchCard(c.id, c.paneId, c.terminalId) : undefined))
						.catch((e) => store.updateCard(card.id, { column: "blocked", note: `派工失敗:${e}` }));
					return;
				}
				const patch: Partial<Card> = { column };
				if (column === "proposed") Object.assign(patch, { paneId: undefined, note: "已退回,等待重新考慮" });
				if (column === "rejected") Object.assign(patch, { note: "不要了" });
				return send(res, 200, store.updateCard(card.id, patch));
			}
			m = path.match(/^\/api\/cards\/([^/]+)$/);
			if (req.method === "POST" && m) {
				const card = store.card(m[1]);
				if (!card) return send(res, 404, { error: "unknown card" });
				const b = await body(req);
				const patch: Record<string, string> = {};
				for (const k of ["title", "agent", "instructions", "doneCriteria", "note"]) if (typeof b[k] === "string") patch[k] = b[k];
				return send(res, 200, store.updateCard(card.id, patch));
			}
			// 網頁端診斷記錄(複製流程等),寫到 logs/client.log,上限 2MB
			if (req.method === "POST" && path === "/api/clientlog") {
				const b = await body(req).catch(() => ({}));
				const file = join(DATA_DIR, "logs", "client.log");
				mkdirSync(dirname(file), { recursive: true });
				let size = 0;
				try {
					size = fileStat(file).size;
				} catch {
					/* 還沒有檔案 */
				}
				if (size < 2_000_000) appendFileSync(file, `${new Date().toISOString()} ${req.socket.remoteAddress} ${header(req, "tailscale-user-login") ?? ""} ${JSON.stringify(b).slice(0, 2000)}\n`);
				return send(res, 204, "");
			}
			// 終端機:讓 herdr 跳到這個專案所在的 space(沒有就不動)
			if (req.method === "POST" && path === "/api/terminal/focus") {
				const { project, create } = await body(req);
				const p = store.project(project);
				if (!p || p.kind !== "project") return send(res, 404, { error: "unknown project" });
				currentCache = null; // 跳完馬上查要拿到新位置
				return send(res, 200, focusProject(store, p, { create: create !== false }));
			}
			if (req.method === "GET" && path === "/api/agents") return send(res, 200, { agents: listAgents().filter((a) => a.installed && a.dispatch).map((a) => ({ id: a.id, name: a.name })) });
			if (req.method === "GET" && path === "/api/terminal/current") return send(res, 200, terminalCurrent());
			// 三個頁面共用的「目前專案」
			if (req.method === "GET" && path === "/api/current") return send(res, 200, getCurrent() ?? {});
			if (req.method === "PUT" && path === "/api/current") {
				const b = await body(req);
				const p = store.project(String(b.project ?? ""));
				if (!p) return send(res, 404, { error: "unknown project" });
				return send(res, 200, putCurrent(p.id, String(b.source ?? "")));
			}
			if (req.method === "GET" && path === "/api/health") {
				// 沒登入只回「活著」;用量、窗格狀態要登入才看得到
				if (!(await authorize(req)).ok) return send(res, 200, { ok: true });
				const usage = await steward.usage().catch(() => undefined);
				const watchedCards = await steward.watchedCards().catch(() => undefined);
				return send(res, 200, { ok: true, usage, watchedCards, watcher: watcher.status() });
			}
			// 手動觸發:立刻整理某個窗格的新內容(除錯、或使用者想馬上更新時用)
			if (req.method === "POST" && path === "/api/ingest") {
				const { pane } = await body(req);
				const target = (listPanes() ?? []).find((p) => p.pane_id === pane);
				if (!target?.agent) return send(res, 404, { error: "找不到這個 agent 窗格" });
				const answer = await watcher.report(target);
				return send(res, 200, { answer: answer ?? "(沒有新內容)" });
			}
			return send(res, 404, { error: "not found" });
		} catch (e) {
			console.error("[server]", e);
			if (!res.headersSent) send(res, 500, { error: String(e) });
		}
	};

	// /terminal/* 轉接到只綁本機的 ttyd(herdr 網頁終端機);HTTP 與 WebSocket 都轉
	// 只把「管家已放行」交給 ttyd(ttyd 以 --auth-header X-Steward-User 啟動);用戶端自帶的同名標頭與密碼一律拿掉。
	// 值要短:ttyd 在 WebSocket 階段把它複製進很小的緩衝區,太長(例如帳號+中文裝置名)會直接拒絕連線。
	// 完整身分只寫在管家記錄裡。
	const TTYD_USER_TOKEN = "steward";
	const upstreamHeaders = (req: IncomingMessage, user: string) => {
		const h: Record<string, string | string[] | undefined> = { ...req.headers };
		delete h["x-steward-user"];
		delete h.authorization;
		h["x-steward-user"] = TTYD_USER_TOKEN;
		void user;
		return h;
	};
	const proxyHttp = (req: IncomingMessage, res: ServerResponse) => {
		proxyHttpInner(req, res).catch((e) => {
			console.error("[terminal] 轉接失敗", e);
			if (!res.headersSent) send(res, 502, "終端機轉接失敗", "text/plain; charset=utf-8");
			else res.destroy();
		});
	};
	const proxyHttpInner = async (req: IncomingMessage, res: ServerResponse) => {
		const auth = await authorizeTerminal(req);
		if (!auth.ok) {
			const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
				res.writeHead(auth.status, headers);
			res.end(auth.reason);
			console.error(new Date().toISOString(), "[terminal] 擋下", req.socket.remoteAddress, auth.reason);
			return;
		}
		const up = httpRequest({ host: "127.0.0.1", port: TERMINAL_PORT, method: req.method, path: req.url, headers: upstreamHeaders(req, auth.user) }, (r) => {
			res.writeHead(r.statusCode ?? 502, r.headers);
			r.pipe(res);
		});
		up.on("error", () => send(res, 502, `終端機服務沒有在跑(${serviceHint("terminal")})`, "text/plain; charset=utf-8"));
		req.pipe(up);
	};
	const proxyUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		proxyUpgradeInner(req, socket, head).catch((e) => {
			console.error("[terminal] WebSocket 轉接失敗", e);
			socket.destroy();
		});
	};
	const proxyUpgradeInner = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		if (!req.url?.startsWith("/terminal/")) return socket.destroy();
		const auth = await authorizeTerminal(req);
		if (!auth.ok) {
			socket.end(`HTTP/1.1 ${auth.status} ${auth.status === 401 ? "Unauthorized" : "Forbidden"}\r\nconnection: close\r\n\r\n`);
			return;
		}
		const up = netConnect(TERMINAL_PORT, "127.0.0.1", () => {
			const lines = [`${req.method} ${req.url} HTTP/1.1`];
			for (let i = 0; i < req.rawHeaders.length; i += 2) {
				const name = req.rawHeaders[i].toLowerCase();
				if (name === "x-steward-user" || name === "authorization") continue;
				lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
			}
			lines.push(`x-steward-user: ${TTYD_USER_TOKEN}`);
			console.log(new Date().toISOString(), "[terminal] 連線", auth.user);
			up.write(lines.join("\r\n") + "\r\n\r\n");
			if (head.length) up.write(head);
			up.pipe(socket);
			socket.pipe(up);
		});
		const close = () => {
			up.destroy();
			socket.destroy();
		};
		up.on("error", close);
		socket.on("error", close);
	};

	// 區網存取開啟:聽所有網路介面(區網的人要用密碼登入);否則只聽設定的位址(本機 + tailnet IP)
	const hosts = settings().access.lan.enabled && !process.env.STEWARD_HOSTS ? ["0.0.0.0"] : HOSTS;
	for (const host of hosts) {
		const server = createServer((req, res) => (req.url === "/terminal" || req.url?.startsWith("/terminal/") ? proxyHttp(req, res) : handler(req, res)));
		server.on("upgrade", proxyUpgrade);
		server.on("error", (e) => console.error(`[server] 綁定 ${host}:${PORT} 失敗:${e.message}`));
		server.listen(PORT, host, () => console.log(`[server] http://${host}:${PORT}`));
	}
}
