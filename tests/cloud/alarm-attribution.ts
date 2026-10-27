/* oxlint-disable effecttsgo/global-date -- Host timestamps sign requests or record real elapsed-time evidence independently of the application clock. */
/* oxlint-disable effecttsgo/global-date-in-effect -- Host timestamps record real transport and deadline evidence independently of the injected test clock. */
import type { DurableObjectStorageError } from "@alchemy.run/cloudflare";
import type { Provider } from "@arctools/twitch/testing";
import { nextAlarm, SharedAccount } from "@arctools/twitch/testing";
import { randomUUID as secureRandomUUID } from "@arctools/utils/http";
import { RuntimeContext } from "alchemy/RuntimeContext";
import {
  Context,
  Effect,
  Exit,
  Schema,
  Array as EffectArray,
  Record as EffectRecord,
  String as EffectString,
} from "effect";

export interface AttributionStorage {
  readonly get: <T = unknown>(
    key: string,
  ) => Effect.Effect<T | undefined, never, RuntimeContext>;
  readonly put: <T>(
    key: string,
    value: T,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | DurableObjectStorageError, R | RuntimeContext>;
}

export const attributionLimit = 128;

const Fingerprint = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

const Uuid = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/),
);

const AlarmRun = Schema.Int.check(Schema.isGreaterThan(0));

export const ValidationOrigin = Schema.Struct({
  operation: Schema.Literals(["rpc", "construction", "credential", "alarm"]),
  alarmRun: Schema.NullOr(AlarmRun),
}).check(
  Schema.makeFilter(
    (origin) => (origin.operation === "alarm") === (origin.alarmRun !== null),
  ),
);

export class CurrentValidationOrigin extends Context.Reference<
  typeof ValidationOrigin.Type
>("fixture/ValidationOrigin", {
  defaultValue: () => ({ operation: "rpc", alarmRun: null }),
}) {}

export const ValidationCorrelation = Schema.Struct({
  invocationId: Uuid,
  instance: Uuid,
  origin: ValidationOrigin,
});

const Invocation = Schema.Struct({
  id: Uuid,
  instance: Uuid,
  origin: ValidationOrigin,
  credentialFingerprint: Fingerprint,
  startedAt: Schema.Finite,
  completion: Schema.NullOr(
    Schema.Struct({
      at: Schema.Finite,
      outcome: Schema.Literals(["success", "failure", "interrupted"]),
    }),
  ),
});

const Lease = Schema.NullOr(
  Schema.Struct({ owner: Schema.String, until: Schema.Finite }),
);

export const CompletedAlarmRun = Schema.Struct({
  key: Schema.String,
  instance: Uuid,
  alarmRun: AlarmRun,
  completedAt: Schema.Finite,
  accountTime: Schema.Finite,
  entryAlarm: Schema.NullOr(Schema.Finite),
  lease: Lease,
  intended: Schema.NullOr(Schema.Finite),
  scheduled: Schema.NullOr(Schema.Finite),
  native: Schema.NullOr(Schema.Finite),
  credential: Schema.NullOr(
    Schema.Struct({
      fingerprint: Fingerprint,
      validatedAt: Schema.Finite,
      expiresAt: Schema.Finite,
    }),
  ),
  validationInvocationIds: Schema.Array(Uuid),
});

const ActivationEvent = Schema.Struct({
  kind: Schema.Literals([
    "activation",
    "build",
    "reconstruct",
    "alarm-entry",
    "alarm-complete",
  ]),
  instance: Uuid,
  at: Schema.Finite,
  alarmRun: Schema.NullOr(AlarmRun),
});

export const AccountAttribution = Schema.Struct({
  events: Schema.Array(ActivationEvent),
  invocations: Schema.Array(Invocation),
  completedRuns: Schema.Array(CompletedAlarmRun),
  integrityErrors: Schema.Array(
    Schema.Struct({
      invocationId: Uuid,
      phase: Schema.Literals(["start", "completion"]),
    }),
  ),
  eventsDropped: Schema.Int,
  invocationsDropped: Schema.Int,
  completedRunsDropped: Schema.Int,
  integrityErrorsDropped: Schema.Int,
});

export const LiveAccountAttribution = Schema.Struct({
  instance: Uuid,
  attribution: AccountAttribution,
});

export const ProviderAttribution = Schema.Struct({
  counts: Schema.Record(Fingerprint, Schema.Int),
  events: Schema.Array(
    Schema.Struct({
      id: Uuid,
      at: Schema.Finite,
      credentialFingerprint: Fingerprint,
      credentialCount: Schema.Int,
      globalCount: Schema.Int,
      correlation: Schema.NullOr(ValidationCorrelation),
      correlationError: Schema.Boolean,
    }),
  ),
  eventsDropped: Schema.Int,
  credentialsDropped: Schema.Int,
});

