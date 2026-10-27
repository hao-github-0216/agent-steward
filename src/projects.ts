// 從工作目錄判斷屬於哪個專案:git 根目錄 > 已登記的資料夾 > 雜務。
import { execFileSync } from "node:child_process";
import { pathInside } from "./platform.ts";
import { basename } from "node:path";
import { isPrivatePath, MISC_ROOTS } from "./config.ts";
import type { Project, Store } from "./store.ts";

export const MISC_ROOT = "(雜務)";
export const OVERVIEW_ROOT = "(總覽)";

export function gitRoot(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		}).trim() || undefined;
	} catch {
		return undefined;
	}
}

export function ensureSpecial(store: Store, root: typeof MISC_ROOT | typeof OVERVIEW_ROOT): Project {
	return (
		store.projectByRoot(root) ??
		store.addProject({
			root,
			name: root === MISC_ROOT ? "雜務" : "總覽",
			kind: root === MISC_ROOT ? "misc" : "overview",
			status: "active",
			private: false,
		})
	);
}

/**
 * 找出 cwd 所屬的專案。非 git、也沒登記過的資料夾會建立一筆 pending,
 * 在看板上問使用者要不要登記;決定前先歸到雜務。
 */
export function resolveProject(store: Store, cwd: string): Project {
	if (!cwd || MISC_ROOTS.includes(cwd.replace(/\/$/, ""))) return ensureSpecial(store, MISC_ROOT);

	// 已登記的資料夾(含它的子資料夾),取最長的那個
	const registered = store
		.projects()
		.filter((p) => p.kind === "project" && p.status === "active" && pathInside(cwd, p.root))
		.sort((a, b) => b.root.length - a.root.length)[0];

	const root = gitRoot(cwd);
	if (root && !MISC_ROOTS.includes(root)) {
		if (registered && registered.root.length >= root.length) return active(store, registered);
		return active(store, store.projectByRoot(root) ?? store.addProject({ root, name: basename(root), kind: "project", status: "active", private: isPrivatePath(root) }));
	}
	if (registered) return active(store, registered);

	// 非 git、沒登記:記一筆 pending(同一個資料夾只問一次),目前先歸雜務
	if (!store.projectByRoot(cwd)) {
		store.addProject({ root: cwd, name: basename(cwd), kind: "project", status: "pending", private: isPrivatePath(cwd) });
	}
	return ensureSpecial(store, MISC_ROOT);
}

/**
 * 這個資料夾「最貼近」的追蹤中專案(不建立任何紀錄,給跳轉/計數用)。
 * 子專案(拆出來的資料夾、巢狀 git repo)優先於上層,所以 course/hw2 的窗格不會算到 course。
 */
export function ownerOf(store: Store, cwd: string): Project | undefined {
	return store
		.projects()
		.filter((p) => p.kind === "project" && p.status === "active" && pathInside(cwd, p.root))
		.sort((a, b) => b.root.length - a.root.length)[0];
}

function active(store: Store, p: Project): Project {
	if (p.status === "ignored") return ensureSpecial(store, MISC_ROOT);
	if (p.status === "pending") return ensureSpecial(store, MISC_ROOT);
	return p;
}
