import { readFileSync, statSync } from "node:fs";
import { settings } from "./settings.ts";

export type TranslationTable = Record<string, string>;

const tables = new Map<string, { mtime: number | null; table: TranslationTable | null }>();

export function isEn(): boolean {
	return settings().ui.lang === "en";
}

export function tr(zh: string, vars?: Record<string, unknown>): string {
	const en = isEn() ? readEnTable() : null;
	const text = en && Object.hasOwn(en, zh) ? en[zh] : zh;
	return text.replace(/\{([^{}]+)\}/g, (match, name) => vars && Object.hasOwn(vars, name) ? String(vars[name]) : match);
}

export function readEnTable(path: string | URL = new URL("../web/i18n/en.json", import.meta.url)): TranslationTable | null {
	const id = String(path);
	let mtime: number | null = null;
	try {
		mtime = statSync(path).mtimeMs;
		const cached = tables.get(id);
		if (cached?.mtime === mtime) return cached.table;
		const table = JSON.parse(readFileSync(path, "utf8"));
		if (!table || typeof table !== "object" || Array.isArray(table) || !Object.values(table).every((value) => typeof value === "string")) {
			throw new Error("Expected an object of translation strings");
		}
		tables.set(id, { mtime, table });
		return table;
	} catch (error) {
		if (tables.get(id)?.mtime !== mtime) console.error(`[i18n] Cannot load English translations: ${String((error as Error).message).replace(/[\r\n]+/g, " ")}`);
		tables.set(id, { mtime, table: null });
		return null;
	}
}

export function renderIndex(html: string, lang: string, enTable: TranslationTable | null): string {
	const effectiveLang = lang === "en" ? "en" : "zh-TW";
	const table = JSON.stringify(effectiveLang === "en" ? enTable : null).replace(/</g, "\\u003c");
	return html
		.replace('<html lang="zh-Hant">', effectiveLang === "en" ? '<html lang="en">' : '<html lang="zh-Hant">')
		.replace("__STEWARD_LANG__", effectiveLang)
		.replace("__STEWARD_EN__", () => table);
}
