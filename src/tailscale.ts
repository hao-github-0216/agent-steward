import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findTailscale, settings } from "./settings.ts";

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
	if (!bin) throw new Error("這台電腦沒有 Tailscale");
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

export function serveOff(port: number): boolean {
	const bin = findTailscale();
	if (!bin) return false;
	const mine = findSteward(serveStatus(bin), port);
	if (!mine) return false;
	run(bin, ["serve", `--https=${mine.split(":").pop()}`, "off"]);
	return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes("--serve-off")) {
	if (!findTailscale()) console.log("這台電腦沒有 Tailscale");
	else {
		try {
			console.log(serveOff(settings().server.port) ? "已關掉轉到專案管家的 Tailscale Serve" : "沒有轉到專案管家的 Tailscale Serve");
		} catch (e) {
			console.error(`Tailscale 設定失敗:${String((e as { stderr?: string }).stderr || (e as Error).message).slice(0, 300)}`);
			process.exitCode = 1;
		}
	}
}
