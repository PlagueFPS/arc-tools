import { expect } from "bun:test";
import * as Test from "alchemy/Test/Bun";
import { Effect, Layer, Redacted, Schema } from "effect";
import { EnvironmentConfig } from "../src/config.js";
import { digest } from "../src/provider-http.js";
import { type AccountConfig, makeAccount } from "../src/twitch-account.js";
import { type Account, Dispatch } from "../src/twitch-contracts.js";
import {
  makeProvider,
  type Subscription,
  TwitchProvider,
} from "../src/twitch-provider.js";
import { AccountState, AccountStore, emptyState } from "../src/twitch-state.js";

const { test } = Test.make({ providers: Layer.empty });
const callback = "https://fixture.invalid/webhooks/twitch";
const identity = Schema.decodeUnknownSync(EnvironmentConfig)({
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
const fixture = Effect.fnUntraced(function* () {
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
  const noLateCreate = (): typeof CreateRequest.Type | null => null;
  const control = {
    remote: new Map<string, Subscription>(),
    secrets: new Map<string, string>(),
    calls: { get: 0, post: 0, delete: 0, conflict: 0, send: 0 },
    loseB: false,
    lateB: noLateCreate(),
  };
  const insert = (input: typeof CreateRequest.Type, id: string) => {
    const subscription: Subscription = {
      ...input,
      id,
      status: "enabled",
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
          data: url.searchParams
            .getAll("login")
            .map((login) => ({
              login,
              id:
                login === "fixture_channel"
                  ? "200"
                  : login === "fixture_sender"
                    ? "100"
                    : "101",
            })),
        });
      if (url.pathname === "/chat/messages") {
        control.calls.send++;
        return Response.json({ data: [{ is_sent: true, message_id: "sent" }] });
      }
      if (request.method === "GET") {
        control.calls.get++;
        return Response.json({ data: [...control.remote.values()] });
      }
      if (request.method === "DELETE") {
        control.calls.delete++;
        control.remote.delete(url.searchParams.get("id") ?? "");
        return new Response(null, { status: 204 });
      }
      control.calls.post++;
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
            sub.condition.broadcaster_user_id ===
              input.condition.broadcaster_user_id &&
            sub.condition.user_id === input.condition.user_id,
        )
      ) {
        control.calls.conflict++;
        return Response.json({}, { status: 409 });
      }
      const sub = insert(input, `created-${control.calls.post}`);
      return Response.json({ data: [sub] }, { status: 202 });
    },
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)));
  const base = `http://127.0.0.1:${server.port}`;
  const construct = Effect.fnUntraced(function* (
    secret: string,
    overrides: Partial<AccountConfig> = {},
  ) {
    const binding = yield* digest(
      JSON.stringify([callback, identity.twitchClientId, secret]),
    );
    const config: AccountConfig = {
      identity,
      callback,
      redirect: "https://fixture.invalid/oauth/twitch/callback",
      webhookReady: true,
      subscriptionBinding: binding,
      revision: secret,
      ...overrides,
    };
    const provider = makeProvider(
      {
        clientId: config.identity.twitchClientId,
        clientSecret: Redacted.make("client-secret"),
        signingSecret: Redacted.make(secret),
        callback: config.callback,
        redirect: config.redirect,
      },
      { api: base, oauth: base },
    );
    const account = yield* makeAccount(config).pipe(
      Effect.provideService(AccountStore, store),
      Effect.provideService(TwitchProvider, provider),
    );
    return { ...account, config, provider };
  });
  const grants = Effect.fnUntraced(function* (account: Account) {
    const setup = yield* account.setup("operator");
    for (const grant of setup.authorizations) {
      const params = new URL(grant.url).searchParams;
      yield* account.completeOAuth({
        state: params.get("state") ?? "",
        operator: "operator",
        code: JSON.stringify({
          user:
            grant.login === "fixture_channel"
              ? "200"
              : grant.login === "fixture_sender"
                ? "100"
                : "101",
          login: grant.login,
          scopes: params.get("scope")?.split(" ") ?? [],
        }),
      });
    }
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
    control,
    store,
    construct,
    grants,
    send,
    snapshot: () => Schema.decodeUnknownSync(AccountState)(raw),
  };
});

test(
  "late B creation and C conflict cannot claim C ownership; manual repair replaces B",
  Effect.gen(function* () {
    const f = yield* fixture();
    const b = yield* f.construct("secret-B");
    yield* f.grants(b.service);
    f.control.loseB = true;
    yield* b.service.setup("operator").pipe(Effect.exit);
    const c = yield* f.construct("secret-C");
    yield* f.grants(c.service);
    const conflict = yield* c.service.setup("operator");
    const afterConflict = {
      setup: conflict.status.setup,
      binding: f.snapshot().subscriptions["200"]?.binding ?? null,
      secret: f.control.secrets.get("late-B"),
      outcome: (yield* f.send(c.service, "after-conflict")).kind,
      ...f.control.calls,
    };
    yield* c.service.setup("operator");
    yield* c.service.setup("operator");
    expect(afterConflict).toEqual({
      setup: "pending",
      binding: null,
      secret: "secret-B",
      outcome: "rejected",
      get: 2,
      post: 2,
      delete: 0,
      conflict: 1,
      send: 0,
    });
    expect(
      [...f.control.remote.keys()].map((id) => f.control.secrets.get(id)),
    ).toEqual(["secret-C"]);
    expect(f.snapshot().subscriptions["200"]?.binding).toBe(
      c.config.subscriptionBinding,
    );
    expect(f.control.calls).toEqual({
      get: 4,
      post: 3,
      delete: 1,
      conflict: 1,
      send: 0,
    });
  }),
);

test(
  "completing rotated grants cannot make retained enabled A ready or dispatchable",
  Effect.gen(function* () {
    const f = yield* fixture();
    const a = yield* f.construct("secret-A");
    yield* f.grants(a.service);
    yield* a.service.setup("operator");
    const b = yield* f.construct("secret-B");
    yield* f.grants(b.service);
    const status = yield* b.service.status();
    const outcome = yield* f.send(b.service, "after-grants");
    expect({
      setup: status.setup,
      outcome: outcome.kind,
      sends: f.control.calls.send,
      remote: [...f.control.remote.keys()].map((id) =>
        f.control.secrets.get(id),
      ),
    }).toEqual({
      setup: "repair-required",
      outcome: "rejected",
      sends: 0,
      remote: ["secret-A"],
    });
  }),
);
