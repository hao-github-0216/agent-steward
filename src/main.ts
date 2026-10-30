// 管家常駐程式進入點(launchd 啟動)。
import { STORE_PATH } from "./config.ts";
import { justAnswered } from "./followup.ts";
import { notify } from "./notify.ts";
import { ensureSpecial, MISC_ROOT, OVERVIEW_ROOT } from "./projects.ts";
import { startServer } from "./server.ts";
import { Steward } from "./steward.ts";
import { Store } from "./store.ts";
import { Watcher } from "./watcher.ts";
import { publicUrl } from "./config.ts";
import { settings } from "./settings.ts";

// 第一次執行時建立設定檔(從這台電腦偵測 Tailscale、pi、Hermes)
settings();

// 診斷:記錄模型請求在網路層失敗的真正原因(OpenAI SDK 只回 "Connection error.")
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
	try {
		return await realFetch(input, init);
	} catch (e) {
		const err = e as { message?: string; cause?: { code?: string; message?: string } };
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		console.error(new Date().toISOString(), "[fetch] 失敗", url.slice(0, 80), err.message, "|", err.cause?.code, err.cause?.message);
		throw e;
	}
}) as typeof fetch;

const store = new Store(STORE_PATH);
ensureSpecial(store, MISC_ROOT);
ensureSpecial(store, OVERVIEW_ROOT);

// 推播裡附的看板網址(設定頁可改;Tailscale serve 的 https 網址會自動偵測)
const boardUrl = () => publicUrl();

const steward = new Steward({
	store,
	onCardProposed: (card, project) => {
		void notify(`🗂 專案管家提案(${project.name})\n${card.title}\n→ 交給 ${card.agent}\n完成標準:${card.doneCriteria}\n\n到看板核准:${boardUrl()}`, { projectId: project.id });
	},
});
await steward.open();

// 卡片被標成卡住時推播;派出去的工作做完了只推 iPhone app(其他管道維持原本的量)
const idsIn = (col: string) => new Set(store.cards().filter((c) => c.column === col).map((c) => c.id));
let lastBlocked = idsIn("blocked");
let lastDone = idsIn("done");
store.onChange((what) => {
	if (what !== "cards") return;
	const now = idsIn("blocked");
	for (const id of now) {
		if (lastBlocked.has(id)) continue;
		const c = store.card(id)!;
		const p = store.project(c.projectId);
		void notify(`⚠️ 工作卡卡住(${p?.name ?? "?"})\n${c.title}\n${c.note ?? ""}\n\n${boardUrl()}`, { projectId: c.projectId });
	}
	lastBlocked = now;
	const done = idsIn("done");
	for (const id of done) {
		if (lastDone.has(id)) continue;
		const c = store.card(id)!;
		if (!c.paneId) continue; // 沒派出去過(例如直接拖到完成)就不吵
		const p = store.project(c.projectId);
		// 追問有回覆:推回覆的開頭
		const reply = justAnswered(c) ? c.thread!.at(-1)!.text : undefined;
		void notify(reply ? `💬 追問有回覆(${p?.name ?? "?"})\n${c.title}\n${reply.slice(0, 300)}` : `✅ 工作完成(${p?.name ?? "?"})\n${c.title}\n${(c.note ?? "").slice(0, 300)}`, { projectId: c.projectId, iphoneOnly: true });
	}
	lastDone = done;
});

// 總覽:跨專案提醒(規則判斷,不呼叫模型),一天最多推一次
const DAY = 86_400_000;
let lastDigestDay = "";
function digest(): void {
	const today = new Date().toISOString().slice(0, 10);
	if (today === lastDigestDay) return;
	const now = Date.now();
	const age = (iso?: string) => (iso ? now - Date.parse(iso) : Infinity);
	const lines: string[] = [];
	for (const c of store.cards()) {
		const p = store.project(c.projectId)?.name ?? "?";
		if (c.column === "blocked" && age(c.updatedAt) > DAY) lines.push(`⚠️ ${p}:「${c.title}」卡住 ${Math.floor(age(c.updatedAt) / DAY)} 天`);
		if (c.column === "proposed" && age(c.createdAt) > 2 * DAY) lines.push(`🗂 ${p}:提案「${c.title}」等核准 ${Math.floor(age(c.createdAt) / DAY)} 天`);
	}
	for (const p of store.projects()) {
		if (p.kind !== "project" || p.status !== "active" || !p.state.blockers.length) continue;
		const idle = age(p.lastActivityAt ?? p.state.updatedAt);
		if (idle > 3 * DAY && idle < 30 * DAY) lines.push(`⏸ ${p.name}:${Math.floor(idle / DAY)} 天沒進展,卡在「${p.state.blockers[0]}」`);
	}
	if (!lines.length) return;
	lastDigestDay = today;
	void notify(`📋 專案管家每日提醒\n${lines.slice(0, 12).join("\n")}\n\n${boardUrl()}`);
}
setInterval(digest, 6 * 3_600_000);
setTimeout(digest, 60_000);

const watcher = new Watcher(store, steward);
watcher.start();
startServer(store, steward, watcher);

const shutdown = async () => {
	watcher.stop();
	await steward.close().catch(() => undefined);
	process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
