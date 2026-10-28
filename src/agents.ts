// Agent 偵測與整合:找出這台電腦裝了哪些 AI agent,讓使用者在設定頁一個一個接上 / 拿掉專案管家。
// 整合分三種(每個 agent 支援的不一樣):
//  - 開工簡報(hook / extension):開新 session 自動讀到專案進度
//  - MCP 工具:agent 可以主動問管家、回報(steward_brief / steward_ask / steward_report)
//  - 工作說明:在 agent 的全域說明檔加一段「有專案管家可以用」
// 另外:herdr 支援的 agent 都能從看板派工。
// 每個被改的設定檔都先備份成 *.bak-steward-<日期>;拿掉時只移除我們加的部分。
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const HOME = homedir();
const WIN = process.platform === "win32";
const STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, "");
/** 管家程式所在目錄(部署後是 ~/.agent-steward/app) */
export const APP_DIR = process.env.STEWARD_APP_DIR ?? join(dirname(new URL(import.meta.url).pathname), "..");
const BIN = join(HOME, ".local", "bin", WIN ? "steward.cmd" : "steward");

/** agent 執行 steward 指令的方式(hook、MCP 用) */
export function stewardCommand(): { command: string; args: string[] } {
	return WIN ? { command: process.execPath, args: [join(APP_DIR, "bin", "steward.mjs")] } : { command: BIN, args: [] };
}
const cmdLine = (...extra: string[]) => {
	const c = stewardCommand();
	return [c.command, ...c.args, ...extra].map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(" ");
};

// ---------- 小工具 ----------
function readJson(p: string): any {
	try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; }
}
function backup(p: string) {
	if (!existsSync(p)) return;
	const b = `${p}.bak-steward-${STAMP}`;
	if (!existsSync(b)) copyFileSync(p, b);
}
function writeText(p: string, text: string, changed: string[]) {
	if (existsSync(p) && readFileSync(p, "utf8") === text) return;
	backup(p);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(`${p}.steward.tmp`, text);
	renameSync(`${p}.steward.tmp`, p);
	changed.push(p);
}
const writeJson = (p: string, v: unknown, changed: string[]) => writeText(p, `${JSON.stringify(v, null, 2)}\n`, changed);
/** 在 JSON 設定檔的某個物件下加/移除 steward 這一項 */
function jsonEntry(p: string, key: string[], entry: unknown | null, changed: string[]) {
	const s = readJson(p) ?? {};
	let o = s;
	for (const k of key) o = o[k] ??= {};
	if (entry === null) {
		if (!("steward" in o)) return;
		delete o.steward;
	} else o.steward = entry;
	writeJson(p, s, changed);
}
const hasJsonEntry = (p: string, key: string[]) => { let o = readJson(p); for (const k of key) o = o?.[k]; return !!o?.steward; };

const INSTR_RE = /\n?<!-- steward:start -->[\s\S]*?<!-- steward:end -->\n?/;
const INSTRUCTIONS = `
<!-- steward:start -->
# 專案管家(steward)

有一個常駐的「專案管家」在追蹤每個專案的進度(目前做到哪、下一步、卡點、決定、其他 agent 最近做了什麼)。
- 開新 session 時若 context 裡沒有「專案管家簡報」,先執行 \`steward brief\`(或 MCP 工具 steward_brief)看一下再開工。
- 想知道別的 session/agent 做過什麼、某個決定的來由:\`steward ask "問題"\`(或 MCP 工具 steward_ask)。
- 需要參考別的專案:\`steward projects\`(或 steward_projects)看有哪些專案與位置,再用 \`steward ask --project 名稱 "問題"\` / \`steward brief --project 名稱\`(MCP 加 project 參數);問答會記在目前這個專案。細節可以直接去讀那個專案的檔案。
- 收工不必手動回報,管家會自動整理;真的需要強調的重要決定才用 \`steward report "…"\`(或 steward_report)。
<!-- steward:end -->
`;
function instructions(p: string, on: boolean, changed: string[]) {
	const text = existsSync(p) ? readFileSync(p, "utf8") : "";
	const base = text.replace(INSTR_RE, "").replace(/\s+$/, "");
	if (!on && base === text.replace(/\s+$/, "")) return;
	writeText(p, on ? `${base}${base ? "\n" : ""}${INSTRUCTIONS}` : `${base}\n`, changed);
}
const hasInstructions = (p: string) => existsSync(p) && INSTR_RE.test(readFileSync(p, "utf8"));

const mcpStdio = (agent: string) => { const c = stewardCommand(); return { command: c.command, args: [...c.args, "mcp"], env: { STEWARD_AGENT: agent } }; };

