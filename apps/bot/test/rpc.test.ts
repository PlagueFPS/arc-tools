import { expect, test } from "bun:test";

import { EnrollmentSession } from "@arctools/twitch/server";
import { Effect, Redacted, String as Str } from "effect";

import { botOperations } from "../src/rpc.js";

const operations = botOperations({
  account: Effect.die("Invalid RPC must not resolve the account client"),
  enrollment: Effect.die("Invalid RPC must not resolve the enrollment client"),
  operatorSecret: Redacted.make("controlled-operator"),
});

for (const [label, operation] of [
  [
    "begin nonce",
    operations
      .enrollmentBegin({
        session: EnrollmentSession.make(Str.repeat(64)("a")),
        previousSession: null,
        state: "malformed",
      })
      .pipe(Effect.asVoid),
  ],
  [
    "completion nonce",
    operations
      .enrollmentComplete({
        session: EnrollmentSession.make(Str.repeat(64)("a")),
        state: "malformed",
        outcome: { kind: "denied" },
      })
      .pipe(Effect.asVoid),
  ],
  [
    "operator code",
    operations
      .completeOperatorOAuth({ state: "operator", code: "" })
      .pipe(Effect.asVoid),
  ],
] as const) {
  test(`Bot validates ${label} before selecting a Durable Object`, async () => {
    const error = await Effect.runPromise(Effect.flip(operation));
    expect(error._tag).toBe("AccountError");
    expect(error.code).toBe("input");
  });
}
