/* oxlint-disable effecttsgo/new-promise -- Native event and callback APIs require Promise resolvers at this interoperability boundary. */
/* oxlint-disable effecttsgo/run-effect-inside-effect -- Native fixture callbacks need synchronous values or Promises from the simulated Effect services. */
/* oxlint-disable effecttsgo/schema-sync -- Fixture builders and native callbacks validate synchronously; Effect programs use Effect decoders. */
/* oxlint-disable effecttsgo/schema-sync-in-effect -- Fixture builders and native callbacks validate synchronously; Effect programs use Effect decoders. */
import { expect } from "bun:test";

import { randomUUID as secureRandomUUID } from "@arctools/utils/http";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Test from "alchemy/Test/Bun";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
  Array as Arr,
  String as Str,
} from "effect";

import { EnvironmentConfig } from "../../apps/bot/src/config.js";
import { fixtureControl } from "./fixture-control.js";
import { makeFixtureHttp } from "./fixture-http.js";
import {
  FixtureCleanupError,
  makeJourneyControls,
  withTemporaryControl,
} from "./fixture-journey.js";
import { fixtureRuntime, fixtureStorage } from "./fixture-storage.js";
import { makeSourceFixture } from "./metaforge.js";
import { makeProviderFixture } from "./twitch-provider-fixture.js";

const { test } = Test.make({ providers: Layer.empty });

const config = Schema.decodeSync(EnvironmentConfig)({
  kind: "test",
  stage: "test-account-0123456789ab",
  applicationStage: "test-account-0123456789ab",
  senderKind: "synthetic",
  senderLogin: "fixture_sender",
  channelLogins: ["fixture_channel"],
  twitchClientId: "fixture-twitch",
  discordApplicationId: "fixture-discord",
});

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(RuntimeContext, fixtureRuntime),
    Effect.scoped,
  );

const message = JSON.stringify({
  broadcaster_id: "200",
  sender_id: "100",
  message: "test",
  reply_parent_message_id: "same-attempt",
});

const send = (
  provider: Effect.Success<ReturnType<typeof makeProviderFixture>>,
) => provider.request("POST", "/helix/chat/messages", message, "");

for (const mode of [
  "success",
  "failure",
  "defect",
  "acquisition-loss",
  "acquisition-failure",
] as const) {
  test(
    `control restores effective provider behavior after ${mode}`,
    run(
      Effect.gen(function* () {
        const provider = yield* makeProviderFixture(
          yield* fixtureStorage(),
          config,
        );

        const id = yield* secureRandomUUID;
        let bodyStarted = false;
        const release = provider.retire(id).pipe(Effect.orDie);

        const activated = provider
          .activate({
            id,
            patch: { appClient: "wrong-client", holdSend: true },
          })
          .pipe(Effect.orDie);

        const exit = yield* withTemporaryControl(
          {
            control: { id, release },
            activate:
              mode === "acquisition-failure"
                ? Effect.fail("acquisition")
                : activated.pipe(
                    Effect.andThen(
                      mode === "acquisition-loss"
                        ? Effect.fail("response-lost")
                        : Effect.void,
                    ),
                  ),
          },
          () =>
            Effect.gen(function* () {
              bodyStarted = true;

              const validation = yield* provider.request(
                "GET",
                "/oauth/validate",
                "",
                "OAuth synthetic-app-1",
              );

              expect(validation.body).toMatchObject({
                client_id: "wrong-client",
              });

              if (mode === "failure") return yield* Effect.fail("body");

              if (mode === "defect") return yield* Effect.die("assertion");

              return 42;
            }),
        ).pipe(Effect.exit);

        expect(bodyStarted).toBe(!Str.startsWith("acquisition")(mode));
        expect(Exit.isSuccess(exit)).toBe(mode === "success");

        if (Exit.isSuccess(exit)) expect(exit.value).toBe(42);

        const restored = yield* provider.request(
          "GET",
          "/oauth/validate",
          "",
          "OAuth synthetic-app-2",
        );

        expect(restored.body).toMatchObject({ client_id: "fixture-twitch" });
        expect((yield* send(provider)).status).toBe(200);
        expect((yield* provider.controlState(id)).gates).toEqual([]);
      }),
    ),
  );
}

