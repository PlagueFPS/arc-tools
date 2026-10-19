import { Stack } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Deferred, Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/http-api";

import {
  type EnvironmentConfig,
  runtimeConfig,
} from "../../apps/bot/src/config.js";
import {
  manifestHash,
  RemoteCommands,
} from "../../apps/bot/src/discord-manifest.js";
import { subscriptionBinding } from "../../apps/bot/src/twitch-binding.js";
import { Subscription } from "../../apps/bot/src/twitch-provider.js";
import {
  type AttributionStorage,
  credentialFingerprint,
  ProviderAttribution,
  parseValidationPath,
  readProviderAttribution,
  recordProviderValidation,
} from "./alarm-attribution.js";
import { identifyFixtureResponse } from "./fixture-response.js";

const Grant = Schema.Struct({
  userId: Schema.String,
  login: Schema.String,
  scopes: Schema.Array(Schema.String),
  clientId: Schema.String,
});
export const ProviderControl = Schema.Struct({
  createStatus: Schema.optional(
    Schema.Literals(["enabled", "webhook_callback_verification_pending"]),
  ),
  resetMessages: Schema.optional(Schema.Boolean),
  sendStatus: Schema.optional(Schema.Int),
  sendBody: Schema.optional(Schema.Unknown),
  holdSend: Schema.optional(Schema.Boolean),
  holdCreate: Schema.optional(Schema.Boolean),
  holdMint: Schema.optional(Schema.Boolean),
  appClient: Schema.optional(Schema.String),
  expiresIn: Schema.optional(Schema.Int),
  remote: Schema.optional(Schema.Array(Subscription)),
  commands: Schema.optional(RemoteCommands),
  releaseRevision: Schema.optional(Schema.String),
  badDiscordReadback: Schema.optional(Schema.Boolean),
  changeReleaseAfterWrite: Schema.optional(Schema.Boolean),
});
export const ProviderSnapshot = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      at: Schema.Number,
      body: Schema.Struct({
        broadcaster_id: Schema.String,
        sender_id: Schema.String,
        message: Schema.String,
        reply_parent_message_id: Schema.String,
      }),
    }),
  ),
  calls: Schema.Record(Schema.String, Schema.Int),
  validations: ProviderAttribution,
  remote: Schema.Array(Subscription),
  bindings: Schema.Record(Schema.String, Schema.String),
  logs: Schema.Array(Schema.String),
});
export const makeProviderFixture = (
  storage: AttributionStorage & {
    readonly list: <T = unknown>(options: {
      prefix: string;
    }) => Effect.Effect<Map<string, T>, never, RuntimeContext>;
  },
  identity: EnvironmentConfig,
) =>
  Effect.sync(() => {
    const gates = new Map<string, Deferred.Deferred<void>>();
    const observation = Effect.fnUntraced(function* (
      key: string,
      fingerprint: string | null = null,
      scope: Pick<
        ReturnType<typeof parseValidationPath>,
        "correlation" | "correlationError"
      > = { correlation: null, correlationError: false },
    ) {
      return yield* storage
        .transaction(
          Effect.gen(function* () {
            const n = ((yield* storage.get<number>(`call:${key}`)) ?? 0) + 1;
            yield* storage.put(`call:${key}`, n);
            if (fingerprint !== null)
              yield* recordProviderValidation(storage, fingerprint, n, scope);
            const logs = (yield* storage.get<string[]>("logs")) ?? [];
            yield* storage.put("logs", [...logs.slice(-255), key]);
            return n;
          }),
        )
        .pipe(Effect.orDie);
    });
    const wait = Effect.fnUntraced(function* (key: string) {
      const gate = gates.get(key);
      if (gate) yield* Deferred.await(gate);
    });
    return {
      control: Effect.fnUntraced(function* (
        input: typeof ProviderControl.Type,
      ) {
        for (const [field, key] of [
          [input.holdSend, "send"],
          [input.holdCreate, "create"],
          [input.holdMint, "mint"],
        ] as const) {
          if (field) gates.set(key, yield* Deferred.make<void>());
          if (field === false) {
            const gate = gates.get(key);
            if (gate) yield* Deferred.succeed(gate, undefined);
            gates.delete(key);
          }
        }
        const previous =
          (yield* storage.get<typeof ProviderControl.Type>("control")) ?? {};
        yield* storage.put("control", { ...previous, ...input });
        if (input.resetMessages) yield* storage.put("messages", []);
        if (input.remote) yield* storage.put("remote", input.remote);
        if (input.commands) yield* storage.put("discord", input.commands);
      }),
      snapshot: Effect.fnUntraced(function* () {
        return yield* storage
          .transaction(
            Effect.gen(function* () {
              return {
                messages: (yield* storage.get("messages")) ?? [],
                calls: Object.fromEntries(
                  [...(yield* storage.list<number>({ prefix: "call:" }))].map(
                    ([key, value]) => [key.slice(5), value],
                  ),
                ),
                remote: (yield* storage.get<Subscription[]>("remote")) ?? [],
                bindings: Object.fromEntries(
                  [
                    ...(yield* storage.list<string>({ prefix: "binding:" })),
                  ].map(([key, value]) => [key.slice(8), value]),
                ),
                logs: (yield* storage.get<string[]>("logs")) ?? [],
                validations: yield* readProviderAttribution(storage),
              };
            }),
          )
          .pipe(Effect.orDie);
      }),
      request: Effect.fnUntraced(function* (
        method: string,
        path: string,
        body: string,
        authorization: string,
      ) {
        const url = new URL(path, "https://fixture.invalid");
        const parsed = parseValidationPath(path);
        url.pathname = parsed.path;
        const key = `${method} ${url.pathname}`;
        const fingerprint =
          url.pathname === "/oauth/validate"
            ? yield* credentialFingerprint(authorization.replace(/^OAuth /, ""))
            : null;
        const count = yield* observation(key, fingerprint, {
          correlation: parsed.correlation,
          correlationError: parsed.correlationError,
        });
        const control =
          (yield* storage.get<typeof ProviderControl.Type>("control")) ?? {};
        if (url.pathname === "/health")
          return {
            status: 200,
            body: {
              status: "ready",
              stage: identity.stage,
              revision: control.releaseRevision ?? "fixture-release",
              manifestHash: yield* manifestHash,
            },
          };
        if (url.pathname === "/applications/fixture-discord/commands") {
          if (method === "PUT") {
            const commands = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(RemoteCommands),
            )(body).pipe(Effect.orDie);
            yield* storage.put("discord", commands);
            if (control.changeReleaseAfterWrite)
              yield* storage.put("control", {
                ...control,
                releaseRevision: "newer-release",
              });
            return { status: 200, body: commands };
          }
          const full = url.searchParams.get("with_localizations") === "true";
          yield* observation(
            full ? "discord-full-read" : "discord-partial-read",
          );
          const commands =
            (yield* storage.get<RemoteCommands>("discord")) ?? [];
          return {
            status: 200,
            body: control.badDiscordReadback
              ? []
              : full
                ? commands
                : commands.map((command) => ({
                    ...command,
                    name_localizations: undefined,
                    description_localizations: undefined,
                    options: command.options?.map((option) => ({
                      ...option,
                      name_localizations: undefined,
                      description_localizations: undefined,
                      choices: option.choices?.map((choice) => ({
                        ...choice,
                        name_localizations: undefined,
                      })),
                    })),
                  })),
          };
        }
        if (url.pathname === "/oauth/token") {
          const form = new URLSearchParams(body);
          if (form.get("grant_type") === "client_credentials") {
            yield* observation("mint");
            yield* wait("mint");
            return {
              status: 200,
              body: {
                access_token: `synthetic-app-${count}`,
                token_type: "bearer",
                expires_in: control.expiresIn ?? 3600,
              },
            };
          }
          const grant = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Grant),
          )(form.get("code")).pipe(Effect.orDie);
          return {
            status: 200,
            body: {
              access_token: JSON.stringify(grant),
              refresh_token: "CANARY-USER-REFRESH",
              token_type: "bearer",
              expires_in: 3600,
            },
          };
        }
        if (url.pathname === "/oauth/validate") {
          const token = authorization.replace(/^OAuth /, "");
          if (token.startsWith("synthetic-app-"))
            return {
              status: 200,
              body: {
                client_id: control.appClient ?? "fixture-twitch",
                expires_in: control.expiresIn ?? 3600,
                scopes: [],
              },
            };
          const grant = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Grant),
          )(token).pipe(Effect.orDie);
          return {
            status: 200,
            body: {
              client_id: grant.clientId,
              user_id: grant.userId,
              login: grant.login,
              scopes: grant.scopes,
              expires_in: 3600,
            },
          };
        }
        if (url.pathname === "/helix/users")
          return {
            status: 200,
            body: {
              data: url.searchParams.getAll("login").map((login) => ({
                login,
                id:
                  login === "fixture_sender"
                    ? "100"
                    : login === "fixture_channel"
                      ? "200"
                      : "300",
              })),
            },
          };
        if (url.pathname === "/helix/eventsub/subscriptions") {
          if (method === "GET") {
            const remote = (yield* storage.get<Subscription[]>("remote")) ?? [];
            const page = Number(url.searchParams.get("after") ?? 0);
            return {
              status: 200,
              body: {
                data: remote.slice(page, page + 1),
                pagination:
                  page + 1 < remote.length ? { cursor: String(page + 1) } : {},
              },
            };
          }
          if (method === "DELETE") {
            yield* storage
              .transaction(
                Effect.gen(function* () {
                  const remote =
                    (yield* storage.get<Subscription[]>("remote")) ?? [];
                  yield* storage.put(
                    "remote",
                    remote.filter(
                      (subscription) =>
                        subscription.id !== url.searchParams.get("id"),
                    ),
                  );
                }),
              )
              .pipe(Effect.orDie);
            return { status: 204, body: null };
          }
          const input = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                type: Schema.String,
                version: Schema.String,
                condition: Schema.Record(Schema.String, Schema.String),
                transport: Schema.Struct({
                  method: Schema.String,
                  callback: Schema.String,
                  secret: Schema.String,
                }),
              }),
            ),
          )(body).pipe(Effect.orDie);
          const result = yield* storage
            .transaction(
              Effect.gen(function* () {
                const remote =
                  (yield* storage.get<Subscription[]>("remote")) ?? [];
                if (
                  remote.some(
                    (subscription) =>
                      subscription.type === input.type &&
                      subscription.version === input.version &&
                      subscription.transport.method ===
                        input.transport.method &&
                      subscription.condition.broadcaster_user_id ===
                        input.condition.broadcaster_user_id &&
                      subscription.condition.user_id ===
                        input.condition.user_id,
                  )
                )
                  return { status: 409, body: {} };
                const subscription = {
                  ...input,
                  transport: {
                    method: input.transport.method,
                    callback: input.transport.callback,
                  },
                  id: `created-${count}`,
                  status: control.createStatus ?? "enabled",
                };
                yield* storage.put(
                  `binding:${subscription.id}`,
                  yield* subscriptionBinding({
                    callback: input.transport.callback,
                    clientId: identity.twitchClientId,
                    signingSecret: Redacted.make(input.transport.secret),
                  }),
                );
                yield* storage.put("remote", [...remote, subscription]);
                return { status: 202, body: { data: [subscription] } };
              }),
            )
            .pipe(Effect.orDie);
          yield* wait("create");
          return result;
        }
        if (url.pathname === "/helix/chat/messages") {
          const payload = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              ProviderSnapshot.fields.messages.value.fields.body,
            ),
          )(body).pipe(Effect.orDie);
          const messages =
            (yield* storage.get<(typeof ProviderSnapshot.Type)["messages"]>(
              "messages",
            )) ?? [];
          yield* storage.put("messages", [
            ...messages.slice(-127),
            { at: Date.now(), body: payload },
          ]);
          yield* wait("send");
          return {
            status: control.sendStatus ?? 200,
            body: control.sendBody ?? {
              data: [{ is_sent: true, message_id: `message-${count}` }],
            },
          };
        }
        return { status: 404, body: {} };
      }),
    };
  });
