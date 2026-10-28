// CI 用:在乾淨的資料夾實際安裝外掛(TinyTeX、uv + Jupyter),並用裝好的 TinyTeX 編譯中文與缺套件的文件。
// 用法:STEWARD_DATA_DIR=<暫存資料夾> node --experimental-strip-types scripts/ci-plugins.mjs <工作資料夾>
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const work = process.argv[2];
const plugins = await import("../src/plugins.ts");
const latex = await import("../src/latex.ts");
const log = (m, p) => { if (p === undefined || p % 50 === 0) console.log("  ", m); };

console.log("== Notebook 外掛");
await plugins.INSTALLERS.notebook(log);
const py = plugins.ownJupyterPython();
console.log(execFileSync(py, ["-c", "import ipykernel, numpy, pandas, matplotlib; print('jupyter ok', ipykernel.__version__)"]).toString().trim());

console.log("== LaTeX 外掛");
await plugins.INSTALLERS.latex(log);
console.log("latexmk:", latex.latexmkPath());
mkdirSync(join(work, "tex"), { recursive: true });
writeFileSync(join(work, "tex", "zh.tex"), "\\documentclass{article}\n\\usepackage{xeCJK}\n\\begin{document}\n中文測試 $E=mc^2$\n\\end{document}\n");
writeFileSync(join(work, "tex", "need.tex"), "\\documentclass{article}\n\\usepackage{lipsum}\n\\begin{document}\n\\lipsum[1]\n\\end{document}\n");
const p = { id: "ci", root: work };
for (const f of ["tex/zh.tex", "tex/need.tex"]) {
	const r = await latex.buildLatex(p, f);
	console.log(f, JSON.stringify({ ok: r.ok, engine: r.engine, pdf: r.pdf, installed: r.installed, errors: r.issues.filter((i) => i.level === "error").slice(0, 3) }));
	if (!r.ok) { console.log(r.log.split("\n").slice(-40).join("\n")); process.exit(1); }
}
console.log("全部通過");
