// 專案 ↔ herdr space 一對一:綁定、建立、沿用、改名、搬窗格、整理計畫。
// 規則:管家永遠不關閉 space 或窗格;搬窗格用 herdr 的 pane.move(程序不中斷,但窗格 ID 會變)。
import { connect } from "node:net";
import { HERDR_SOCKET } from "./config.ts";
import { herdrCli, listPanes, listWorkspaces, type HerdrPane, type HerdrWorkspace } from "./herdr.ts";
import { ownerOf } from "./projects.ts";
import type { Project, Store } from "./store.ts";

/** 直接打 herdr socket(CLI 沒有 pane.move) */
export function herdrRpc(method: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<any> {
	return new Promise((resolve, reject) => {
		const s = connect(HERDR_SOCKET);
		let buf = "";
		const timer = setTimeout(() => {
			s.destroy();
			reject(new Error(`herdr ${method} 逾時`));
		}, timeoutMs);
		s.on("data", (d) => {
			buf += d;
			const i = buf.indexOf("\n");
			if (i >= 0) {
				clearTimeout(timer);
				s.end();
				try {
					resolve(JSON.parse(buf.slice(0, i)));
				} catch (e) {
					reject(e);
				}
			}
		});
		s.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		s.write(JSON.stringify({ id: `steward-${Date.now()}`, method, params }) + "\n");
	});
}

const norm = (s?: string) => (s ?? "").trim().toLowerCase();

/** 檢查綁定是否還有效;ID 不見了先用名稱找回,找不到就解除綁定。回傳目前的 space(或 undefined) */
export function boundSpace(store: Store, p: Project, spaces: HerdrWorkspace[] = listWorkspaces()): HerdrWorkspace | undefined {
	if (!p.spaceId && !p.spaceLabel) return undefined;
	const byId = spaces.find((w) => w.workspace_id === p.spaceId);
	if (byId) {
		if (byId.label && byId.label !== p.spaceLabel) store.updateProject(p.id, { spaceLabel: byId.label });
		return byId;
	}
	const byLabel = p.spaceLabel ? spaces.find((w) => norm(w.label) === norm(p.spaceLabel)) : undefined;
	if (byLabel && !store.projects().some((x) => x.id !== p.id && x.spaceId === byLabel.workspace_id)) {
		store.updateProject(p.id, { spaceId: byLabel.workspace_id });
		return byLabel;
	}
	store.updateProject(p.id, { spaceId: undefined, spaceLabel: undefined }); // space 被關掉了:解除綁定
	return undefined;
}

/** 某個 space 綁給了哪個專案 */
export function projectOfSpace(store: Store, spaceId: string): Project | undefined {
	return store.projects().find((p) => p.kind === "project" && p.status === "active" && p.spaceId === spaceId);
}

export function bind(store: Store, p: Project, w: HerdrWorkspace): Project {
	return store.updateProject(p.id, { spaceId: w.workspace_id, spaceLabel: w.label ?? p.name });
}

/** 建立一個新 space(停在專案資料夾的 shell tab),回傳 space 與它的第一個窗格 */
export function createSpace(label: string, cwd: string): { space: HerdrWorkspace; paneId?: string } {
	const res = herdrCli(["workspace", "create", "--label", label, "--cwd", cwd, "--no-focus"]);
	const w = res?.result?.workspace;
	if (!w?.workspace_id) throw new Error(`建立 space 失敗:${JSON.stringify(res?.error ?? res).slice(0, 200)}`);
	const paneId = res?.result?.root_pane?.pane_id ?? (listPanes() ?? []).find((x) => x.workspace_id === w.workspace_id)?.pane_id;
	return { space: { workspace_id: w.workspace_id, label: w.label ?? label }, paneId };
}

/**
 * 確保專案有自己的 space:已綁定就用;沒有就沿用「同名且沒綁給別人」的 space;都沒有就建新的。
 * 派工、跳轉時呼叫(space 被關掉後會在這裡自動重建)。
 */
export function ensureSpace(store: Store, p: Project): { space: HerdrWorkspace; created: boolean; paneId?: string } {
	const spaces = listWorkspaces();
	const bound = boundSpace(store, p, spaces);
	if (bound) return { space: bound, created: false };
	const same = spaces.find((w) => norm(w.label) === norm(p.name) && !projectOfSpace(store, w.workspace_id));
	if (same) {
		bind(store, p, same);
		return { space: same, created: false };
	}
	const { space, paneId } = createSpace(p.name, p.root);
	bind(store, p, space);
	return { space, created: true, paneId };
}

/** 屬於這個專案、但不在它綁定的 space 裡的窗格 */
export function strayPanes(store: Store, p: Project, panes: HerdrPane[] = listPanes() ?? []): HerdrPane[] {
	if (!p.spaceId) return [];
	return panes.filter((x) => ownerOf(store, x.foreground_cwd ?? x.cwd ?? "")?.id === p.id && x.workspace_id !== p.spaceId);
}

/**
 * 把窗格搬到某個 space 的新 tab(沿用原本 tab 的名稱)。程序不中斷;搬完窗格 ID 會變,
 * 這裡順便更新所有記著舊 ID 的工作卡。
 */
export async function movePane(store: Store, pane: HerdrPane, spaceId: string): Promise<string> {
	const label = (herdrCli(["tab", "get", pane.tab_id])?.result?.tab?.label as string | undefined) ?? "moved";
	const res = await herdrRpc("pane.move", { pane_id: pane.pane_id, destination: { type: "new_tab", workspace_id: spaceId, label }, focus: false });
	if (res?.error) throw new Error(`搬 ${pane.pane_id} 失敗:${res.error.message ?? JSON.stringify(res.error)}`);
	const newId: string | undefined = res?.result?.move_result?.pane?.pane_id;
	if (!newId) throw new Error(`搬 ${pane.pane_id} 後找不到新窗格`);
	for (const c of store.cards()) if (c.paneId === pane.pane_id) store.updateCard(c.id, { paneId: newId });
	return newId;
}

// ---------- 整理計畫 ----------

export type TidyAction = "bind" | "create" | "keep" | "skip";
export interface TidyRow {
	projectId: string;
	project: string;
	action: TidyAction; // bind=綁定現有 space;create=新建 space;keep=已綁定,只搬窗格;skip=不處理
	spaceId?: string; // bind/keep 時的目標
	spaceLabel?: string; // 目標 space 名稱(create 時是要建的名稱)
	moves: { paneId: string; tab: string; from: string }[]; // 要搬過去的窗格
	reason: string;
	nameDiffers?: boolean;
}

/** 產生整理計畫(只讀,不動任何東西) */
export function tidyPlan(store: Store): TidyRow[] {
	const spaces = listWorkspaces();
	const panes = listPanes() ?? [];
	const label = (id: string) => spaces.find((w) => w.workspace_id === id)?.label ?? id;
	const tabLabel = (pane: HerdrPane) => (herdrCli(["tab", "get", pane.tab_id])?.result?.tab?.label as string | undefined) ?? pane.tab_id;
	const projects = store.projects().filter((p) => p.kind === "project" && p.status === "active");
	for (const p of projects) boundSpace(store, p, spaces);

	// 每個專案的窗格分布在哪些 space
	const owned = new Map<string, HerdrPane[]>();
	for (const pane of panes) {
		const o = ownerOf(store, pane.foreground_cwd ?? pane.cwd ?? "");
		if (o) owned.set(o.id, [...(owned.get(o.id) ?? []), pane]);
	}
	// 每個 space 裡各專案的窗格數
	const perSpace = new Map<string, Map<string, number>>();
	for (const [pid, list] of owned) for (const pane of list) {
		const m = perSpace.get(pane.workspace_id) ?? new Map<string, number>();
		m.set(pid, (m.get(pid) ?? 0) + 1);
		perSpace.set(pane.workspace_id, m);
	}

	// 決定每個 space 歸誰:已綁定的優先;其次名稱相同的專案;再其次窗格最多的專案
	const claim = new Map<string, string>(); // spaceId → projectId
	for (const p of projects) if (p.spaceId) claim.set(p.spaceId, p.id);
	for (const w of spaces) {
		if (claim.has(w.workspace_id)) continue;
		const counts = perSpace.get(w.workspace_id);
		const named = projects.find((p) => !p.spaceId && norm(p.name) === norm(w.label));
		if (named && ![...claim.values()].includes(named.id)) {
			claim.set(w.workspace_id, named.id);
			continue;
		}
		if (!counts) continue; // 沒有專案窗格的 space(例如 work)不動
		const best = [...counts.entries()].filter(([pid]) => !projects.find((p) => p.id === pid)?.spaceId && ![...claim.values()].includes(pid)).sort((a, b) => b[1] - a[1])[0];
		if (best) claim.set(w.workspace_id, best[0]);
	}

	const rows: TidyRow[] = [];
	for (const p of projects) {
		const list = owned.get(p.id) ?? [];
		const mine = [...claim.entries()].find(([, pid]) => pid === p.id)?.[0];
		const target = p.spaceId ?? mine;
		if (!target) {
			if (!list.length) {
				rows.push({ projectId: p.id, project: p.name, action: "skip", moves: [], reason: "目前沒有開著的窗格;之後跳轉或派工時才建 space" });
				continue;
			}
			rows.push({
				projectId: p.id,
				project: p.name,
				action: "create",
				spaceLabel: p.name,
				moves: list.map((x) => ({ paneId: x.pane_id, tab: tabLabel(x), from: label(x.workspace_id) })),
				reason: `窗格和別的專案混在 ${[...new Set(list.map((x) => label(x.workspace_id)))].join("、")}:新建「${p.name}」space 並搬過去`,
			});
			continue;
		}
		const moves = list.filter((x) => x.workspace_id !== target).map((x) => ({ paneId: x.pane_id, tab: tabLabel(x), from: label(x.workspace_id) }));
		const tl = label(target);
		rows.push({
			projectId: p.id,
			project: p.name,
			action: p.spaceId ? "keep" : "bind",
			spaceId: target,
			spaceLabel: tl,
			moves,
			nameDiffers: norm(tl) !== norm(p.name),
			reason: p.spaceId
				? moves.length ? `已綁定「${tl}」,有 ${moves.length} 個窗格在別的 space` : `已綁定「${tl}」,沒有要搬的`
				: `綁定現有的「${tl}」space${moves.length ? `,並把 ${moves.length} 個窗格搬過來` : ""}`,
		});
	}
	// 搬完之後會被搬空的 space(herdr 會自動移除空的 space):綁在上面又沒有自己窗格的專案改成略過
	const leaving = new Set(rows.flatMap((r) => r.moves.map((m) => m.paneId)));
	for (const r of rows) {
		if (r.action !== "bind" || !r.spaceId || (owned.get(r.projectId) ?? []).length) continue;
		const remaining = panes.filter((x) => x.workspace_id === r.spaceId && !leaving.has(x.pane_id)).length;
		if (!remaining) {
			r.action = "skip";
			r.reason = `沒有自己的窗格;「${r.spaceLabel}」裡的窗格都會搬給子專案,搬空後 herdr 會自動移除這個 space。之後要用時再建`;
			r.spaceId = undefined;
		}
	}
	return rows;
}

/** 執行使用者確認過的整理列 */
export async function runTidy(store: Store, rows: TidyRow[]): Promise<string[]> {
	const log: string[] = [];
	const panes = listPanes() ?? [];
	for (const r of rows) {
		const p = store.project(r.projectId);
		if (!p || r.action === "skip") continue;
		try {
			let spaceId = r.spaceId;
			let moves = r.moves;
			if (r.action === "create") {
				const first = moves.map((m) => panes.find((x) => x.pane_id === m.paneId)).find(Boolean);
				const name = r.spaceLabel ?? p.name;
				if (first) {
					// 第一個窗格直接搬成新 space(不會多出空的 shell tab),其餘再搬進去
					const tab = (herdrCli(["tab", "get", first.tab_id])?.result?.tab?.label as string | undefined) ?? "main";
					const res = await herdrRpc("pane.move", { pane_id: first.pane_id, destination: { type: "new_workspace", label: name, tab_label: tab }, focus: false });
					const moved = res?.result?.move_result?.pane;
					if (res?.error || !moved) throw new Error(`建立 space 失敗:${res?.error?.message ?? "沒有回應"}`);
					for (const c of store.cards()) if (c.paneId === first.pane_id) store.updateCard(c.id, { paneId: moved.pane_id });
					bind(store, p, { workspace_id: moved.workspace_id, label: name });
					spaceId = moved.workspace_id;
					moves = moves.filter((m) => m.paneId !== first.pane_id);
					log.push(`${p.name}:建立 space「${name}」,「${tab}」搬過來`);
				} else {
					const { space } = createSpace(name, p.root);
					bind(store, p, space);
					spaceId = space.workspace_id;
					log.push(`${p.name}:建立 space「${space.label}」`);
				}
			} else if (r.action === "bind" && spaceId) {
				const w = listWorkspaces().find((x) => x.workspace_id === spaceId);
				if (w) {
					bind(store, p, w);
					log.push(`${p.name}:綁定「${w.label}」`);
				}
			}
			for (const m of moves) {
				const pane = panes.find((x) => x.pane_id === m.paneId);
				if (!pane || !spaceId) continue;
				const id = await movePane(store, pane, spaceId);
				log.push(`${p.name}:「${m.tab}」從 ${m.from} 搬過來(${pane.pane_id} → ${id})`);
			}
		} catch (e) {
			log.push(`${p.name}:失敗 ${String(e).slice(0, 160)}`);
		}
	}
	return log;
}
