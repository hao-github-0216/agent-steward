import { env as runtimeEnv } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import type { PushRequest } from "../src/validate";

interface MockReply {
  url: string;
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface MockState {
  requests: RecordedRequest[];
  pending: number;
  unexpected: string[];
}

const controller = (runtimeEnv as unknown as { MOCK_UPSTREAM: Fetcher }).MOCK_UPSTREAM;
const oauthUrl = "https://oauth2.googleapis.com/token";
const fcmUrl = "https://fcm.googleapis.com/v1/projects/test-project/messages:send";
const ios: PushRequest = {
  v: 1,
  platform: "ios",
  token: "ab".repeat(32),
  payload: "cHJpdmF0ZS1wYXlsb2FkLXNlbnRpbmVs",
};
const android: PushRequest = { ...ios, platform: "android", token: "FCM_token-123:device" };
let p8: string;
let rsaPrivate: string;
let rsaPublic: CryptoKey;
let counter = 0;

function pem(bytes: ArrayBuffer): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

function decodeJwtPart(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

function configuration(overrides: Partial<Env> = {}): Env {
  counter += 1;
  return {
    APNS_KEY_P8: p8,
    APNS_KEY_ID: `TEST${counter}`,
    APNS_TEAM_ID: "TESTTEAM",
    APNS_TOPIC: "io.github.haogithub0216.agentsteward.native",
    FCM_SERVICE_ACCOUNT: JSON.stringify({
      project_id: "test-project",
      client_email: "relay@test-project.iam.gserviceaccount.com",
      private_key: rsaPrivate,
      private_key_id: `rsa-test-${counter}`,
      token_uri: "https://untrusted.invalid/not-used",
    }),
    RL_IP: { limit: vi.fn(async () => ({ success: true })) },
    RL_TOKEN: { limit: vi.fn(async () => ({ success: true })) },
    ...overrides,
  };
}

async function setReplies(replies: MockReply[]): Promise<void> {
  await controller.fetch("https://mock.invalid/", {
    method: "POST", body: JSON.stringify({ replies }),
  });
}

async function state(): Promise<MockState> {
  const response = await controller.fetch("https://mock.invalid/");
  return response.json<MockState>();
}

function send(push: PushRequest, env: Env, ip = "198.51.100.7"): Promise<Response> {
  return worker.fetch(new Request("https://relay.invalid/v1/push", {
    method: "POST",
    headers: { "cf-connecting-ip": ip, "content-type": "application/json" },
    body: JSON.stringify(push),
  }), env);
}

function appleUrl(push = ios): string {
  return `https://${push.env === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com"}/3/device/${push.token}`;
}

function oauthReply(token = "test-access-token"): MockReply {
  return { url: oauthUrl, status: 200, body: JSON.stringify({ access_token: token, expires_in: 3600 }) };
}

beforeAll(async () => {
  const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign", "verify",
  ]) as CryptoKeyPair;
  p8 = pem(await crypto.subtle.exportKey("pkcs8", ec.privateKey) as ArrayBuffer);
  const rsa = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  }, true, ["sign", "verify"]) as CryptoKeyPair;
  rsaPrivate = pem(await crypto.subtle.exportKey("pkcs8", rsa.privateKey) as ArrayBuffer);
  rsaPublic = rsa.publicKey;
});

beforeEach(async () => {
  await setReplies([]);
  vi.stubGlobal("console", { ...console, log: vi.fn() });
});

