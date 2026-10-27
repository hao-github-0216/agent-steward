// 設定頁的「用 ChatGPT / Claude 登入」:在伺服器跑 pi-ai 的登入流程,網頁輪詢進度。
// 在這台電腦的瀏覽器登入:登入完成後自動接上(本機回呼)。
// 從手機或別台電腦登入:登入後的頁面會打不開,把網址列整段貼回設定頁即可。
import { randomBytes } from "node:crypto";
import { loginProvider } from "./models.ts";

interface Session {
	id: string;
	provider: string;
	status: "waiting" | "done" | "error";
	url?: string;
	userCode?: string;
	message?: string;
	needCode: boolean;
	submit?: (code: string) => void;
	abort: AbortController;
	at: number;
}
const sessions = new Map<string, Session>();

function cleanup(): void {
	for (const [id, s] of sessions) if (Date.now() - s.at > 15 * 60_000) { s.abort.abort(); sessions.delete(id); }
}

export function startLogin(provider: string, onFinish?: (ok: boolean) => void): Session {
	cleanup();
	// 同一個服務同時只留一個登入流程(避免兩個流程搶同一個本機回呼埠)
	for (const [id, s] of sessions) if (s.provider === provider && s.status === "waiting") { s.abort.abort(); sessions.delete(id); }
	const s: Session = { id: randomBytes(12).toString("hex"), provider, status: "waiting", needCode: false, abort: new AbortController(), at: Date.now() };
	sessions.set(s.id, s);
	const interaction = {
		signal: s.abort.signal,
		notify(ev: { type: string; url?: string; message?: string; userCode?: string; verificationUri?: string }) {
			if (ev.type === "auth_url") s.url = ev.url;
			else if (ev.type === "device_code") { s.url = ev.verificationUri; s.userCode = ev.userCode; }
			else if (ev.message) s.message = ev.message;
		},
		prompt(p: { type: string; message: string; signal?: AbortSignal; options?: readonly { id: string }[] }): Promise<string> {
			// 選擇題(例如 Claude 的登入方式):用預設的第一個(瀏覽器登入)
			if (p.type === "select") return Promise.resolve(p.options?.[0]?.id ?? "");
			// 文字題(例如 GitHub Copilot 問企業版網域):留空 = 預設(github.com)
			if (p.type === "text") return Promise.resolve("");
			// 其他就是「貼上登入後的網址」(和本機回呼同時進行,回呼先到就取消這個問題)
			return new Promise((resolve, reject) => {
				s.needCode = true;
				s.submit = (code) => { s.needCode = false; s.submit = undefined; resolve(code); };
				const stop = () => { s.needCode = false; s.submit = undefined; reject(new Error("canceled")); };
				p.signal?.addEventListener("abort", stop, { once: true });
				s.abort.signal.addEventListener("abort", stop, { once: true });
			});
		},
	};
	loginProvider(provider, interaction).then(
		() => { s.status = "done"; s.needCode = false; s.message = "登入完成"; onFinish?.(true); },
		(e) => { s.status = "error"; s.needCode = false; s.message = String((e as Error)?.message ?? e).slice(0, 300); onFinish?.(false); },
	);
	return s;
}

export function loginStatus(id: string) {
	const s = sessions.get(id);
	if (!s) return undefined;
	return { id: s.id, provider: s.provider, status: s.status, url: s.url, userCode: s.userCode, message: s.message, needCode: s.needCode };
}

export function submitCode(id: string, code: string): boolean {
	const s = sessions.get(id);
	if (!s?.submit) return false;
	s.submit(code.trim());
	return true;
}

export function cancelLogin(id: string): void {
	const s = sessions.get(id);
	if (s) { s.abort.abort(); sessions.delete(id); }
}
