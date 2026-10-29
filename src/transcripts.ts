// 從 agent 的對話記錄讀出「上次之後的新內容」,整理成精簡節錄給管家消化。
// 認得的 agent(pi / Claude Code / Codex)讀自己的 jsonl;其他 agent 退回讀 herdr 窗格畫面。
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./config.ts";
import { herdrCli, type HerdrPane } from "./herdr.ts";

const MAX_EXCERPT = 24_000; // 給管家的節錄上限(字元)
const MAX_READ = 4_000_000; // 單次最多讀這麼多 bytes 的新記錄

export interface Excerpt {
	key: string; // cursor key
	text: string;
	nextOffset: number;
	source: "transcript" | "pane";
}

export type Line = { role: "user" | "assistant" | "tool"; text: string };

// ---------- 找記錄檔 ----------

function claudeTranscript(sessionId: string): string | undefined {
	const base = join(HOME, ".claude", "projects");
	try {
		for (const dir of readdirSync(base)) {
			const f = join(base, dir, `${sessionId}.jsonl`);
			if (existsSync(f)) return f;
		}
	} catch {
		/* 沒有 claude 目錄 */
	}
	return undefined;
}

function codexTranscript(sessionId: string): string | undefined {
	const base = join(HOME, ".codex", "sessions");
	const walk = (dir: string, depth: number): string | undefined => {
		let names: string[];
		try {
			names = readdirSync(dir).sort().reverse();
		} catch {
			return undefined;
		}
		for (const n of names) {
			const p = join(dir, n);
			if (depth < 3) {
				const hit = walk(p, depth + 1);
				if (hit) return hit;
			} else if (n.endsWith(".jsonl") && n.includes(sessionId)) return p;
		}
		return undefined;
	};
	return walk(base, 0);
}

export interface AgentSessionRef {
	agent: string;
	kind?: string; // "path" | "id"
	value?: string;
}

export function transcriptPath(ref: AgentSessionRef): string | undefined {
	if (!ref.value) return undefined;
	if (ref.kind === "path") return existsSync(ref.value) ? ref.value : undefined;
	if (ref.agent === "claude") return claudeTranscript(ref.value);
	if (ref.agent === "codex") return codexTranscript(ref.value);
	return undefined;
}

// ---------- 解析 ----------

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c: any) => {
			if (c?.type === "text" || c?.type === "input_text" || c?.type === "output_text") return c.text ?? "";
			return "";
		})
		.join("");
}

function toolCallsOf(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((c: any) => c?.type === "toolCall" || c?.type === "tool_use")
		.map((c: any) => {
			const args = c.arguments ?? c.input ?? {};
			const brief = typeof args.command === "string" ? args.command : typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : JSON.stringify(args);
			return `${c.name}: ${String(brief).replace(/\s+/g, " ").slice(0, 160)}`;
		});
}

