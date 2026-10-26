import { Deferred, Effect, Schema, Semaphore } from "effect";

import type { AttributionStorage } from "./alarm-attribution.js";

export const ControlId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/),
);

export const ControlObservation = Schema.Struct({
  id: ControlId,
  phase: Schema.Literals(["active", "retired", "unknown"]),
  activeId: Schema.NullOr(ControlId),
  gates: Schema.Array(Schema.String),
  effectiveSettingsSha256: Schema.String,
  precedingSettingsSha256: Schema.String,
});

export class FixtureControlError extends Schema.TaggedError<FixtureControlError>()(
  "FixtureControlError",
  {
    id: ControlId,
    code: Schema.Literals(["retired", "overlap"]),
  },
) {}

const hash = Effect.fnUntraced(function* <P>(value: P) {
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(value)),
    ),
  );

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
});

type Active<P> = { id: string; previous: P; applied: P };

export const fixtureControl = Effect.fnUntraced(function* <P>(
  storage: AttributionStorage,
  baseline: P,
  gateKeys: (settings: P) => ReadonlyArray<string>,
) {
  const permit = yield* Semaphore.make(1);
  const gates = new Map<string, Deferred.Deferred<void>>();

  const settings = Effect.fnUntraced(function* () {
    return (yield* storage.get<P>("temporary:settings")) ?? baseline;
  });

  const rebuild = Effect.fnUntraced(function* (next: P) {
    const keys = new Set(gateKeys(next));

    for (const [key, gate] of gates) {
      if (!keys.has(key)) {
        yield* Deferred.succeed(gate, undefined);
        gates.delete(key);
      }
    }

    for (const key of keys)
      if (!gates.has(key)) gates.set(key, yield* Deferred.make<void>());
  });

  yield* rebuild(yield* settings());

  const activate = Effect.fnUntraced(
    function* (id: string, patch: P) {
      const next = yield* storage
        .transaction(
          Effect.gen(function* () {
            if ((yield* storage.get(`temporary:retired:${id}`)) !== undefined)
              return yield* new FixtureControlError({ id, code: "retired" });
            const active = yield* storage.get<Active<P>>("temporary:active");

            if (active) {
              if (active.id !== id)
                return yield* new FixtureControlError({ id, code: "overlap" });

              return active.applied;
            }

            const previous = yield* settings();
            yield* storage.put("temporary:active", {
              id,
              previous,
              applied: patch,
            });
            yield* storage.put("temporary:settings", patch);

            return patch;
          }),
        )
        .pipe(
          Effect.catch((error) =>
            Schema.is(FixtureControlError)(error)
              ? error
              : Effect.die("Fixture control storage failed"),
          ),
        );

      yield* rebuild(next);
    },
    (effect) => effect.pipe(permit.withPermit, Effect.uninterruptible),
  );

  const retire = Effect.fnUntraced(
    function* (id: string) {
      const next = yield* storage
        .transaction(
          Effect.gen(function* () {
            const active = yield* storage.get<Active<P>>("temporary:active");
            const retired = yield* storage.get<P>(`temporary:retired:${id}`);

            const previous =
              retired !== undefined
                ? retired
                : active?.id === id
                  ? active.previous
                  : yield* settings();

            yield* storage.put(`temporary:retired:${id}`, previous);

            if (active?.id === id) {
              yield* storage.put("temporary:settings", previous);
              yield* storage.put("temporary:active", null);
            }

            return yield* settings();
          }),
        )
        .pipe(Effect.orDie);

      yield* rebuild(next);
    },
    (effect) => effect.pipe(permit.withPermit, Effect.uninterruptible),
  );

  return {
    activate,
    retire,
    capture: Effect.gen(function* () {
      return {
        id: (yield* storage.get<Active<P>>("temporary:active"))?.id ?? null,
        settings: yield* settings(),
        gates: new Map(gates),
      };
    }).pipe(permit.withPermit),
    update: Effect.fnUntraced(
      function* (id: string | null, change: (settings: P) => P) {
        yield* storage
          .transaction(
            Effect.gen(function* () {
              const active = yield* storage.get<Active<P>>("temporary:active");

              if (!active || active.id !== id) return;
              const next = change(yield* settings());
              yield* storage.put("temporary:settings", next);
              yield* storage.put("temporary:active", {
                ...active,
                applied: next,
              });
            }),
          )
          .pipe(Effect.orDie);
      },
      (effect) => effect.pipe(permit.withPermit, Effect.uninterruptible),
    ),
    observe: Effect.fnUntraced(
      function* (id: string) {
        const active = yield* storage.get<Active<P>>("temporary:active");
        const retired = yield* storage.get<P>(`temporary:retired:${id}`);

        return {
          id,
          phase:
            retired !== undefined
              ? ("retired" as const)
              : active?.id === id
                ? ("active" as const)
                : ("unknown" as const),
          activeId: active?.id ?? null,
          gates: [...gates.keys()],
          effectiveSettingsSha256: yield* hash(yield* settings()),
          precedingSettingsSha256: yield* hash(
            retired !== undefined ? retired : (active?.previous ?? baseline),
          ),
        };
      },
      (effect) => effect.pipe(permit.withPermit),
    ),
  };
});
