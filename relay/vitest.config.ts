import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { Response } from "miniflare";
import { defineConfig } from "vitest/config";

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

let replies: MockReply[] = [];
let requests: RecordedRequest[] = [];
let unexpected: string[] = [];

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      remoteBindings: false,
      miniflare: {
        host: "127.0.0.1",
        outboundService: async (request) => {
          requests.push({
            url: request.url,
            method: request.method,
            headers: Object.fromEntries(request.headers),
            body: await request.text(),
          });
          const reply = replies.shift();
          if (!reply || reply.url !== request.url || request.method !== "POST") {
            unexpected.push(request.url);
            return Response.json({ error: "unexpected_upstream" }, { status: 502 });
          }
          return new Response(reply.body ?? "", {
            status: reply.status,
            headers: { "content-type": "application/json", ...reply.headers },
          });
        },
        serviceBindings: {
          MOCK_UPSTREAM: async (request) => {
            if (request.method === "POST") {
              const next = await request.json() as { replies: MockReply[] };
              replies = next.replies;
              requests = [];
              unexpected = [];
            }
            return Response.json({ requests, pending: replies.length, unexpected });
          },
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 10_000,
  },
});
