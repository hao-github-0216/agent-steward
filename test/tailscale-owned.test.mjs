// 移除程式只關「這份安裝設定的」Tailscale Serve:Serve 是整台電腦共用的,同一台電腦上的其他安裝不能誤關。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "steward-ts-owned-"));
process.env.STEWARD_DATA_DIR = dir;
const { ownedServe } = await import("../src/tailscale.ts");
test.after(() => rmSync(dir, { recursive: true, force: true }));

const serve = { Web: { "box.example.ts.net:8793": { Handlers: { "/": { Proxy: "http://127.0.0.1:8791" } } }, "box.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5000" } } } } };
const saved = { server: { port: 8791, publicUrl: "https://box.example.ts.net:8793/" }, access: { tailscale: { enabled: true } } };

test("設定檔的網址和 Serve 一致、Tailscale 存取開著:算是這份安裝的", () => {
	assert.deepEqual(ownedServe(saved, serve), { port: 8791, https: "8793" });
});

test("沒有設定檔、存取沒開、網址不同或 port 不同:都不算,不關", () => {
	assert.equal(ownedServe(undefined, serve), undefined);
	assert.equal(ownedServe({ ...saved, access: { tailscale: { enabled: false } } }, serve), undefined);
	assert.equal(ownedServe({ ...saved, server: { port: 8791, publicUrl: "" } }, serve), undefined);
	assert.equal(ownedServe({ ...saved, server: { port: 8791, publicUrl: "https://other.example.ts.net:8793/" } }, serve), undefined);
	assert.equal(ownedServe({ ...saved, server: { port: 8791, publicUrl: "https://box.example.ts.net/" } }, serve), undefined);
	assert.equal(ownedServe({ ...saved, server: { port: 18941, publicUrl: "https://box.example.ts.net:8793/" } }, serve), undefined);
});

test("轉到 443 的 Serve:網址沒寫 port 也對得上", () => {
	const s443 = { Web: { "box.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8791" } } } } };
	assert.deepEqual(ownedServe({ ...saved, server: { port: 8791, publicUrl: "https://box.example.ts.net/" } }, s443), { port: 8791, https: "443" });
});
