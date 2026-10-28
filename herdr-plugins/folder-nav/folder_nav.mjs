// herdr 資料夾導覽 popup(macOS / Windows / Linux 共用,用 Node.js 跑)。
// 滑鼠/觸控為主:點資料夾進入、每列「開啟」按鈕、上下工具列按鈕;右鍵選單與鍵盤也能用。
// 開啟規則:目標窗格閒在 shell 提示字元 → cd;否則(agent、vim、ssh、指令執行中)→ 在同一個 space 開新 tab。
// 自己處理 SGR 滑鼠序列與 ANSI 繪圖(不依賴 curses)。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

const WIN = process.platform === "win32";
const HOME = homedir();
const HERDR = process.env.HERDR_BIN_PATH
	|| [WIN ? join(HOME, ".agent-steward", "bin", "herdr", "herdr.exe") : join(HOME, ".local", "bin", "herdr"), join(HOME, ".agent-steward", "bin", WIN ? "herdr.exe" : "herdr")].find((p) => existsSync(p))
	|| (WIN ? "herdr.exe" : "herdr");
const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "nu", "pwsh", "powershell", "cmd"]);
const DOUBLE_CLICK_MS = 400;

// ---------- herdr ----------
function herdr(...args) {
	try { return JSON.parse(execFileSync(HERDR, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }) || "{}"); } catch { return {}; }
}
function targetContext() {
	let pane = process.env.HERDR_ACTIVE_PANE_ID;
	let ws = process.env.HERDR_ACTIVE_WORKSPACE_ID || process.env.HERDR_WORKSPACE_ID;
	let cwd = process.env.HERDR_ACTIVE_PANE_CWD;
	const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
	if (raw && !pane) {
		try {
			const ctx = JSON.parse(raw);
			const fp = ctx.focused_pane ?? ctx.pane ?? {};
			pane = pane || (typeof fp === "object" ? fp.pane_id : fp) || ctx.focused_pane_id || ctx.pane_id;
			ws = ws || ctx.workspace_id || ctx.workspace?.workspace_id;
			if (typeof fp === "object") cwd = cwd || fp.foreground_cwd || fp.cwd;
		} catch { /* 沒有 context */ }
	}
	if (pane && (!cwd || !ws)) {
		const info = herdr("pane", "get", pane).result?.pane ?? {};
		cwd = cwd || info.foreground_cwd || info.cwd;
		ws = ws || info.workspace_id;
	}
	if (!cwd || !existsSync(cwd)) cwd = HOME;
	return { pane, ws, cwd };
}
/** 前景是 shell 本身(沒有 agent、沒有在跑別的程式)才算閒置;回傳 shell 名稱 */
function idleShell(pane) {
	if (!pane) return null;
	const info = herdr("pane", "get", pane).result?.pane;
	if (!info || info.agent) return null;
	const pi = herdr("pane", "process-info", "--pane", pane).result?.process_info ?? {};
	const procs = pi.foreground_processes ?? [];
	if (!pi.shell_pid || pi.foreground_process_group_id !== pi.shell_pid || !procs.length) return null;
	const names = procs.map((p) => String(p.name ?? "").replace(/^-/, "").replace(/\.exe$/i, "").toLowerCase());
	return names.every((n) => SHELLS.has(n)) ? names[0] : null;
}
function cdCommand(shell, path) {
	if (shell === "pwsh" || shell === "powershell") return `Set-Location -LiteralPath '${path.replace(/'/g, "''")}'`;
	if (shell === "cmd") return `cd /d "${path}"`;
	return `cd -- '${path.replace(/'/g, "'\\''")}'`;
}
function openInTerminal(path, pane, ws) {
	const sh = idleShell(pane);
	if (sh) {
		// 清掉提示字元上打到一半的字:Windows 的 PowerShell / cmd 不認得 Ctrl+U(會變成一個看不見的字元
		// 黏在指令前面),要用 Esc;Mac/Linux 的 shell(含 pwsh)用 Ctrl+U,那裡的 Esc 會跟下一個字變成組合鍵
		herdr("pane", "send-keys", pane, WIN && ["pwsh", "powershell", "cmd"].includes(sh) ? "esc" : "ctrl+u");
		herdr("pane", "run", pane, cdCommand(sh, path));
		return `已在目前窗格 cd 到 ${path}`;
	}
	herdr("tab", "create", ...(ws ? ["--workspace", ws] : []), "--cwd", path, "--focus");
	return `已在新 tab 開啟 ${path}`;
}
function copyPath(path) {
	if (WIN) spawnSync("clip.exe", { input: path });
	else if (process.platform === "darwin") spawnSync("pbcopy", { input: path });
	// 也送 OSC 52:從網頁終端機(手機)用時,讓瀏覽器那邊的剪貼簿也拿到
	process.stdout.write(`\x1b]52;c;${Buffer.from(path).toString("base64")}\x07`);
}

