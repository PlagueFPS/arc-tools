import { expect, test } from "bun:test";

import { toRpcAsync } from "@alchemy.run/cloudflare/Bridge";
import { handleRpcExit } from "@alchemy.run/cloudflare/Workers/WorkerBridge";
import { AccountError } from "@arctools/twitch/server";
import { Effect, Exit } from "effect";

import { botOperationsClient } from "../../website/src/server/bot.js";
import { websiteHttp } from "../../website/src/server/enrollment.js";
import { WebsiteUnavailable } from "../../website/src/server/errors.js";
import type { Bot } from "../src/worker.js";

for (const [code, expected] of [
  ["state", 401],
  ["input", 401],
  ["provider", 503],
  ["busy", 503],
] as const) {
  test(`serialized RPC AccountError ${code} is an HTTP ${expected}, never successful status`, async () => {
    const bot = toRpcAsync<Bot>({
      enrollmentStatus: () =>
        handleRpcExit(Exit.fail(new AccountError({ code }))),
    });

    const response = await Effect.runPromise(
      websiteHttp(Effect.succeed(botOperationsClient(bot))).status(
        new Request("https://website.invalid/oauth/twitch/enroll/status", {
          headers: { cookie: `__Host-arctools-enrollment=${"a".repeat(64)}` },
        }),
      ),
    );

    expect(response.status).toBe(expected);
    expect(await response.json()).toEqual({ error: "enrollment-unavailable" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
}

test("missing Website binding is a private 503 for begin, authenticated status and callback", async () => {
  const http = websiteHttp(new WebsiteUnavailable());

  const request = new Request(
    "https://website.invalid/oauth/twitch/callback?state=operator&code=code",
    {
      headers: { cookie: `__Host-arctools-enrollment=${"a".repeat(64)}` },
    },
  );

  for (const handler of [http.begin, http.status, http.callback]) {
    const response = await Effect.runPromise(handler(request));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("set-cookie")).toBeNull();
  }
});
