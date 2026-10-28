// 「電腦上的 agent CLI」接口:直接用已經登入好的 Claude Code、Codex、Gemini CLI、GitHub Copilot CLI、Qwen Code
// 回答(用它們自己的訂閱,不用另外登入或付 API 費用)。
// CLI 沒辦法呼叫管家的工具,所以只用在不需要工具的工作:聊天問答、建議問題、產生提交訊息。
// 每次呼叫都在空的暫存資料夾裡、關掉工具與外掛執行;問題從標準輸入送進去(不放在指令列上)。
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { which } from "./agents.ts";
import { IS_WIN } from "./platform.ts";
import type { ProviderConfig } from "./settings.ts";

export type CliKind = "claude" | "codex" | "gemini" | "copilot" | "qwen";
/** 可以用 CLI 接口的工作(其他工作需要呼叫管家的工具) */
export const CLI_ROLES = ["chat", "suggest", "commitmsg"] as const;

const CODEX_MODELS = Object.values(OPENAI_CODEX_MODELS as Record<string, { id: string }>).map((m) => m.id);
export const CLI_KINDS: Record<CliKind, { name: string; exe: string[]; models: string[]; note?: string }> = {
	claude: { name: "Claude Code", exe: ["claude"], models: ["default", "sonnet", "opus", "haiku"] },
	codex: { name: "Codex", exe: ["codex"], models: ["default", ...CODEX_MODELS], note: "Codex 每次呼叫會先送出它自己的長提示(約 1 萬多 token),比較慢" },
	gemini: { name: "Gemini CLI", exe: ["gemini"], models: ["default"] },
	copilot: { name: "GitHub Copilot CLI", exe: ["copilot"], models: ["default"] },
	qwen: { name: "Qwen Code", exe: ["qwen"], models: ["default"] },
};
export const isCliKind = (k: unknown): k is CliKind => typeof k === "string" && k in CLI_KINDS;

/** 這台電腦裝了哪些(給設定頁「新增接口」用) */
export function detectCliProviders(): ProviderConfig[] {
	return (Object.keys(CLI_KINDS) as CliKind[])
		.filter((k) => CLI_KINDS[k].exe.some((e) => which(e)))
		.map((k) => ({ id: `cli-${k}`, type: "agent-cli", cli: k, name: `${CLI_KINDS[k].name}(電腦上的 CLI)` }));
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();

/** 問一次,回傳文字。system 和 user 合在一起從標準輸入送進去。 */
export function runCli(kind: CliKind, model: string, system: string, user: string, timeoutMs = 180_000): Promise<string> {
	const def = CLI_KINDS[kind];
	const exe = def.exe.map(which).find(Boolean);
	if (!exe) return Promise.reject(new Error(`這台電腦找不到 ${def.name}(${def.exe[0]} 指令)`));
	const dir = mkdtempSync(join(tmpdir(), "steward-cli-"));
	const m = model && model !== "default" ? model : "";
	const prompt = `${system}\n\n---\n\n${user}`;
	let args: string[] = [];
	let outFile = "";
	if (kind === "claude") {
		// 不給工具、不載入 MCP、不跑 hooks(避免又觸發管家自己的開工簡報)、不留 session 紀錄
		writeFileSync(join(dir, "mcp.json"), '{"mcpServers":{}}');
		writeFileSync(join(dir, "settings.json"), '{"disableAllHooks":true}');
		args = ["-p", "--output-format", "text", "--tools", "", "--strict-mcp-config", "--mcp-config", join(dir, "mcp.json"), "--settings", join(dir, "settings.json"), "--no-session-persistence", ...(m ? ["--model", m] : [])];
	} else if (kind === "codex") {
		outFile = join(dir, "answer.txt");
		args = ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never", "-o", outFile, ...(m ? ["-m", m] : []), "-"];
	} else if (kind === "gemini" || kind === "qwen") {
		// 標準輸入的內容會接在 -p 前面
		args = ["-p", "Answer the request above.", ...(m ? ["-m", m] : [])];
	} else {
		// Copilot CLI 只吃指令列上的問題
		if (IS_WIN) return Promise.reject(new Error("GitHub Copilot CLI 在 Windows 上還不支援當管家的接口"));
		args = ["-p", prompt, ...(m ? ["--model", m] : [])];
	}
	return new Promise((resolve, reject) => {
		// Windows 的 npm 指令是 .cmd,要經過 cmd.exe(參數都是固定值,問題走標準輸入)
		const winCmd = IS_WIN && /\.(cmd|bat)$/i.test(exe);
		const child = winCmd
			? spawn("cmd.exe", ["/d", "/s", "/c", `"${[exe, ...args].map((a) => (/[\s"]/.test(a) || a === "" ? `"${a.replace(/"/g, '""')}"` : a)).join(" ")}"`], { cwd: dir, windowsVerbatimArguments: true, windowsHide: true })
			: spawn(exe, args, { cwd: dir, windowsHide: true, env: { ...process.env, NO_COLOR: "1" } });
		let out = "", err = "";
		child.stdout.on("data", (d) => { out += d; });
		child.stderr.on("data", (d) => { err += d; });
		const timer = setTimeout(() => { child.kill(); }, timeoutMs);
		child.on("error", (e) => { clearTimeout(timer); rmSync(dir, { recursive: true, force: true }); reject(e); });
		child.on("close", (code) => {
			clearTimeout(timer);
			let text = strip(out);
			if (outFile) { try { text = strip(readFileSync(outFile, "utf8")); } catch { /* 沒寫出來 */ } }
			rmSync(dir, { recursive: true, force: true });
			if (code === 0 && text) return resolve(text);
			const why = strip(err).split("\n").filter(Boolean).slice(-3).join(" ") || strip(out).slice(-300) || `結束代碼 ${code}`;
			reject(new Error(`${def.name}:${why.slice(0, 400)}`));
		});
		if (kind !== "copilot") child.stdin.end(prompt);
		else child.stdin.end();
	});
}
