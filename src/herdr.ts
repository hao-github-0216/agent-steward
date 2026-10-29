// herdr 的薄包裝:用 CLI(HERDR_BIN_PATH 或 PATH 上的 herdr)。
import { execFileSync } from "node:child_process";
import { herdrBin } from "./platform.ts";

const BIN = herdrBin();

export function herdrCli(args: string[], timeoutMs = 8000): any {
	try {
		const out = execFileSync(BIN, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
		try {
			return JSON.parse(out);
		} catch {
			return out;
		}
	} catch (e: any) {
		// herdr 失敗時有時把 JSON 錯誤寫在 stderr
		const out = e?.stdout?.toString?.().trim() || e?.stderr?.toString?.().trim();
		try {
			return out ? JSON.parse(out) : { error: { message: String(e?.message ?? e) } };
		} catch {
			return { error: { message: String(e?.message ?? e) } };
		}
	}
}

export interface HerdrPane {
	pane_id: string;
	terminal_id?: string;
	tab_id: string;
	workspace_id: string;
	cwd?: string;
	foreground_cwd?: string;
	agent?: string;
	agent_status?: string;
	agent_session?: { agent: string; kind?: string; value?: string } | null;
	focused?: boolean;
}

export function listPanes(): HerdrPane[] | undefined {
	const res = herdrCli(["pane", "list"]);
	return res?.result?.panes;
}

export interface HerdrWorkspace {
	workspace_id: string;
	label?: string;
	focused?: boolean;
}

export function listWorkspaces(): HerdrWorkspace[] {
	return herdrCli(["workspace", "list"])?.result?.workspaces ?? [];
}
