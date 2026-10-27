import { makeRpcStub } from "@alchemy.run/cloudflare/Bridge";
import { handleRpcExit } from "@alchemy.run/cloudflare/Workers/WorkerBridge";
import type { BotOperations } from "@arctools/bot-contracts";
import { AccountError } from "@arctools/twitch/server";
import { Effect, Exit, String as Str } from "effect";
import { expect, test } from "vitest";

import { websiteHttp } from "./enrollment.js";
import { WebsiteUnavailable } from "./errors.js";

for (const [code, expected] of [
  ["state", 401],
  ["input", 401],
  ["provider", 503],
  ["busy", 503],
] as const) {
  test(`serialized RPC AccountError ${code} is an HTTP ${expected}, never successful status`, async () => {
    const bot = makeRpcStub<BotOperations>(
      {
        enrollmentStatus: () =>
          handleRpcExit(Exit.fail(new AccountError({ code }))),
      },
      { errors: [AccountError] },
    );

    const response = await Effect.runPromise(
      websiteHttp(Effect.succeed(bot)).status(
        new Request("https://website.invalid/oauth/twitch/enroll/status", {
          headers: {
            cookie: `__Host-arctools-enrollment=${Str.repeat(64)("a")}`,
          },
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
      headers: {
        cookie: `__Host-arctools-enrollment=${Str.repeat(64)("a")}`,
      },
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
