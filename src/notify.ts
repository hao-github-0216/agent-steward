// 推播通知:依設定頁選的方式送出(不推播 / Hermes webhook / Telegram 機器人 / 通用 webhook)。
// Hermes:簽章與 pi 的 telegram-notify 相同,hex HMAC-SHA256("<timestamp>.<body>"),標頭 X-Webhook-Signature-V2;
// secret 每次從 ~/.hermes/webhook_subscriptions.json 讀,路由還沒建就安靜略過。
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./config.ts";
import { settings } from "./settings.ts";
import { messageFromText, pushAll } from "./apns.ts";

export function hermesSecret(route: string): string | undefined {
	try {
		const subs = JSON.parse(readFileSync(join(HOME, ".hermes", "webhook_subscriptions.json"), "utf8"));
		const secret = (subs?.[route] ?? subs?.routes?.[route])?.secret;
		return typeof secret === "string" && secret ? secret : undefined;
	} catch {
		return undefined;
	}
}

async function post(url: string, body: string, headers: Record<string, string> = {}): Promise<boolean> {
	try {
		const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, signal: AbortSignal.timeout(8000) });
		return res.ok;
	} catch {
		return false;
	}
}

export interface NotifyOptions {
	/** 跟哪個專案有關:iPhone 上點通知直接打開那個專案 */
	projectId?: string;
	/** 只推到 iPhone app(例如「工作完成」,不想讓 Telegram 等管道變吵) */
	iphoneOnly?: boolean;
}

/** 送一則推播:設定頁選的管道 + 登記過的 iPhone app;都沒送出回 false(不丟錯) */
export async function notify(text: string, opts: NotifyOptions = {}): Promise<boolean> {
	const phone = pushAll(messageFromText(text, opts.projectId)).catch(() => false);
	if (opts.iphoneOnly) return phone;
	const [a, b] = await Promise.all([sendConfigured(text), phone]);
	return a || b;
}

async function sendConfigured(text: string): Promise<boolean> {
	const n = settings().notify;
	if (n.kind === "hermes") {
		const secret = hermesSecret(n.hermes.route);
		const url = process.env.STEWARD_NOTIFY_URL ?? n.hermes.url;
		if (!secret || !url) return false;
		const body = JSON.stringify({ text });
		const ts = Math.floor(Date.now() / 1000);
		const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
		return post(url, body, { "X-Webhook-Signature-V2": sig, "X-Webhook-Timestamp": String(ts) });
	}
	if (n.kind === "telegram") {
		if (!n.telegram.botToken || !n.telegram.chatId) return false;
		return post(`https://api.telegram.org/bot${n.telegram.botToken}/sendMessage`, JSON.stringify({ chat_id: n.telegram.chatId, text, disable_web_page_preview: true }));
	}
	if (n.kind === "webhook") {
		if (!n.webhook.url) return false;
		// 同時給 text / content(Discord)/ message,常見服務都吃得到
		return post(n.webhook.url, JSON.stringify({ text, content: text, message: text }));
	}
	return false;
}