// ---------- 找執行檔 ----------
const EXTRA_DIRS = WIN
	? [join(HOME, "AppData", "Roaming", "npm"), join(HOME, ".local", "bin")]
	: [join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", join(HOME, ".npm-global", "bin"), join(HOME, ".bun", "bin"), join(HOME, ".cargo", "bin")];
export function which(exe: string): string | undefined {
	const dirs = [...(process.env.PATH ?? "").split(delimiter), ...EXTRA_DIRS];
	const exts = WIN ? ["", ".cmd", ".exe", ".bat", ".ps1"] : [""];
	for (const d of dirs) for (const e of exts) { const p = join(d, exe + e); if (d && existsSync(p)) return p; }
	return undefined;
}

// ---------- 各個 agent ----------
type Parts = { brief?: boolean; mcp?: boolean; instructions?: boolean };
interface AgentDef {
	id: string;
	name: string;
	exe: string[];
	/** herdr agent start --kind(能派工) */
	herdrKind?: string;
	/** 管家會自動讀它的對話記錄 */
	records?: boolean;
	/** 能自動接上的部分 */
	can: Parts;
	status?: () => Parts;
	apply?: (on: boolean, changed: string[]) => void;
	/** 不能自動接的:給使用者手動設定的說明 */
	manual?: string;
}

const claudeSettings = join(HOME, ".claude", "settings.json");
const hookCmd = (agent: string) => cmdLine("hook", agent);
function claudeHook(on: boolean, changed: string[]) {
	const s = readJson(claudeSettings) ?? {};
	const list = ((s.hooks ??= {}).SessionStart ??= []) as { hooks?: { command?: string }[] }[];
	const kept = list.filter((h) => !h.hooks?.some((x) => /steward/.test(x.command ?? "") && /hook claude/.test(x.command ?? "")));
	if (on) kept.push({ matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: hookCmd("claude"), timeout: 5 }] } as never);
	s.hooks.SessionStart = kept;
	writeJson(claudeSettings, s, changed);
}