/** 把一行 jsonl 轉成節錄行;無關的行回傳空陣列。三種格式都試。 */
function parseLine(raw: string): Line[] {
	let d: any;
	try {
		d = JSON.parse(raw);
	} catch {
		return [];
	}
	// pi:{type:"message", message:{role, content}}
	// Claude Code:{type:"user"|"assistant", message:{role, content}}
	const msg = d.message ?? (d.type === "response_item" ? d.payload : undefined);
	if (d.type === "custom_message" || d.isMeta || d.isSidechain) return [];
	// Claude Code 新版會記下每次送給模型的整包請求(含全部舊訊息),不是新的對話內容
	if (typeof d.type === "string" && d.type.startsWith("api-request")) return [];
	if (msg && typeof msg === "object") {
		const role = msg.role;
		if (role === "user") {
			const t = textOf(msg.content).trim();
			// Claude 的 tool_result 也是 user 訊息,跳過;系統注入的提醒也跳過
			if (!t || /^(【專案管家支線】|<system-reminder>|<command-|<environment_context|<user_instructions|<local-command|# AGENTS\.md|\[長期記憶|Caveat:)/.test(t)) return [];
			return [{ role: "user", text: t }];
		}
		if (role === "assistant") {
			const out: Line[] = [];
			const t = textOf(msg.content).trim();
			if (t) out.push({ role: "assistant", text: t });
			for (const call of toolCallsOf(msg.content)) out.push({ role: "tool", text: call });
			return out;
		}
	}
	// Codex:{type:"response_item", payload:{type:"function_call", name, arguments}}
	if (d.type === "response_item" && d.payload?.type === "function_call") {
		return [{ role: "tool", text: `${d.payload.name}: ${String(d.payload.arguments ?? "").slice(0, 160)}` }];
	}
	return [];
}

function render(lines: Line[]): string {
	const out = lines.map((l) => {
		const t = l.text.length > 2000 ? `${l.text.slice(0, 1200)}\n…(中略)…\n${l.text.slice(-600)}` : l.text;
		return l.role === "user" ? `【使用者】${t}` : l.role === "assistant" ? `【agent】${t}` : `  ↳ ${t}`;
	});
	let text = out.join("\n");
	// 太長就保留開頭一點、後面多一點(最近的事比較重要)
	if (text.length > MAX_EXCERPT) text = `${text.slice(0, 4000)}\n…(省略中間 ${text.length - MAX_EXCERPT} 字)…\n${text.slice(-(MAX_EXCERPT - 4000))}`;
	return text;
}

/** 讀記錄檔從 offset 之後的新內容 */
export function readTranscriptDelta(path: string, offset: number): { lines: Line[]; nextOffset: number } {
	const size = statSync(path).size;
	if (offset > size) offset = 0; // 檔案被截斷或換掉
	const start = Math.max(offset, size - MAX_READ);
	const len = size - start;
	if (len <= 0) return { lines: [], nextOffset: size };
	const buf = Buffer.alloc(len);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buf, 0, len, start);
	} finally {
		closeSync(fd);
	}
	const text = buf.toString("utf8");
	const lastNl = text.lastIndexOf("\n");
	if (lastNl < 0) return { lines: [], nextOffset: offset }; // 還沒寫完一整行
	const complete = text.slice(0, lastNl);
	const rows = complete.split("\n");
	if (start > offset && rows.length) rows.shift(); // 從中間開始讀,第一行不完整
	return { lines: rows.flatMap(parseLine), nextOffset: start + Buffer.byteLength(complete, "utf8") + 1 };
}

export function transcriptExcerpt(ref: AgentSessionRef, offset: number): Excerpt | undefined {
	const path = transcriptPath(ref);
	if (!path) return undefined;
	const { lines, nextOffset } = readTranscriptDelta(path, offset);
	const meaningful = lines.filter((l) => l.role !== "tool");
	return { key: `t:${path}`, text: meaningful.length ? render(lines) : "", nextOffset, source: "transcript" };
}

/** 退路:讀窗格畫面最近的內容 */
export function paneExcerpt(paneId: string): Excerpt | undefined {
	const res = herdrCli(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "200"]);
	const text = typeof res === "string" ? res : (res?.result?.text ?? res?.result?.read?.text);
	if (!text || typeof text !== "string") return undefined;
	const cleaned = text
		.split("\n")
		.map((l) => l.replace(/[│┃]\s*$/, "").trimEnd())
		.filter((l) => l.trim() && !/^[─━]+/.test(l.trim()))
		.join("\n");
	return { key: `p:${paneId}`, text: cleaned.slice(-MAX_EXCERPT), nextOffset: 0, source: "pane" };
}

// ---------- 找出窗格的 agent session(開支線用) ----------

/** 窗格前景 process 的啟動時間(毫秒);Windows 或查不到就回 undefined */
function procStartMs(pid: number): number | undefined {
	if (process.platform === "win32") return undefined;
	try {
		const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 3000, env: { ...process.env, LC_ALL: "C", LANG: "C" } }).trim();
		const t = Date.parse(out);
		return Number.isFinite(t) ? t : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Claude Code:herdr 常常沒回報 session ID。
 * 先看 ~/.claude/sessions/<pid>.json;窗格裡的 claude 只是前端、對話跑在背景 process 時,
 * 用「同一個目錄、幾乎同時啟動」對上背景 session,只對到一個才算數(猜錯比沒有更糟)。
 */
