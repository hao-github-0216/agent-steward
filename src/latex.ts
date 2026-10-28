// 程式碼頁的 LaTeX 編譯:用 latexmk 編譯 .tex,回傳 PDF 位置與整理過的錯誤 / 警告。
// 引擎:檔案開頭的「% !TEX program = xelatex」優先;有中日韓文字或 xeCJK / ctex / fontspec 用 xelatex;其他用 pdflatex。
// 「% !TEX root = main.tex」會改編譯主檔。不開 shell-escape。中間檔放在 .latexmk/。
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { which } from "./agents.ts";
import { CodeError, inProject } from "./code.ts";
import { IS_WIN } from "./platform.ts";
import type { Project } from "./store.ts";

export function latexmkPath(): string | undefined {
	return which("latexmk") ?? (IS_WIN ? ["C:\\texlive\\2026\\bin\\windows\\latexmk.exe", "C:\\texlive\\2025\\bin\\windows\\latexmk.exe"] : ["/Library/TeX/texbin/latexmk", "/usr/local/texlive/2026/bin/universal-darwin/latexmk", "/usr/bin/latexmk"]).find((p) => existsSync(p));
}

const magic = (src: string, key: string) => src.split("\n").slice(0, 30).map((l) => l.match(new RegExp(`^\\s*%\\s*!\\s*TeX\\s+${key}\\s*=\\s*(.+?)\\s*$`, "i"))?.[1]).find(Boolean);

export interface LatexIssue { file?: string; line?: number; message: string; level: "error" | "warning" }
export interface LatexResult { ok: boolean; engine: string; main: string; pdf?: string; issues: LatexIssue[]; log: string; seconds: number }

const running = new Map<string, Promise<LatexResult>>();

export function buildLatex(p: Project, rel: string): Promise<LatexResult> {
	let abs = inProject(p, rel);
	if (!/\.tex$/i.test(abs)) throw new CodeError(400, "只能編譯 .tex 檔");
	// % !TEX root = ../main.tex
	const root = magic(readFileSync(abs, "utf8"), "root");
	if (root) {
		const r = resolve(dirname(abs), root);
		inProject(p, relative(inProject(p, ""), r)); // 不能跑出專案
		if (!existsSync(r)) throw new CodeError(400, `找不到 % !TEX root 指定的主檔:${root}`);
		abs = r;
	}
	const mainRel = relative(inProject(p, ""), abs).split(sep).join("/");
	const key = `${p.id}:${mainRel}`;
	const busy = running.get(key);
	if (busy) return busy;
	const job = run(p, abs, mainRel).finally(() => running.delete(key));
	running.set(key, job);
	return job;
}

function run(p: Project, abs: string, mainRel: string): Promise<LatexResult> {
	const exe = latexmkPath();
	if (!exe) throw new CodeError(400, "這台電腦找不到 latexmk:請先安裝 TeX Live / MacTeX(macOS 可以用 brew install --cask mactex-no-gui)");
	const src = readFileSync(abs, "utf8");
	let engine = (magic(src, "program") ?? "").toLowerCase();
	if (!["pdflatex", "xelatex", "lualatex"].includes(engine)) engine = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]|\\usepackage(\[[^\]]*\])?\{(xeCJK|ctex|fontspec)\}|\\documentclass(\[[^\]]*\])?\{ctex/.test(src) ? "xelatex" : "pdflatex";
	const flag = engine === "xelatex" ? "-xelatex" : engine === "lualatex" ? "-lualatex" : "-pdf";
	const cwd = dirname(abs), file = basename(abs), job = file.replace(/\.tex$/i, "");
	const t0 = Date.now();
	// TeX 的執行檔不一定在 PATH(launchd 起的服務):把 latexmk 所在的資料夾加進去
	const env = { ...process.env, PATH: `${dirname(exe)}${IS_WIN ? ";" : ":"}${process.env.PATH ?? ""}` };
	return new Promise((ok) => {
		// 中間檔(.aux .log .fls…)放隱藏資料夾 .latexmk,專案裡只留 PDF
		execFile(exe, [flag, "-interaction=nonstopmode", "-file-line-error", "-synctex=1", "-auxdir=.latexmk", "-f", file], { cwd, env, timeout: 180_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
			const logPath = [join(cwd, ".latexmk", `${job}.log`), join(cwd, `${job}.log`)].find((f) => existsSync(f)) ?? "";
			const log = logPath ? readFileSync(logPath, "latin1") : `${stdout}\n${stderr}`;
			const issues = parseLog(Buffer.from(log, "latin1").toString("utf8"), cwd, inProject(p, ""));
			const pdfAbs = join(cwd, `${job}.pdf`);
			const pdf = existsSync(pdfAbs) ? relative(inProject(p, ""), pdfAbs).split(sep).join("/") : undefined;
			if ((err as { killed?: boolean } | null)?.killed) issues.unshift({ message: "編譯超過 3 分鐘,已經停止", level: "error" });
			const hasError = issues.some((i) => i.level === "error");
			ok({ ok: !hasError && !!pdf, engine, main: mainRel, pdf, issues: issues.slice(0, 200), log: Buffer.from(log, "latin1").toString("utf8").split("\n").slice(-300).join("\n"), seconds: Math.round((Date.now() - t0) / 100) / 10 });
		});
	});
}

/** 從 .log 整理錯誤(-file-line-error 格式「./a.tex:12: 訊息」)與重要警告 */
function parseLog(log: string, cwd: string, root: string): LatexIssue[] {
	const out: LatexIssue[] = [];
	const seen = new Set<string>();
	const rel = (f: string) => { const a = resolve(cwd, f); return a.startsWith(root) ? relative(root, a).split(sep).join("/") : f; };
	const lines = log.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		let m = l.match(/^(.*?\.(?:tex|sty|cls|bib|bbl)):(\d+): (.*)$/);
		if (m) {
			let msg = m[3].trim();
			// 下一兩行常是「l.12 \foo」的出錯位置,附上
			const ctx = lines.slice(i + 1, i + 4).find((x) => /^l\.\d+ /.test(x));
			if (ctx) msg += `(${ctx.replace(/^l\.\d+ /, "").trim().slice(0, 80)})`;
			const it: LatexIssue = { file: rel(m[1]), line: Number(m[2]), message: msg, level: "error" };
			const k = `${it.file}:${it.line}:${it.message}`;
			if (!seen.has(k)) { seen.add(k); out.push(it); }
			continue;
		}
		if (/^! /.test(l) && !lines.slice(Math.max(0, i - 1), i + 1).some((x) => /\.tex:\d+:/.test(x))) {
			out.push({ message: l.slice(2).trim(), level: "error" });
			continue;
		}
		m = l.match(/^(?:LaTeX|Package \w+) Warning: (.*?)(?: on input line (\d+))?\.?$/);
		if (m && !/^Label\(s\) may have changed/.test(m[1])) {
			const k = `w:${m[1]}:${m[2]}`;
			if (!seen.has(k)) { seen.add(k); out.push({ message: m[1], line: m[2] ? Number(m[2]) : undefined, level: "warning" }); }
		}
	}
	// 錯誤排前面
	return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
}
