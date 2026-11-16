import { describe, expect, it } from "vitest";
import fixtures from "./vectors.json";

interface Vector {
  name: string;
  key: string;
  nonce: string;
  plaintext: string;
  payload: string;
}

interface Fixtures {
  v: number;
  aad: string;
  vectors: Vector[];
  wrongKey: Vector;
}

const f = fixtures as unknown as Fixtures;

const EXPECTED_AAD = "agent-steward-push-v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PAYLOAD_CHARS = 3000;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const encoder = new TextEncoder();

function b64ToBytes(value: string): Uint8Array {
  expect(value).toMatch(BASE64_RE);
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

async function decryptPayload(keyB64: string, payloadB64: string, aad: string): Promise<string> {
  const keyBytes = b64ToBytes(keyB64);
  expect(keyBytes.length).toBe(32);

  const payload = b64ToBytes(payloadB64);
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-GCM", false, [
    "decrypt",
  ]);
  const plainBuf = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: payload.subarray(0, NONCE_BYTES) as BufferSource,
      additionalData: encoder.encode(aad) as BufferSource,
      tagLength: TAG_BYTES * 8,
    },
    key,
    payload.subarray(NONCE_BYTES) as BufferSource,
  );
  return new TextDecoder().decode(plainBuf);
}

describe("fixture shape (scripts/make-vectors.mjs output)", () => {
  it("has protocol-level constants", () => {
    expect(f.v).toBe(1);
    expect(f.aad).toBe(EXPECTED_AAD);
    expect(f.aad).toBe("agent-steward-push-v1");
    expect(f.vectors).toHaveLength(4);
  });

  it("every vector has well-formed key/nonce/payload material", () => {
    for (const vector of f.vectors) {
      expect(vector.key.length % 4, `${vector.name}: key base64 length`).toBe(0);
      expect(b64ToBytes(vector.key)).toHaveLength(32);

      expect(vector.nonce.length % 4, `${vector.name}: nonce base64 length`).toBe(0);
      expect(b64ToBytes(vector.nonce)).toHaveLength(NONCE_BYTES);

      expect(vector.payload.length).toBeGreaterThan(0);
      expect(vector.payload.length).toBeLessThanOrEqual(MAX_PAYLOAD_CHARS);
      expect(vector.payload.length % 4, `${vector.name}: payload base64 length`).toBe(0);

      // 密文依序放入 12 位元組 nonce、加密內容與 16 位元組驗證標籤。
      const payload = b64ToBytes(vector.payload);
      expect(payload.length).toBeGreaterThan(NONCE_BYTES + TAG_BYTES);
      expect(
        sameBytes(payload.subarray(0, NONCE_BYTES), b64ToBytes(vector.nonce)),
        `${vector.name}: nonce is the first 12 bytes of payload`,
      ).toBe(true);
    }
  });

  it("plaintexts cover link/thread present and absent, title/body always set", () => {
    const parsed = f.vectors.map((vector) => JSON.parse(vector.plaintext) as Record<string, unknown>);
    for (const message of parsed) {
      expect(typeof message.title).toBe("string");
      expect((message.title as string).length).toBeGreaterThan(0);
      expect(typeof message.body).toBe("string");
      expect((message.body as string).length).toBeGreaterThan(0);
      for (const optional of ["link", "thread"] as const) {
        if (optional in message) expect(typeof message[optional]).toBe("string");
      }
    }
    const withLinkThread = parsed.filter((m) => m.link && m.thread);
    const withoutLinkThread = parsed.filter((m) => !m.link && !m.thread);
    expect(withLinkThread.length).toBeGreaterThanOrEqual(1);
    expect(withoutLinkThread.length).toBeGreaterThanOrEqual(1);
  });

  it("vector-4 includes the encrypted notification category and card", async () => {
    const vector = f.vectors[3];
    expect(vector.name).toBe("vector-4");
    const decrypted = JSON.parse(await decryptPayload(vector.key, vector.payload, EXPECTED_AAD));
    expect(decrypted.category).toBe("proposal");
    expect(decrypted.card).toBe("card-action-1");
    for (const oldVector of f.vectors.slice(0, 3)) {
      const message = JSON.parse(oldVector.plaintext);
      expect(message.category).toBeUndefined();
      expect(message.card).toBeUndefined();
    }
  });

  it("wrongKey fixture reuses vector-1 ciphertext with a different key", () => {
    expect(f.wrongKey.name).toBe("wrongKey");
    expect(f.wrongKey.payload).toBe(f.vectors[0].payload);
    expect(f.wrongKey.key).not.toBe(f.vectors[0].key);
    expect(f.wrongKey.nonce).toBe(f.vectors[0].nonce);
    expect(f.wrongKey.plaintext).toBe(f.vectors[0].plaintext);
    expect(b64ToBytes(f.wrongKey.key)).toHaveLength(32);
  });
});

describe("AES-256-GCM decryption via WebCrypto (PROTOCOL.md §加密)", () => {
  it("requires a WebCrypto runtime (no Node crypto anywhere in this file)", () => {
    expect(typeof crypto).toBe("object");
    expect(typeof crypto.subtle).toBe("object");
    expect(typeof crypto.subtle.importKey).toBe("function");
  });

  for (const vector of f.vectors) {
    it(`decrypts ${vector.name} to the exact plaintext`, async () => {
      const decrypted = await decryptPayload(vector.key, vector.payload, EXPECTED_AAD);
      expect(decrypted).toBe(vector.plaintext);
      expect(JSON.parse(decrypted)).toEqual(JSON.parse(vector.plaintext));
    });
  }

  it("rejects decryption when the key does not match (wrongKey)", async () => {
    await expect(
      decryptPayload(f.wrongKey.key, f.wrongKey.payload, EXPECTED_AAD),
    ).rejects.toThrow();
  });

  it("rejects decryption when the tag is tampered with", async () => {
    const payload = b64ToBytes(f.vectors[0].payload);
    // 翻轉驗證標籤的一個位元，確認解密會失敗。
    payload[payload.length - 1] ^= 0x01;
    const tampered = bytesToB64(payload);
    expect(tampered).not.toBe(f.vectors[0].payload);
    await expect(decryptPayload(f.vectors[0].key, tampered, EXPECTED_AAD)).rejects.toThrow();
  });

  it("rejects decryption when the AAD is wrong", async () => {
    await expect(
      decryptPayload(f.vectors[0].key, f.vectors[0].payload, "agent-steward-push-v2"),
    ).rejects.toThrow();
  });
});
