// 把 herdr 側邊欄 agents 清單限制在目前 space(current),或還原成全部(all)。macOS / Windows 共用。
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const SOURCE = `plugin:${process.env.HERDR_PLUGIN_ID ?? "local.current-space-agents"}`;
const mode = process.argv[2] ?? "current";
const req = mode === "all"
	? { id: "view_clear", method: "agent.view.clear", params: { source: SOURCE } }
	: { id: "view_set", method: "agent.view.set", params: { source: SOURCE, label: "this space", filter: { op: "eq", field: "workspace_id", value: { context: "current_workspace_id" } } } };

const cfgDir = process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "herdr")
	: process.platform === "win32" ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "herdr")
	: join(homedir(), ".config", "herdr");
let path = process.env.HERDR_SOCKET_PATH ?? join(cfgDir, "herdr.sock");
if (process.platform === "win32" && !path.startsWith("\\\\.\\pipe\\")) path = `\\\\.\\pipe\\${path}`;
const s = net.connect(path, () => s.end(`${JSON.stringify(req)}\n`));
let buf = "";
s.on("data", (d) => { buf += d; });
s.on("end", () => { const line = buf.split("\n")[0].trim(); console.log(line); process.exit(line.includes('"result"') ? 0 : 1); });
s.on("error", (e) => { console.error(e.message); process.exit(1); });
