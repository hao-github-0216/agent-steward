// 部署更新後執行:已經接上專案管家的 agent 重新套一次設定(管家路徑變了會跟著更新)。沒接上的不動。
// 加 --remove-all:移除專案管家時,拿掉所有 agent 的整合。
import { refreshIntegrated, removeAll } from "./agents.ts";

if (process.argv.includes("--remove-all")) {
	const changed = removeAll();
	console.log(changed.length ? `已拿掉 agent 整合:\n  ${changed.join("\n  ")}` : "沒有接上的 agent");
} else {
	const changed = refreshIntegrated();
	console.log(changed.length ? `agent 整合已更新:\n  ${changed.join("\n  ")}` : "agent 整合沒有需要改的");
}
