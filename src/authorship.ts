// 工作卡的作者與使用者修改紀錄:哪些字是使用者寫的、哪些是管家擬的。
// 給外部工具(例如依使用者習慣整理 agent skill)判斷「這是使用者的意思」用;管家本身不讀。

export type CardAuthor = "user" | "steward";

/** 使用者改了管家擬的哪個欄位:改前是管家的版本,改後是使用者的版本 */
export interface UserEdit {
	field: "title" | "instructions" | "doneCriteria";
	before: string;
	after: string;
	at: string;
}

export interface CardText {
	title: string;
	instructions: string;
	doneCriteria: string;
}

const FIELDS: UserEdit["field"][] = ["title", "instructions", "doneCriteria"];
const CLIP = 4000;
const clip = (s: string) => (s.length > CLIP ? `${s.slice(0, CLIP)}…` : s);

export function textOf(c: CardText): CardText {
	return { title: c.title, instructions: c.instructions, doneCriteria: c.doneCriteria };
}

/** 比對兩個版本,回傳有變的欄位(空白差異不算) */
export function diffEdits(before: CardText, after: CardText, at = new Date().toISOString()): UserEdit[] {
	const out: UserEdit[] = [];
	for (const field of FIELDS) {
		const b = String(before[field] ?? "").trim();
		const a = String(after[field] ?? "").trim();
		if (b !== a) out.push({ field, before: clip(b), after: clip(a), at });
	}
	return out;
}

/** 接上新的修改;同一欄位多次修改保留最早的 before 與最新的 after,避免越存越多 */
export function mergeEdits(prev: UserEdit[] | undefined, next: UserEdit[]): UserEdit[] {
	const out = [...(prev ?? [])];
	for (const e of next) {
		const i = out.findIndex((x) => x.field === e.field);
		if (i < 0) out.push(e);
		else out[i] = { ...out[i], after: e.after, at: e.at };
	}
	return out.filter((e) => e.before !== e.after);
}