export const AGENTS: AgentDef[] = [
	{
		id: "claude", name: "Claude Code", exe: ["claude"], herdrKind: "claude", records: true,
		can: { brief: true, mcp: true },
		status: () => ({
			brief: !!readJson(claudeSettings)?.hooks?.SessionStart?.some((h: any) => h.hooks?.some((x: any) => /steward/.test(x.command ?? "") && /hook claude/.test(x.command ?? ""))),
			mcp: !!readJson(join(HOME, ".claude.json"))?.mcpServers?.steward,
		}),
		apply: (on, changed) => {
			claudeHook(on, changed);
			const claude = which("claude");
			if (!claude) return;
			const has = !!readJson(join(HOME, ".claude.json"))?.mcpServers?.steward;
			try {
				if (on && !has) {
					const c = stewardCommand();
					// -e 會吃掉後面所有 KEY=VALUE 以外的參數,所以名稱要放在 -e 前面
					execFileSync(claude, ["mcp", "add", "-s", "user", "steward", "-e", "STEWARD_AGENT=claude", "--", c.command, ...c.args, "mcp"], { stdio: "ignore", timeout: 20_000 });
					changed.push("claude mcp add steward");
				}
				if (!on && has) {
					execFileSync(claude, ["mcp", "remove", "-s", "user", "steward"], { stdio: "ignore", timeout: 20_000 });
					changed.push("claude mcp remove steward");
				}
			} catch { /* claude CLI 失敗就略過 MCP */ }
		},
	},
	{
		id: "codex", name: "Codex", exe: ["codex"], herdrKind: "codex", records: true,
		can: { brief: true, mcp: true, instructions: true },
		status: () => {
			const toml = join(HOME, ".codex", "config.toml");
			return {
				brief: !!readJson(join(HOME, ".codex", "hooks.json"))?.hooks?.SessionStart?.some((h: any) => h.hooks?.some((x: any) => /hook codex/.test(x.command ?? ""))),
				mcp: existsSync(toml) && readFileSync(toml, "utf8").includes("[mcp_servers.steward]"),
				instructions: hasInstructions(join(HOME, ".codex", "AGENTS.md")),
			};
		},
		apply: (on, changed) => {
			const hp = join(HOME, ".codex", "hooks.json");
			const s = readJson(hp) ?? { hooks: {} };
			const list = ((s.hooks ??= {}).SessionStart ??= []) as any[];
			const kept = list.filter((h) => !h.hooks?.some((x: any) => /hook codex/.test(x.command ?? "")));
			if (on) kept.push({ matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: hookCmd("codex"), timeout: 5 }] });
			s.hooks.SessionStart = kept;
			writeJson(hp, s, changed);
			const tp = join(HOME, ".codex", "config.toml");
			let text = existsSync(tp) ? readFileSync(tp, "utf8") : "";
			text = text.replace(/\n?\[mcp_servers\.steward\]\n(?:(?!\[)[^\n]*\n?)*/g, "\n");
			if (on) {
				const c = mcpStdio("codex");
				const block = `[mcp_servers.steward]\ncommand = ${JSON.stringify(c.command)}\nargs = ${JSON.stringify(c.args)}\nenv = { STEWARD_AGENT = "codex" }\n`;
				// 插在第一個 [mcp_servers.*] 之前,避免落進別的表格
				const i = text.indexOf("[mcp_servers.");
				text = i >= 0 ? `${text.slice(0, i)}${block}\n${text.slice(i)}` : `${text.replace(/\s+$/, "")}\n\n${block}`;
			}
			writeText(tp, text.replace(/\n{3,}/g, "\n\n"), changed);
			instructions(join(HOME, ".codex", "AGENTS.md"), on, changed);
		},
	},
	{
		id: "pi", name: "pi", exe: ["pi"], herdrKind: "pi", records: true,
		can: { brief: true, mcp: true, instructions: true },
		status: () => ({
			brief: existsSync(join(HOME, ".pi", "agent", "extensions", "steward-brief.ts")),
			mcp: hasJsonEntry(join(HOME, ".pi", "agent", "mcp.json"), ["mcpServers"]),
			instructions: hasInstructions(join(HOME, ".pi", "agent", "AGENTS.md")),
		}),
		apply: (on, changed) => {
			const link = join(HOME, ".pi", "agent", "extensions", "steward-brief.ts");
			const target = join(APP_DIR, "integrations", "pi", "steward-brief.ts");
			const exists = existsSync(link) || (() => { try { return !!lstatSync(link); } catch { return false; } })();
			if (on) {
				let same = false;
				try { same = readlinkSync(link) === target; } catch { /* 不是連結 */ }
				if (!same) {
					if (exists) unlinkSync(link);
					mkdirSync(dirname(link), { recursive: true });
					// Windows 建連結要管理員權限:改用複製
					if (WIN) copyFileSync(target, link); else symlinkSync(target, link);
					changed.push(link);
				}
			} else if (exists) { unlinkSync(link); changed.push(`移除 ${link}`); }
			jsonEntry(join(HOME, ".pi", "agent", "mcp.json"), ["mcpServers"], on ? { ...mcpStdio("pi"), exposure: "deferred", toolExposure: { steward_brief: "direct", steward_ask: "direct" } } : null, changed);
			instructions(join(HOME, ".pi", "agent", "AGENTS.md"), on, changed);
		},
	},
	{
		id: "opencode", name: "opencode", exe: ["opencode"], herdrKind: "opencode",
		can: { mcp: true, instructions: true },
		status: () => ({ mcp: hasJsonEntry(join(HOME, ".config", "opencode", "opencode.json"), ["mcp"]), instructions: hasInstructions(join(HOME, ".config", "opencode", "AGENTS.md")) }),
		apply: (on, changed) => {
			const c = mcpStdio("opencode");
			jsonEntry(join(HOME, ".config", "opencode", "opencode.json"), ["mcp"], on ? { enabled: true, type: "local", command: [c.command, ...c.args], environment: c.env } : null, changed);
			instructions(join(HOME, ".config", "opencode", "AGENTS.md"), on, changed);
		},
	},
	{
		id: "gemini", name: "Gemini CLI", exe: ["gemini"], herdrKind: "gemini",
		can: { mcp: true, instructions: true },
		status: () => ({ mcp: hasJsonEntry(join(HOME, ".gemini", "settings.json"), ["mcpServers"]), instructions: hasInstructions(join(HOME, ".gemini", "GEMINI.md")) }),
		apply: (on, changed) => {
			jsonEntry(join(HOME, ".gemini", "settings.json"), ["mcpServers"], on ? mcpStdio("gemini") : null, changed);
			instructions(join(HOME, ".gemini", "GEMINI.md"), on, changed);
		},
	},
	{
		id: "qwen", name: "Qwen Code", exe: ["qwen"], herdrKind: "qwen",
		can: { mcp: true, instructions: true },
		status: () => ({ mcp: hasJsonEntry(join(HOME, ".qwen", "settings.json"), ["mcpServers"]), instructions: hasInstructions(join(HOME, ".qwen", "QWEN.md")) }),
		apply: (on, changed) => {
			jsonEntry(join(HOME, ".qwen", "settings.json"), ["mcpServers"], on ? mcpStdio("qwen") : null, changed);
			instructions(join(HOME, ".qwen", "QWEN.md"), on, changed);
		},
	},
	{
		id: "cursor", name: "Cursor CLI", exe: ["cursor-agent"], herdrKind: "cursor",
		can: { mcp: true },
		status: () => ({ mcp: hasJsonEntry(join(HOME, ".cursor", "mcp.json"), ["mcpServers"]) }),
		apply: (on, changed) => jsonEntry(join(HOME, ".cursor", "mcp.json"), ["mcpServers"], on ? mcpStdio("cursor") : null, changed),
	},
	{
		id: "copilot", name: "GitHub Copilot CLI", exe: ["copilot"], herdrKind: "copilot",
		can: { mcp: true },
		status: () => ({ mcp: hasJsonEntry(join(HOME, ".copilot", "mcp-config.json"), ["mcpServers"]) }),
		apply: (on, changed) => { const c = mcpStdio("copilot"); jsonEntry(join(HOME, ".copilot", "mcp-config.json"), ["mcpServers"], on ? { type: "local", ...c, tools: ["*"] } : null, changed); },
	},
	{
		id: "amp", name: "Amp", exe: ["amp"], herdrKind: "amp",
		can: { mcp: true },
		status: () => ({ mcp: hasJsonEntry(join(HOME, ".config", "amp", "settings.json"), ["amp.mcpServers"]) }),
		apply: (on, changed) => jsonEntry(join(HOME, ".config", "amp", "settings.json"), ["amp.mcpServers"], on ? mcpStdio("amp") : null, changed),
	},
	// 只偵測、可以派工;MCP 請照說明手動加
	...(
		[
			["hermes", "Hermes Agent", ["hermes"], "hermes"],
			["kimi", "Kimi CLI", ["kimi"], "kimi"],
			["kiro", "Kiro CLI", ["kiro-cli"], "kiro"],
			["droid", "Factory Droid", ["droid"], "droid"],
			["grok", "Grok CLI", ["grok"], "grok"],
			["kilo", "Kilo Code CLI", ["kilo"], "kilo"],
			["cline", "Cline CLI", ["cline"], "cline"],
			["devin", "Devin CLI", ["devin"], "devin"],
			["agy", "Antigravity", ["agy"], "agy"],
			["qodercli", "Qoder CLI", ["qodercli"], "qodercli"],
			["letta", "Letta Code", ["letta"], "letta"],
			["omp", "omp", ["omp"], "omp"],
			["mastracode", "Mastra Code", ["mastracode"], "mastracode"],
			["maki", "Maki", ["maki"], "maki"],
			["muse", "Muse", ["muse"], "muse"],
		] as [string, string, string[], string][]
	).map(([id, name, exe, herdrKind]): AgentDef => ({ id, name, exe, herdrKind, can: {}, manual: "在它的 MCP 設定加一個 stdio 伺服器:" })),
];

