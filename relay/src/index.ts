import { sendAPNs, type APNsConfig, type UpstreamResult } from "./apns";
import { sendFCM } from "./fcm";
import { readPushBody, validatePush, type PushRequest } from "./validate";

export interface Env {
  APNS_KEY_P8?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC: string;
  FCM_SERVICE_ACCOUNT?: string;
  RL_IP: Pick<RateLimit, "limit">;
  RL_TOKEN: Pick<RateLimit, "limit">;
}

function platformConfiguration(env: Env): { ios: boolean; android: boolean } {
  return {
    ios: [env.APNS_KEY_P8, env.APNS_KEY_ID, env.APNS_TEAM_ID].every(
      (value) => typeof value === "string" && value.trim().length > 0,
    ),
    android: typeof env.FCM_SERVICE_ACCOUNT === "string" && env.FCM_SERVICE_ACCOUNT.trim().length > 0,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const configured = platformConfiguration(env);
    if (request.method === "GET" && pathname === "/v1/health") {
      return Response.json({ ok: true, ...configured, v: 1 });
    }
    if (request.method !== "POST" || pathname !== "/v1/push") {
      return new Response("Not found", { status: 404 });
    }

    const body = await readPushBody(request);
    if ("error" in body) return Response.json({ ok: false, error: body.error }, { status: 400 });
    const error = validatePush(body.value);
    if (error) return Response.json({ ok: false, error }, { status: 400 });
    const push = body.value as PushRequest;

    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (!(await env.RL_IP.limit({ key: ip })).success) {
      return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }
    const tokenKey = `${push.platform}:${push.platform === "ios" ? push.token.toLowerCase() : push.token}`;
    if (!(await env.RL_TOKEN.limit({ key: tokenKey })).success) {
      return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }
    if (!configured[push.platform]) {
      return Response.json({ ok: false, error: "platform_not_configured" }, { status: 503 });
    }

    const started = Date.now();
    let status = 502;
    try {
      const result: UpstreamResult = push.platform === "ios"
        ? await sendAPNs(push, env as APNsConfig)
        : await sendFCM(push, env.FCM_SERVICE_ACCOUNT!);
      status = result.status;
      if (result.gone) return Response.json({ ok: false, gone: true }, { status: 410 });
      if (result.status === 200 && !result.error) return Response.json({ ok: true });
      return Response.json(
        { ok: false, error: result.error ?? "upstream_error" },
        { status: 502 },
      );
    } catch (cause) {
      const timedOut = cause instanceof Error &&
        (cause.name === "TimeoutError" || cause.name === "AbortError");
      return Response.json(
        { ok: false, error: timedOut ? "upstream_timeout" : "upstream_error" },
        { status: 502 },
      );
    } finally {
      console.log(JSON.stringify({ platform: push.platform, status, ms: Date.now() - started }));
    }
  },
} satisfies ExportedHandler<Env>;