afterEach(async () => {
  try {
    const mock = await state();
    expect(mock.unexpected).toEqual([]);
    expect(mock.pending).toBe(0);
    for (const args of vi.mocked(console.log).mock.calls) {
      expect(args).toHaveLength(1);
      expect(typeof args[0]).toBe("string");
      const entry = JSON.parse(args[0]);
      expect(Object.keys(entry).sort()).toEqual(["ms", "platform", "status"]);
      expect(["ios", "android"]).toContain(entry.platform);
      expect(typeof entry.status).toBe("number");
      expect(typeof entry.ms).toBe("number");
      expect(entry.ms).toBeGreaterThanOrEqual(0);
    }
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("routing and platform configuration", () => {
  it.each([
    ["GET", "/missing"], ["POST", "/missing"], ["GET", "/v1/push"],
    ["PUT", "/v1/push"], ["POST", "/v1/health"], ["HEAD", "/v1/health"],
    ["POST", "/v1/push/"],
  ])("%s %s returns 404", async (method, path) => {
    const response = await worker.fetch(new Request(`https://relay.invalid${path}`, { method }), configuration());
    expect(response.status).toBe(404);
    expect(console.log).not.toHaveBeenCalled();
  });

  it("uses the Wrangler bindings when called through the Worker entry point", async () => {
    const response = await SELF.fetch("https://relay.invalid/v1/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ios: false, android: false, v: 1 });
  });

  it.each([
    [false, false], [true, false], [false, true], [true, true],
  ])("health reports ios=%s, android=%s", async (hasIos, hasAndroid) => {
    const env = configuration();
    if (!hasIos) env.APNS_KEY_P8 = "";
    if (!hasAndroid) env.FCM_SERVICE_ACCOUNT = "";
    const response = await worker.fetch(new Request("https://relay.invalid/v1/health"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ios: hasIos, android: hasAndroid, v: 1 });
    expect(env.RL_IP.limit).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it.each(["APNS_KEY_P8", "APNS_KEY_ID", "APNS_TEAM_ID"] as const)(
    "missing or empty %s disables iOS", async (field) => {
      for (const value of [undefined, "", " \n "]) {
        const env = configuration({ [field]: value });
        const response = await send(ios, env);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ ok: false, error: "platform_not_configured" });
        const health = await worker.fetch(new Request("https://relay.invalid/v1/health"), env);
        expect(await health.json()).toEqual({ ok: true, ios: false, android: true, v: 1 });
      }
      expect(console.log).not.toHaveBeenCalled();
    },
  );

  it("missing or empty FCM service account disables Android", async () => {
    for (const value of [undefined, "", " \n "]) {
      const response = await send(android, configuration({ FCM_SERVICE_ACCOUNT: value }));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, error: "platform_not_configured" });
    }
    expect(console.log).not.toHaveBeenCalled();
  });
});

describe("iOS APNs", () => {
  it.each([
    { env: "sandbox" as const, collapse: "a1b2-test_thread" },
    { env: "production" as const },
    { collapse: "default-production" },
    { collapse: "" },
  ])("sends exactly the protocol body and headers: %j", async (options) => {
    const push: PushRequest = { ...ios, ...options };
    const env = configuration();
    await setReplies([{ url: appleUrl(push), status: 200 }]);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const response = await send(push, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const calls = (await state()).requests;
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(appleUrl(push));
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers).toMatchObject({
      "apns-topic": env.APNS_TOPIC,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    });
    expect(calls[0].headers.authorization).toMatch(/^bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(calls[0].headers).not.toHaveProperty("apns-collapse-id");
    expect(JSON.parse(calls[0].body)).toEqual({
      aps: {
        alert: { "title-loc-key": "PUSH_FALLBACK_TITLE", "loc-key": "PUSH_FALLBACK_BODY" },
        "mutable-content": 1,
        sound: "default",
        ...(push.collapse !== undefined ? { "thread-id": push.collapse } : {}),
      },
      e: push.payload,
    });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
    expect(console.log).toHaveBeenCalledOnce();
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({ platform: "ios", status: 200 });
  });

  it.each([
    [410, "Unregistered"], [410, "other"], [400, "BadDeviceToken"], [400, "Unregistered"],
  ])("maps APNs %s %s to 410 gone", async (status, reason) => {
    await setReplies([{ url: appleUrl(), status, body: JSON.stringify({ reason }) }]);
    const response = await send(ios, configuration());
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ ok: false, gone: true });
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0]).status).toBe(status);
  });

  it("signs a new APNs JWT after ExpiredProviderToken", async () => {
    const config = configuration();
    await setReplies([
      { url: appleUrl(), status: 403, body: JSON.stringify({ reason: "ExpiredProviderToken" }) },
      { url: appleUrl(), status: 200 },
    ]);
    expect((await send(ios, config)).status).toBe(502);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
    expect((await send(ios, config)).status).toBe(200);
    const calls = (await state()).requests;
    expect(calls).toHaveLength(2);
    expect(calls[1].headers.authorization).not.toBe(calls[0].headers.authorization);
  });

  it("maps APNs 500 to 502 with status and reason", async () => {
    await setReplies([{ url: appleUrl(), status: 500, body: JSON.stringify({ reason: "InternalServerError" }) }]);
    const response = await send(ios, configuration());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: "apns_500_InternalServerError" });
  });

  it("handles non-JSON APNs errors", async () => {
    await setReplies([{ url: appleUrl(), status: 503, body: "unavailable" }]);
    const response = await send(ios, configuration());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: "apns_503_unknown" });
  });

  it("does not follow upstream redirects", async () => {
    await setReplies([{ url: appleUrl(), status: 302, headers: { location: "https://untrusted.invalid/push" } }]);
    const response = await send(ios, configuration());
    expect(response.status).toBe(502);
    expect((await state()).requests).toHaveLength(1);
  });
});

