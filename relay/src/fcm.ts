import { base64Url, pkcs8Bytes, type UpstreamResult } from "./apns";
import type { PushRequest } from "./validate";

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

const tokenUrl = "https://oauth2.googleapis.com/token";
let cachedAccessToken: { source: string; token: string; refreshAt: number } | undefined;

function readServiceAccount(source: string): ServiceAccount {
  const account: unknown = JSON.parse(source);
  if (account === null || typeof account !== "object" || Array.isArray(account)) {
    throw new Error("invalid_service_account");
  }
  const fields = account as Record<string, unknown>;
  for (const field of ["project_id", "client_email", "private_key"]) {
    if (typeof fields[field] !== "string" || !fields[field].trim()) {
      throw new Error("invalid_service_account");
    }
  }
  return account as ServiceAccount;
}

async function accessToken(
  source: string,
  account: ServiceAccount,
): Promise<{ token: string } | UpstreamResult> {
  if (cachedAccessToken?.source === source && Date.now() < cachedAccessToken.refreshAt) {
    return { token: cachedAccessToken.token };
  }
  const now = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const header = base64Url(
    encoder.encode(JSON.stringify({
      alg: "RS256",
      typ: "JWT",
      ...(account.private_key_id ? { kid: account.private_key_id } : {}),
    })),
  );
  const claims = base64Url(
    encoder.encode(JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: tokenUrl,
      iat: now,
      exp: now + 3600,
    })),
  );
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8Bytes(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(signingInput),
  );
  const assertion = `${signingInput}.${base64Url(new Uint8Array(signature))}`;
  const issuedAt = Date.now();
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) {
    return { status: response.status, error: `fcm_${response.status}` };
  }
  const data = await response.json<{ access_token?: unknown; expires_in?: unknown }>();
  if (
    typeof data.access_token !== "string" ||
    !data.access_token ||
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0
  ) {
    throw new Error("invalid_oauth_response");
  }
  cachedAccessToken = {
    source,
    token: data.access_token,
    refreshAt: issuedAt + (data.expires_in - 300) * 1000,
  };
  return { token: data.access_token };
}

export async function sendFCM(push: PushRequest, source: string): Promise<UpstreamResult> {
  const account = readServiceAccount(source);
  const result = await accessToken(source, account);
  if (!("token" in result)) return result;
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${result.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token: push.token,
          data: { v: "1", e: push.payload },
          android: {
            priority: "high",
            ...(push.collapse !== undefined ? { collapse_key: push.collapse } : {}),
          },
        },
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (response.status === 200) return { status: 200 };
  if (response.status === 404) return { status: 404, gone: true };
  const body = await response.json<{
    error?: { details?: { errorCode?: unknown }[] };
  }>().catch(() => null);
  if (
    Array.isArray(body?.error?.details) &&
    body.error.details.some((detail) => detail?.errorCode === "UNREGISTERED")
  ) {
    return { status: response.status, gone: true };
  }
  return { status: response.status, error: `fcm_${response.status}` };
}