export const NativeAlarmSnapshot = Schema.Struct({
  instance: Uuid,
  capturedAt: Schema.Finite,
  liveAlarmRuns: Schema.Int,
  attribution: AccountAttribution,
  intended: Schema.NullOr(Schema.Finite),
  native: Schema.NullOr(Schema.Finite),
  lease: Lease,
});

export const stableRunKey = (run: {
  readonly instance: string;
  readonly alarmRun: number;
}) => `${run.instance}:${run.alarmRun}`;

export const validationEndpoints = (
  baseUrl: string,
  correlation: typeof ValidationCorrelation.Type | null,
) => {
  const base = EffectString.replace(/\/$/, "")(baseUrl);

  const prefix =
    correlation === null
      ? base
      : `${base}/fixture-validation/${correlation.instance}/${correlation.origin.operation}/${correlation.origin.alarmRun ?? "none"}/${correlation.invocationId}`;

  return { api: `${prefix}/helix`, oauth: `${prefix}/oauth` };
};

export function parseValidationPath(path: string) {
  const url = new URL(path, "https://fixture.invalid");

  if (!EffectString.startsWith("/fixture-validation/")(url.pathname))
    return { path: url.pathname, correlation: null, correlationError: false };

  const [, , instance, operation, alarmRun, invocationId, ...rest] =
    EffectString.split(url.pathname, "/");

  const decoded = Schema.decodeUnknownExit(ValidationCorrelation)({
    instance,
    invocationId,
    origin: {
      operation,
      alarmRun: alarmRun === "none" ? null : Number(alarmRun),
    },
  });

  return {
    path: `/${EffectArray.join(rest, "/")}`,
    correlation: Exit.isSuccess(decoded) ? decoded.value : null,
    correlationError: Exit.isFailure(decoded),
  };
}

export const credentialFingerprint = Effect.fnUntraced(function* (
  token: string,
) {
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );

  return EffectArray.join(
    EffectArray.map([...new Uint8Array(digest)], (byte) =>
      EffectString.padStart(2, "0")(byte.toString(16)),
    ),
    "",
  );
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
      completedRuns: [],
      integrityErrors: [],
      eventsDropped: 0,
      invocationsDropped: 0,
      completedRunsDropped: 0,
      integrityErrorsDropped: 0,
    }
  );
});

const appendEvent = (
  previous: typeof AccountAttribution.Type,
  event: Omit<typeof ActivationEvent.Type, "at">,
) => ({
  ...previous,
  events: [
    ...previous.events.slice(-(attributionLimit - 1)),
    { ...event, at: Date.now() },
  ],
  eventsDropped:
    previous.eventsDropped + Number(previous.events.length >= attributionLimit),
});

export const recordActivation = Effect.fnUntraced(function* (
  storage: AttributionStorage,
  event: Omit<typeof ActivationEvent.Type, "at">,
) {
  yield* storage
    .transaction(
      Effect.gen(function* () {
        yield* storage.put(
          "fixtureAttribution",
          appendEvent(yield* readAccountAttribution(storage), event),
        );
      }),
    )
    .pipe(Effect.orDie);
});

export const recordCompletedAlarm = Effect.fnUntraced(function* (
  storage: AttributionStorage & {
    readonly getAlarm: () => Effect.Effect<
      number | null,
      never,
      RuntimeContext
    >;
  },
  run: Pick<
    typeof CompletedAlarmRun.Type,
    "instance" | "alarmRun" | "entryAlarm" | "accountTime"
  >,
) {
  return yield* storage
    .transaction(
      Effect.gen(function* () {
        const record = yield* storage
          .get("account:shared:v1")
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(SharedAccount)));

        const previous = yield* readAccountAttribution(storage);
        const key = stableRunKey(run);

        if (
          EffectArray.some(
            previous.completedRuns,
            (completed) => !!(completed.key === key),
          )
        )
          return yield* Effect.die("Completed alarm key already exists");

        const completed: typeof CompletedAlarmRun.Type = {
          ...run,
          key,
          completedAt: Date.now(),
          lease: record.tokenLease,
          intended: record.nextCredentialCheck,
          scheduled: nextAlarm(record),
          native: yield* storage.getAlarm(),
          credential:
            record.session === null
              ? null
              : {
                  fingerprint: yield* credentialFingerprint(
                    record.session.token,
                  ),
                  validatedAt: record.session.validatedAt,
                  expiresAt: record.session.expiresAt,
                },
          validationInvocationIds: EffectArray.map(
            EffectArray.filter(
              previous.invocations,
              (invocation) =>
                !!(
                  invocation.instance === run.instance &&
                  invocation.origin.alarmRun === run.alarmRun
                ),
            ),
            (invocation) => invocation.id,
          ),
        };

        yield* storage.put("fixtureAttribution", {
          ...appendEvent(previous, {
            kind: "alarm-complete",
            instance: run.instance,
            alarmRun: run.alarmRun,
          }),
          completedRuns: [
            ...previous.completedRuns.slice(-(attributionLimit - 1)),
            completed,
          ],
          completedRunsDropped:
            previous.completedRunsDropped +
            Number(previous.completedRuns.length >= attributionLimit),
        });

        return completed;
      }),
    )
    .pipe(Effect.orDie);
});