// ---------- 文字寬度 ----------
const wide = (cp) => (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)));
const cwidth = (ch) => { const cp = ch.codePointAt(0); return /\p{M}/u.test(ch) ? 0 : wide(cp) ? 2 : 1; };
const swidth = (s) => [...s].reduce((n, c) => n + cwidth(c), 0);
function fit(s, width, leftEllipsis = false) {
	if (width <= 0) return "";
	if (swidth(s) <= width) return s + " ".repeat(width - swidth(s));
	const chars = [...s];
	if (leftEllipsis) {
		let out = "", w = 1;
		for (let i = chars.length - 1; i >= 0; i--) { if (w + cwidth(chars[i]) > width) break; out = chars[i] + out; w += cwidth(chars[i]); }
		return `…${out}${" ".repeat(width - w)}`;
	}
	let out = "", w = 0;
	for (const c of chars) { if (w + cwidth(c) > width - 1) break; out += c; w += cwidth(c); }
	return `${out}…${" ".repeat(Math.max(0, width - w - 1))}`;
}

// ---------- 終端機 ----------
const ESC = "\x1b";
const RESET = `${ESC}[0m`, BOLD = `${ESC}[1m`, DIM = `${ESC}[2m`, REV = `${ESC}[7m`;
const BLUE = `${ESC}[34m`, YELLOW = `${ESC}[33m`, RED = `${ESC}[31m`;
const BTN = `${ESC}[48;5;238m${ESC}[97m`; // 按鈕:深灰底白字
const termSize = () => [process.stdout.columns || 60, process.stdout.rows || 20];

