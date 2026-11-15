import { afterEach, describe, expect, it, vi } from "vitest";
import { getAPNsJwt, type APNsConfig } from "../src/apns";

function decode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

async function keys(): Promise<{ config: APNsConfig; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign", "verify",
  ]) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer);
  const base64 = btoa(String.fromCharCode(...pkcs8));
  return {
    config: {
      APNS_KEY_P8: `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`,
      APNS_KEY_ID: "TESTKID",
      APNS_TEAM_ID: "TESTTEAM",
      APNS_TOPIC: "test.topic",
    },
    publicKey: pair.publicKey,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("APNs ES256 JWT", () => {
  it("contains kid, iss and iat and verifies with the matching P-256 public key", async () => {
    const { config, publicKey } = await keys();
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const jwt = await getAPNsJwt(config);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const [header, claims, signature] = parts;
    expect(JSON.parse(new TextDecoder().decode(decode(header)))).toEqual({
      alg: "ES256", kid: config.APNS_KEY_ID,
    });
    expect(JSON.parse(new TextDecoder().decode(decode(claims)))).toEqual({
      iss: config.APNS_TEAM_ID, iat: now / 1000,
    });
    expect(decode(signature)).toHaveLength(64);
    expect(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      decode(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    )).toBe(true);
    expect(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      decode(signature),
      new TextEncoder().encode(`${header}.${claims}tampered`),
    )).toBe(false);
  });

  it("aligns iat to 30-minute windows, reuses within a window and renews at the boundary", async () => {
    const { config } = await keys();
    const window = 30 * 60 * 1000;
    const start = 1_800_000_000_000; // 剛好落在格線上
    const clock = vi.spyOn(Date, "now").mockReturnValue(start + 7 * 60 * 1000);
    const first = await getAPNsJwt(config);
    expect(JSON.parse(new TextDecoder().decode(decode(first.split(".")[1]))).iat).toBe(start / 1000);
    clock.mockReturnValue(start + window - 1);
    expect(await getAPNsJwt(config)).toBe(first);
    clock.mockReturnValue(start + window);
    const renewed = await getAPNsJwt(config);
    expect(renewed).not.toBe(first);
    expect(JSON.parse(new TextDecoder().decode(decode(renewed.split(".")[1]))).iat)
      .toBe((start + window) / 1000);
  });

  it("does not reuse JWTs after signing credentials change", async () => {
    const first = await keys();
    const second = await keys();
    const oldJwt = await getAPNsJwt(first.config);
    const newJwt = await getAPNsJwt(second.config);
    expect(newJwt).not.toBe(oldJwt);
    const [header, claims, signature] = newJwt.split(".");
    const data = new TextEncoder().encode(`${header}.${claims}`);
    expect(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, second.publicKey, decode(signature), data,
    )).toBe(true);
    expect(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, first.publicKey, decode(signature), data,
    )).toBe(false);
  });
});
