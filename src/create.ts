// 從看板建立專案:選現有資料夾或新建 → 處理重複 → 建立或沿用 space → (選用)啟動 agent。
// 重複規則(使用者 2026-10-27 確認):
//  1. 資料夾已經是專案 → 不建第二個,回傳那個專案
//  2. 同名 space 存在且沒綁給任何專案 → 沿用
//  3. 同名 space 已綁給別的專案 → 衝突,建議「上層資料夾名-名稱」
//  4. 資料夾在另一個專案底下 → 視為拆出子專案;裡面已有窗格就回報數量,讓看板問要不要搬
import { execFileSync } from "node:child_process";
import { pathInside } from "./platform.ts";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { HOME, isPrivatePath, MISC_ROOTS } from "./config.ts";
import { herdrCli, listWorkspaces } from "./herdr.ts";
import { ownerOf } from "./projects.ts";
import { bind, createSpace, projectOfSpace, strayPanes } from "./spaces.ts";
import type { Steward } from "./steward.ts";
import type { Project, Store } from "./store.ts";
import type { Watcher } from "./watcher.ts";

const AGENTS: Record<string, string> = { pi: "pi", claude: "claude", codex: "codex" };

export interface CreateInput {
	path?: string; // 選現有資料夾
	parent?: string; // 或:在這個資料夾底下
	newName?: string; //     新建這個名字的資料夾
	git?: boolean;
	agent?: string; // none / pi / claude / codex
	spaceName?: string; // 專案(=space)名稱,預設用資料夾名
}

type Result = { status: number; body: Record<string, unknown> };
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Result => ({ status, body: { error, ...extra } });
const norm = (s?: string) => (s ?? "").trim().toLowerCase();

export function createProject(store: Store, steward: Steward, watcher: Watcher, b: CreateInput): Result {
	// ---------- 資料夾 ----------
	const expand = (p: string) => resolve(p.trim().replace(/^~(?=\/|$)/, HOME));
	let folder: string;
	let makeNew = false;
	if (b.newName !== undefined) {
		const name = String(b.newName).trim();
		if (!name || name.includes("/") || name.startsWith(".")) return fail(400, "資料夾名稱不能是空的,也不能有 / 或用 . 開頭");
		if (!b.parent) return fail(400, "缺少上層資料夾");
		folder = join(expand(b.parent), name);
		makeNew = true;
		if (existsSync(folder)) return fail(409, `「${name}」已經存在,請直接選它,或換一個名字`, { existing: folder });
	} else if (b.path) {
		folder = expand(b.path);
		if (!existsSync(folder) || !statSync(folder).isDirectory()) return fail(400, "資料夾不存在");
	} else return fail(400, "請選一個資料夾,或輸入新資料夾名稱");
	if (!pathInside(folder, HOME)) return fail(400, "只能用家目錄底下的資料夾");
	if (MISC_ROOTS.includes(folder)) return fail(400, "家目錄、桌面、下載這類資料夾不能當專案");

	// 規則 1:已經是專案
	const existing = store.projectByRoot(folder);
	if (existing && existing.status === "active" && existing.kind === "project") {
		return { status: 200, body: { exists: true, project: existing, message: `這個資料夾已經是專案「${existing.name}」` } };
	}

	// ---------- 名稱與 space 重複 ----------
	const name = (b.spaceName ?? "").trim() || basename(folder);
	const spaces = listWorkspaces();
	const sameSpace = spaces.find((w) => norm(w.label) === norm(name));
	const owner = sameSpace ? projectOfSpace(store, sameSpace.workspace_id) : undefined;
	const nameTaken = store.projects().find((p) => p.kind === "project" && p.status === "active" && norm(p.name) === norm(name));
	if (owner || nameTaken) {
		// 規則 3:同名 space(或同名專案)已經屬於別的專案
		const suggestion = `${basename(dirname(folder))}-${name}`;
		return fail(409, `「${name}」已經是專案「${(owner ?? nameTaken)!.name}」的 space。建議改名為「${suggestion}」`, { conflict: true, suggestion });
	}

	// ---------- 建資料夾 ----------
	if (makeNew) {
		try {
			mkdirSync(folder);
			if (b.git) execFileSync("git", ["-C", folder, "init", "-q"], { timeout: 10_000 });
		} catch (e) {
			return fail(500, `建立資料夾失敗:${String(e).slice(0, 160)}`);
		}
	}

	// 規則 4:在另一個專案底下 → 子專案(登記過的子資料夾會優先於上層)
	const parentProject = ownerOf(store, folder);

	// ---------- 專案 ----------
	let project: Project = existing
		? store.updateProject(existing.id, { status: "active", kind: "project", name })
		: store.addProject({ root: folder, name, kind: "project", status: "active", private: isPrivatePath(folder) });

	// ---------- space ----------
	let adopted = false;
	let firstPane: string | undefined;
	try {
		if (sameSpace) {
			project = bind(store, project, sameSpace); // 規則 2:沿用沒人綁的同名 space
			adopted = true;
		} else {
			const { space, paneId } = createSpace(name, folder);
			project = bind(store, project, space);
			firstPane = paneId;
		}
	} catch (e) {
		return fail(500, `專案已建立,但建立 space 失敗:${String(e).slice(0, 160)}`, { project });
	}

	// ---------- 選用:啟動 agent(背景做,不卡住回應) ----------
	const kind = AGENTS[String(b.agent ?? "")];
	if (kind) {
		setTimeout(() => {
			let pane = firstPane;
			if (!pane) {
				// 沿用的 space:另開一個停在專案資料夾的 tab
				const res = herdrCli(["tab", "create", "--workspace", project.spaceId!, "--cwd", folder, "--label", name, "--no-focus"]);
				pane = res?.result?.root_pane?.pane_id;
			}
			if (pane) herdrCli(["agent", "start", `${kind}-${basename(folder)}`.slice(0, 40), "--kind", kind, "--pane", pane, "--timeout", "60000"], 70_000);
		}, 50);
	}

	// 有既有紀錄可以參考(上層專案或已開的窗格)就補建初始狀態
	const strays = strayPanes(store, project).length;
	if (parentProject?.state.updatedAt || strays) watcher.bootstrap(project.id).catch(() => undefined);
	void steward;

	return {
		status: 200,
		body: {
			project,
			space: project.spaceLabel,
			adopted,
			subProjectOf: parentProject?.name,
			strays,
			agent: kind ?? null,
			message: adopted ? `已沿用現有的「${name}」space` : `已建立「${name}」space`,
		},
	};
}
