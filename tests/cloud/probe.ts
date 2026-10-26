import * as Cloudflare from "@alchemy.run/cloudflare";
import { Stack } from "alchemy";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/http-api";

import {
  acknowledgeReconstruction,
  identifyFixtureResponse,
} from "./fixture-response.js";

const AlarmInvocation = Schema.Struct({
  at: Schema.Number,
  attempt: Schema.Number,
  retryCount: Schema.Number,
});

export const ProbeSnapshot = Schema.Struct({
  instance: Schema.String,
  value: Schema.String,
  attempts: Schema.Number,
  completed: Schema.Boolean,
  retryCount: Schema.Number,
  alarm: Schema.NullOr(Schema.Number),
  invocations: Schema.Array(AlarmInvocation),
});

export class ProbeObject extends Cloudflare.DurableObject<ProbeObject>()(
  "FoundationProbe",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      const instance = crypto.randomUUID();
      yield* state.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS proof (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
      );

      const snapshot = Effect.fn("Probe.snapshot")(function* () {
        const cursor = yield* state.storage.sql.exec<{ value: string }>(
          "SELECT value FROM proof WHERE id = 1",
        );

        const rows = yield* cursor.toArray();

        return {
          instance,
          invocations:
            (yield* state.storage.get<readonly (typeof AlarmInvocation.Type)[]>(
              "invocations",
            )) ?? [],
          value: rows[0]?.value ?? "empty",
          attempts: (yield* state.storage.get<number>("attempts")) ?? 0,
          completed: (yield* state.storage.get<boolean>("completed")) ?? false,
          retryCount: (yield* state.storage.get<number>("retryCount")) ?? 0,
          alarm: yield* state.storage.getAlarm(),
        };
      });

      return {
        snapshot,
        prepare: Effect.fn("Probe.prepare")(function* () {
          yield* state.storage.sql.exec(
            "INSERT OR REPLACE INTO proof VALUES (1, 'committed')",
          );
          const before = Date.now() + 60_000;
          yield* state.storage.setAlarm(before);

          const rolledBack = yield* state.storage
            .transaction(
              Effect.gen(function* () {
                yield* state.storage.sql.exec(
                  "UPDATE proof SET value = 'must-rollback' WHERE id = 1",
                );
                yield* state.storage.put("attempts", 99);
                yield* state.storage.setAlarm(Date.now() + 120_000);

                return yield* Effect.fail("intentional-rollback");
              }),
            )
            .pipe(
              Effect.match({
                onFailure: (error) => error === "intentional-rollback",
                onSuccess: () => false,
              }),
            );

          return {
            rolledBack,
            before,
            snapshot: yield* snapshot(),
          };
        }),
        arm: Effect.fn("Probe.arm")(function* () {
          yield* state.storage.put({
            attempts: 0,
            completed: false,
            retryCount: 0,
            invocations: [],
          });
          yield* state.storage.setAlarm(Date.now() + 1_000);

          return yield* snapshot();
        }),
        reset: Effect.fn("Probe.reset")(function* () {
          yield* state.storage.sync();
          yield* state.abort("foundation reconstruction probe");
        }),
        alarm: Effect.fn("Probe.alarm")(function* (
          info?: Cloudflare.AlarmInvocationInfo,
        ) {
          const attempts =
            ((yield* state.storage.get<number>("attempts")) ?? 0) + 1;

          const invocations =
            (yield* state.storage.get<readonly (typeof AlarmInvocation.Type)[]>(
              "invocations",
            )) ?? [];

          yield* state.storage.put({
            invocations: [
              ...invocations,
              {
                at: Date.now(),
                attempt: attempts,
                retryCount: info?.retryCount ?? 0,
              },
            ],
            attempts,
            retryCount: info?.retryCount ?? 0,
          });
          yield* state.storage.sync();

          if (attempts === 1) {
            return yield* Effect.die(
              "intentional alarm failure to exercise Cloudflare retry",
            );
          }

          yield* state.storage.put("completed", true);
        }),
      };
    });
  }),
) {}

class ProbeApi extends HttpApi.make("foundation-probe").add(
  HttpApiGroup.make("probe").add(
    HttpApiEndpoint.get("health", "/health"),
    HttpApiEndpoint.post("raw", "/raw"),
    HttpApiEndpoint.post("prepare", "/prepare"),
    HttpApiEndpoint.post("reset", "/reset"),
    HttpApiEndpoint.post("arm", "/arm"),
    HttpApiEndpoint.get("snapshot", "/snapshot"),
  ),
) {}

export class ProbeWorker extends Cloudflare.Worker<ProbeWorker>()(
  "Probe",
  Effect.gen(function* () {
    const { stage } = yield* Stack;

    return {
      name: `arc-tools-probe-${stage}`,
      main: import.meta.url,
      workersDev: true,
      compatibility: { date: "2026-10-01" },
    };
  }),
  Effect.gen(function* () {
    const objects = yield* ProbeObject;
    const object = () => objects.getByName("proof");

    const handlers = HttpApiBuilder.group(ProbeApi, "probe", (handlers) =>
      handlers
        .handleRaw("health", () =>
          Effect.succeed(HttpServerResponse.text("foundation-probe")),
        )
        .handleRaw("raw", ({ request }) =>
          Effect.gen(function* () {
            const bytes = new Uint8Array(
              yield* request.arrayBuffer.pipe(Effect.orDie),
            );

            return HttpServerResponse.uint8Array(bytes, {
              contentType: "application/octet-stream",
            });
          }),
        )
        .handleRaw("prepare", () =>
          object()
            .prepare()
            .pipe(
              Effect.map(HttpServerResponse.jsonUnsafe),
              Effect.catchCause(() =>
                Effect.succeed(
                  HttpServerResponse.jsonUnsafe(
                    { probeError: "fixture-failure" },
                    { status: 500 },
                  ),
                ),
              ),
            ),
        )
        .handleRaw("reset", () =>
          acknowledgeReconstruction(
            object().reset(),
            "foundation reconstruction probe",
          ),
        )
        .handleRaw("arm", () =>
          object()
            .arm()
            .pipe(
              Effect.map(HttpServerResponse.jsonUnsafe),
              Effect.catchCause(() =>
                Effect.succeed(
                  HttpServerResponse.jsonUnsafe(
                    { probeError: "fixture-failure" },
                    { status: 500 },
                  ),
                ),
              ),
            ),
        )
        .handleRaw("snapshot", () =>
          object()
            .snapshot()
            .pipe(
              Effect.map(HttpServerResponse.jsonUnsafe),
              Effect.catchCause(() =>
                Effect.succeed(
                  HttpServerResponse.jsonUnsafe(
                    { probeError: "fixture-failure" },
                    { status: 500 },
                  ),
                ),
              ),
            ),
        ),
    );

    return {
      fetch: HttpApiBuilder.layer(ProbeApi).pipe(
        Layer.provide(handlers),
        Layer.provide(HttpServer.layerServices),
        HttpRouter.toHttpEffect,
        Effect.map((handler) =>
          handler.pipe(Effect.map(identifyFixtureResponse)),
        ),
      ),
    };
  }),
) {}

export default ProbeWorker;
