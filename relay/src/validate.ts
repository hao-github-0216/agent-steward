export interface PushRequest {
  v: 1;
  platform: "ios" | "android";
  token: string;
  env?: "sandbox" | "production";
  payload: string;
  collapse?: string;
}

const allowedFields = new Set(["v", "platform", "token", "env", "payload", "collapse"]);

export function validatePush(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "invalid_body";
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    return "unknown_field";
  }
  if (body.v !== 1) return "invalid_v";
  if (body.platform !== "ios" && body.platform !== "android") return "invalid_platform";
  if (typeof body.token !== "string") return "invalid_token";
  if (body.platform === "ios" && !/^[a-fA-F0-9]{64,200}$/.test(body.token)) {
    return "invalid_token";
  }
  if (body.platform === "android" && !/^[A-Za-z0-9_:-]{1,4096}$/.test(body.token)) {
    return "invalid_token";
  }
  if (
    body.platform === "ios" &&
    body.env !== undefined &&
    body.env !== "sandbox" &&
    body.env !== "production"
  ) {
    return "invalid_env";
  }
  if (
    typeof body.payload !== "string" ||
    body.payload.length < 1 ||
    body.payload.length > 3000 ||
    !/^[A-Za-z0-9+/=]+$/.test(body.payload)
  ) {
    return "invalid_payload";
  }
  if (
    body.collapse !== undefined &&
    (typeof body.collapse !== "string" ||
      body.collapse.length > 64 ||
      !/^[A-Za-z0-9_-]*$/.test(body.collapse))
  ) {
    return "invalid_collapse";
  }
  return null;
}

export async function readPushBody(
  request: Request,
): Promise<{ value: unknown } | { error: string }> {
  if (!request.body) return { error: "invalid_json" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) {
        await reader.cancel();
        return { error: "body_too_large" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) };
  } catch {
    return { error: "invalid_json" };
  } finally {
    reader.releaseLock();
  }
}
