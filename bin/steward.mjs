#!/usr/bin/env node
// steward:專案管家的指令列工具(純 JS,不需編譯)。
//   steward brief [--cwd DIR] [--project 名稱]   目前專案(或指定專案)的簡報
//   steward ask "問題" [--project 名稱]           問管家;指定別的專案時問答記在目前專案
//   steward projects                              列出所有專案
//   steward report "做了什麼" [--agent X] 主動回報
//   steward board                      開啟看板
//   steward branch [--here] [窗格]     從 agent 窗格開一條支線(分叉主線的對話,在新 tab 另外問);
//                                      預設開在獨立的 git worktree,--here 開在跟主線同一個資料夾
//   steward branch back [--send]       在支線裡:把結論整理成草稿,確認後帶回主線
//   steward branch close [--remove-worktree]  關掉這條支線(加參數一併移除 worktree,改動先存進支線分支)
//   steward hook <agent>               給各 agent 的 SessionStart hook 用(失敗安靜略過)
//   steward mcp                        以 MCP stdio server 執行
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
	// 雜務/總覽不注入;還沒有紀錄的專案只給 herdr 的提示,避免雜訊
	if (data.project.kind !== "project") return;
	const parts = [];
	if (data.project.state?.updatedAt) parts.push(`${data.text}\n\n(以上由專案管家自動提供,反映其他 session/agent 的最新進度;與現場不符時以現場為準。)`);
	// 窗格被搬到別的 space 後,HERDR_PANE_ID / HERDR_WORKSPACE_ID 和 herdr pane current 還是舊的位置(可能是別的專案):直接告訴 agent 這個專案的 space
	if (data.space) parts.push(`【在 herdr 開新分頁】這個專案的 herdr space 是「${data.space.label}」(${data.space.id}),資料夾 ${data.project.root}。要開新分頁或新的 agent 時用 herdr tab create --workspace ${data.space.id} --cwd "${data.project.root}" --no-focus;不要用 herdr pane current、HERDR_PANE_ID、HERDR_WORKSPACE_ID 判斷自己在哪(窗格被搬過 space 後那些還是舊的位置,會開到別的專案)。`);
	if (!parts.length) return;
	const text = parts.join("\n\n");
	if (agent === "claude") {
		process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
	} else if (agent === "codex") {
		process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
	} else {
		process.stdout.write(text);
	}
}

/** 伺服器回的錯誤訊息(api() 丟出的是「狀態碼 + 內容」) */
function errText(e) {
	const m = String(e.message ?? e).match(/^\d+ (.*)$/s);
	try {
		return JSON.parse(m?.[1] ?? "").error ?? e.message;
	} catch {
		return e.message;
	}
}

async function confirm(question) {
	if (!process.stdin.isTTY) return undefined; // 在 agent 裡用 ! 執行時沒有鍵盤可以回答
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return /^y(es)?$/i.test((await rl.question(question)).trim());
	} finally {
		rl.close();
	}
}

/**
 * 這個指令是在哪個 Claude session 裡跑的:往上找父程序的 ~/.claude/sessions/<pid>.json(找不到就 undefined)。
 * 用來認出真的窗格:窗格被搬到別的 space 後,HERDR_PANE_ID 還是舊的位置
 */
function claudeSession() {
	try {
		let pid = process.ppid;
		for (let i = 0; i < 8 && pid > 1; i++) {
			const f = join(homedir(), ".claude", "sessions", `${pid}.json`);
			if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")).sessionId || undefined;
			pid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
		}
	} catch {
		/* 沒有 ps(Windows)或不是在 Claude 裡跑 */
	}
	return undefined;
}

