import { expect, test } from "bun:test";

import { AccountError } from "@arctools/twitch/server";
import { Effect } from "effect";
import { HttpServerRequest } from "effect/http";

import { enrollmentCookie, enrollmentHttp } from "../src/enrollment.js";

const request = (cookie: string) =>
  HttpServerRequest.fromWeb(
    new Request("https://bot.invalid/oauth/twitch/enroll/status", {
      headers: { cookie },
    }),
  );

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
    const http = enrollmentHttp({
      begin: () => Effect.die("unused"),
      complete: () => Effect.die("unused"),
      status: () => new AccountError({ code: error }),
    });

    const response = await http.status(request(cookie)).pipe(Effect.runPromise);
    expect(response.status).toBe(expected);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });
}
