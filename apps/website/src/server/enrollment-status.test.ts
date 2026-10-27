/* oxlint-disable effecttsgo/async-function -- Native Bun, Node, and Web callbacks expose Promise contracts at this host boundary. */
import { AccountError } from "@arctools/twitch/server";
import { Effect, String as EffectString } from "effect";
import { expect, test } from "vitest";

import { enrollmentCookie, websiteHttp } from "./enrollment.js";

const request = (cookie: string) =>
  new Request("https://bot.invalid/oauth/twitch/enroll/status", {
    headers: { cookie },
  });

for (const [label, cookie, error, expected] of [
  ["absent session", "", "provider", 401],
  ["malformed session", `${enrollmentCookie}=invalid`, "provider", 401],
  [
    "duplicate session",
    `${enrollmentCookie}=${EffectString.repeat(64)("a")}; ${enrollmentCookie}=${EffectString.repeat(64)("a")}`,
    "provider",
    401,
  ],
  [
    "unavailable account",
    `${enrollmentCookie}=${EffectString.repeat(64)("a")}`,
    "provider",
    503,
  ],
  [
    "busy account",
    `${enrollmentCookie}=${EffectString.repeat(64)("a")}`,
    "busy",
    503,
  ],
] as const) {
  test(`status maps ${label} to ${expected}`, async () => {
    const http = websiteHttp(
      Effect.succeed({
        enrollmentBegin: () => Effect.die("unused"),
        enrollmentComplete: () => Effect.die("unused"),
        completeOperatorOAuth: () => Effect.die("unused"),
        enrollmentLeave: () => Effect.die("Unexpected leave"),
        enrollmentStatus: () => new AccountError({ code: error }),
      }),
    );

    const response = await http.status(request(cookie)).pipe(Effect.runPromise);
    expect(response.status).toBe(expected);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
}