for (const phase of ["activation", "body"] as const) {
  test(
    `pending parent interrupt awaits child shutdown and restoration during ${phase}`,
    run(
      Effect.gen(function* () {
        const provider = yield* makeProviderFixture(
          yield* fixtureStorage(),
          config,
        );

        const ready = yield* Deferred.make<void>();
        const childReady = yield* Deferred.make<void>();
        const cleanupReady = yield* Deferred.make<void>();
        const finishCleanup = yield* Deferred.make<void>();
        const order: string[] = [];
        const id = yield* secureRandomUUID;

        const fiber = yield* withTemporaryControl(
          {
            control: {
              id,
              release: Effect.gen(function* () {
                order.push("restore-start");
                yield* Deferred.succeed(cleanupReady, undefined);
                yield* Deferred.await(finishCleanup);
                yield* provider.retire(id).pipe(Effect.orDie);
                order.push("restored");
              }),
            },
            activate: provider
              .activate({ id, patch: { holdSend: true } })
              .pipe(
                Effect.orDie,
                Effect.andThen(
                  phase === "activation"
                    ? Deferred.succeed(ready, undefined).pipe(
                        Effect.andThen(Effect.never),
                      )
                    : Effect.void,
                ),
              ),
          },
          () =>
            Effect.gen(function* () {
              yield* Effect.never.pipe(
                Effect.onExit(() =>
                  Effect.sync(() => {
                    order.push("child-stopped");
                  }),
                ),
                (effect) =>
                  Deferred.succeed(childReady, undefined).pipe(
                    Effect.andThen(effect),
                  ),
                Effect.forkScoped,
              );
              yield* Deferred.await(childReady);
              yield* Deferred.succeed(ready, undefined);

              return yield* Effect.never;
            }),
        ).pipe(Effect.forkScoped);

        yield* Deferred.await(ready);
        const interrupt = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
        yield* Deferred.await(cleanupReady);
        expect(interrupt.pollUnsafe()).toBeUndefined();
        expect(order).toEqual(
          phase === "body"
            ? ["child-stopped", "restore-start"]
            : ["restore-start"],
        );
        yield* Deferred.succeed(finishCleanup, undefined);
        yield* Fiber.join(interrupt);
        expect(fiber.pollUnsafe()?._tag).toBe("Failure");
        expect(order.at(-1)).toBe("restored");
        expect((yield* send(provider)).status).toBe(200);
      }),
    ),
  );
}

test(
  "failed body stops held scoped child before restoring and preserves both causes",
  run(
    Effect.gen(function* () {
      const source = yield* makeSourceFixture(yield* fixtureStorage());
      const id = yield* secureRandomUUID;
      const order: string[] = [];
      const started = yield* Deferred.make<void>();

      const cleanupError = new FixtureCleanupError({
        controlId: id,
        phase: "verify",
        state: "unknown",
      });

      const exit = yield* withTemporaryControl(
        {
          control: {
            id,
            release: source.retire(id).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  order.push("restored");
                }),
              ),
              Effect.andThen(cleanupError),
            ),
          },
          activate: source.activate({
            id,
            patch: { key: "/items", body: { data: [] } },
          }),
        },
        () =>
          Effect.gen(function* () {
            yield* source.request("/items").pipe(
              (effect) =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(effect),
                ),
              Effect.onExit(() =>
                Effect.sync(() => {
                  order.push("child-stopped");
                }),
              ),
              Effect.forkScoped,
            );
            yield* Deferred.await(started);

            return yield* Effect.fail("body-failure");
          }),
      ).pipe(Effect.exit);

      expect(order).toEqual(["child-stopped", "restored"]);

      if (!Exit.isFailure(exit))
        return yield* Effect.die("Expected combined failure");
      expect(Cause.pretty(exit.cause)).toContain("body-failure");
      expect(Cause.pretty(exit.cause)).toContain("FixtureCleanupError");
      expect((yield* source.request("/items")).status).toBe(200);
    }),
  ),
);

