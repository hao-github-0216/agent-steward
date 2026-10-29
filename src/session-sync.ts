// 讓 herdr 重開(重開機、herdr server stop、更新)後能把 Claude Code 窗格接回原本的對話。
//
// herdr 重開時會對「有記錄對話 ID」的窗格自動執行 `claude --resume <id>`。ID 本來是 herdr 的
// Claude hook 回報的,但 Claude Code 把對話跑在背景程式時,hook 在背景程式裡拿不到窗格編號,
// 什麼都沒回報 → 重開後那些窗格只剩空的 shell。
// 這裡由管家補上:用 transcripts.ts 的對應邏輯找出窗格的對話 ID,照官方 hook 的格式回報給 herdr。
//  - 沒有 ID 的 Claude 窗格:每輪都找
//  - 已經有 ID 的:每 90 秒對一次,換了對話(/clear、開新對話)就更新,免得下次接回舊的
//  - 對不出唯一的對話就不回報(猜錯比沒有更糟)
import { herdrCli, type HerdrPane } from "./herdr.ts";
import { claudeSessionOfPane, transcriptPath } from "./transcripts.ts";

const RECHECK_MS = 90_000;

export interface SessionSyncDeps {
	resolve: (pane: HerdrPane) => string | undefined;
	report: (pane: HerdrPane, sessionId: string, replacing: boolean) => boolean;
	now: () => number;
}

/**
 * 照官方 Claude hook 的格式回報(source herdr:claude、奈秒 seq),herdr 才會在重開時用它接回對話。
 * 窗格已經有別的 ID 時要帶 --session-start-source,herdr 才肯換(不帶會默默忽略,實測過)。
 */
function reportToHerdr(pane: HerdrPane, sessionId: string, replacing: boolean): boolean {
	const seq = (BigInt(Date.now()) * 1_000_000n).toString();
	const args = ["pane", "report-agent-session", "--source", "herdr:claude", "--agent", "claude", "--seq", seq, "--agent-session-id", sessionId];
	const path = transcriptPath({ agent: "claude", kind: "id", value: sessionId });
	if (path) args.push("--agent-session-path", path);
	if (replacing) args.push("--session-start-source", "resume");
	args.push(pane.pane_id);
	return !herdrCli(args)?.error;
}

/** 還沒有對話紀錄檔的 ID 不報:herdr 重開時 `claude --resume` 它也接不回任何東西 */
function resolveWithTranscript(pane: HerdrPane): string | undefined {
	const id = claudeSessionOfPane(pane);
	return id && transcriptPath({ agent: "claude", kind: "id", value: id }) ? id : undefined;
}

export class ClaudeSessionSync {
	private checked = new Map<string, number>(); // 窗格 → 上次對的時間
	private readonly deps: SessionSyncDeps;
	constructor(deps: Partial<SessionSyncDeps> = {}) {
		this.deps = { resolve: resolveWithTranscript, report: reportToHerdr, now: Date.now, ...deps };
	}

	/** 每輪窗格清單呼叫一次;回傳這輪回報了哪些窗格 */
	sync(panes: HerdrPane[]): string[] {
		const now = this.deps.now();
		const reported: string[] = [];
		const seen = new Set<string>();
		for (const pane of panes) {
			if (pane.agent !== "claude") continue;
			seen.add(pane.pane_id);
			const known = pane.agent_session?.value;
			const last = this.checked.get(pane.pane_id);
			if (known && last !== undefined && now - last < RECHECK_MS) continue;
			this.checked.set(pane.pane_id, now);
			const id = this.deps.resolve(pane);
			if (!id || id === known) continue;
			if (this.deps.report(pane, id, !!known)) reported.push(pane.pane_id);
		}
		for (const id of this.checked.keys()) if (!seen.has(id)) this.checked.delete(id);
		return reported;
	}
}
