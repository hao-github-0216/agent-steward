import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { validatePush } from "../src/validate";

const valid = { v: 1, platform: "ios", token: "a".repeat(64), payload: "YWJjZA==" };

function environment(): Env {
  return {
    APNS_TOPIC: "test.topic",
    RL_IP: { limit: vi.fn(async () => ({ success: true })) },
    RL_TOKEN: { limit: vi.fn(async () => ({ success: true })) },
  };
}

const invalid: [string, unknown, string][] = [
  ["null body", null, "invalid_body"],
  ["array body", [], "invalid_body"],
  ["string body", "text", "invalid_body"],
  ["number body", 1, "invalid_body"],
  ["missing version", { ...valid, v: undefined }, "invalid_v"],
  ["wrong version", { ...valid, v: 2 }, "invalid_v"],
  ["string version", { ...valid, v: "1" }, "invalid_v"],
  ["missing platform", { ...valid, platform: undefined }, "invalid_platform"],
  ["wrong platform", { ...valid, platform: "windows" }, "invalid_platform"],
  ["non-string platform", { ...valid, platform: 1 }, "invalid_platform"],
  ["missing token", { ...valid, token: undefined }, "invalid_token"],
  ["non-string token", { ...valid, token: 123 }, "invalid_token"],
  ["empty iOS token", { ...valid, token: "" }, "invalid_token"],
  ["short iOS token", { ...valid, token: "a".repeat(63) }, "invalid_token"],
  ["long iOS token", { ...valid, token: "a".repeat(201) }, "invalid_token"],
  ["non-hex iOS token", { ...valid, token: "g".repeat(64) }, "invalid_token"],
  ["empty Android token", { ...valid, platform: "android", token: "" }, "invalid_token"],
  ["Android token punctuation", { ...valid, platform: "android", token: "a/b" }, "invalid_token"],
  ["Android token whitespace", { ...valid, platform: "android", token: "a b" }, "invalid_token"],
  ["missing payload", { ...valid, payload: undefined }, "invalid_payload"],
  ["non-string payload", { ...valid, payload: {} }, "invalid_payload"],
  ["empty payload", { ...valid, payload: "" }, "invalid_payload"],
  ["long payload", { ...valid, payload: "a".repeat(3001) }, "invalid_payload"],
  ["base64url payload", { ...valid, payload: "a_-" }, "invalid_payload"],
  ["payload whitespace", { ...valid, payload: "YW Jj" }, "invalid_payload"],
  ["payload Unicode", { ...valid, payload: "中文" }, "invalid_payload"],
  ["wrong iOS environment", { ...valid, env: "development" }, "invalid_env"],
  ["non-string iOS environment", { ...valid, env: null }, "invalid_env"],
  ["non-string collapse", { ...valid, collapse: 12 }, "invalid_collapse"],
  ["null collapse", { ...valid, collapse: null }, "invalid_collapse"],
  ["long collapse", { ...valid, collapse: "a".repeat(65) }, "invalid_collapse"],
  ["collapse punctuation", { ...valid, collapse: "a/b" }, "invalid_collapse"],
  ["collapse Unicode", { ...valid, collapse: "專案" }, "invalid_collapse"],
  ["URL field", { ...valid, url: "https://example.invalid" }, "unknown_field"],
];

describe("request validation", () => {
  it.each(invalid)("%s returns 400", async (_name, body, error) => {
    const env = environment();
    const response = await worker.fetch(
      new Request("https://relay.invalid/v1/push", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error });
    expect(env.RL_IP.limit).not.toHaveBeenCalled();
    expect(env.RL_TOKEN.limit).not.toHaveBeenCalled();
  });

  it("rejects Android tokens longer than 4096 characters", async () => {
    const body = { ...valid, platform: "android", token: "a".repeat(4097) };
    expect(validatePush(body)).toBe("invalid_token");
    const response = await worker.fetch(
      new Request("https://relay.invalid/v1/push", { method: "POST", body: JSON.stringify(body) }),
      environment(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "body_too_large" });
  });

  it.each([
    { ...valid, token: "A0".repeat(32) },
    { ...valid, token: "b".repeat(200) },
    { ...valid, env: "sandbox" },
    { ...valid, env: "production" },
    { ...valid, platform: "android", token: "a" },
    { ...valid, platform: "android", token: "A0-_:" },
    { ...valid, platform: "android", token: "a".repeat(4096) },
    { ...valid, platform: "android", token: "a", env: "ignored" },
    { ...valid, payload: "a" },
    { ...valid, payload: "+/==" },
    { ...valid, payload: "a".repeat(3000) },
    { ...valid, collapse: "" },
    { ...valid, collapse: "aZ0_-" },
    { ...valid, collapse: "a".repeat(64) },
  ])("accepts valid field boundaries: %j", (body) => {
    expect(validatePush(body)).toBeNull();
  });

  it.each(["{", "", "not json"])("rejects malformed JSON: %j", async (body) => {
    const response = await worker.fetch(
      new Request("https://relay.invalid/v1/push", { method: "POST", body }),
      environment(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "invalid_json" });
  });

  it("rejects invalid UTF-8", async () => {
    const response = await worker.fetch(
      new Request("https://relay.invalid/v1/push", { method: "POST", body: new Uint8Array([255]) }),
      environment(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "invalid_json" });
  });

  it("accepts exactly 4096 bytes but rejects 4097", async () => {
    const text = JSON.stringify(valid);
    for (const size of [4096, 4097]) {
      const response = await worker.fetch(
        new Request("https://relay.invalid/v1/push", {
          method: "POST",
          body: text + " ".repeat(size - text.length),
        }),
        environment(),
      );
      expect(response.status).toBe(size === 4096 ? 503 : 400);
      expect(await response.json()).toEqual({
        ok: false,
        error: size === 4096 ? "platform_not_configured" : "body_too_large",
      });
    }
  });

  it("measures UTF-8 bytes rather than characters", async () => {
    const body = JSON.stringify({ text: "字".repeat(1400) });
    expect(body.length).toBeLessThan(4096);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(4096);
    const response = await worker.fetch(
      new Request("https://relay.invalid/v1/push", { method: "POST", body }),
      environment(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "body_too_large" });
  });

  it("cancels streamed bodies once their actual size exceeds the limit", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2048).fill(32));
        controller.enqueue(new Uint8Array(2049).fill(32));
      },
      cancel,
    });
    const response = await worker.fetch(
      new Request("https://relay.invalid/v1/push", {
        method: "POST",
        headers: { "content-length": "1" },
        body,
      }),
      environment(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "body_too_large" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