export interface AgentStatus {
	id: string;
	name: string;
	installed: boolean;
	path?: string;
	dispatch: boolean;
	records: boolean;
	can: Parts;
	on: Parts;
	integrated: boolean;
	manual?: string;
}
export function agentStatus(def: AgentDef): AgentStatus {
	const path = def.exe.map(which).find(Boolean);
	const on = def.status?.() ?? {};
	const parts = Object.keys(def.can).filter((k) => def.can[k as keyof Parts]) as (keyof Parts)[];
	return {
		id: def.id, name: def.name, installed: !!path, path, dispatch: !!def.herdrKind, records: !!def.records,
		can: def.can, on, integrated: parts.length > 0 && parts.some((k) => on[k]),
		manual: def.manual ? `${def.manual}${JSON.stringify({ steward: mcpStdio(def.id) })}` : undefined,
	};
}
export function listAgents(): AgentStatus[] {
	return AGENTS.map(agentStatus);
}
/** 接上 / 拿掉;回傳改了哪些檔案 */
export function setAgent(id: string, on: boolean): { changed: string[]; status: AgentStatus } {
	const def = AGENTS.find((a) => a.id === id);
	if (!def?.apply) throw new Error("這個 agent 不能自動設定");
	const changed: string[] = [];
	def.apply(on, changed);
	return { changed, status: agentStatus(def) };
}
/** 部署更新時:已經接上的 agent 重新套一次(路徑變了會跟著更新) */
export function refreshIntegrated(): string[] {
	const changed: string[] = [];
	for (const def of AGENTS) if (def.apply && agentStatus(def).integrated) def.apply(true, changed);
	return changed;
}
/** 移除專案管家時:拿掉所有 agent 的整合 */
export function removeAll(): string[] {
	const changed: string[] = [];
	for (const def of AGENTS) if (def.apply && agentStatus(def).integrated) def.apply(false, changed);
	return changed;
}
/** 派工用:看板上的名稱 → herdr agent kind */
export function herdrKindOf(name: string): string | undefined {
	const n = name.trim().toLowerCase();
	if (n === "claude code") return "claude";
	return AGENTS.find((a) => a.id === n || a.name.toLowerCase() === n)?.herdrKind;
}