describe("Android FCM", () => {
  it("exchanges a verified RS256 JWT once and reuses the access token", async () => {
    const env = configuration();
    const withCollapse: PushRequest = { ...android, collapse: "opaque-thread" };
    await setReplies([
      oauthReply(), { url: fcmUrl, status: 200, body: "{}" },
      { url: fcmUrl, status: 200, body: "{}" },
    ]);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    for (const push of [withCollapse, android]) {
      const response = await send(push, env);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
    const calls = (await state()).requests;
    expect(calls.map((call) => call.url)).toEqual([oauthUrl, fcmUrl, fcmUrl]);
    expect(calls[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(calls[0].body);
    expect(Array.from(form.keys()).sort()).toEqual(["assertion", "grant_type"]);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const jwt = form.get("assertion")!;
    expect(jwt.split(".")).toHaveLength(3);
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(decodeJwtPart(header)))).toEqual({
      alg: "RS256", typ: "JWT", kid: JSON.parse(env.FCM_SERVICE_ACCOUNT!).private_key_id,
    });
    const decoded = JSON.parse(new TextDecoder().decode(decodeJwtPart(claims)));
    expect(decoded).toEqual({
      iss: "relay@test-project.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: oauthUrl,
      iat: expect.any(Number),
      exp: expect.any(Number),
    });
    expect(decoded.exp - decoded.iat).toBe(3600);
    expect(Math.abs(decoded.iat - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2);
    expect(await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", rsaPublic, decodeJwtPart(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    )).toBe(true);
    for (const [index, push] of [withCollapse, android].entries()) {
      const call = calls[index + 1];
      expect(call.method).toBe("POST");
      expect(call.headers).toMatchObject({
        authorization: "Bearer test-access-token", "content-type": "application/json",
      });
      expect(JSON.parse(call.body)).toEqual({
        message: {
          token: push.token,
          data: { v: "1", e: push.payload },
          android: {
            priority: "high",
            ...(push.collapse !== undefined ? { collapse_key: push.collapse } : {}),
          },
        },
      });
      expect(JSON.parse(call.body).message).not.toHaveProperty("notification");
    }
    expect(timeout).toHaveBeenCalledTimes(3);
    expect(timeout.mock.calls.every(([ms]) => ms === 10_000)).toBe(true);
  });

  it("renews the OAuth token exactly five minutes before expiry", async () => {
    const env = configuration();
    const start = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    await setReplies([
      oauthReply("first-access"), { url: fcmUrl, status: 200 },
      { url: fcmUrl, status: 200 },
      oauthReply("second-access"), { url: fcmUrl, status: 200 },
    ]);
    expect((await send(android, env)).status).toBe(200);
    clock.mockReturnValue(start + 55 * 60 * 1000 - 1);
    expect((await send(android, env)).status).toBe(200);
    clock.mockReturnValue(start + 55 * 60 * 1000);
    expect((await send(android, env)).status).toBe(200);
    const calls = (await state()).requests;
    expect(calls.map((call) => call.url)).toEqual([oauthUrl, fcmUrl, fcmUrl, oauthUrl, fcmUrl]);
    expect(calls[1].headers.authorization).toBe("Bearer first-access");
    expect(calls[2].headers.authorization).toBe("Bearer first-access");
    expect(calls[4].headers.authorization).toBe("Bearer second-access");
  });

  it.each([
    [404, "not JSON"],
    [400, JSON.stringify({ error: { details: [{ errorCode: "UNREGISTERED" }] } })],
    [500, JSON.stringify({ error: { details: [null, { errorCode: "OTHER" }, { errorCode: "UNREGISTERED" }] } })],
  ])("maps FCM %s / UNREGISTERED to gone", async (status, body) => {
    await setReplies([oauthReply(), { url: fcmUrl, status, body }]);
    const response = await send(android, configuration());
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ ok: false, gone: true });
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0]).status).toBe(status);
  });

  it.each([400, 401, 429, 500])("maps FCM %s to 502", async (status) => {
    await setReplies([oauthReply(), { url: fcmUrl, status, body: "not JSON" }]);
    const response = await send(android, configuration());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: `fcm_${status}` });
  });

  it("maps OAuth errors to 502 without calling FCM", async () => {
    await setReplies([{ url: oauthUrl, status: 401, body: "{}" }]);
    const response = await send(android, configuration());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: "fcm_401" });
    expect((await state()).requests).toHaveLength(1);
  });

  it.each(["{}", "not JSON", '{"access_token":"test","expires_in":0}'])(
    "maps malformed OAuth replies to 502: %s", async (body) => {
      await setReplies([{ url: oauthUrl, status: 200, body }]);
      const response = await send(android, configuration());
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ ok: false, error: "upstream_error" });
    },
  );

  it.each(["not JSON", "{}", "null"])("handles invalid service account configuration: %s", async (account) => {
    const response = await send(android, configuration({ FCM_SERVICE_ACCOUNT: account }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: "upstream_error" });
    expect((await state()).requests).toHaveLength(0);
  });
});