function claudeSessionOfPane(pane: HerdrPane): string | undefined {
	const info = herdrCli(["pane", "process-info", "--pane", pane.pane_id])?.result?.process_info;
	const procs: { pid: number; argv0?: string; name?: string; cwd?: string }[] = info?.foreground_processes ?? [];
	const proc = procs.find((x) => /claude/i.test(`${x.argv0 ?? ""}`)) ?? procs[0];
	if (!proc?.pid) return undefined;
	const dir = join(HOME, ".claude", "sessions");
	const read = (f: string) => {
		try {
			return JSON.parse(readFileSync(join(dir, f), "utf8")) as { pid?: number; sessionId?: string; cwd?: string; startedAt?: number };
		} catch {
			return undefined;
		}
	};
	const own = read(`${proc.pid}.json`);
	if (own?.sessionId) return own.sessionId;
	const started = procStartMs(proc.pid);
	const cwd = proc.cwd ?? pane.foreground_cwd ?? pane.cwd;
	if (!started || !cwd) return undefined;
	let names: string[] = [];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".json"));
	} catch {
		return undefined;
	}
	const hits = names
		.map(read)
		.filter((d): d is NonNullable<typeof d> => !!d?.sessionId && d.cwd === cwd && typeof d.startedAt === "number" && Math.abs(d.startedAt - started) < 10_000);
	return hits.length === 1 ? hits[0].sessionId : undefined;
}

/** 窗格目前的 agent session:herdr 有回報就用;Claude 沒回報時自己找;其他找不到就回 undefined */
export function resolveSession(pane: HerdrPane): AgentSessionRef | undefined {
	const s = pane.agent_session;
	if (s?.value) return { ...s, agent: s.agent ?? pane.agent ?? "" };
	if (pane.agent === "claude") {
		const id = claudeSessionOfPane(pane);
		if (id) return { agent: "claude", kind: "id", value: id };
	}
	return undefined;
}

/** Codex 分叉出來的新 session:找 forked_from_id 是主線、且在 sinceMs 之後建立的紀錄檔 */
export function codexForkOf(mainId: string, sinceMs: number): string | undefined {
	const base = join(HOME, ".codex", "sessions");
	const days = [0, 1].map((d) => new Date(sinceMs + d * 86_400_000));
	let best: { path: string; at: number } | undefined;
	for (const day of days) {
		const dir = join(base, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
		let names: string[] = [];
		try {
			names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const n of names) {
			const path = join(dir, n);
			try {
				if (statSync(path).mtimeMs < sinceMs - 10_000) continue;
				const fd = openSync(path, "r");
				const buf = Buffer.alloc(8192);
				const len = readSync(fd, buf, 0, buf.length, 0);
				closeSync(fd);
				const first = buf.subarray(0, len).toString("utf8");
				if (!first.includes(mainId)) continue;
				const meta = first.match(/"forked_from_id":"([^"]+)"/)?.[1];
				const ts = Date.parse(first.match(/"timestamp":"([^"]+)"/)?.[1] ?? "");
				if (meta === mainId && ts >= sinceMs - 10_000 && (!best || ts > best.at)) best = { path, at: ts };
			} catch {
				/* 讀不到就跳過 */
			}
		}
	}
	return best?.path;
}

function lineTime(raw: string): number | undefined {
	const m = raw.match(/"timestamp":\s*"([^"]+)"/);
	const t = m ? Date.parse(m[1]) : NaN;
	return Number.isFinite(t) ? t : undefined;
}

/**
 * 分叉出來的紀錄檔會複製主線的歷史(時間戳保留原本的),所以「支線自己的內容」= 最後一行早於 sinceMs 的紀錄之後。
 * 回傳那個位置,給管家的讀取進度當起點。
 */
export function offsetSince(path: string, sinceMs: number): number {
	const size = statSync(path).size;
	const start = Math.max(0, size - MAX_READ);
	const buf = Buffer.alloc(size - start);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buf, 0, buf.length, start);
	} finally {
		closeSync(fd);
	}
	// 複製過來的歷史在前面(開頭可能夾著幾行新時間戳的設定),支線自己的內容接在最後:
	// 從「最後一行舊時間戳」之後開始讀
	let pos = start;
	let end = start;
	for (const row of buf.toString("utf8").split("\n")) {
		pos += Buffer.byteLength(row, "utf8") + 1;
		const t = lineTime(row);
		if (t !== undefined && t < sinceMs) end = pos;
	}
	return Math.min(end, size);
}

/** 紀錄檔裡 sinceMs 之後的內容(整理過的節錄) */
export function transcriptSince(path: string, sinceMs: number): string {
	const { lines } = readTranscriptDelta(path, offsetSince(path, sinceMs));
	return lines.length ? render(lines) : "";
}
