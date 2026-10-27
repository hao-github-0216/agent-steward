// 開場簡報:直接從狀態檔組出來,不呼叫模型,所以 hook 裡也能瞬間回應。
import type { Project, Store } from "./store.ts";

export const ago = (iso?: string) => {
	if (!iso) return "";
	const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
	if (m < 60) return `${m} 分鐘前`;
	if (m < 60 * 24) return `${Math.round(m / 60)} 小時前`;
	return `${Math.round(m / 1440)} 天前`;
};

export function brief(store: Store, p: Project, opts: { recent?: number } = {}): string {
	const s = p.state;
	const cards = store.cards(p.id).filter((c) => ["proposed", "approved", "running", "blocked"].includes(c.column));
	const lines: string[] = [];
	lines.push(`# 專案管家簡報:${p.name}${p.kind === "project" ? `(${p.root})` : ""}`);
	if (!s.updatedAt && !cards.length) {
		lines.push("管家還沒有這個專案的紀錄。收工後它會自動從對話記錄整理進度。");
		return lines.join("\n");
	}
	if (s.goal) lines.push(`**目標**:${s.goal}`);
	if (s.progress) lines.push(`**目前進度**(更新於 ${ago(s.updatedAt)}):${s.progress}`);
	const list = (title: string, items: string[]) => {
		if (items.length) lines.push(`**${title}**\n${items.map((i) => `- ${i}`).join("\n")}`);
	};
	list("下一步", s.nextSteps);
	list("卡住的地方", s.blockers);
	list("重要決定", s.decisions.slice(-8));
	if (cards.length) {
		const col: Record<string, string> = { proposed: "待核准", approved: "已核准", running: "進行中", blocked: "卡住" };
		lines.push(`**工作卡**\n${cards.map((c) => `- [${c.id}] ${col[c.column]}:${c.title}(${c.agent}${c.paneId ? ` @ ${c.paneId}` : ""})${c.note ? `|${c.note}` : ""}`).join("\n")}`);
	}
	const recent = s.recent.slice(0, opts.recent ?? 4);
	if (recent.length) lines.push(`**最近的工作**\n${recent.map((r) => `- ${ago(r.at)} ${r.agent}:${r.summary}`).join("\n")}`);
	lines.push('(要問細節可用 `steward ask "…"`;做完一段落管家會自動記錄,不必手動回報。)');
	return lines.join("\n\n");
}
