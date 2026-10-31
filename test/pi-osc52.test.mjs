// pi 擴充套件:在 herdr 裡讓 pi 全螢幕模式的複製也送 OSC 52,網頁終端機才收得到
import { test } from "node:test";
import assert from "node:assert/strict";

const { enableOsc52Copy } = await import("../integrations/pi/steward-brief.ts");

test("在 herdr 窗格裡打開 OSC 52", () => {
	const env = { TERM_PROGRAM: "herdr" };
	enableOsc52Copy(env);
	assert.equal(env.PI_CLIPBOARD_OSC52, "1");
	const env2 = { HERDR_PANE_ID: "w1:p1" };
	enableOsc52Copy(env2);
	assert.equal(env2.PI_CLIPBOARD_OSC52, "1");
});

test("不在 herdr 裡不動", () => {
	const env = { TERM_PROGRAM: "iTerm.app" };
	enableOsc52Copy(env);
	assert.equal(env.PI_CLIPBOARD_OSC52, undefined);
});

test("使用者自己設過就照他的", () => {
	const env = { TERM_PROGRAM: "herdr", PI_CLIPBOARD_OSC52: "0" };
	enableOsc52Copy(env);
	assert.equal(env.PI_CLIPBOARD_OSC52, "0");
});
