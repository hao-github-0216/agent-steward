// 管家的宿主端狀態:專案登記、每個專案的進度狀態、工作卡、對話記錄讀取進度。
// 存成一個 JSON 檔,寫入走「寫暫存檔再 rename」確保不會寫一半。
// (管家自己的對話記憶在 pi durable 的 SQLite 裡,這裡只放要被快速讀取、給看板與簡報用的結構化狀態。)
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type ProjectKind = "project" | "misc" | "overview";
export type ProjectStatus = "active" | "pending" | "ignored";

export interface ProjectState {
	goal: string;
	progress: string; // 目前做到哪
	nextSteps: string[];
	decisions: string[];
	blockers: string[];
	recent: { at: string; agent: string; summary: string }[]; // 最近的 session 摘要,新的在前
	updatedAt: string;
}

export interface Project {
	id: string;
	root: string; // 專案根目錄(misc / overview 為虛擬名稱)
	name: string;
	kind: ProjectKind;
	status: ProjectStatus; // pending = 非 git 資料夾,等使用者決定要不要登記
	private: boolean; // 符合 privacy-paths → 走本地模型
	conversationId?: string;
	state: ProjectState;
	lastActivityAt?: string;
	lastProposalCheckAt?: string;
	// 一對一綁定的 herdr space(ID 可能在 herdr 重啟後改變,所以也記名稱,用來找回)
	spaceId?: string;
	spaceLabel?: string;
	createdAt: string;
}

export type CardColumn = "proposed" | "approved" | "running" | "blocked" | "done" | "rejected";

export interface Card {
	id: string;
	projectId: string;
	title: string;
	agent: string; // 建議交給哪個 agent(pi / claude / codex / opencode ...)
	instructions: string;
	doneCriteria: string;
	column: CardColumn;
	note?: string; // 最新狀態說明(例如卡住原因)
	paneId?: string; // 派工後的 herdr 窗格
	attempts?: number; // 派工次數(重新派工會加一)
	terminalId?: string; // herdr 終端機 ID:窗格搬到別的 space 時 paneId 會變,這個不會
	createdAt: string;
	updatedAt: string;
}

export interface SourceCursor {
	// 某個 agent session 的對話記錄已讀到哪裡
	offset: number;
	lastReportAt?: string;
}

interface Data {
	version: 1;
	projects: Record<string, Project>;
	cards: Record<string, Card>;
	cursors: Record<string, SourceCursor>;
}

export function emptyState(): ProjectState {
	return { goal: "", progress: "", nextSteps: [], decisions: [], blockers: [], recent: [], updatedAt: "" };
}

export class Store {
	private data: Data;
	private listeners = new Set<(what: string) => void>();

	private readonly path: string;
	constructor(path: string) {
		this.path = path;
		mkdirSync(dirname(path), { recursive: true });
		this.data = existsSync(path)
			? (JSON.parse(readFileSync(path, "utf8")) as Data)
			: { version: 1, projects: {}, cards: {}, cursors: {} };
	}

	onChange(fn: (what: string) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private save(what: string): void {
		const tmp = `${this.path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.data, null, 1));
		renameSync(tmp, this.path);
		for (const fn of this.listeners) {
			try {
				fn(what);
			} catch {
				/* 監聽者出錯不影響存檔 */
			}
		}
	}

	// ---------- 專案 ----------
	projects(): Project[] {
		return Object.values(this.data.projects);
	}
	project(id: string): Project | undefined {
		return this.data.projects[id];
	}
	projectByRoot(root: string): Project | undefined {
		return this.projects().find((p) => p.root === root);
	}
	addProject(p: Omit<Project, "id" | "createdAt" | "state"> & { state?: ProjectState }): Project {
		const project: Project = { ...p, id: randomUUID(), createdAt: new Date().toISOString(), state: p.state ?? emptyState() };
		this.data.projects[project.id] = project;
		this.save("projects");
		return project;
	}
	updateProject(id: string, patch: Partial<Project>): Project {
		const p = this.data.projects[id];
		if (!p) throw new Error(`unknown project ${id}`);
		Object.assign(p, patch);
		this.save("projects");
		return p;
	}
	updateState(id: string, patch: Partial<ProjectState>): ProjectState {
		const p = this.data.projects[id];
		if (!p) throw new Error(`unknown project ${id}`);
		p.state = { ...p.state, ...patch, updatedAt: new Date().toISOString() };
		this.save("state");
		return p.state;
	}

	// ---------- 工作卡 ----------
	cards(projectId?: string): Card[] {
		const all = Object.values(this.data.cards);
		return projectId ? all.filter((c) => c.projectId === projectId) : all;
	}
	card(id: string): Card | undefined {
		return this.data.cards[id];
	}
	addCard(c: Omit<Card, "id" | "createdAt" | "updatedAt" | "column"> & { column?: CardColumn }): Card {
		const now = new Date().toISOString();
		const card: Card = { column: "proposed", ...c, id: randomUUID().slice(0, 8), createdAt: now, updatedAt: now };
		this.data.cards[card.id] = card;
		this.save("cards");
		return card;
	}
	updateCard(id: string, patch: Partial<Card>): Card {
		const c = this.data.cards[id];
		if (!c) throw new Error(`unknown card ${id}`);
		Object.assign(c, patch, { updatedAt: new Date().toISOString() });
		this.save("cards");
		return c;
	}

	// ---------- 對話記錄讀取進度 ----------
	cursor(key: string): SourceCursor | undefined {
		return this.data.cursors[key];
	}
	setCursor(key: string, cursor: SourceCursor): void {
		this.data.cursors[key] = cursor;
		this.save("cursors");
	}
}
