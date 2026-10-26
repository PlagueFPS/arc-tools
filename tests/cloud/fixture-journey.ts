import { Cause, Effect, Exit, Schema, type Scope } from "effect";

import { ControlObservation } from "./fixture-control.js";
import { auditedObservation, fixtureHttp } from "./fixture-http.js";
import type { SourceControl } from "./metaforge.js";
import type { TemporaryProviderPatch } from "./twitch-provider-fixture.js";

export class FixtureCleanupError extends Schema.TaggedError<FixtureCleanupError>()(
  "FixtureCleanupError",
  {
    controlId: Schema.String,
    phase: Schema.Literals(["release", "verify"]),
    state: Schema.Literals(["dirty", "unknown"]),
  },
) {
  override get message() {
    return JSON.stringify({
      controlId: this.controlId,
      phase: this.phase,
      state: this.state,
    });
  }
}

export interface TemporaryControl<R = never> {
  readonly id: string;
  readonly release: Effect.Effect<void, FixtureCleanupError, R>;
}

export const withTemporaryControl = <A, E, R, AE, AR, CR>(
  lifetime: {
    readonly control: TemporaryControl<CR>;
    readonly activate: Effect.Effect<unknown, AE, AR>;
  },
  body: (control: TemporaryControl<CR>) => Effect.Effect<A, E, R | Scope.Scope>,
) =>
  Effect.scoped(
    Effect.suspend(() =>
      lifetime.activate.pipe(Effect.andThen(() => body(lifetime.control))),
    ),
  ).pipe(Effect.onExit(() => lifetime.control.release));

export const makeJourneyControls = (
  http = fixtureHttp,
  budgets = { releaseMs: 4000, observeMs: 5000 },
) => {
  const withControl = <A, E, R>(
    url: string,
    patch: Schema.Json,
    body: (control: TemporaryControl) => Effect.Effect<A, E, R | Scope.Scope>,
  ) =>
    Effect.suspend(() => {
      const id = crypto.randomUUID();
      let confirmed = false;

      const release = Effect.gen(function* () {
        if (confirmed) return;

        const response = yield* http
          .requestOnce(
            `${url}/temporary/retire`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id }),
            },
            budgets.releaseMs,
          )
          .pipe(Effect.exit);

        return yield* Effect.gen(function* () {
          const observed = yield* http
            .observe(
              auditedObservation(
                "control",
                `${url}/temporary/state?id=${id}`,
                ControlObservation,
              ),
              {
                until: (value) =>
                  value.phase === "retired" &&
                  value.activeId === null &&
                  value.gates.length === 0 &&
                  value.effectiveSettingsSha256 ===
                    value.precedingSettingsSha256,
                budgetMs: budgets.observeMs,
              },
            )
            .pipe(
              Effect.catchCause((cause) =>
                Effect.failCause(
                  Cause.map(
                    cause,
                    () =>
                      new FixtureCleanupError({
                        controlId: id,
                        phase: "verify",
                        state: "unknown",
                      }),
                  ),
                ),
              ),
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? http.recordCleanup(
                      url,
                      id,
                      "unknown",
                      Exit.isFailure(response),
                    )
                  : Effect.void,
              ),
            );

          if (
            observed.phase !== "retired" ||
            observed.activeId !== null ||
            observed.gates.length !== 0 ||
            observed.effectiveSettingsSha256 !==
              observed.precedingSettingsSha256
          ) {
            return yield* new FixtureCleanupError({
              controlId: id,
              phase: Exit.isFailure(response) ? "release" : "verify",
              state: "dirty",
            }).pipe(
              Effect.onExit(() =>
                http.recordCleanup(url, id, "dirty", Exit.isFailure(response)),
              ),
            );
          }

          yield* http.recordCleanup(
            url,
            id,
            "confirmed",
            Exit.isFailure(response),
          );

          confirmed = true;
        }).pipe(
          Effect.onExit(() => {
            if (Exit.isSuccess(response)) return Effect.void;
            const defects = response.cause.reasons.filter(Cause.isDieReason);

            return defects.length > 0
              ? Effect.failCause(Cause.fromReasons<never>(defects))
              : Effect.void;
          }),
        );
      }).pipe(Effect.uninterruptible);

      return withTemporaryControl(
        {
          control: { id, release },
          activate: http.post(`${url}/temporary/activate`, { id, patch }),
        },
        body,
      );
    });

  return {
    withProviderControl: <A, E, R>(
      url: string,
      patch: TemporaryProviderPatch,
      body: (control: TemporaryControl) => Effect.Effect<A, E, R | Scope.Scope>,
    ) => withControl(url, patch, body),
    withSourceHold: <A, E, R>(
      url: string,
      patch: typeof SourceControl.Type,
      body: (control: TemporaryControl) => Effect.Effect<A, E, R | Scope.Scope>,
    ) => withControl(url, patch, body),
  };
};

export const { withProviderControl, withSourceHold } = makeJourneyControls();
