// 隱私專案的共用規則:內容只送隱私路由的模型、跨專案只露名稱、推播不帶內容。
import { routeFor } from "./models.ts";
import type { Project } from "./store.ts";

type Role = Parameters<typeof routeFor>[0];

/** 依專案挑模型:隱私專案一律用隱私路由(沒設定就丟 NoModelError),不用備用模型 */
export function routeForProject(role: Role, opts: { private?: boolean; fallback?: boolean } = {}): { provider: string; modelId: string } {
	if (opts.private) return routeFor(role, { private: true });
	return routeFor(role, { fallback: opts.fallback });
}

/** 跨專案時對外能看的專案資料:別的專案查隱私專案只給名稱 */
export function publicProjectView(target: Project | undefined, from?: Project): Project | { name: string; private: true } | null {
	if (!target) return null;
	if (target.private && target.id !== from?.id) return { name: target.name, private: true };
	return target;
}

/** 推播文字:隱私專案用不含專案內容的通用文字 */
export function pushText(project: { private?: boolean } | undefined | null, full: string, generic: string): string {
	return project?.private ? generic : full;
}
