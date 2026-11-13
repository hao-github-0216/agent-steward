import { tr } from "./i18n.ts";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findTailscale, SETTINGS_PATH } from "./settings.ts";

function run(bin: string, args: string[]): string {
	return execFileSync(bin, args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
}

export function serveStatus(bin: string): any {
	try { return JSON.parse(run(bin, ["serve", "status", "--json"])); } catch { return {}; }
}

/** 找出轉到本機管家埠的 https 入口。 */
export function findSteward(serve: any, port: number): string | undefined {
	return Object.entries<any>(serve?.Web ?? {}).find(([, web]) => Object.values<any>(web?.Handlers ?? {}).some((handler) => {
		try {
			const target = new URL(handler?.Proxy);
			return target.hostname === "127.0.0.1" && target.port === String(port);
		} catch { return false; }
	}))?.[0];
}

export function serveOn(port: number): { url: string; login: string } {
	const bin = findTailscale();
	if (!bin) throw new Error(tr("這台電腦沒有 Tailscale"));
	const st = JSON.parse(run(bin, ["status", "--json"]));
	const dns = String(st.Self?.DNSName ?? "").replace(/\.$/, "");
	const serve = serveStatus(bin);
	let httpsPort = findSteward(serve, port)?.split(":").pop();
	if (!httpsPort) {
		const used = new Set(Object.keys(serve?.Web ?? {}).map((hp) => hp.split(":").pop()));
		httpsPort = ["443", "8443", "8793", "9443"].find((p) => !used.has(p)) ?? "10443";
		run(bin, ["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${port}`]);
	}
	const url = `https://${dns}${httpsPort === "443" ? "" : `:${httpsPort}`}/`;
	const login = String(st.User?.[String(st.Self?.UserID)]?.LoginName ?? "").toLowerCase();
	return { url, login };
}

/**
 * 移除程式用:找出「確定是這份安裝設定的」那條 Serve。
 * Tailscale Serve 是整台電腦共用的,所以要這份安裝的設定檔裡 Tailscale 存取是開著的,
 * 而且記的網址跟那條 Serve 的位址、port 一致才算;同一台電腦上另一份安裝(例如測試用的)不會誤關。
 */
export function ownedServe(saved: any, serve: any): { port: number; https: string } | undefined {
	const port = Number(saved?.server?.port ?? 8791);
	if (!saved?.access?.tailscale?.enabled || !saved?.server?.publicUrl) return undefined;
	const mine = findSteward(serve, port);
	if (!mine) return undefined;
	let url: URL;
	try { url = new URL(saved.server.publicUrl); } catch { return undefined; }
	const [host, https = "443"] = [mine.slice(0, mine.lastIndexOf(":")), mine.split(":").pop()];
	if (url.hostname !== host || (url.port || "443") !== https) return undefined;
	return { port, https };
}

export function serveOff(port: number): boolean {
	const bin = findTailscale();
	if (!bin) return false;
	const mine = findSteward(serveStatus(bin), port);
	if (!mine) return false;
	run(bin, ["serve", `--https=${mine.split(":").pop()}`, "off"]);
	return true;
}

// 比對實際路徑:macOS 的 /var、/tmp 是捷徑,直接比字串會以為不是被直接執行
const isMain = (() => { try { return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain && process.argv.includes("--serve-off")) {
	if (!findTailscale()) console.log("這台電腦沒有 Tailscale");
	else {
		try {
			// 直接讀設定檔,不呼叫 settings():沒有設定檔時 settings() 會偵測並新建一份
			const saved = existsSync(SETTINGS_PATH) ? JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) : undefined;
			const bin = findTailscale()!;
			const owned = ownedServe(saved, serveStatus(bin));
			if (owned) run(bin, ["serve", `--https=${owned.https}`, "off"]);
			console.log(owned ? "已關掉轉到專案管家的 Tailscale Serve" : "沒有這份專案管家設定的 Tailscale Serve,不動");
		} catch (e) {
			console.error(`Tailscale 設定失敗:${String((e as { stderr?: string }).stderr || (e as Error).message).slice(0, 300)}`);
			process.exitCode = 1;
		}
	}
}