test(
  "identity fencing survives reconstruction, duplicate activation and old retirement without clearing history",
  run(
    Effect.gen(function* () {
      const storage = yield* fixtureStorage();
      let provider = yield* makeProviderFixture(storage, config);
      const id = yield* secureRandomUUID;
      yield* provider.activate({ id, patch: { holdSend: true } });
      const first = yield* send(provider).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* provider.activate({ id, patch: { holdSend: true } });
      expect(
        (yield* provider
          .activate({
            id: yield* secureRandomUUID,
            patch: { appClient: "wrong" },
          })
          .pipe(Effect.flip)).code,
      ).toBe("overlap");
      yield* provider.retire(id);
      expect((yield* Fiber.join(first)).status).toBe(200);
      yield* provider.retire(id);
      provider = yield* makeProviderFixture(storage, config);
      expect(
        (yield* provider
          .activate({ id, patch: { holdSend: true } })
          .pipe(Effect.flip)).code,
      ).toBe("retired");
      const next = yield* secureRandomUUID;
      yield* provider.activate({ id: next, patch: { holdSend: true } });
      yield* provider.retire(id);
      expect((yield* provider.controlState(next)).gates).toEqual(["send"]);
      const oldRequest = yield* send(provider).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(oldRequest);
      expect(Exit.isFailure(yield* Fiber.await(oldRequest))).toBeTrue();
      const rebuilt = yield* makeProviderFixture(storage, config);
      expect((yield* rebuilt.controlState(next)).gates).toEqual(["send"]);
      yield* rebuilt.retire(next);
      expect((yield* send(rebuilt)).status).toBe(200);
      expect((yield* rebuilt.snapshot()).messages).toHaveLength(3);
    }),
  ),
);

test(
  "release before activation retires even a nullable source baseline durably",
  run(
    Effect.gen(function* () {
      const storage = yield* fixtureStorage();
      const id = yield* secureRandomUUID;
      const source = yield* makeSourceFixture(storage);
      yield* source.retire(id);
      const rebuilt = yield* makeSourceFixture(storage);
      expect(
        (yield* rebuilt
          .activate({ id, patch: { key: "/items", body: { data: [] } } })
          .pipe(Effect.flip)).code,
      ).toBe("retired");
      expect((yield* rebuilt.request("/items")).body).toMatchObject({
        data: [{ id: "sensors" }],
      });
    }),
  ),
);

for (const mode of ["lost-release", "unavailable", "dirty"] as const) {
  test(
    `HTTP control cleanup reports ${mode} truthfully without mutation replay`,
    run(
      Effect.gen(function* () {
        const protocol = yield* fixtureControl(
          yield* fixtureStorage(),
          {},
          () => [],
        );

        let activations = 0;
        let retirements = 0;
        const events: string[] = [];

        const client = makeFixtureHttp(
          async (url, init) => {
            const parsed = new URL(url);

            if (Str.endsWith("activate")(parsed.pathname)) {
              activations++;

              const input = Schema.decodeUnknownSync(
                Schema.Struct({ id: Schema.String }),
              )(
                Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
                  init.body,
                ),
              );

              await Effect.runPromise(
                protocol
                  .activate(input.id, {})
                  .pipe(Effect.provideService(RuntimeContext, fixtureRuntime)),
              );

              return new Response(null, { status: 204 });
            }

            if (Str.endsWith("retire")(parsed.pathname)) {
              retirements++;

              const input = Schema.decodeUnknownSync(
                Schema.Struct({ id: Schema.String }),
              )(
                Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
                  init.body,
                ),
              );

              if (mode !== "dirty")
                await Effect.runPromise(
                  protocol
                    .retire(input.id)
                    .pipe(
                      Effect.provideService(RuntimeContext, fixtureRuntime),
                    ),
                );
              throw Object.assign(new TypeError("CANARY"), {
                code: "ECONNRESET",
              });
            }

            if (mode === "unavailable") throw new TypeError("CANARY");

            const state = await Effect.runPromise(
              protocol
                .observe(parsed.searchParams.get("id") ?? "")
                .pipe(Effect.provideService(RuntimeContext, fixtureRuntime)),
            );

            return Response.json(state);
          },
          (event) =>
            Effect.sync(() => {
              events.push(
                Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(event),
              );
            }),
        );

        const result = yield* makeJourneyControls(client, {
          releaseMs: 50,
          observeMs: 50,
        })
          .withProviderControl(
            "https://provider.invalid/journeys/test",
            {},
            () => Effect.succeed(7),
          )
          .pipe(Effect.exit);

        expect(activations).toBe(1);
        expect(retirements).toBe(1);
        expect(Exit.isSuccess(result)).toBe(mode === "lost-release");

        if (Exit.isFailure(result))
          expect(Cause.pretty(result.cause)).toContain("FixtureCleanupError");
        expect(Arr.join(events, "\n")).toContain("ECONNRESET");
        expect(Arr.join(events, "\n")).not.toContain("CANARY");
      }),
    ),
  );
}