export const observeValidations = Effect.fnUntraced(function* (
  providerFor: (
    correlation: typeof ValidationCorrelation.Type | null,
  ) => Provider,
  storage: AttributionStorage,
  instance: string,
) {
  const runtime = yield* RuntimeContext;

  const write = <E>(
    invocationId: string,
    phase: "start" | "completion",
    effect: Effect.Effect<void, E, RuntimeContext>,
  ) =>
    effect.pipe(
      Effect.catchCause(() =>
        storage
          .transaction(
            Effect.gen(function* () {
              const previous = yield* readAccountAttribution(storage);
              yield* storage.put("fixtureAttribution", {
                ...previous,
                integrityErrors: [
                  ...previous.integrityErrors.slice(-(attributionLimit - 1)),
                  { invocationId, phase },
                ],
                integrityErrorsDropped:
                  previous.integrityErrorsDropped +
                  Number(previous.integrityErrors.length >= attributionLimit),
              });
            }),
          )
          .pipe(Effect.ignoreCause),
      ),
    );

  const validate = Effect.fnUntraced(function* (token: string) {
    const invocation: typeof Invocation.Type = {
      id: yield* secureRandomUUID,
      instance,
      origin: yield* CurrentValidationOrigin,
      credentialFingerprint: yield* credentialFingerprint(token),
      startedAt: Date.now(),
      completion: null,
    };

    return yield* Effect.uninterruptibleMask((restore) =>
      write(
        invocation.id,
        "start",
        storage.transaction(
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
        ),
      ).pipe(
        Effect.andThen(
          restore(
            providerFor({
              invocationId: invocation.id,
              instance,
              origin: invocation.origin,
            }).validate(token),
          ).pipe(
            Effect.onExit((exit) =>
              write(
                invocation.id,
                "completion",
                storage.transaction(
                  Effect.gen(function* () {
                    const previous = yield* readAccountAttribution(storage);

                    if (
                      !EffectArray.some(
                        previous.invocations,
                        (record) => !!(record.id === invocation.id),
                      )
                    )
                      return yield* Effect.die(
                        "Validation start record missing",
                      );

                    const completion: NonNullable<
                      typeof Invocation.Type.completion
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
                      invocations: EffectArray.map(
                        previous.invocations,
                        (record) =>
                          record.id === invocation.id
                            ? { ...record, completion }
                            : record,
                      ),
                    });
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  });

  return {
    ...providerFor(null),
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
    )) ?? { counts: {}, events: [], eventsDropped: 0, credentialsDropped: 0 }
  );
});

export const recordProviderValidation = Effect.fnUntraced(function* (
  storage: AttributionStorage,
  fingerprint: string,
  globalCount: number,
  scope: Pick<
    ReturnType<typeof parseValidationPath>,
    "correlation" | "correlationError"
  >,
) {
  const previous = yield* readProviderAttribution(storage);
  const count = (previous.counts[fingerprint] ?? 0) + 1;

  const counts = EffectRecord.toEntries({
    ...previous.counts,
    [fingerprint]: count,
  });

  yield* storage.put("fixtureValidations", {
    counts: EffectRecord.fromEntries(counts.slice(-attributionLimit)),
    events: [
      ...previous.events.slice(-(attributionLimit - 1)),
      {
        id: yield* secureRandomUUID,
        at: Date.now(),
        credentialFingerprint: fingerprint,
        credentialCount: count,
        globalCount,
        ...scope,
      },
    ],
    eventsDropped:
      previous.eventsDropped +
      Number(previous.events.length >= attributionLimit),
    credentialsDropped:
      previous.credentialsDropped + Number(counts.length > attributionLimit),
  });
});
