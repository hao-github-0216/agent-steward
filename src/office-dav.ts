// 「用 Office 編輯」:給 Word / Excel / PowerPoint 一個 WebDAV 位址(/dav/<專用連結>/<檔名>),
// Office 打開後按存檔就直接寫回專案裡的原檔。
// 專用連結只能存取一個檔案,12 小時有效,每次存檔或鎖定都會延長;Office 拿不到瀏覽器的登入,所以靠這個連結。
// 每次存檔前把舊版本留在 ~/.agent-steward/office-history(每個檔案最近 20 版、最多 30 天)。
import { randomBytes, createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join } from "node:path";
import { inProject, OFFICE } from "./code.ts";
import { DATA_DIR } from "./settings.ts";
import type { Project, Store } from "./store.ts";

const LINK_TTL = 12 * 3600_000;
const LINKS_FILE = join(DATA_DIR, "office-links.json");
const HISTORY = join(DATA_DIR, "office-history");
const KEEP_VERSIONS = 20, KEEP_DAYS = 30;

interface Link { pid: string; rel: string; exp: number }
let links: Record<string, Link> = {};
try { links = JSON.parse(readFileSync(LINKS_FILE, "utf8")); } catch { /* 第一次 */ }
function saveLinks() {
	const now = Date.now();
	for (const [k, v] of Object.entries(links)) if (v.exp < now) delete links[k];
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(LINKS_FILE, JSON.stringify(links), { mode: 0o600 });
}

/** 網頁按「用 Office 編輯」:同一個檔案還有效的連結就沿用(Office 的「最近開啟」比較不會亂) */
export function officeLink(p: Project, rel: string): string {
	const now = Date.now();
	for (const [tok, l] of Object.entries(links)) {
		if (l.pid === p.id && l.rel === rel && l.exp > now + 3600_000) { l.exp = now + LINK_TTL; saveLinks(); return tok; }
	}
	const tok = randomBytes(24).toString("hex");
	links[tok] = { pid: p.id, rel, exp: now + LINK_TTL };
	saveLinks();
	return tok;
}

// ---------- Office 鎖定(誰正在用 Office 編輯) ----------
interface Lock { token: string; until: number; owner: string }
const locks = new Map<string, Lock>(); // key = pid:rel
const lockKey = (l: Link) => `${l.pid}:${l.rel}`;
export function officeEditing(p: Project, rel: string): { editing: boolean; owner?: string } {
	const l = locks.get(`${p.id}:${rel}`);
	return l && l.until > Date.now() ? { editing: true, owner: l.owner } : { editing: false };
}

// ---------- 舊版本 ----------
const histDir = (p: Project, rel: string) => join(HISTORY, p.id.replace(/[^A-Za-z0-9_-]/g, "_"), createHash("sha1").update(rel).digest("hex").slice(0, 16));
function backupVersion(p: Project, rel: string, abs: string) {
	if (!existsSync(abs)) return;
	const dir = histDir(p, rel);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "path.txt"), rel);
	const st = statSync(abs);
	copyFileSync(abs, join(dir, `${Math.round(st.mtimeMs)}${extname(abs)}`));
	// 留最近 20 版、30 天內
	const files = readdirSync(dir).filter((f) => /^\d+\./.test(f)).sort().reverse();
	const cutoff = Date.now() - KEEP_DAYS * 86400_000;
	files.forEach((f, i) => { if (i >= KEEP_VERSIONS || Number(f.split(".")[0]) < cutoff) { try { unlinkSync(join(dir, f)); } catch { /* 已刪 */ } } });
}
export function officeVersions(p: Project, rel: string): { id: string; at: number; size: number }[] {
	const dir = histDir(p, rel);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => /^\d+\./.test(f)).sort().reverse().map((f) => ({ id: f, at: Number(f.split(".")[0]), size: statSync(join(dir, f)).size }));
}
export function officeVersionFile(p: Project, rel: string, id: string): string {
	if (!/^\d+\.[A-Za-z0-9]+$/.test(id)) throw new Error("bad version");
	const f = join(histDir(p, rel), id);
	if (!existsSync(f)) throw new Error("找不到這個版本");
	return f;
}
/** 還原:目前的版本也先留一份 */
export function officeRestore(p: Project, rel: string, id: string): void {
	const src = officeVersionFile(p, rel, id);
	const abs = inProject(p, rel);
	backupVersion(p, rel, abs);
	copyFileSync(src, abs);
}

