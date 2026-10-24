import { AccountError } from "@arctools/twitch/server";
import { Effect } from "effect";
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
    `${enrollmentCookie}=${"a".repeat(64)}; ${enrollmentCookie}=${"a".repeat(64)}`,
    "provider",
    401,
  ],
  [
    "unavailable account",
    `${enrollmentCookie}=${"a".repeat(64)}`,
    "provider",
    503,
  ],
  ["busy account", `${enrollmentCookie}=${"a".repeat(64)}`, "busy", 503],
] as const) {
  test(`status maps ${label} to ${expected}`, async () => {
    const http = websiteHttp(
      Effect.succeed({
        enrollmentBegin: () => Effect.die("unused"),
        enrollmentComplete: () => Effect.die("unused"),
        completeOperatorOAuth: () => Effect.die("unused"),
        enrollmentStatus: () => new AccountError({ code: error }),
      }),
    );

    const response = await http.status(request(cookie)).pipe(Effect.runPromise);
    expect(response.status).toBe(expected);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
}
