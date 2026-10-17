import { RuntimeContext } from "alchemy/RuntimeContext";
import { Context, Effect, Exit, Schema } from "effect";
import type { Provider } from "../../apps/bot/src/twitch-provider.js";

export interface AttributionStorage {
  readonly get: <T = unknown>(
    key: string,
  ) => Effect.Effect<T | undefined, never, RuntimeContext>;
  readonly put: (
    key: string,
    value: unknown,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, unknown, R | RuntimeContext>;
}
export const attributionLimit = 128;
const Fingerprint = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const ValidationOrigin = Schema.Struct({
  operation: Schema.Literals(["rpc", "construction", "credential", "alarm"]),
  alarmRun: Schema.NullOr(Schema.Int),
});
export class CurrentValidationOrigin extends Context.Reference<
  typeof ValidationOrigin.Type
>("fixture/ValidationOrigin", {
  defaultValue: (): typeof ValidationOrigin.Type => ({
    operation: "rpc",
    alarmRun: null,
  }),
}) {}
const Invocation = Schema.Struct({
  id: Schema.String,
  instance: Schema.String,
  origin: ValidationOrigin,
  credentialFingerprint: Fingerprint,
  startedAt: Schema.Number,
  completion: Schema.NullOr(
    Schema.Struct({
      at: Schema.Number,
      outcome: Schema.Literals(["success", "failure", "interrupted"]),
    }),
  ),
});
const ActivationEvent = Schema.Struct({
  kind: Schema.Literals([
    "activation",
    "build",
    "reconstruct",
    "alarm-entry",
    "alarm-complete",
  ]),
  instance: Schema.String,
  at: Schema.Number,
  alarmRun: Schema.NullOr(Schema.Int),
});
export const AccountAttribution = Schema.Struct({
  events: Schema.Array(ActivationEvent),
  invocations: Schema.Array(Invocation),
  eventsDropped: Schema.Int,
  invocationsDropped: Schema.Int,
});
export const ProviderAttribution = Schema.Struct({
  counts: Schema.Record(Fingerprint, Schema.Int),
  events: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      at: Schema.Number,
      credentialFingerprint: Fingerprint,
      credentialCount: Schema.Int,
      globalCount: Schema.Int,
    }),
  ),
  eventsDropped: Schema.Int,
  credentialsDropped: Schema.Int,
});
export const NativeAlarmSnapshot = Schema.Struct({
  instance: Schema.String,
  capturedAt: Schema.Number,
  liveAlarmRuns: Schema.Int,
  attribution: AccountAttribution,
  intended: Schema.NullOr(Schema.Number),
  native: Schema.NullOr(Schema.Number),
  lease: Schema.NullOr(
    Schema.Struct({ owner: Schema.String, until: Schema.Number }),
  ),
  observation: Schema.NullOr(
    Schema.Struct({
      runs: Schema.Number,
      instance: Schema.String,
      completedAt: Schema.Number,
      lease: Schema.NullOr(
        Schema.Struct({ owner: Schema.String, until: Schema.Number }),
      ),
      validationInvocationIds: Schema.Array(Schema.String),
      entryAlarm: Schema.NullOr(Schema.Number),
      intended: Schema.NullOr(Schema.Number),
      native: Schema.NullOr(Schema.Number),
    }),
  ),
});
export const credentialFingerprint = Effect.fnUntraced(function* (
  token: string,
) {
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
});
export const readAccountAttribution = Effect.fnUntraced(function* (
  storage: AttributionStorage,
) {
  return (
    (yield* storage.get<typeof AccountAttribution.Type>(
      "fixtureAttribution",
    )) ?? {
      events: [],
      invocations: [],
      eventsDropped: 0,
      invocationsDropped: 0,
    }
  );
});
export const recordActivation = Effect.fnUntraced(function* (
  storage: AttributionStorage,
  event: Omit<typeof ActivationEvent.Type, "at">,
) {
  yield* storage
    .transaction(
      Effect.gen(function* () {
        const previous = yield* readAccountAttribution(storage);
        yield* storage.put("fixtureAttribution", {
          ...previous,
          events: [
            ...previous.events.slice(-(attributionLimit - 1)),
            { ...event, at: Date.now() },
          ],
          eventsDropped:
            previous.eventsDropped +
            Number(previous.events.length >= attributionLimit),
        });
      }),
    )
    .pipe(Effect.orDie);
});
export const observeValidations = Effect.fnUntraced(function* (
  provider: Provider,
  storage: AttributionStorage,
  instance: string,
) {
  const runtime = yield* RuntimeContext;
  const validate = Effect.fnUntraced(function* (token: string) {
    const invocation: typeof Invocation.Type = {
      id: crypto.randomUUID(),
      instance,
      origin: yield* CurrentValidationOrigin,
      credentialFingerprint: yield* credentialFingerprint(token),
      startedAt: Date.now(),
      completion: null,
    };
    yield* storage
      .transaction(
        Effect.gen(function* () {
          const previous = yield* readAccountAttribution(storage);
          yield* storage.put("fixtureAttribution", {
            ...previous,
            invocations: [
              ...previous.invocations.slice(-(attributionLimit - 1)),
              invocation,
            ],
            invocationsDropped:
              previous.invocationsDropped +
              Number(previous.invocations.length >= attributionLimit),
          });
        }),
      )
      .pipe(Effect.orDie);
    return yield* provider.validate(token).pipe(
      Effect.onExit((exit) =>
        storage
          .transaction(
            Effect.gen(function* () {
              const previous = yield* readAccountAttribution(storage);
              const completion: NonNullable<
                (typeof Invocation.Type)["completion"]
              > = {
                at: Date.now(),
                outcome: Exit.isSuccess(exit)
                  ? "success"
                  : Exit.hasInterrupts(exit)
                    ? "interrupted"
                    : "failure",
              };
              yield* storage.put("fixtureAttribution", {
                ...previous,
                invocations: previous.invocations.map((record) =>
                  record.id === invocation.id
                    ? { ...record, completion }
                    : record,
                ),
              });
            }),
          )
          .pipe(Effect.orDie),
      ),
    );
  });
  return {
    ...provider,
    validate: (token: string) =>
      validate(token).pipe(Effect.provideService(RuntimeContext, runtime)),
  } satisfies Provider;
});
export const readProviderAttribution = Effect.fnUntraced(function* (
  storage: AttributionStorage,
) {
  return (
    (yield* storage.get<typeof ProviderAttribution.Type>(
      "fixtureValidations",
    )) ?? {
      counts: {},
      events: [],
      eventsDropped: 0,
      credentialsDropped: 0,
    }
  );
});
export const recordProviderValidation = Effect.fnUntraced(function* (
  storage: AttributionStorage,
  fingerprint: string,
  globalCount: number,
) {
  const previous = yield* readProviderAttribution(storage);
  const count = (previous.counts[fingerprint] ?? 0) + 1;
  const counts = Object.entries({ ...previous.counts, [fingerprint]: count });
  yield* storage.put("fixtureValidations", {
    counts: Object.fromEntries(counts.slice(-attributionLimit)),
    events: [
      ...previous.events.slice(-(attributionLimit - 1)),
      {
        id: crypto.randomUUID(),
        at: Date.now(),
        credentialFingerprint: fingerprint,
        credentialCount: count,
        globalCount,
      },
    ],
    eventsDropped:
      previous.eventsDropped +
      Number(previous.events.length >= attributionLimit),
    credentialsDropped:
      previous.credentialsDropped + Number(counts.length > attributionLimit),
  });
});
