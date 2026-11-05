// 補建初始狀態時篩選可參考的上層紀錄,並限制提示詞只採用與子資料夾直接相關的內容。
import { readdirSync } from "node:fs";
import { basename, relative } from "node:path";
import type { Project } from "./store.ts";

/** 資料夾裡有沒有非隱藏的檔案或資料夾;讀不了或不存在就回 false。 */
export function folderHasContent(dir: string): boolean {
	try {
		return readdirSync(dir).some((name) => !name.startsWith("."));
	} catch {
		return false;
	}
}

/** 上層專案的紀錄有沒有提到這個子資料夾。 */
export function parentMentions(parent: Project, childRoot: string): boolean {
	const normalize = (text: string) => text.toLowerCase().replace(/[\s_-]+/g, "");
	const s = parent.state;
	const text = normalize([s.goal, s.progress, ...s.nextSteps, ...s.blockers, ...s.decisions, ...s.recent.map((r) => r.summary)].join("\n"));
	const candidates = [basename(childRoot), relative(parent.root, childRoot).replace(/\\/g, "/")];
	return candidates.map(normalize).some((name) => name.length >= 2 && text.includes(name));
}

/** 有上層、資料夾有東西、上層紀錄有提到它,才把上層紀錄給模型參考。 */
export function useParentState(childRoot: string, parent: Project | undefined): boolean {
	return !!parent && folderHasContent(childRoot) && parentMentions(parent, childRoot);
}

/** 補建用的提示詞。 */
export function bootstrapMessage(name: string, root: string, parts: string[]): string {
	return `【回報】「${name}」(${root})剛登記成獨立專案。請只根據下面的資料建立它的初始狀態(呼叫 update_project_state)。
只寫跟這個資料夾直接相關的內容;資料裡找不到相關內容的欄位就不要給(保持空白),不要照抄上層專案的目標、進度、下一步或卡點。goal 只有資料裡明確寫到這個資料夾要做什麼時才填。session_summary 寫「從現有記錄補建」。
如果資料裡完全沒有跟這個資料夾有關的內容,就不要呼叫 update_project_state,直接回覆「沒有可補建的內容」。

${parts.join("\n\n")}`;
}
