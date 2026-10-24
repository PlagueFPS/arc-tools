import type { BotOperations } from "@arctools/bot-contracts";
import {
  AccountError,
  EnrollmentBegin,
  EnrollmentCompletion,
  EnrollmentSession,
  OAuthCompletion,
  type TwitchAccount,
  type TwitchEnrollment,
} from "@arctools/twitch/server";
import { digest } from "@arctools/utils/http";
import { Effect, Redacted, Schema, Struct } from "effect";

const OperatorCompletion = OAuthCompletion.mapFields(Struct.omit(["operator"]));

export const botOperations = <R>(clients: {
  readonly account: Effect.Effect<typeof TwitchAccount.Service, never, R>;
  readonly enrollment: Effect.Effect<typeof TwitchEnrollment.Service, never, R>;
  readonly operatorSecret: Redacted.Redacted<string>;
}) => ({
  enrollmentBegin: Effect.fnUntraced(function* (
    input: Parameters<BotOperations["enrollmentBegin"]>[0],
  ) {
    const valid = yield* Schema.decodeUnknownEffect(EnrollmentBegin)(
      input,
    ).pipe(Effect.mapError(() => new AccountError({ code: "input" })));

    return yield* (yield* clients.enrollment).begin(valid);
  }),
  enrollmentComplete: Effect.fnUntraced(function* (
    input: Parameters<BotOperations["enrollmentComplete"]>[0],
  ) {
    const valid = yield* Schema.decodeUnknownEffect(EnrollmentCompletion)(
      input,
    ).pipe(Effect.mapError(() => new AccountError({ code: "input" })));

    return yield* (yield* clients.enrollment).complete(valid);
  }),
  enrollmentStatus: Effect.fnUntraced(function* (
    input: Parameters<BotOperations["enrollmentStatus"]>[0],
  ) {
    const valid = yield* Schema.decodeUnknownEffect(EnrollmentSession)(
      input,
    ).pipe(Effect.mapError(() => new AccountError({ code: "input" })));

    return yield* (yield* clients.enrollment).status(valid);
  }),
  completeOperatorOAuth: Effect.fnUntraced(function* (
    input: Parameters<BotOperations["completeOperatorOAuth"]>[0],
  ) {
    const valid = yield* Schema.decodeUnknownEffect(OperatorCompletion)(
      input,
    ).pipe(Effect.mapError(() => new AccountError({ code: "input" })));

    return yield* (yield* clients.account).completeOAuth({
      ...valid,
      operator: yield* digest(Redacted.value(clients.operatorSecret)),
    });
  }),
});