describe("rate limiting, exceptions and private logs", () => {
  it("checks the CF source IP first and skips the token binding when denied", async () => {
    const env = configuration();
    vi.mocked(env.RL_IP.limit).mockResolvedValue({ success: false });
    const response = await send(ios, env);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ ok: false, error: "rate_limited" });
    expect(env.RL_IP.limit).toHaveBeenCalledExactlyOnceWith({ key: "198.51.100.7" });
    expect(env.RL_TOKEN.limit).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("checks the token after the IP and normalizes iOS hex case", async () => {
    const env = configuration();
    const order: string[] = [];
    vi.mocked(env.RL_IP.limit).mockImplementation(async () => { order.push("ip"); return { success: true }; });
    vi.mocked(env.RL_TOKEN.limit).mockImplementation(async () => { order.push("token"); return { success: false }; });
    const response = await send({ ...ios, token: ios.token.toUpperCase() }, env);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ ok: false, error: "rate_limited" });
    expect(order).toEqual(["ip", "token"]);
    expect(env.RL_TOKEN.limit).toHaveBeenCalledExactlyOnceWith({ key: `ios:${ios.token}` });
  });

  it("preserves Android token case in the limiter key", async () => {
    const env = configuration();
    vi.mocked(env.RL_TOKEN.limit).mockResolvedValue({ success: false });
    expect((await send(android, env)).status).toBe(429);
    expect(env.RL_TOKEN.limit).toHaveBeenCalledExactlyOnceWith({ key: `android:${android.token}` });
  });

  it("does not bypass IP limiting when CF-Connecting-IP is absent", async () => {
    const env = configuration();
    vi.mocked(env.RL_IP.limit).mockResolvedValue({ success: false });
    const response = await worker.fetch(new Request("https://relay.invalid/v1/push", {
      method: "POST", body: JSON.stringify(ios),
    }), env);
    expect(response.status).toBe(429);
    expect(env.RL_IP.limit).toHaveBeenCalledExactlyOnceWith({ key: "unknown" });
  });

  it.each([ios, android])("maps immediate $platform timeouts to 502", async (push) => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(
      () => AbortSignal.abort(new DOMException("test timeout", "TimeoutError")),
    );
    const response = await send(push, configuration());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: "upstream_timeout" });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
  });

  it("applies the FCM timeout after an access token has been cached", async () => {
    const env = configuration();
    await setReplies([oauthReply(), { url: fcmUrl, status: 200 }]);
    expect((await send(android, env)).status).toBe(200);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(
      () => AbortSignal.abort(new DOMException("test timeout", "TimeoutError")),
    );
    const response = await send(android, env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: "upstream_timeout" });
    expect((await state()).requests).toHaveLength(2);
  });

  it("does not expose exception messages in logs or responses", async () => {
    const secretMessage = `${ios.token} ${ios.payload} opaque-collapse`;
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error(secretMessage));
    const response = await send({ ...ios, collapse: "opaque-collapse" }, configuration());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: "upstream_error" });
    const output = JSON.stringify(vi.mocked(console.log).mock.calls);
    for (const value of [ios.token, ios.payload, "opaque-collapse"]) expect(output).not.toContain(value);
  });

  it("logs only platform, upstream status and elapsed time on success", async () => {
    await setReplies([{ url: appleUrl(), status: 200 }]);
    expect((await send({ ...ios, collapse: "private-collapse" }, configuration())).status).toBe(200);
    expect(console.log).toHaveBeenCalledOnce();
    const output = JSON.stringify(vi.mocked(console.log).mock.calls);
    for (const value of [ios.token, ios.payload, "private-collapse"]) expect(output).not.toContain(value);
  });
});