// ---------- WebDAV ----------
const xmlEsc = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
function props(href: string, st: { size: number; mtime: Date; birthtime: Date } | null, mime: string, lock?: Lock) {
	const lockXml = lock ? `<D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth><D:owner>${xmlEsc(lock.owner)}</D:owner><D:timeout>Second-${Math.max(1, Math.round((lock.until - Date.now()) / 1000))}</D:timeout><D:locktoken><D:href>${lock.token}</D:href></D:locktoken></D:activelock></D:lockdiscovery>` : "<D:lockdiscovery/>";
	const body = st
		? `<D:displayname>${xmlEsc(decodeURIComponent(href.split("/").pop() || ""))}</D:displayname><D:getcontentlength>${st.size}</D:getcontentlength><D:getcontenttype>${mime}</D:getcontenttype><D:getlastmodified>${st.mtime.toUTCString()}</D:getlastmodified><D:creationdate>${st.birthtime.toISOString()}</D:creationdate><D:getetag>"${st.size}-${st.mtime.getTime()}"</D:getetag><D:resourcetype/>`
		: "<D:resourcetype><D:collection/></D:resourcetype>";
	return `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${body}<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>${lockXml}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}
const MIME: Record<string, string> = { ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".doc": "application/msword", ".xls": "application/vnd.ms-excel", ".ppt": "application/vnd.ms-powerpoint" };

function readBody(req: IncomingMessage, limit = 200 * 1024 * 1024): Promise<Buffer> {
	return new Promise((ok, fail) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (c: Buffer) => { size += c.length; if (size > limit) { req.destroy(); fail(new Error("too large")); } else chunks.push(c); });
		req.on("end", () => ok(Buffer.concat(chunks)));
		req.on("error", fail);
	});
}

/** /dav/<專用連結>/<檔名>;回傳 true = 已處理 */
export async function handleDav(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
	const url = new URL(req.url ?? "/", "http://x");
	const m = url.pathname.match(/^\/dav\/([0-9a-f]{48})(\/.*)?$/);
	if (!m) return false;
	const link = links[m[1]];
	const reply = (code: number, headers: Record<string, string> = {}, body = "") => { res.writeHead(code, { "cache-control": "no-store", ...headers }); res.end(body); };
	if (!link || link.exp < Date.now()) { reply(404, { "content-type": "text/plain; charset=utf-8" }, "這個編輯連結已經過期,請回到專案管家重新按「用 Office 編輯」"); return true; }
	const p = store.project(link.pid);
	if (!p) { reply(404); return true; }
	const abs = inProject(p, link.rel);
	const name = basename(link.rel);
	const base = `/dav/${m[1]}/`;
	const fileHref = base + encodeURIComponent(name);
	const sub = decodeURIComponent((m[2] ?? "/").slice(1));
	const isFile = sub === name;
	const isDir = sub === "";
	const method = (req.method ?? "GET").toUpperCase();
	const mime = MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
	const key = lockKey(link);
	const lock = locks.get(key);
	const liveLock = lock && lock.until > Date.now() ? lock : undefined;
	const extend = () => { link.exp = Date.now() + LINK_TTL; saveLinks(); };
	const DAV = { DAV: "1,2", "MS-Author-Via": "DAV", Allow: "OPTIONS, GET, HEAD, PUT, PROPFIND, PROPPATCH, LOCK, UNLOCK" };

	if (method === "OPTIONS") { reply(200, DAV); return true; }
	if (!isFile && !isDir) {
		// Office 有時會試著碰同資料夾的其他檔案(暫存檔、owner 檔):這個連結只開放一個檔案
		if (method === "PROPFIND" || method === "GET" || method === "HEAD") { reply(404); return true; }
		reply(403); return true;
	}
	if (method === "PROPFIND") {
		await readBody(req).catch(() => Buffer.alloc(0));
		const st = existsSync(abs) ? statSync(abs) : null;
		const depth = String(req.headers.depth ?? "1");
		let xml = "";
		if (isDir) { xml += props(base, null, ""); if (depth !== "0" && st) xml += props(fileHref, st, mime, liveLock); }
		else if (st) xml += props(fileHref, st, mime, liveLock);
		else { reply(404); return true; }
		reply(207, { "content-type": 'application/xml; charset="utf-8"', ...DAV }, `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${xml}</D:multistatus>`);
		return true;
	}
	if (!isFile) { reply(405, DAV); return true; }
	if (method === "GET" || method === "HEAD") {
		if (!existsSync(abs)) { reply(404); return true; }
		const st = statSync(abs);
		res.writeHead(200, { "content-type": mime, "content-length": String(st.size), "last-modified": st.mtime.toUTCString(), etag: `"${st.size}-${st.mtime.getTime()}"`, "cache-control": "no-store", ...DAV });
		if (method === "HEAD") res.end(); else createReadStream(abs).pipe(res);
		return true;
	}
	if (method === "PUT") {
		// 別人(另一個 Office)鎖住時不准寫
		const ifh = String(req.headers.if ?? "");
		if (liveLock && ifh && !ifh.includes(liveLock.token)) { await readBody(req).catch(() => null); reply(423); return true; }
		let buf: Buffer;
		try { buf = await readBody(req); } catch { reply(413); return true; }
		if (!OFFICE[extname(abs).toLowerCase()]) { reply(403); return true; }
		const existed = existsSync(abs);
		backupVersion(p, link.rel, abs);
		const tmp = `${abs}.steward-tmp`;
		writeFileSync(tmp, buf);
		renameSync(tmp, abs);
		extend();
		if (liveLock) liveLock.until = Math.max(liveLock.until, Date.now() + 600_000);
		reply(existed ? 204 : 201, DAV);
		return true;
	}
	if (method === "PROPPATCH") {
		await readBody(req).catch(() => null);
		reply(207, { "content-type": 'application/xml; charset="utf-8"' }, `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${fileHref}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`);
		return true;
	}
	if (method === "LOCK") {
		const raw = (await readBody(req).catch(() => Buffer.alloc(0))).toString("utf8");
		const tm = String(req.headers.timeout ?? "").match(/Second-(\d+)/i);
		const secs = Math.min(3600, Math.max(60, tm ? Number(tm[1]) : 3600));
		const ifh = String(req.headers.if ?? "");
		let lk = liveLock;
		if (!raw.trim() && lk && ifh.includes(lk.token)) lk.until = Date.now() + secs * 1000; // 續約
		else {
			if (lk && !ifh.includes(lk.token)) { reply(423); return true; } // 別人正在編輯
			const owner = (raw.match(/<(?:\w+:)?owner>([\s\S]*?)<\/(?:\w+:)?owner>/i)?.[1] ?? "").replace(/<[^>]+>/g, "").trim().slice(0, 100) || "Office";
			lk = { token: `opaquelocktoken:${randomBytes(16).toString("hex")}`, until: Date.now() + secs * 1000, owner };
			locks.set(key, lk);
		}
		extend();
		reply(200, { "content-type": 'application/xml; charset="utf-8"', "lock-token": `<${lk.token}>`, ...DAV },
			`<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth><D:owner>${xmlEsc(lk.owner)}</D:owner><D:timeout>Second-${secs}</D:timeout><D:locktoken><D:href>${lk.token}</D:href></D:locktoken><D:lockroot><D:href>${fileHref}</D:href></D:lockroot></D:activelock></D:lockdiscovery></D:prop>`);
		return true;
	}
	if (method === "UNLOCK") {
		const tok = String(req.headers["lock-token"] ?? "").replace(/[<>]/g, "");
		if (liveLock && liveLock.token === tok) locks.delete(key);
		reply(204, DAV);
		return true;
	}
	reply(405, DAV);
	return true;
}
