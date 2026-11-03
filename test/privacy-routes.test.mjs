// 隱私專案:建議問題/提交訊息只走隱私路由(不用備用)、跨專案只露名稱、推播不帶內容
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STEWARD_DATA_DIR = mkdtempSync(join(tmpdir(), "privacy-routes-"));
const { updateSettings } = await import("../src/settings.ts");
const { NoModelError } = await import("../src/models.ts");
const { publicProjectView, pushText, routeForProject } = await import("../src/privacy.ts");

const empty = { primary: "", fallback: "" };
const cloud = { primary: "cloud/y", fallback: "cloud/z" };
const routing = (privacy) => ({ chat: empty, suggest: cloud, digest: empty, judge: empty, commitmsg: cloud, privacy });

const secret = { id: "p-secret", name: "示範隱私專案", private: true, root: "/secret/root", state: { progress: "示範進度", blockers: ["示範卡點"] } };
const other = { id: "p-other", name: "一般專案", private: false, root: "/other/root", state: { progress: "公開進度", blockers: [] } };

test("隱私專案一律用隱私路由,傳 fallback 也不改用備用", () => {
	updateSettings({ providers: [], routing: routing("loc/x") });
	assert.deepEqual(routeForProject("suggest", { private: true }), { provider: "loc", modelId: "x" });
	assert.deepEqual(routeForProject("commitmsg", { private: true, fallback: true }), { provider: "loc", modelId: "x" });
});

test("非隱私專案照路由的主要/備用", () => {
	updateSettings({ providers: [], routing: routing("loc/x") });
	assert.deepEqual(routeForProject("suggest", {}), { provider: "cloud", modelId: "y" });
	assert.deepEqual(routeForProject("suggest", { fallback: true }), { provider: "cloud", modelId: "z" });
});

test("隱私路由沒設定:丟 NoModelError,不退回一般模型", () => {
	updateSettings({ providers: [], routing: routing("") });
	assert.throws(() => routeForProject("suggest", { private: true }), NoModelError);
	assert.throws(() => routeForProject("commitmsg", { private: true, fallback: true }), NoModelError);
});

test("跨專案查隱私專案只給名稱", () => {
	const v = publicProjectView(secret, other);
	assert.deepEqual(Object.keys(v).sort(), ["name", "private"]);
	assert.deepEqual(v, { name: "示範隱私專案", private: true });
	assert.equal("state" in v, false);
	assert.equal("root" in v, false);
	// 沒有來源專案(例如沒帶 cwd)也一樣
	assert.deepEqual(publicProjectView(secret, undefined), { name: "示範隱私專案", private: true });
});

test("同一個專案、非隱私專案原樣回;找不到回 null", () => {
	assert.equal(publicProjectView(secret, { ...secret }), secret);
	assert.equal(publicProjectView(other, secret), other);
	assert.equal(publicProjectView(undefined, other), null);
});

test("推播:隱私專案用通用文字,不含專案名和卡片標題", () => {
	const title = "示範卡片標題";
	const full = `⚠️ 工作卡卡住(${secret.name})\n${title}`;
	const generic = "🔒 有一個隱私專案的工作卡卡住,請到看板查看";
	const out = pushText(secret, full, generic);
	assert.equal(out, generic);
	assert.equal(out.includes(secret.name), false);
	assert.equal(out.includes(title), false);
	assert.equal(pushText(other, full, generic), full);
	assert.equal(pushText(undefined, full, generic), full);
});
