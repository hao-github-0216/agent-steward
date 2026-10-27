// steward-brief:pi 每個 session 第一次送出問題時,向專案管家拿這個專案的進度簡報,
// 以隱藏訊息放進 context(和 memory-auto 同一種注入方式)。管家沒開或沒有紀錄就略過。
// 由 ~/agent-steward/integrations/install.sh 以 symlink 安裝;改動後在 pi 裡 /reload 生效。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE = process.env.STEWARD_URL ?? `http://127.0.0.1:${process.env.STEWARD_PORT ?? 8791}`;

export default function (pi: ExtensionAPI) {
	let done = false;

	pi.on("session_start", () => {
		done = false;
	});

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		if (done || event.messageType !== "user") return;
		done = true; // 每個 session 只注入一次
		try {
			const cwd = ctx.cwd ?? process.cwd();
			const res = await fetch(`${BASE}/api/brief?format=json&cwd=${encodeURIComponent(cwd)}`, { signal: AbortSignal.timeout(1500) });
			if (!res.ok) return;
			const data = (await res.json()) as { project: { kind: string; state?: { updatedAt?: string } }; text: string };
			if (data.project.kind !== "project" || !data.project.state?.updatedAt) return;
			return {
				message: {
					customType: "steward-brief",
					content: `${data.text}\n\n(以上由專案管家自動提供,反映其他 session/agent 的最新進度;與現場不符時以現場為準。)`,
					display: false,
				},
			};
		} catch {
			return; // fail-open
		}
	});
}
