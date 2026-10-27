// 從 agent 的對話記錄讀出「上次之後的新內容」,整理成精簡節錄給管家消化。
// 認得的 agent(pi / Claude Code / Codex)讀自己的 jsonl;其他 agent 退回讀 herdr 窗格畫面。
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./config.ts";
import { herdrCli } from "./herdr.ts";

const MAX_EXCERPT = 24_000; // 給管家的節錄上限(字元)
const MAX_READ = 4_000_000; // 單次最多讀這麼多 bytes 的新記錄

export interface Excerpt {
	key: string; // cursor key
	text: string;
	nextOffset: number;
	source: "transcript" | "pane";
}

type Line = { role: "user" | "assistant" | "tool"; text: string };

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
	if (msg && typeof msg === "object") {
		const role = msg.role;
		if (role === "user") {
			const t = textOf(msg.content).trim();
			// Claude 的 tool_result 也是 user 訊息,跳過;系統注入的提醒也跳過
			if (!t || /^(<system-reminder>|<command-|<environment_context|<user_instructions|<local-command|# AGENTS\.md|\[長期記憶|Caveat:)/.test(t)) return [];
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