export class ProviderFixtureState extends Cloudflare.DurableObject<ProviderFixtureState>()(
  "ProviderFixtureState",
  Effect.gen(function* () {
    const { storage } = yield* Cloudflare.DurableObjectState;
    const { identity } = yield* runtimeConfig.pipe(Effect.orDie);
    return makeProviderFixture(storage, identity);
  }),
) {}

class ProviderApi extends HttpApi.make("provider-fixture").add(
  HttpApiGroup.make("fixture").add(
    HttpApiEndpoint.post("control", "/control"),
    HttpApiEndpoint.get("snapshot", "/snapshot"),
    HttpApiEndpoint.post("token", "/oauth/token"),
    HttpApiEndpoint.get("validate", "/oauth/validate"),
    HttpApiEndpoint.get(
      "correlatedValidate",
      "/fixture-validation/:instance/:operation/:alarmRun/:invocationId/oauth/validate",
    ),
    HttpApiEndpoint.get("users", "/helix/users"),
    HttpApiEndpoint.get("list", "/helix/eventsub/subscriptions"),
    HttpApiEndpoint.post("create", "/helix/eventsub/subscriptions"),
    HttpApiEndpoint.delete("remove", "/helix/eventsub/subscriptions"),
    HttpApiEndpoint.post("send", "/helix/chat/messages"),
    HttpApiEndpoint.get("health", "/health"),
    HttpApiEndpoint.get(
      "discordRead",
      "/applications/fixture-discord/commands",
    ),
    HttpApiEndpoint.put(
      "discordWrite",
      "/applications/fixture-discord/commands",
    ),
  ),
) {}
export class TwitchProviderFixture extends Cloudflare.Worker<TwitchProviderFixture>()(
  "TwitchProviderFixture",
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    return {
      name: `arc-tools-provider-${stage}`,
      main: import.meta.url,
      workersDev: true,
      compatibility: { date: "2026-10-01" },
    };
  }),
  Effect.gen(function* () {
    const objects = yield* ProviderFixtureState;
    const object = () => objects.getByName("provider");
    const provider = Effect.fnUntraced(function* (
      request: import("effect/http/HttpServerRequest").HttpServerRequest,
    ) {
      const result = yield* object().request(
        request.method,
        request.url,
        yield* request.text.pipe(Effect.orDie),
        request.headers.authorization ?? "",
      );
      return result.status === 204
        ? HttpServerResponse.empty({ status: 204 })
        : HttpServerResponse.jsonUnsafe(result.body, { status: result.status });
    });
    const handlers = HttpApiBuilder.group(ProviderApi, "fixture", (handlers) =>
      handlers
        .handleRaw("control", ({ request }) =>
          Effect.gen(function* () {
            const control = yield* request.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(ProviderControl)),
              Effect.orDie,
            );
            yield* object().control(control);
            return HttpServerResponse.empty({ status: 204 });
          }),
        )
        .handleRaw("snapshot", () =>
          object().snapshot().pipe(Effect.map(HttpServerResponse.jsonUnsafe)),
        )
        .handleRaw("token", ({ request }) =>
          provider(request).pipe(
            Effect.tapCause((cause) =>
              Effect.logError("Controlled token fixture failed", cause),
            ),
          ),
        )
        .handleRaw("validate", ({ request }) => provider(request))
        .handleRaw("correlatedValidate", ({ request }) => provider(request))
        .handleRaw("users", ({ request }) => provider(request))
        .handleRaw("list", ({ request }) => provider(request))
        .handleRaw("create", ({ request }) => provider(request))
        .handleRaw("remove", ({ request }) => provider(request))
        .handleRaw("send", ({ request }) => provider(request))
        .handleRaw("health", ({ request }) => provider(request))
        .handleRaw("discordRead", ({ request }) => provider(request))
        .handleRaw("discordWrite", ({ request }) => provider(request)),
    );
    return {
      fetch: HttpApiBuilder.layer(ProviderApi).pipe(
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
export default TwitchProviderFixture;
