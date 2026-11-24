// 檢查 GitHub 上的最新版本
import { tr } from "./i18n.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "./agents.ts";
import { integrityStatus } from "./integrity.ts";

export const REPO = process.env.STEWARD_REPO ?? "hao-github-0216/agent-steward";

/** 目前裝的版本:release 標籤(v1.2.3)、main,或開發版的 commit */
export function currentVersion(): string {
	try { return readFileSync(join(APP_DIR, "REVISION"), "utf8").trim(); } catch { return "dev"; }
}
const isRelease = (v: string) => /^v\d+(\.\d+)*/.test(v);
function newer(a: string, b: string): boolean {
	const p = (v: string) => v.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
	const x = p(a), y = p(b);
	for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
	return false;
}

let cache: { at: number; latest: string; url: string; notes: string } | undefined;
export interface UpdateInfo { current: string; latest?: string; hasUpdate: boolean; dev: boolean; url?: string; notes?: string; error?: string; desktop: boolean; downloadUrl: string; releaseUrl: string; integrity: ReturnType<typeof integrityStatus> }

export async function checkUpdate(force = false): Promise<UpdateInfo> {
	const current = currentVersion();
	const dev = !isRelease(current);
	const mode = () => ({ desktop: process.env.STEWARD_DESKTOP === "1", downloadUrl: `https://github.com/${REPO}/releases/latest`, releaseUrl: current.startsWith("v") ? `https://github.com/${REPO}/releases/tag/${encodeURIComponent(current)}` : `https://github.com/${REPO}/releases/latest`, integrity: integrityStatus() });
	try {
		if (force || !cache || Date.now() - cache.at > 3600_000) {
			const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "agent-steward" }, signal: AbortSignal.timeout(10_000) });
			if (r.status === 404) return { ...mode(), current, dev, hasUpdate: false, error: tr("還沒有發布任何版本") };
			if (!r.ok) throw new Error(tr("GitHub 回應 {status}", { status: r.status }));
			const j = (await r.json()) as { tag_name: string; html_url: string; body?: string };
			cache = { at: Date.now(), latest: j.tag_name, url: j.html_url, notes: (j.body ?? "").slice(0, 2000) };
		}
		return { ...mode(), current, dev, latest: cache.latest, url: cache.url, notes: cache.notes, hasUpdate: !dev && newer(cache.latest, current) };
	} catch (e) {
		return { ...mode(), current, dev, hasUpdate: false, error: tr("查不到最新版本:{error}", { error: (e as Error).message }) };
	}
}
