// 圈選提問:網頁上圈一塊畫面問管家。網頁負責取出圈到的文字(或截圖)與周圍內容;
// 終端機的部分由這裡找出是哪個 herdr 窗格,再讀那個窗格最近的輸出當前後文。
import { herdrCli, listPanes, listWorkspaces, type HerdrPane } from "./herdr.ts";

export interface SnapInfo {
	kind: "terminal" | "code" | "doc" | "page";
	label: string; // 給人看的出處:「終端機」「src/a.ts」「report.pdf 第 3 頁」
	text: string; // 圈到的內容(沒有文字時是空的,改看圖)
	context?: string; // 周圍內容(網頁取的;終端機由這裡補)
	path?: string;
	from?: number;
	to?: number;
}

const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);

/** 整理網頁送來的圈選資料 */
export function parseSnap(raw: unknown): SnapInfo | undefined {
	const s = raw as Partial<SnapInfo> | undefined;
	if (!s || typeof s !== "object") return undefined;
	const kind = (["terminal", "code", "doc", "page"] as const).find((k) => k === s.kind) ?? "page";
	return {
		kind,
		label: clip(s.label, 200) || "畫面",
		text: clip(s.text, 20_000),
		context: s.context ? clip(s.context, 12_000) : undefined,
		path: s.path ? clip(s.path, 500) : undefined,
		from: Number(s.from) || undefined,
		to: Number(s.to) || undefined,
	};
}

const readPane = (id: string, args: string[]) => {
	const r = herdrCli(["pane", "read", id, ...args]);
	return typeof r === "string" ? r : "";
};
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * 圈到的終端機文字是哪個窗格的:比對各窗格畫面上看得到的內容(herdr 的版面座標不含側欄位移,不好直接換算)。
 * 先找目前的 space,找不到再找全部;都對不上就用目前的窗格。
 */
export function findSnapPane(text: string): HerdrPane | undefined {
	const panes = listPanes() ?? [];
	if (!panes.length) return undefined;
	const lines = text.split("\n").map(squash).filter((l) => l.length >= 4).sort((a, b) => b.length - a.length).slice(0, 5);
	const ws = listWorkspaces().find((w) => w.focused)?.workspace_id;
	const score = (p: HerdrPane) => {
		const screen = squash(readPane(p.pane_id, ["--source", "visible"]));
		return lines.reduce((n, l) => n + (screen.includes(l) ? 1 : 0), 0);
	};
	const pick = (list: HerdrPane[]) => {
		let best: HerdrPane | undefined, top = 0;
		for (const p of list) {
			const s = score(p);
			if (s > top || (s === top && s > 0 && p.focused)) { best = p; top = s; }
		}
		return best;
	};
	if (lines.length) {
		const here = ws ? panes.filter((p) => p.workspace_id === ws) : [];
		const found = (here.length ? pick(here) : undefined) ?? pick(panes.filter((p) => !here.includes(p)));
		if (found) return found;
	}
	return panes.find((p) => p.focused && p.workspace_id === ws) ?? panes.find((p) => p.focused);
}

/** 終端機圈選:補上窗格最近約 100 行輸出當前後文 */
export function terminalContext(p: HerdrPane): string {
	return readPane(p.pane_id, ["--lines", "100"]).split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").trim().slice(-8000);
}

/** 給模型看的圈選段落 */
export function snapPrompt(s: SnapInfo, hasImage: boolean): string {
	const where = s.from ? `${s.label} 第 ${s.from}${s.to && s.to !== s.from ? `–${s.to}` : ""} 行` : s.label;
	const parts = [`\n\n【圈選】使用者在「${where}」圈了一塊畫面在問。回答要短、直接針對圈到的內容。`];
	if (s.text) parts.push(`圈到的內容:\n\`\`\`\n${s.text}\n\`\`\``);
	else if (hasImage) parts.push("圈到的是圖片(附在這題),沒有文字。");
	if (s.context) parts.push(`周圍的內容(參考用,不是使用者圈的):\n\`\`\`\n${s.context}\n\`\`\``);
	return parts.join("\n");
}