test(
  "parent interruption cannot cancel HTTP restoration and a hung retirement is bounded independently",
  run(
    Effect.gen(function* () {
      const provider = yield* makeProviderFixture(
        yield* fixtureStorage(),
        config,
      );

      const ready = yield* Deferred.make<void>();
      let retirementSignalWasAborted = true;
      let retiredId = "";

      const client = makeFixtureHttp(
        async (url, init) => {
          const parsed = new URL(url);

          if (Str.endsWith("activate")(parsed.pathname)) {
            const input = Schema.decodeUnknownSync(
              Schema.Struct({ id: Schema.String }),
            )(
              Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
                init.body,
              ),
            );

            await Effect.runPromise(
              provider
                .activate({ id: input.id, patch: { holdSend: true } })
                .pipe(Effect.provideService(RuntimeContext, fixtureRuntime)),
            );
            Effect.runSync(Deferred.succeed(ready, undefined));

            return await new Promise<Response>((_resolve, reject) =>
              init.signal?.addEventListener("abort", () =>
                reject(new TypeError("response lost")),
              ),
            );
          }

          if (Str.endsWith("retire")(parsed.pathname)) {
            retirementSignalWasAborted = init.signal?.aborted ?? true;

            const input = Schema.decodeUnknownSync(
              Schema.Struct({ id: Schema.String }),
            )(
              Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
                init.body,
              ),
            );

            retiredId = input.id;
            await Effect.runPromise(
              provider
                .retire(input.id)
                .pipe(Effect.provideService(RuntimeContext, fixtureRuntime)),
            );

            return await new Promise<Response>(() => {});
          }

          return Response.json(
            await Effect.runPromise(
              provider
                .controlState(parsed.searchParams.get("id") ?? "")
                .pipe(Effect.provideService(RuntimeContext, fixtureRuntime)),
            ),
          );
        },
        () => Effect.void,
      );

      const fiber = yield* makeJourneyControls(client, {
        releaseMs: 10,
        observeMs: 100,
      })
        .withProviderControl(
          "https://provider.invalid/journeys/interrupt",
          { holdSend: true },
          () => Effect.never,
        )
        .pipe(Effect.forkScoped);

      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      expect(retirementSignalWasAborted).toBeFalse();
      expect((yield* provider.controlState(retiredId)).phase).toBe("retired");
      expect((yield* send(provider)).status).toBe(200);
      expect(fiber.pollUnsafe()?._tag).toBe("Failure");
    }),
  ),
);

