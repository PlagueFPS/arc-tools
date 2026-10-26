import { AccountError, SetupResult } from "@arctools/twitch/server";
import { Clock, Effect, Schema } from "effect";

import { fixtureHttp } from "./fixture-http.js";

const SetupReply = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("success"), value: SetupResult }),
  Schema.Struct({
    kind: Schema.Literal("failure"),
    code: AccountError.fields.code,
  }),
]);

export const makeAccountSetup = (http = fixtureHttp, budgetMs = 10000) =>
  Effect.fnUntraced(function* (url: string) {
    const clock = yield* Clock.Clock;
    const started = clock.monotonicTimeNanosUnsafe();

    const remaining = () =>
      budgetMs - Number(clock.monotonicTimeNanosUnsafe() - started) / 1e6;

    for (let attempt = 1; attempt <= 20; attempt++) {
      if (remaining() <= 0)
        return yield* Effect.fail(new Error("Account setup remained busy"));

      const response = yield* http.requestOnce(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
        remaining(),
      );

      const reply = yield* http.json(response, SetupReply);

      if (reply.kind === "success") return reply.value;

      if (reply.code !== "busy")
        return yield* new AccountError({ code: reply.code });

      yield* Effect.sleep(Math.min(250, Math.max(0, remaining())));
    }

    return yield* Effect.fail(new Error("Account setup remained busy"));
  });

export const setupWhenAvailable = makeAccountSetup();
