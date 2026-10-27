#!/usr/bin/env node
// steward:專案管家的指令列工具(純 JS,不需編譯)。
//   steward brief [--cwd DIR]          目前專案的簡報(預設用 $PWD)
//   steward ask "問題" [--cwd DIR]      問管家
//   steward report "做了什麼" [--agent X] 主動回報
//   steward board                      開啟看板
//   steward hook <agent>               給各 agent 的 SessionStart hook 用(失敗安靜略過)
//   steward mcp                        以 MCP stdio server 執行
import { execFileSync } from "node:child_process";

const BASE = process.env.STEWARD_URL ?? `http://127.0.0.1:${process.env.STEWARD_PORT ?? 8791}`;
const args = process.argv.slice(2);
const cmd = args.shift();

function flag(name, fallback) {
	const i = args.indexOf(`--${name}`);
	if (i < 0) return fallback;
	const v = args[i + 1];
	args.splice(i, 2);
	return v;
}

async function api(path, init = {}, timeoutMs = 300_000) {
	const res = await fetch(BASE + path, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { "content-type": "application/json" } });
	const text = await res.text();
	if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
	return text;
}

const post = (path, data, t) => api(path, { method: "POST", body: JSON.stringify(data) }, t);

/** 讀 hook 的 stdin JSON(Claude Code / Codex 會給 cwd、source 等) */
async function readStdinJson() {
	if (process.stdin.isTTY) return {};
	let s = "";
	process.stdin.setEncoding("utf8");
	const done = new Promise((r) => process.stdin.on("end", r));
	process.stdin.on("data", (c) => (s += c));
	await Promise.race([done, new Promise((r) => setTimeout(r, 500))]);
	try {
		return JSON.parse(s);
	} catch {
		return {};
	}
}

async function hook(agent) {
	const input = await readStdinJson();
	const cwd = input.cwd ?? process.env.PWD ?? process.cwd();
	let data;
	try {
		data = JSON.parse(await api(`/api/brief?format=json&cwd=${encodeURIComponent(cwd)}`, {}, 1500));
	} catch {
		return; // 管家沒開:不影響 agent 開場
	}
	// 雜務/總覽、或還沒有紀錄的專案:不注入,避免雜訊
	if (data.project.kind !== "project" || !data.project.state?.updatedAt) return;
	const text = `${data.text}\n\n(以上由專案管家自動提供,反映其他 session/agent 的最新進度;與現場不符時以現場為準。)`;
	if (agent === "claude") {
		process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
	} else if (agent === "codex") {
		process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
	} else {
		process.stdout.write(text);
	}
}

async function main() {
	switch (cmd) {
		case "brief": {
			const cwd = flag("cwd", process.cwd());
			process.stdout.write((await api(`/api/brief?cwd=${encodeURIComponent(cwd)}`)) + "\n");
			break;
		}
		case "ask": {
			const cwd = flag("cwd", process.cwd());
			const agent = flag("agent", process.env.STEWARD_AGENT ?? "cli");
			const r = JSON.parse(await post("/api/ask", { cwd, question: args.join(" "), agent }));
			process.stdout.write(`[${r.project}] ${r.answer}\n`);
			break;
		}
		case "report": {
			const cwd = flag("cwd", process.cwd());
			const agent = flag("agent", process.env.STEWARD_AGENT ?? "cli");
			const r = JSON.parse(await post("/api/report", { cwd, text: args.join(" "), agent }));
			process.stdout.write(`[${r.project}] ${r.answer}\n`);
			break;
		}
		case "board": {
			const url = BASE.replace("127.0.0.1", "localhost") + "/";
			try {
				execFileSync("open", [url]);
			} catch {
				/* 非 macOS */
			}
			process.stdout.write(url + "\n");
			break;
		}
		case "hook":
			await hook(args[0] ?? "generic");
			break;
		case "mcp": {
			const { runMcp } = await import("./mcp.mjs");
			await runMcp(BASE);
			break;
		}
		default:
			process.stdout.write("用法:steward brief | ask \"問題\" | report \"做了什麼\" | board | hook <agent> | mcp\n");
			process.exitCode = cmd ? 1 : 0;
	}
}

main().catch((e) => {
	if (cmd === "hook") return; // hook 永遠不失敗
	process.stderr.write(`steward:${e.message}\n(專案管家有在跑嗎?打開 ${BASE}/ 看看;macOS 是 launchd 的 agent-steward 服務,Windows 是工作排程器的 agent-steward)\n`);
	process.exitCode = 1;
});
