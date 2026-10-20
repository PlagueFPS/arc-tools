import { Match, Effect, Redacted, Schema } from "effect";

import { EnvironmentConfig } from "../src/config.js";
import {
  type AccountConfig,
  AccountService,
  accountServiceLayer,
} from "../src/twitch-account.js";
import { subscriptionBinding } from "../src/twitch-binding.js";
import {
  type Account,
  Dispatch,
  type SetupResult,
} from "../src/twitch-contracts.js";
import {
  type Subscription,
  TwitchProvider,
  providerLayer,
} from "../src/twitch-provider.js";
import { AccountState, AccountStore, emptyState } from "../src/twitch-state.js";

export const callback = "https://fixture.invalid/webhooks/twitch";

export const identity = Schema.decodeUnknownSync(EnvironmentConfig)({
  kind: "test",
  stage: "test-proof-0123456789ab",
  applicationStage: "test-proof-0123456789ab",
  senderKind: "synthetic",
  senderLogin: "fixture_sender",
  channelLogins: ["fixture_channel"],
  twitchClientId: "fixture-twitch",
  discordApplicationId: "fixture-discord",
});

const CreateRequest = Schema.Struct({
  type: Schema.String,
  version: Schema.String,
  condition: Schema.Struct({
    broadcaster_user_id: Schema.String,
    user_id: Schema.String,
  }),
  transport: Schema.Struct({
    method: Schema.String,
    callback: Schema.String,
    secret: Schema.String,
  }),
});

const Grant = Schema.Struct({
  user: Schema.String,
  login: Schema.String,
  scopes: Schema.Array(Schema.String),
});

