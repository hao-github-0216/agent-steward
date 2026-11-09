import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = mkdtempSync(join(tmpdir(), "steward-update-request-"));
process.env.HOME = DATA;
process.env.USERPROFILE = DATA;
process.env.STEWARD_DATA_DIR = DATA;
process.env.STEWARD_APP_DIR = fileURLToPath(new URL("../", import.meta.url));
after(() => rmSync(DATA, { recursive: true, force: true }));
const { updateRequestError } = await import("../src/update.ts");

const info = { current: "v0.1.0", latest: "v0.1.1", hasUpdate: true, dev: false, running: false };
const stale = "有更新的版本了,請重新檢查更新後再按一次";

test("沒有更新或查不到最新版時,回傳原本的錯誤", () => {
	assert.equal(updateRequestError({ ...info, hasUpdate: false }, info.latest), "已經是最新版");
	assert.equal(updateRequestError({ ...info, hasUpdate: false, dev: true }, info.latest), "開發版不能自動更新");
	assert.equal(updateRequestError({ ...info, hasUpdate: false, error: "查不到最新版本" }, info.latest), "查不到最新版本");
	assert.equal(updateRequestError({ ...info, latest: undefined }, info.latest), "已經是最新版");
});

test("確認的版本不等於最新版時拒絕更新", () => {
	assert.equal(updateRequestError(info, "v0.1.0"), stale);
});

test("請求沒有字串版本號時拒絕更新", () => {
	for (const tag of [undefined, null, 1, {}, [info.latest]]) assert.equal(updateRequestError(info, tag), stale);
});

test("請求版本與最新版相同時允許更新", () => {
	assert.equal(updateRequestError(info, info.latest), undefined);
});
