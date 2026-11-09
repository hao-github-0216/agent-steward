import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type ReceiptLanguage = "zh-TW" | "en";
export type ReceiptSource = "existing" | "download" | "brew";
export type ReceiptChangeType = "file" | "modified" | "symlink" | "launchd" | "systemd" | "linger" | "herdr-plugin" | "scheduled-task";

export interface ReceiptChange {
	type: ReceiptChangeType;
	path: string;
	note?: string;
}

export interface InstallReceipt {
	version: 1;
	lang?: ReceiptLanguage;
	without?: string;
	installedAt: string;
	updatedAt: string;
	app?: { version: string };
	node?: { path: string; source: ReceiptSource };
	herdr?: { tag: string; symlink: boolean };
	ttyd?: { path: string; source: ReceiptSource };
	herdrKeyAdded?: boolean;
	lingerByInstaller?: boolean;
	pathAdded?: string[];
	backups: string[];
	changes: ReceiptChange[];
}

function receiptPath(): string {
	return join(process.env.STEWARD_DATA_DIR ?? join(homedir(), ".agent-steward"), "install.json");
}

export function readReceipt(): InstallReceipt | null {
	try {
		return JSON.parse(readFileSync(receiptPath(), "utf8")) as InstallReceipt;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export function updateReceipt(patch: Partial<InstallReceipt>): InstallReceipt {
	const previous = readReceipt();
	const now = new Date().toISOString();
	const changes = new Map<string, ReceiptChange>();
	for (const change of [...(previous?.changes ?? []), ...(patch.changes ?? [])]) {
		changes.set(JSON.stringify([change.type, change.path]), change);
	}
	const receipt: InstallReceipt = {
		...previous,
		...patch,
		version: 1,
		installedAt: previous?.installedAt ?? now,
		updatedAt: now,
		...(previous?.pathAdded || patch.pathAdded ? { pathAdded: [...new Set([...(previous?.pathAdded ?? []), ...(patch.pathAdded ?? [])])] } : {}),
		backups: [...new Set([...(previous?.backups ?? []), ...(patch.backups ?? [])])],
		changes: [...changes.values()],
	};
	const path = receiptPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(receipt, null, "\t") + "\n", "utf8");
	return receipt;
}

type InstallerMessages = Record<string, Record<ReceiptLanguage, string>>;

function translator(lang: ReceiptLanguage): (key: string, ...values: string[]) => string {
	const messages = JSON.parse(readFileSync(new URL("../i18n/installer.json", import.meta.url), "utf8")) as InstallerMessages;
	return (key, ...values) => messages[key][lang].replace(/\{(\d+)\}/g, (placeholder, index: string) => values[Number(index)] ?? placeholder);
}

function tilde(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

function isLanguage(value: unknown): value is ReceiptLanguage {
	return value === "zh-TW" || value === "en";
}

function cliLanguage(): ReceiptLanguage {
	if (isLanguage(process.env.STEWARD_LANG)) return process.env.STEWARD_LANG;
	try {
		const lang = readReceipt()?.lang;
		if (isLanguage(lang)) return lang;
	} catch {
		// Reading a damaged receipt must not prevent a localized CLI error.
	}
	return "en";
}

function runCli(): void {
	const [command, ...args] = process.argv.slice(2);
	const usage = () => {
		console.error(translator(cliLanguage())("receipt_usage"));
		process.exitCode = 1;
	};
	try {
		switch (command) {
			case "set":
			case "set-file": {
				if (args.length !== 1) return usage();
				const json = command === "set-file" ? readFileSync(args[0], "utf8").replace(/^\uFEFF/, "") : args[0];
				const patch = JSON.parse(json);
				if (!patch || typeof patch !== "object" || Array.isArray(patch)) return usage();
				updateReceipt(patch);
				return;
			}
			case "change": {
				const [type, path, note] = args;
				const types: ReceiptChangeType[] = ["file", "modified", "symlink", "launchd", "systemd", "linger", "herdr-plugin", "scheduled-task"];
				if (args.length < 2 || args.length > 3 || !types.includes(type as ReceiptChangeType)) return usage();
				updateReceipt({ changes: [{ type: type as ReceiptChangeType, path, ...(note === undefined ? {} : { note }) }] });
				return;
			}
			case "backup":
				if (args.length !== 1) return usage();
				updateReceipt({ backups: [args[0]] });
				return;
			case "get": {
				if (args.length !== 1) return usage();
				let value: unknown = readReceipt();
				for (const key of args[0].split(".")) {
					value = value !== null && typeof value === "object" && Object.hasOwn(value, key)
						? (value as Record<string, unknown>)[key] : undefined;
				}
				console.log(value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));
				return;
			}
			case "summary": {
				if (args.length < 1 || args.length > 2 || !isLanguage(args[0])) return usage();
				const t = translator(args[0]);
				const receipt = readReceipt();
				console.log(t(args[1] ?? "receipt_header"));
				for (const change of receipt?.changes ?? []) {
					console.log(t(`receipt_change_${change.type}`, tilde(change.path), change.note ? ` — ${change.note}` : ""));
				}
				for (const path of receipt?.backups ?? []) console.log(t("receipt_backup", tilde(path)));
				return;
			}
			default:
				usage();
		}
	} catch (error) {
		console.error(translator(cliLanguage())("receipt_error", error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
	}
}

// 比對實際路徑:macOS 的 /var、/tmp 是捷徑,直接比字串會以為不是被直接執行
const isMain = (() => { try { return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
	runCli();
}