export const fixture = Effect.fnUntraced(function* () {
  let raw: unknown = emptyState("");

  const store = AccountStore.of({
    update: (f) =>
      Effect.sync(() => {
        const state = Schema.decodeUnknownSync(AccountState)(raw);
        const result = f(state);
        raw = Schema.encodeSync(AccountState)(state);

        return result;
      }),
  });

  const noResponse = (): { status: number; body: unknown } | null => null;
  const noGate = (): ReturnType<typeof responseGate> | null => null;
  const noLateCreate = (): typeof CreateRequest.Type | null => null;
  const requests: { method: string; path: string }[] = [];

  const control = {
    responses: new Map<
      string,
      (request: Request) => Response | Promise<Response>
    >(),
    requests,
    remote: new Map<string, Subscription>(),
    secrets: new Map<string, string>(),
    calls: { get: 0, post: 0, delete: 0, conflict: 0, send: 0 },
    loseB: false,
    hideRemote: false,
    conflictOnly: false,
    loseReceipt: false,
    disconnect: false,
    malformed: false,
    response: noResponse(),
    createGate: noGate(),
    listGate: noGate(),
    deleteGate: noGate(),
    phase: "enabled",
    senderId: "100",
    lateB: noLateCreate(),
  };

  const insert = (input: typeof CreateRequest.Type, id: string) => {
    const subscription: Subscription = {
      ...input,
      id,
      status: control.phase,
      transport: {
        method: input.transport.method,
        callback: input.transport.callback,
      },
    };

    control.remote.set(id, subscription);
    control.secrets.set(id, input.transport.secret);

    return subscription;
  };

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      control.requests.push({ method: request.method, path: url.pathname });

      const response = control.responses.get(
        `${request.method} ${url.pathname}`,
      );

      if (response) return response(request);

      if (url.pathname === "/token") {
        const params = new URLSearchParams(await request.text());

        return Response.json({
          access_token: params.get("code") ?? "app-token",
          expires_in: 3600,
          token_type: "bearer",
        });
      }

      if (url.pathname === "/validate") {
        const token = request.headers.get("Authorization")?.slice(6);

        if (token === "app-token")
          return Response.json({
            client_id: identity.twitchClientId,
            expires_in: 3600,
            scopes: [],
          });

        const grant = Schema.decodeUnknownSync(Schema.fromJsonString(Grant))(
          token,
        );

        return Response.json({
          client_id: identity.twitchClientId,
          expires_in: 3600,
          user_id: grant.user,
          login: grant.login,
          scopes: grant.scopes,
        });
      }

      if (url.pathname === "/users")
        return Response.json({
          data: url.searchParams.getAll("login").map((login) => ({
            login,
            id: Match.value(login).pipe(
              Match.when("fixture_channel", () => "200"),
              Match.when("fixture_sender", () => control.senderId),
              Match.orElse(() => "101"),
            ),
          })),
        });

      if (url.pathname === "/chat/messages") {
        control.calls.send++;

        return Response.json({ data: [{ is_sent: true, message_id: "sent" }] });
      }

      if (request.method === "GET") {
        control.calls.get++;
        const data = control.hideRemote ? [] : [...control.remote.values()];

        if (control.listGate) {
          control.listGate.entered.resolve();
          await control.listGate.release.promise;
        }

        return Response.json({ data });
      }

      if (request.method === "DELETE") {
        control.calls.delete++;

        if (control.deleteGate) {
          control.deleteGate.entered.resolve();
          await control.deleteGate.release.promise;
        }

        control.remote.delete(url.searchParams.get("id") ?? "");

        return new Response(null, { status: 204 });
      }

      control.calls.post++;

      if (control.conflictOnly) {
        control.calls.conflict++;

        return new Response("conflict without a body", { status: 409 });
      }

      if (control.response && control.response.status !== 202)
        return Schema.is(Schema.String)(control.response.body)
          ? new Response(control.response.body, {
              status: control.response.status,
            })
          : Response.json(control.response.body, {
              status: control.response.status,
            });

      const input = Schema.decodeUnknownSync(CreateRequest)(
        await request.json(),
      );

      if (control.loseB && input.transport.secret === "secret-B") {
        control.lateB = input;

        return new Response("lost receipt", { status: 500 });
      }

      if (control.lateB) {
        insert(control.lateB, "late-B");
        control.lateB = null;
      }

      if (
        [...control.remote.values()].some(
          (sub) =>
            sub.type === input.type &&
            sub.version === input.version &&
            sub.transport.method === input.transport.method &&
            sub.condition.broadcaster_user_id ===
              input.condition.broadcaster_user_id &&
            sub.condition.user_id === input.condition.user_id,
        )
      ) {
        control.calls.conflict++;

        return Response.json({}, { status: 409 });
      }

      const sub = insert(input, `created-${control.calls.post}`);

      if (control.createGate) {
        control.createGate.entered.resolve();
        await control.createGate.release.promise;
      }

      if (control.disconnect) {
        server.stop(true);

        return new Response(null);
      }

      if (control.malformed) return new Response("not JSON", { status: 202 });

      if (control.loseReceipt) return Response.json({}, { status: 500 });

      return Response.json(control.response?.body ?? { data: [sub] }, {
        status: 202,
      });
    },
  });

  yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)));
  const base = `http://127.0.0.1:${server.port}`;

  const construct = Effect.fnUntraced(function* (
    secret: string,
    overrides: Partial<AccountConfig> = {},
  ) {
    const binding = yield* subscriptionBinding({
      callback: overrides.callback ?? callback,
      clientId: identity.twitchClientId,
      signingSecret: Redacted.make(secret),
    });

    const config: AccountConfig = {
      identity,
      callback,
      redirect: "https://fixture.invalid/oauth/twitch/callback",
      webhookReady: true,
      subscriptionBinding: binding,
      revision: secret,
      ...overrides,
    };

    const provider = yield* TwitchProvider.pipe(
      Effect.provide(
        providerLayer(
          {
            clientId: config.identity.twitchClientId,
            clientSecret: Redacted.make("client-secret"),
            signingSecret: Redacted.make(secret),
            callback: config.callback,
            redirect: config.redirect,
          },
          { api: base, oauth: base },
        ),
      ),
    );

    const account = yield* AccountService.pipe(
      Effect.provide(accountServiceLayer(config)),
    ).pipe(
      Effect.provideService(AccountStore, store),
      Effect.provideService(TwitchProvider, provider),
    );

    return { ...account, config, provider };
  });

  const authorize = Effect.fnUntraced(function* (
    account: Account,
    authorizations: SetupResult["authorizations"],
  ) {
    for (const grant of authorizations) {
      const params = new URL(grant.url).searchParams;
      yield* account.completeOAuth({
        state: params.get("state") ?? "",
        operator: "operator",
        code: JSON.stringify({
          user: Match.value(grant.login).pipe(
            Match.when("fixture_channel", () => "200"),
            Match.when("fixture_sender", () => control.senderId),
            Match.orElse(() => "101"),
          ),
          login: grant.login,
          scopes: params.get("scope")?.split(" ") ?? [],
        }),
      });
    }
  });

  const grants = Effect.fnUntraced(function* (account: Account) {
    yield* authorize(
      account,
      (yield* account.setup("operator")).authorizations,
    );
  });

  const send = (account: Account, attemptId: string) =>
    account.dispatch(
      Schema.decodeUnknownSync(Dispatch)({
        attemptId,
        broadcasterId: "200",
        replyParentId: "reply",
        text: "Sensors",
        deadline: Date.now() + 10_000,
      }),
    );

  return {
    base,
    control,
    store,
    construct,
    grants,
    authorize,
    send,
    snapshot: () => Schema.decodeUnknownSync(AccountState)(raw),
  };
});

export function responseGate() {
  return {
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  };
}

export const observation = (
  config: AccountConfig,
  id: string,
  status: string,
) => ({
  id,
  broadcasterId: Dispatch.fields.broadcasterId.make("200"),
  senderId: "100",
  binding: config.subscriptionBinding,
  callback: config.callback,
  status,
});
