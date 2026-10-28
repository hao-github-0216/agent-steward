// 極簡 MCP stdio server(JSON-RPC 2.0,一行一則),把管家的 brief / ask / report 包成工具。
// 不依賴 MCP SDK:所有 agent 都能用同一支 `steward mcp`。
import { createInterface } from "node:readline";

const TOOLS = [
	{
		name: "steward_brief",
		description: "取得專案管家對某個專案的進度簡報(目前做到哪、下一步、卡點、決定、最近其他 agent 做了什麼)。開始新工作前先呼叫。",
		inputSchema: { type: "object", properties: { project: { type: "string", description: "要看別的專案時填專案名稱(用 steward_projects 查);不填就是目前資料夾的專案" }, cwd: { type: "string", description: "專案目錄(預設用目前工作目錄)" } } },
	},
	{
		name: "steward_ask",
		description: "問專案管家關於專案的問題(例如某個決定的來由、別的 agent 做過什麼)。要問別的專案就填 project(問答會記在目前這個專案)。",
		inputSchema: { type: "object", properties: { question: { type: "string" }, project: { type: "string", description: "要問別的專案時填專案名稱(用 steward_projects 查);不填就是目前資料夾的專案" }, cwd: { type: "string" } }, required: ["question"] },
	},
	{
		name: "steward_projects",
		description: "列出專案管家追蹤的所有專案(名稱、位置、目前進度)。要問或參考別的專案時先用這個找名稱和位置;需要細節可以直接去讀那個專案的檔案。隱私專案只列名稱、不開放查詢。",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "steward_report",
		description: "主動向專案管家回報重要進展或決定。平常不必呼叫(管家會自動讀對話記錄),只在需要強調時用。",
		inputSchema: { type: "object", properties: { text: { type: "string" }, cwd: { type: "string" } }, required: ["text"] },
	},
];

export async function runMcp(base) {
	const cwd0 = process.env.PWD ?? process.cwd();
	const agent = process.env.STEWARD_AGENT ?? "mcp";
	const call = async (path, init) => {
		const res = await fetch(base + path, { ...init, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(300_000) });
		const text = await res.text();
		if (!res.ok) throw new Error(text.slice(0, 300));
		return text;
	};
	const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
	const rl = createInterface({ input: process.stdin });
	for await (const line of rl) {
		if (!line.trim()) continue;
		let req;
		try {
			req = JSON.parse(line);
		} catch {
			continue;
		}
		const { id, method, params } = req;
		if (id === undefined) continue; // notification
		try {
			if (method === "initialize") {
				out({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "steward", version: "0.1.0" } } });
			} else if (method === "tools/list") {
				out({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
			} else if (method === "tools/call") {
				const a = params?.arguments ?? {};
				const cwd = a.cwd ?? cwd0;
				let text;
				if (params.name === "steward_brief") text = await call(`/api/brief?cwd=${encodeURIComponent(cwd)}${a.project ? `&project=${encodeURIComponent(a.project)}` : ""}`);
				else if (params.name === "steward_ask") text = JSON.parse(await call("/api/ask", { method: "POST", body: JSON.stringify({ cwd, question: a.question, agent, ...(a.project ? { project: a.project } : {}) }) })).answer;
				else if (params.name === "steward_projects") {
					const list = JSON.parse(await call("/api/projects")).projects;
					text = list.length ? list.map((p) => (p.private ? `- ${p.name}(隱私專案,不開放查詢)` : `- ${p.name}:${p.root}${p.progress ? `\n  進度:${p.progress}` : ""}`)).join("\n") : "還沒有追蹤任何專案";
				}
				else if (params.name === "steward_report") text = JSON.parse(await call("/api/report", { method: "POST", body: JSON.stringify({ cwd, text: a.text, agent }) })).answer;
				else throw new Error(`unknown tool ${params.name}`);
				out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
			} else if (method === "ping") {
				out({ jsonrpc: "2.0", id, result: {} });
			} else {
				out({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
			}
		} catch (e) {
			if (method === "tools/call") out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `管家無法回應:${e.message}` }], isError: true } });
			else out({ jsonrpc: "2.0", id, error: { code: -32000, message: String(e.message ?? e) } });
		}
	}
}
