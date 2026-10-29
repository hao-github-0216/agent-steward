// iPhone 推播:通知文字轉成推播內容、APNs 的 JWT 簽章格式
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { jwt, messageFromText } from "../src/apns.ts";

test("messageFromText:第一行當標題、去掉看板網址、帶專案連結", () => {
	const m = messageFromText("⚠️ 工作卡卡住(WA2)\n修 Q2\n等使用者確認\n\nhttps://mac.ts.net:8793/", "p1");
	assert.equal(m.title, "⚠️ 工作卡卡住(WA2)");
	assert.equal(m.body, "修 Q2\n等使用者確認");
	assert.equal(m.link, "agentsteward://project/p1");
	assert.equal(m.thread, "p1");
	const p = messageFromText("🗂 提案(X)\n標題\n\n到看板核准:https://a.b/");
	assert.equal(p.body, "標題");
	assert.equal(p.link, undefined);
	assert.equal(messageFromText("只有一行").body, "只有一行");
});

test("jwt:ES256、kid/iss 正確、簽章是 64 bytes 的 r||s 而且驗得過", () => {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const t = jwt({ teamId: "TEAM123456", keyId: "KEY1234567", key: privateKey });
	const [h, p, s] = t.split(".");
	assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "ES256", kid: "KEY1234567" });
	const claims = JSON.parse(Buffer.from(p, "base64url"));
	assert.equal(claims.iss, "TEAM123456");
	assert.ok(Math.abs(claims.iat - Date.now() / 1000) < 5);
	const sig = Buffer.from(s, "base64url");
	assert.equal(sig.length, 64);
	assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, sig));
});
