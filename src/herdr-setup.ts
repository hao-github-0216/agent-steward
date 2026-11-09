// 安裝程式執行:在 herdr 設定檔(config.toml)加上「資料夾導覽」快捷鍵(prefix+e),
// 有說明文字的自訂指令也會出現在 herdr 的全域選單裡。
// 已經有資料夾導覽的設定就只更新指令路徑(例如舊的 Python 版換成 Node 版),不動使用者的按鍵。
//   node --experimental-strip-types src/herdr-setup.ts            加上 / 更新
//   node --experimental-strip-types src/herdr-setup.ts --remove   拿掉(移除專案管家時)
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { herdrConfigDir, IS_WIN } from "./platform.ts";
import { readReceipt, updateReceipt } from "./install-receipt.ts";

const receipt = readReceipt();
const lang = process.env.STEWARD_LANG || receipt?.lang || "en";
const L = /^zh(?:[-_]|$)/i.test(lang) ? "zh-TW" : "en";
const messages = JSON.parse(readFileSync(new URL("../i18n/installer.json", import.meta.url), "utf8"));
const t = (key: string, ...values: string[]): string => messages[key][L].replace(/\{(\d+)\}/g, (_: string, n: string) => values[Number(n)] ?? "");

const CONFIG = join(herdrConfigDir(), "config.toml");
const PLUGIN = join(herdrConfigDir(), "plugins-local", "folder-nav", "folder_nav.mjs");
const MARK = "# 資料夾導覽 popup(專案管家安裝,外掛 local.folder-nav)";
const STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, "");
// 用安裝程式選定的 Node 路徑(可能是捷徑;process.execPath 會是解開後的真實路徑,換版本就失效)
const NODE = process.env.STEWARD_NODE || process.execPath;
const isFolderNav = (block: string) => /folder[_-]nav/.test(block);

/** 執行資料夾導覽的指令(herdr 交給系統 shell 執行) */
function command(): string {
	if (IS_WIN) {
		// cmd.exe 的引號規則很麻煩:寫一個 .cmd 包起來,設定檔裡只放這個路徑
		const wrapper = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "folder-nav.cmd");
		mkdirSync(dirname(wrapper), { recursive: true });
		writeFileSync(wrapper, `@"${NODE}" "${PLUGIN}" %*\r\n`);
		return /\s/.test(wrapper) ? `"${wrapper}"` : wrapper;
	}
	const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
	return `${q(NODE)} ${q(PLUGIN)}`;
}
const tomlStr = (s: string) => JSON.stringify(s); // TOML 基本字串跟 JSON 字串的跳脫相容

/** 把設定檔切成「表頭開頭的區塊」 */
function blocks(text: string): string[] {
	const out: string[] = [];
	let cur: string[] = [];
	for (const line of text.split("\n")) {
		if (/^\s*\[/.test(line) && cur.some((l) => /^\s*\[/.test(l))) {
			// 新表頭:把前一塊結尾的註解/空行留給新的一塊(通常是寫給下一段的說明)
			const tail: string[] = [];
			while (cur.length && /^\s*(#|$)/.test(cur[cur.length - 1])) tail.unshift(cur.pop()!);
			out.push(cur.join("\n"));
			cur = [...tail];
		}
		cur.push(line);
	}
	out.push(cur.join("\n"));
	return out;
}

function save(text: string, before: string): boolean {
	if (text === before) return false;
	const backup = existsSync(CONFIG) ? `${CONFIG}.bak-steward-${STAMP}` : undefined;
	if (backup) copyFileSync(CONFIG, backup);
	mkdirSync(dirname(CONFIG), { recursive: true });
	writeFileSync(CONFIG, text.endsWith("\n") ? text : `${text}\n`);
	updateReceipt({ backups: backup ? [backup] : [], changes: [{ type: "modified", path: CONFIG }] });
	return true;
}

const before = existsSync(CONFIG) ? readFileSync(CONFIG, "utf8") : "";
const parts = blocks(before);
const isCmdBlock = (b: string) => /^\s*\[\[keys\.command\]\]/m.test(b);

if (process.argv.includes("--remove")) {
	const kept = parts.filter((b) => !(isCmdBlock(b) && isFolderNav(b)));
	console.log(t(save(kept.join("\n"), before) ? "herdr_config_removed" : "herdr_config_absent"));
} else {
	const i = parts.findIndex((b) => isCmdBlock(b) && isFolderNav(b));
	if (i < 0 && receipt?.herdrKeyAdded && !process.argv.includes("--readd")) {
		console.log(t("herdr_key_removed"));
		process.exit(0);
	}
	const cmd = `command = ${tomlStr(command())}`;
	let next: string;
	if (i >= 0) {
		// 已經有:只換指令,沒有說明就補上(說明文字才會出現在選單)
		let b = parts[i].replace(/^\s*command\s*=.*$/m, cmd).replace(/^\s*type\s*=.*$/m, 'type = "popup"');
		if (!/^\s*description\s*=/m.test(b)) b = b.replace(cmd, `${cmd}\ndescription = ${tomlStr(t("herdr_folder_description"))}`);
		parts[i] = b;
		next = parts.join("\n");
	} else {
		const used = /^\s*key\s*=\s*"prefix\+e"/m.test(before);
		const block = `${MARK}\n[[keys.command]]\nkey = "${used ? "prefix+shift+e" : "prefix+e"}"\ntype = "popup"\n${cmd}\ndescription = ${tomlStr(t("herdr_folder_description"))}\nwidth = "60%"\nheight = "80%"\n`;
		next = `${before.replace(/\s*$/, "")}${before.trim() ? "\n\n" : ""}${block}`;
	}
	const changed = save(next, before);
	updateReceipt({ herdrKeyAdded: true });
	console.log(changed ? t("herdr_config_updated", CONFIG) : t("herdr_config_current"));
}