test(
  "manual release caches confirmed cleanup and cannot restore a newer identity",
  run(
    Effect.gen(function* () {
      const protocol = yield* fixtureControl(
        yield* fixtureStorage(),
        {},
        () => [],
      );

      let retirements = 0;

      const client = makeFixtureHttp(
        async (url, init) => {
          const parsed = new URL(url);

          if (Str.endsWith("activate")(parsed.pathname)) {
            const input = Schema.decodeUnknownSync(
              Schema.Struct({ id: Schema.String }),
            )(
              Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
                init.body,
              ),
            );

            await Effect.runPromise(
              protocol
                .activate(input.id, {})
                .pipe(Effect.provideService(RuntimeContext, fixtureRuntime)),
            );

            return new Response(null, { status: 204 });
          }

          if (Str.endsWith("retire")(parsed.pathname)) {
            retirements++;

            const input = Schema.decodeUnknownSync(
              Schema.Struct({ id: Schema.String }),
            )(
              Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
                init.body,
              ),
            );

            await Effect.runPromise(
              protocol
                .retire(input.id)
                .pipe(Effect.provideService(RuntimeContext, fixtureRuntime)),
            );

            return new Response(null, { status: 204 });
          }

          return Response.json(
            await Effect.runPromise(
              protocol
                .observe(parsed.searchParams.get("id") ?? "")
                .pipe(Effect.provideService(RuntimeContext, fixtureRuntime)),
            ),
          );
        },
        () => Effect.void,
      );

      const next = yield* secureRandomUUID;
      yield* makeJourneyControls(client).withProviderControl(
        "https://provider.invalid",
        {},
        (control) =>
          Effect.gen(function* () {
            yield* control.release;
            yield* protocol.activate(next, {});
          }),
      );
      expect(retirements).toBe(1);
      expect((yield* protocol.observe(next)).phase).toBe("active");
      yield* protocol.retire(next);
    }),
  ),
);

test(
  "isolated providers and sources keep identical request keys independent even when cleanup is dirty",
  run(
    Effect.gen(function* () {
      const a = yield* makeProviderFixture(yield* fixtureStorage(), config);
      const b = yield* makeProviderFixture(yield* fixtureStorage(), config);
      const id = yield* secureRandomUUID;

      const failed = yield* withTemporaryControl(
        {
          activate: a.activate({ id, patch: { holdSend: true } }),
          control: {
            id,
            release: new FixtureCleanupError({
              controlId: id,
              phase: "verify",
              state: "unknown",
            }),
          },
        },
        () => Effect.fail("scenario-failed"),
      ).pipe(Effect.exit);

      expect(Exit.isFailure(failed)).toBeTrue();
      const held = yield* send(a).pipe(Effect.forkScoped);
      expect((yield* send(b)).status).toBe(200);
      expect((yield* b.snapshot()).messages).toHaveLength(1);
      expect((yield* b.controlState(id)).gates).toEqual([]);
      yield* a.retire(id);
      yield* Fiber.join(held);
      const sourceA = yield* makeSourceFixture(yield* fixtureStorage());
      const sourceB = yield* makeSourceFixture(yield* fixtureStorage());
      yield* sourceA.activate({
        id,
        patch: { key: "/items", body: { data: [] } },
      });

      const sourceHeld = yield* sourceA
        .request("/items")
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;

      expect((yield* sourceB.request("/items")).body).toMatchObject({
        data: [{ id: "sensors" }],
      });
      yield* sourceA.retire(id);
      expect((yield* Fiber.join(sourceHeld)).body).toEqual({ data: [] });
    }),
  ),
);