/** 把輸入拆成事件:['key', name] 或 ['mouse', btn, x, y, pressed] */
function parseInput(buf) {
	const evs = [];
	let i = 0;
	while (i < buf.length) {
		const rest = buf.slice(i);
		if (rest[0] === ESC) {
			if (rest.length === 1) { evs.push(["key", "esc"]); i++; continue; }
			const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
			if (m) { evs.push(["mouse", +m[1], +m[2] - 1, +m[3] - 1, m[4] === "M"]); i += m[0].length; continue; }
			const k = /^\x1b(\[|O)([0-9;]*[A-Za-z~])/.exec(rest);
			if (k) {
				const name = { "[A": "up", "[B": "down", "[C": "right", "[D": "left", OA: "up", OB: "down", OC: "right", OD: "left", "[H": "home", "[F": "end", OH: "home", OF: "end", "[5~": "pgup", "[6~": "pgdn", "[1~": "home", "[4~": "end", "[3~": "delete" }[k[1] + k[2]];
				if (name) evs.push(["key", name]);
				i += k[0].length;
				continue;
			}
			evs.push(["key", "esc"]); i += 1; continue;
		}
		const ch = [...rest][0];
		const c = ch.codePointAt(0);
		if (c === 13 || c === 10) evs.push(["key", "enter"]);
		else if (c === 127 || c === 8) evs.push(["key", "backspace"]);
		else if (c < 32) evs.push(["key", `ctrl+${String.fromCharCode(c + 96)}`]);
		else evs.push(["key", ch]);
		i += ch.length;
	}
	return evs;
}

// ---------- 瀏覽器 ----------
class Nav {
	constructor(cwd, pane, ws) {
		this.pane = pane; this.ws = ws;
		this.showHidden = false;
		this.msg = ""; this.msgErr = false;
		this.menu = null; // { x, y, items: [[text, action, target]], sel }
		this.hits = []; // [y, x0, x1, action, arg]
		this.navAt = 0;
		this.result = null;
		this.go(cwd);
	}
	isRoot(p) { return parse(p).root === p; }
	go(path, selectName) {
		path = resolve(path);
		let names;
		try { names = readdirSync(path); } catch (e) { this.flash(`無法開啟:${e.code ?? e.message}`, true); return false; }
		const dirs = [], files = [];
		for (const n of names) {
			if (!this.showHidden && n.startsWith(".")) continue;
			let isDir = false;
			try { isDir = statSync(join(path, n)).isDirectory(); } catch { /* 讀不到的當檔案 */ }
			(isDir ? dirs : files).push(n);
		}
		const key = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase());
		this.cwd = path;
		this.items = [...(this.isRoot(path) ? [] : [["..", true]]), ...dirs.sort(key).map((d) => [d, true]), ...files.sort(key).map((f) => [f, false])];
		this.sel = 0; this.top = 0;
		if (selectName) { const i = this.items.findIndex(([n]) => n === selectName); if (i >= 0) this.sel = i; }
		this.msg = "";
		this.navAt = Date.now();
		return true;
	}
	itemPath(i) { const [n] = this.items[i]; return n === ".." ? dirname(this.cwd) : join(this.cwd, n); }
	enter(i) {
		const it = this.items[i];
		if (!it) return;
		if (it[0] === "..") this.up(); else if (it[1]) this.go(join(this.cwd, it[0]));
	}
	up() { if (!this.isRoot(this.cwd)) this.go(dirname(this.cwd), basename(this.cwd)); }
	toggleHidden() { this.showHidden = !this.showHidden; this.go(this.cwd, this.items[this.sel]?.[0]); }
	flash(text, err = false) { this.msg = text; this.msgErr = err; }
	selectedDir() {
		const it = this.items[this.sel];
		return it && it[1] && it[0] !== ".." ? this.itemPath(this.sel) : this.cwd;
	}
	runAction(action, target) {
		if (action === "open") this.result = openInTerminal(target, this.pane, this.ws);
		else if (action === "copy") { copyPath(target); this.flash(`已複製 ${target}`); }
	}
	// --- 版面 ---
	rowH() { return termSize()[0] < 70 ? 2 : 1; } // 窄畫面(手機)每一項佔兩行
	listTop() { return 3; }
	listRows() { return Math.max(1, Math.floor((termSize()[1] - this.listTop() - 1) / this.rowH())); }
	ensureVisible() {
		const rows = this.listRows();
		if (this.sel < this.top) this.top = this.sel;
		else if (this.sel >= this.top + rows) this.top = this.sel - rows + 1;
		this.top = Math.max(0, Math.min(this.top, Math.max(0, this.items.length - rows)));
	}
	buttons(y, w, specs, right) {
		let line = "", x = 0;
		const rw = right ? swidth(` ${right[0]} `) + 1 : 0;
		for (const [text, action, arg] of specs) {
			const label = ` ${text} `, bw = swidth(label);
			if (x + bw > w - rw) break;
			line += `${BTN}${label}${RESET} `;
			this.hits.push([y, x, x + bw, action, arg]);
			x += bw + 1;
		}
		let pad = w - x;
		if (right) {
			const label = ` ${right[0]} `, bw = swidth(label);
			pad -= bw;
			line += " ".repeat(Math.max(0, pad)) + BTN + label + RESET;
			this.hits.push([y, w - bw, w, right[1], right[2]]);
		} else line += " ".repeat(Math.max(0, pad));
		return line;
	}
	draw() {
		const [w, h] = termSize();
		this.ensureVisible();
		this.hits = [];
		const rh = this.rowH(), rows = this.listRows(), top = this.listTop();
		const out = [`${ESC}[H`];
		out.push(this.buttons(0, w, [["← 上一層", "up"], ["⌂ 家", "home"], [this.showHidden ? "● 隱藏檔" : "○ 隱藏檔", "hidden"]], ["✕ 關閉", "close"]) + "\r\n");
		const shown = this.cwd === HOME || this.cwd.startsWith(HOME + (WIN ? "\\" : "/")) ? `~${this.cwd.slice(HOME.length)}` : this.cwd;
		out.push(`${BOLD}${BLUE}${fit(` ${shown}`, w, true)}${RESET}\r\n`);
		out.push(this.msg ? `${this.msgErr ? RED : YELLOW}${fit(` ${this.msg}`, w)}${RESET}\r\n` : `${DIM}${fit(" 點資料夾進入 · 點「開啟」在 terminal 開 · 上下滑捲動", w)}${RESET}\r\n`);
		const openLabel = " 開啟 ", ow = swidth(openLabel);
		for (let r = 0; r < rows; r++) {
			const i = this.top + r, y = top + r * rh;
			if (i < this.items.length) {
				const [name, isDir] = this.items[i];
				const realDir = isDir && name !== "..";
				const label = (realDir ? " ▸ " : name === ".." ? "   ⤴ " : "   ") + name + (realDir ? "/" : "");
				const style = isDir ? BOLD + BLUE : DIM;
				const lw = w - (realDir ? ow + 1 : 0);
				let line = fit(label, lw);
				line = i === this.sel ? REV + style + line + RESET : style + line + RESET;
				if (realDir) { line += ` ${BTN}${openLabel}${RESET}`; for (let k = 0; k < rh; k++) this.hits.push([y + k, w - ow, w, "open-item", i]); }
				for (let k = 0; k < rh; k++) this.hits.push([y + k, 0, lw, "item", i]);
				out.push(line + "\r\n");
				if (rh === 2) {
					const sub = DIM + fit(`     ${realDir ? "資料夾" : name === ".." ? "上一層" : "檔案 · 點一下看選項"}`, w) + RESET;
					out.push((i === this.sel ? REV + sub + RESET : sub) + "\r\n");
				}
			} else out.push(`${" ".repeat(w)}\r\n`.repeat(rh));
		}
		const used = top + rows * rh;
		out.push(`${" ".repeat(w)}\r\n`.repeat(Math.max(0, h - 1 - used)));
		out.push(this.buttons(h - 1, w, [["▶ 在這裡開啟", "open-cwd"], ["⧉ 複製路徑", "copy-cwd"]]));
		if (this.menu) out.push(this.drawMenu(w, h));
		process.stdout.write(out.join(""));
	}
	menuBox(w, h) {
		const inner = Math.max(...this.menu.items.map(([t]) => swidth(t))) + 2;
		const bw = inner + 2, bh = this.menu.items.length + 2;
		return [Math.max(0, Math.min(this.menu.x, w - bw)), Math.max(0, Math.min(this.menu.y, h - bh)), bw, bh, inner];
	}
	drawMenu(w, h) {
		const [x, y, , bh, inner] = this.menuBox(w, h);
		const s = [`${ESC}[${y + 1};${x + 1}H┌${"─".repeat(inner)}┐`];
		this.menu.items.forEach(([text], k) => {
			let body = fit(` ${text}`, inner);
			if (k === this.menu.sel) body = REV + body + RESET;
			s.push(`${ESC}[${y + 2 + k};${x + 1}H│${body}│`);
		});
		s.push(`${ESC}[${y + bh};${x + 1}H└${"─".repeat(inner)}┘`);
		return s.join("");
	}
	// --- 事件 ---
	openMenu(x, y, target, filePath) {
		const items = filePath
			? [["複製檔案路徑", "copy", filePath], ["在 terminal 開啟所在資料夾", "open", target], ["取消", "cancel", null]]
			: [["在 terminal 中開啟", "open", target], ["複製路徑", "copy", target], ["取消", "cancel", null]];
		this.menu = { x, y, items, sel: 0 };
	}
	act(action, arg, x = 0, y = 0) {
		if (action === "up") this.up();
		else if (action === "home") this.go(HOME);
		else if (action === "hidden") this.toggleHidden();
		else if (action === "close") this.result = "";
		else if (action === "open-cwd") this.runAction("open", this.cwd);
		else if (action === "copy-cwd") this.runAction("copy", this.cwd);
		else if (action === "open-item") { this.sel = arg; this.runAction("open", this.itemPath(arg)); }
		else if (action === "item") {
			this.sel = arg;
			const [, isDir] = this.items[arg];
			if (isDir) this.enter(arg); else this.openMenu(x, y, this.cwd, this.itemPath(arg));
		}
	}
	onKey(k) {
		if (this.menu) {
			const items = this.menu.items;
			if (k === "up" || k === "k") this.menu.sel = (this.menu.sel - 1 + items.length) % items.length;
			else if (k === "down" || k === "j") this.menu.sel = (this.menu.sel + 1) % items.length;
			else if (k === "enter") { const [, a, t] = items[this.menu.sel]; this.menu = null; if (a !== "cancel") this.runAction(a, t); }
			else if (["esc", "q", "left", "backspace"].includes(k)) this.menu = null;
			return;
		}
		const n = this.items.length;
		this.msg = "";
		if (["esc", "q", "ctrl+c"].includes(k)) this.result = "";
		else if (k === "up" || k === "k") this.sel = Math.max(0, this.sel - 1);
		else if (k === "down" || k === "j") this.sel = Math.min(n - 1, this.sel + 1);
		else if (k === "pgup") this.sel = Math.max(0, this.sel - this.listRows());
		else if (k === "pgdn") this.sel = Math.min(n - 1, this.sel + this.listRows());
		else if (k === "home" || k === "g") this.sel = 0;
		else if (k === "end" || k === "G") this.sel = Math.max(0, n - 1);
		else if (["enter", "right", "l"].includes(k)) this.enter(this.sel);
		else if (["backspace", "left", "h"].includes(k)) this.up();
		else if (k === "~") this.go(HOME);
		else if (k === "/") this.go(parse(this.cwd).root);
		else if (k === ".") this.toggleHidden();
		else if (k === "o") this.runAction("open", this.selectedDir());
		else if (k === "y") this.runAction("copy", this.selectedDir());
		else if (k === "m") this.openMenu(Math.min(termSize()[0] - 1, 6), this.listTop() + (this.sel - this.top) * this.rowH() + 1, this.selectedDir());
	}
	onMouse(btn, x, y, pressed) {
		const base = btn & ~(4 | 8 | 16); // 去掉 shift/alt/ctrl
		if (base === 64 || base === 65) { // 滾輪(手機上下滑會轉成滾輪)
			if (!this.menu) {
				const rows = this.listRows();
				this.top = Math.max(0, Math.min(this.top + (base === 65 ? 3 : -3), Math.max(0, this.items.length - rows)));
				this.sel = Math.min(Math.max(this.sel, this.top), this.top + rows - 1, this.items.length - 1);
			}
			return;
		}
		if (btn & 32 || !pressed) return; // 拖曳或放開
		if (this.menu) {
			const [w, h] = termSize();
			const [mx, my, bw] = this.menuBox(w, h);
			const k = y - my - 1, items = this.menu.items;
			this.menu = null;
			if (x >= mx && x < mx + bw && k >= 0 && k < items.length && items[k][1] !== "cancel") this.runAction(items[k][1], items[k][2]);
			return;
		}
		const hit = this.hits.find(([hy, x0, x1]) => hy === y && x >= x0 && x < x1);
		if (base === 0) {
			if (!hit) return;
			// 剛換過資料夾:舊習慣雙擊的第二下會點到新清單,忽略
			if ((hit[3] === "item" || hit[3] === "open-item") && Date.now() - this.navAt < DOUBLE_CLICK_MS) return;
			this.msg = "";
			this.act(hit[3], hit[4], x, y);
		} else if (base === 2) { // 右鍵
			if (hit && (hit[3] === "item" || hit[3] === "open-item")) {
				const i = hit[4];
				this.sel = i;
				const [name, isDir] = this.items[i];
				if (isDir && name !== "..") this.openMenu(x, y, this.itemPath(i));
				else if (!isDir) this.openMenu(x, y, this.cwd, this.itemPath(i));
				else this.openMenu(x, y, this.cwd);
			} else this.openMenu(x, y, this.cwd);
		}
	}
}

export { Nav, parseInput, fit, swidth };

// ---------- 主程式 ----------
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
	if (!process.stdin.isTTY) { console.error("folder_nav 需要在終端機裡執行"); process.exit(1); }
	const { pane, ws, cwd } = targetContext();
	const nav = new Nav(cwd, pane, ws);
	const restore = () => {
		process.stdout.write(`${ESC}[?1006l${ESC}[?1002l${ESC}[?1000l${ESC}[?25h${ESC}[?1049l`);
		try { process.stdin.setRawMode(false); } catch { /* 已經關了 */ }
	};
	process.stdin.setRawMode(true);
	process.stdin.setEncoding("utf8");
	process.stdout.write(`${ESC}[?1049h${ESC}[?25l${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h${ESC}[2J`);
	nav.draw();
	const finish = () => { restore(); process.exit(0); };
	process.stdin.on("data", (d) => {
		for (const ev of parseInput(d)) {
			if (ev[0] === "key") nav.onKey(ev[1]); else nav.onMouse(...ev.slice(1));
			if (nav.result !== null) return finish();
		}
		nav.draw();
	});
	process.stdout.on("resize", () => nav.draw());
	process.on("SIGTERM", finish);
}
