// 網頁終端機貼圖片:瀏覽器的剪貼簿圖片傳不進終端機,改成先上傳存檔,再把檔案路徑貼進去
// (Claude Code、Codex、pi 都看得懂圖片路徑)。檔案放 ~/.agent-steward/pastes/,7 天後自動清掉。
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { DATA_DIR } from "./config.ts";

const DIR = join(DATA_DIR, "pastes");
export const MAX_PASTE_BYTES = 25 * 1024 * 1024;
const KEEP_MS = 7 * 24 * 3600_000;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/heic": "heic", "image/heif": "heif", "image/tiff": "tiff" };

export class PasteError extends Error {
	status: number;
	constructor(status: number, message: string) { super(message); this.status = status; }
}

function cleanup(): void {
	try {
		const now = Date.now();
		for (const f of readdirSync(DIR)) {
			const p = join(DIR, f);
			try { if (now - statSync(p).mtimeMs > KEEP_MS) unlinkSync(p); } catch { /* 別人刪了 */ }
		}
	} catch { /* 資料夾還沒建 */ }
}

/** 讀請求內容存成圖片檔,回傳絕對路徑 */
export async function savePastedImage(req: IncomingMessage, type: string): Promise<string> {
	const mime = type.split(";")[0].trim().toLowerCase();
	const ext = EXT[mime];
	if (!ext) throw new PasteError(415, `不支援的圖片格式:${mime || "未知"}`);
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const c of req) {
		size += (c as Buffer).length;
		if (size > MAX_PASTE_BYTES) throw new PasteError(413, "圖片超過 25MB");
		chunks.push(c as Buffer);
	}
	if (!size) throw new PasteError(400, "沒有收到圖片");
	mkdirSync(DIR, { recursive: true });
	cleanup();
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const name = `paste-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${randomBytes(3).toString("hex")}.${ext}`;
	const file = join(DIR, name);
	writeFileSync(file, Buffer.concat(chunks));
	return file;
}