test(
  "every temporary provider knob restores the preceding actual response",
  run(
    Effect.gen(function* () {
      const provider = yield* makeProviderFixture(
        yield* fixtureStorage(),
        config,
      );

      yield* provider.control({
        commands: [{ name: "sell", description: "sell" }],
      });

      for (const patch of [
        { appClient: "wrong", expiresIn: 7 },
        { sendStatus: 503, sendBody: { invalid: true } },
        { releaseRevision: "temporary" },
        { badDiscordReadback: true },
        { changeReleaseAfterWrite: true },
        { createStatus: "webhook_callback_verification_pending" },
      ] satisfies ReadonlyArray<
        import("./twitch-provider-fixture.js").TemporaryProviderPatch
      >) {
        const id = yield* secureRandomUUID;
        yield* provider.activate({ id, patch });

        if ("appClient" in patch)
          expect(
            (yield* provider.request(
              "GET",
              "/oauth/validate",
              "",
              "OAuth synthetic-app-1",
            )).body,
          ).toMatchObject({ client_id: "wrong", expires_in: 7 });

        if ("sendStatus" in patch)
          expect(yield* send(provider)).toEqual({
            status: 503,
            body: { invalid: true },
          });

        if ("releaseRevision" in patch)
          expect(
            (yield* provider.request("GET", "/health", "", "")).body,
          ).toMatchObject({ revision: "temporary" });

        if ("badDiscordReadback" in patch)
          expect(
            (yield* provider.request(
              "GET",
              "/applications/fixture-discord/commands?with_localizations=true",
              "",
              "",
            )).body,
          ).toEqual([]);

        if ("changeReleaseAfterWrite" in patch) {
          yield* provider.request(
            "PUT",
            "/applications/fixture-discord/commands",
            yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
              { name: "sell", description: "sell" },
            ]).pipe(Effect.orDie),
            "",
          );
          expect(
            (yield* provider.request("GET", "/health", "", "")).body,
          ).toMatchObject({ revision: "newer-release" });
        }

        if ("createStatus" in patch) {
          const created = yield* provider.request(
            "POST",
            "/helix/eventsub/subscriptions",
            yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              type: "channel.chat.message",
              version: "1",
              condition: { broadcaster_user_id: "200", user_id: "100" },
              transport: {
                method: "webhook",
                callback: "https://fixture.invalid/webhooks/twitch",
                secret: "synthetic",
              },
            }).pipe(Effect.orDie),
            "",
          );

          expect(created.body).toMatchObject({
            data: [{ status: "webhook_callback_verification_pending" }],
          });
        }

        yield* provider.retire(id);
        expect(
          (yield* provider.request(
            "GET",
            "/oauth/validate",
            "",
            "OAuth synthetic-app-1",
          )).body,
        ).toMatchObject({ client_id: "fixture-twitch", expires_in: 3600 });
        expect((yield* send(provider)).status).toBe(200);
        expect(
          (yield* provider.request("GET", "/health", "", "")).body,
        ).toMatchObject({ revision: "fixture-release" });
        expect(
          (yield* provider.request(
            "GET",
            "/applications/fixture-discord/commands?with_localizations=true",
            "",
            "",
          )).body,
        ).toEqual([{ name: "sell", description: "sell" }]);
      }
    }),
  ),
);

test(
  "failed cleanup observation retains body and retirement evidence defects",
  run(
    Effect.gen(function* () {
      const client = makeFixtureHttp(
        async (url) => {
          if (Str.endsWith("activate")(url))
            return new Response(null, { status: 204 });
          throw Object.assign(new TypeError(""), {
            code: Str.endsWith("retire")(url) ? "ECONNRESET" : "EHOSTUNREACH",
          });
        },
        (event) =>
          Str.endsWith("/retire")(event.route)
            ? Effect.die("retirement-evidence-write-failed")
            : Effect.void,
      );

      const exit = yield* makeJourneyControls(client, {
        releaseMs: 50,
        observeMs: 50,
      })
        .withProviderControl("https://provider.invalid", {}, () =>
          Effect.fail("body-failure"),
        )
        .pipe(Effect.exit);

      if (Exit.isSuccess(exit))
        return yield* Effect.die("Expected cleanup failure");

      const rendered = Cause.pretty(exit.cause);
      expect(rendered).toContain("body-failure");
      expect(rendered).toContain("FixtureCleanupError");
      expect(rendered).toContain("retirement-evidence-write-failed");
    }),
  ),
);

test(
  "lost retirement response waits for restoration to become observable",
  run(
    Effect.gen(function* () {
      let observations = 0;

      const client = makeFixtureHttp(
        async (url) => {
          const parsed = new URL(url);

          if (Str.endsWith("activate")(parsed.pathname))
            return new Response(null, { status: 204 });

          if (Str.endsWith("retire")(parsed.pathname))
            throw Object.assign(new TypeError(""), { code: "ECONNRESET" });

          const id = parsed.searchParams.get("id");
          const retired = ++observations > 1;

          return Response.json({
            id,
            phase: retired ? "retired" : "active",
            activeId: retired ? null : id,
            gates: retired ? [] : ["send"],
            effectiveSettingsSha256: retired ? "before" : "during",
            precedingSettingsSha256: "before",
          });
        },
        () => Effect.void,
      );

      yield* makeJourneyControls(client, {
        releaseMs: 50,
        observeMs: 1000,
      }).withProviderControl("https://provider.invalid", {}, () => Effect.void);

      expect(observations).toBe(2);
    }),
  ),
);