async function branch() {
	const sub = args[0] === "back" || args[0] === "close" ? args.shift() : "open";
	const here = process.env.HERDR_PANE_ID;
	try {
		if (sub === "open") {
			const hereOnly = args.includes("--here");
			const target = args.find((a) => !a.startsWith("--"));
			// 沒指定窗格:伺服器用 Claude session、資料夾核對環境變數(窗格搬過 space 後 HERDR_PANE_ID 會過期)
			const r = JSON.parse(await post("/api/branch", target ? { pane: target, here: hereOnly } : { pane: here, workspace: process.env.HERDR_WORKSPACE_ID, here: hereOnly, fromEnv: true, session: claudeSession(), cwd: process.cwd() }, 180_000));
			const b = r.branch;
			const where = b.worktree ? `開在獨立的 git worktree:${b.worktree.cwd}(分支 ${b.worktree.gitBranch})\n` : `開在跟主線同一個資料夾(${b.hereReason ?? "同資料夾"})\n`;
			process.stdout.write(`已開支線「${b.label}」(${b.agent},窗格 ${b.paneId})\n${where}${b.mode === "excerpt" ? "這個 agent 不能分叉(或找不到主線的 session),已經把主線最近的對話節錄送給它。\n" : "支線接著主線的對話,可以直接在那個 tab 問。\n"}問完要帶回主線:在支線裡執行 steward branch back\n${b.startupNote ? `⚠ ${b.startupNote}\n` : ""}`);
			return;
		}
		const given = args.find((a) => !a.startsWith("--"));
		const pane = given ?? here;
		const session = given ? undefined : claudeSession();
		if (!pane && !session) throw new Error("請在支線的窗格裡執行,或指定窗格 ID");
		const q = given ? `pane=${encodeURIComponent(given)}` : `pane=${encodeURIComponent(here ?? "")}&cwd=${encodeURIComponent(process.cwd())}${session ? `&session=${encodeURIComponent(session)}` : ""}`;
		const b = JSON.parse(await api(`/api/branch/at?${q}`)).branch;
		if (sub === "close") {
			await post(`/api/branch/${b.id}/close`, { removeWorktree: args.includes("--remove-worktree") });
			return;
		}
		const handoff = async (text) => {
			const r = JSON.parse(await post(`/api/branch/${b.id}/handoff`, text ? { text } : {}));
			process.stdout.write(r.status === "sent" ? "已送給主線。\n" : r.status === "queued" ? "主線正在忙,等它閒下來就會送出。\n" : `沒送出:${r.note ?? "主線已經關閉"}\n`);
			return r.status !== "failed";
		};
		if (args.includes("--send")) {
			if (!b.draft) throw new Error("還沒有草稿,先執行 steward branch back");
			await handoff();
			return;
		}
		process.stdout.write("管家正在整理支線的結論…\n");
		const draft = JSON.parse(await post(`/api/branch/${b.id}/draft`, {}, 180_000)).draft;
		process.stdout.write(`\n──── 要送回主線「${b.mainLabel}」的內容 ────\n${draft}\n────────────────\n`);
		const ok = await confirm("送出?(y/N) ");
		if (ok === undefined) {
			process.stdout.write("確認沒問題就執行:steward branch back --send(想改內容可以在網頁終端機按「帶回主線」編輯後送出)\n");
			return;
		}
		if (!ok) return void process.stdout.write("沒有送出。\n");
		if (!(await handoff())) return;
		if (await confirm("要關掉這條支線嗎?(y/N) ")) {
			const removeWorktree = b.worktree && !b.worktree.removed ? await confirm(`也移除 worktree 嗎?改動會先存進分支 ${b.worktree.gitBranch},分支保留。(y/N) `) : false;
			await post(`/api/branch/${b.id}/close`, { removeWorktree: !!removeWorktree });
		}
	} catch (e) {
		// 連不上管家照原本的提示;其他是管家回的錯誤,直接顯示
		if (/fetch failed|ECONNREFUSED/.test(String(e.message))) throw e;
		throw Object.assign(new Error(errText(e)), { known: true });
	}
}

async function main() {
	switch (cmd) {
		case "brief": {
			const cwd = flag("cwd", process.cwd());
			const project = flag("project", "");
			process.stdout.write((await api(`/api/brief?cwd=${encodeURIComponent(cwd)}${project ? `&project=${encodeURIComponent(project)}` : ""}`)) + "\n");
			break;
		}
		case "projects": {
			const list = JSON.parse(await api("/api/projects")).projects;
			process.stdout.write(list.map((p) => (p.private ? `${p.name}(隱私專案)` : `${p.name}\t${p.root}${p.progress ? `\n  ${p.progress}` : ""}`)).join("\n") + "\n");
			break;
		}
		case "ask": {
			const cwd = flag("cwd", process.cwd());
			const agent = flag("agent", process.env.STEWARD_AGENT ?? "cli");
			const project = flag("project", "");
			const r = JSON.parse(await post("/api/ask", { cwd, question: args.join(" "), agent, ...(project ? { project } : {}) }));
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
		case "branch":
			await branch();
			break;
		case "hook":
			await hook(args[0] ?? "generic");
			break;
		case "mcp": {
			const { runMcp } = await import("./mcp.mjs");
			await runMcp(BASE);
			break;
		}
		default:
			process.stdout.write("用法:steward brief | ask \"問題\" | report \"做了什麼\" | board | branch [窗格|back|close] | hook <agent> | mcp\n");
			process.exitCode = cmd ? 1 : 0;
	}
}

main().catch((e) => {
	if (cmd === "hook") return; // hook 永遠不失敗
	if (e.known) {
		process.stderr.write(`steward:${e.message}\n`);
		process.exitCode = 1;
		return;
	}
	process.stderr.write(`steward:${e.message}\n(專案管家有在跑嗎?打開 ${BASE}/ 看看;macOS 是 launchd 的 agent-steward 服務,Windows 是工作排程器的 agent-steward)\n`);
	process.exitCode = 1;
});
