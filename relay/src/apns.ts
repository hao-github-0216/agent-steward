import type { PushRequest } from "./validate";

export interface APNsConfig {
  APNS_KEY_P8: string;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  APNS_TOPIC: string;
}

export interface UpstreamResult {
  status: number;
  gone?: boolean;
  error?: string;
}

export function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function pkcs8Bytes(pem: string): Uint8Array {
  const encoded = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

let cachedJwt:
  | { p8: string; kid: string; team: string; jwt: string; expiresAt: number }
  | undefined;

// 簽發時間對齊到 30 分鐘一格：同時跑的多個 Worker 會簽出相同 iat，不會因為太常換憑證被 APNs 擋
const JWT_WINDOW = 30 * 60 * 1000;

export async function getAPNsJwt(config: APNsConfig, now = Date.now()): Promise<string> {
  if (
    cachedJwt &&
    cachedJwt.p8 === config.APNS_KEY_P8 &&
    cachedJwt.kid === config.APNS_KEY_ID &&
    cachedJwt.team === config.APNS_TEAM_ID &&
    now < cachedJwt.expiresAt
  ) {
    return cachedJwt.jwt;
  }
  const encoder = new TextEncoder();
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "ES256", kid: config.APNS_KEY_ID })));
  const claims = base64Url(
    encoder.encode(JSON.stringify({ iss: config.APNS_TEAM_ID, iat: Math.floor(Math.floor(now / JWT_WINDOW) * JWT_WINDOW / 1000) })),
  );
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8Bytes(config.APNS_KEY_P8),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(signingInput),
  );
  const jwt = `${signingInput}.${base64Url(new Uint8Array(signature))}`;
  cachedJwt = {
    p8: config.APNS_KEY_P8,
    kid: config.APNS_KEY_ID,
    team: config.APNS_TEAM_ID,
    jwt,
    expiresAt: (Math.floor(now / JWT_WINDOW) + 1) * JWT_WINDOW,
  };
  return jwt;
}

export async function sendAPNs(push: PushRequest, config: APNsConfig): Promise<UpstreamResult> {
  const jwt = await getAPNsJwt(config);
  const host = push.env === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const response = await fetch(`https://${host}/3/device/${push.token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "content-type": "application/json",
      "apns-topic": config.APNS_TOPIC,
      "apns-push-type": "alert",
      "apns-priority": "10",
    },
    body: JSON.stringify({
      aps: {
        alert: {
          "title-loc-key": "PUSH_FALLBACK_TITLE",
          "loc-key": "PUSH_FALLBACK_BODY",
        },
        "mutable-content": 1,
        sound: "default",
        ...(push.collapse !== undefined ? { "thread-id": push.collapse } : {}),
      },
      e: push.payload,
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 200) return { status: 200 };
  if (response.status === 410) return { status: 410, gone: true };
  const body = await response.json<{ reason?: unknown }>().catch(() => null);
  const reason = typeof body?.reason === "string" ? body.reason : "unknown";
  if (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") cachedJwt = undefined;
  if (reason === "BadDeviceToken" || reason === "Unregistered") {
    return { status: response.status, gone: true };
  }
  return { status: response.status, error: `apns_${response.status}_${reason}` };
}
