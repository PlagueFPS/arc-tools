/* oxlint-disable effecttsgo/async-function -- Native Bun, Node, and Web callbacks expose Promise contracts at this host boundary. */
import { expect } from "bun:test";

import { ArcData } from "@arctools/arc-data";
import {
  AttemptId,
  Deadline,
  type Account,
  Dispatch,
  ReplyId,
  TwitchAccount,
} from "@arctools/twitch/server";
import * as Test from "alchemy/Test/Bun";
import {
  Clock,
  Effect,
  Layer,
  Redacted,
  Schema,
  Array as EffectArray,
  Record as EffectRecord,
  String as EffectString,
} from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import {
  discordPublicKey,
  signTwitch,
  twitchEvent,
} from "../../../tests/cloud/signatures.js";
import { BotApi } from "../src/api.js";
import { ingressHandlers } from "../src/ingress.js";
import { operatorHandlers } from "../src/operator.js";
import { Tenants } from "../src/tenant-contracts.js";
import { TenantStore } from "../src/tenant-state.js";
import { makeTenant } from "../src/tenant.js";
import {
  fixture as accountFixture,
  callback,
  identity,
} from "./subscription-fixture.js";
import { tenantFixture } from "./tenant-fixture.js";

const { test } = Test.make({ providers: Layer.empty });

const text = "Sensors can be sold for 10 coins each";

const clockAt = (base: Clock.Clock, now: () => number): Clock.Clock => ({
  currentTimeMillis: Effect.sync(now),
  currentTimeMillisUnsafe: now,
  currentTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
  currentTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
  monotonicTimeNanos: base.monotonicTimeNanos,
  monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
  sleep: (duration) => base.sleep(duration),
});

const fixture = Effect.fnUntraced(function* (worker: number) {
  const baseClock = yield* Clock.Clock;
  const clocks = { tenant: 0, account: 0 };
  const tenantClock = clockAt(baseClock, () => clocks.tenant);
  const accountClock = clockAt(baseClock, () => clocks.account);
  const a = yield* accountFixture();

  const account = yield* a
    .construct("fixture-signing")
    .pipe(Effect.provideService(Clock.Clock, accountClock));

  yield* a
    .grants(account.service)
    .pipe(Effect.provideService(Clock.Clock, accountClock));
  expect(
    (yield* account.service
      .setup("operator")
      .pipe(Effect.provideService(Clock.Clock, accountClock))).status.setup,
  ).toBe("ready");
  const dispatches: Dispatch[] = [];

  const trustedAccount: Account = {
    ...account.service,
    status: account.service.status.pipe(
      Effect.provideService(Clock.Clock, accountClock),
    ),
    observeSubscription: (input) =>
      account.service
        .observeSubscription(input)
        .pipe(Effect.provideService(Clock.Clock, accountClock)),
    dispatch: (input) =>
      Effect.sync(() => dispatches.push(input)).pipe(
        Effect.andThen(account.service.dispatch(input)),
        Effect.provideService(Clock.Clock, accountClock),
      ),
  };

  const f = yield* tenantFixture();

  const tenant = yield* makeTenant({
    activation: "clock-contract",
    launch: (effect) =>
      Effect.sync(() => {
        f.launches.push(
          effect.pipe(Effect.provideService(Clock.Clock, tenantClock)),
        );
      }),
  }).pipe(
    Effect.provideService(TenantStore, f.store),
    Effect.provideService(ArcData, f.source.data),
    Effect.provideService(TwitchAccount, trustedAccount),
  );

  const tenants = Tenants.of({
    acceptTwitch: (receipt) =>
      tenant
        .acceptTwitch(receipt)
        .pipe(Effect.provideService(Clock.Clock, tenantClock)),
    respondDiscord: (receipt) =>
      tenant
        .respondDiscord(receipt)
        .pipe(Effect.provideService(Clock.Clock, tenantClock)),
  });

  const request = Effect.fnUntraced(function* (
    receivedAt = worker,
    subscriptionId = "created-1",
  ) {
    const handlers = HttpApiBuilder.layer(BotApi).pipe(
      Layer.provide(
        HttpApiBuilder.group(BotApi, "health", (handlers) =>
          handlers.handle("health", () =>
            Effect.succeed({
              status: "ready",
              stage: identity.stage,
              revision: "clock-contract",
              manifestHash: "fixture",
            }),
          ),
        ),
      ),
      Layer.provide(
        operatorHandlers(identity.stage, Redacted.make("operator")),
      ),
      Layer.provide(
        ingressHandlers({
          identity,
          twitchSigningSecret: Redacted.make("fixture-signing"),
          discordPublicKey,
          callback,
          receivedAt,
        }),
      ),
      Layer.provide(Layer.succeed(TwitchAccount, trustedAccount)),
      Layer.provide(Layer.succeed(Tenants, tenants)),
      Layer.provide(HttpServer.layerServices),
    );

    const app = HttpRouter.toWebHandler(handlers, { disableLogger: true });
    const event = twitchEvent("original-parent", "!sell sensors", callback);

    const body = new TextEncoder().encode(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        ...event,
        subscription: { ...event.subscription, id: subscriptionId },
      }).pipe(Effect.orDie),
    );

    const headers = yield* signTwitch(body, "notification", receivedAt);

    return yield* Effect.acquireUseRelease(
      Effect.succeed(app),
      (app) =>
        Effect.promise(() =>
          app.handler(new Request(callback, { method: "POST", body, headers })),
        ),
      (app) => Effect.promise(() => app.dispose()),
    );
  });

  const bodies: unknown[] = [];
  a.control.responses.set("POST /chat/messages", async (request) => {
    bodies.push(await request.json());

    return Response.json({
      data: [{ is_sent: true, message_id: "clock-sent" }],
    });
  });

  return {
    a,
    f,
    clocks,
    request,
    dispatches,
    bodies,
    dispatch: trustedAccount.dispatch,
    recover: () =>
      tenant.recover().pipe(Effect.provideService(Clock.Clock, tenantClock)),
    work: () => EffectRecord.values(f.snapshot().works)[0],
    posts: () =>
      EffectArray.filter(
        a.control.requests,
        (r) => !!(r.method === "POST" && r.path === "/chat/messages"),
      ).length,
  };
});

for (const [worker, tenant, account] of [
  [0, 0, 0],
  [1, 0, 0],
  [20, 0, 0],
  [20, 0, 20],
  [20, 40, 20],
  [20, 20, 0],
  [20, 20, 40],
] as const)
  test(
    `signed Twitch sends once with Worker/Tenant/account clocks ${worker}/${tenant}/${account}`,
    Effect.gen(function* () {
      const h = yield* fixture(worker);
      Object.assign(h.clocks, { tenant, account });
      expect((yield* h.request()).status).toBe(204);
      expect(h.work()).toMatchObject({
        kind: "computing",
        receivedAt: worker,
        deadline: worker + 10000,
      });
      yield* h.f.drain;

      const observed = {
        work: h.work(),
        posts: h.posts(),
        ledger: EffectRecord.values(h.a.snapshot().attempts),
      };

      h.clocks.tenant += 100;
      h.clocks.account += 100;
      expect((yield* h.request(worker + 100)).status).toBe(204);
      yield* h.f.drain;
      yield* h.recover();
      expect(h.work()).toEqual(observed.work);
      expect(h.posts()).toBe(observed.posts);
      expect(h.dispatches).toHaveLength(1);
      expect(observed).toMatchObject({
        work: {
          kind: "terminal",
          outcome: "sent",
          receivedAt: worker,
          deadline: worker + 10000,
        },
        posts: 1,
        ledger: [
          {
            kind: "terminal",
            deadline: worker + 10000,
            outcome: { kind: "sent", messageId: "clock-sent" },
          },
        ],
      });
      expect(h.bodies).toEqual([
        {
          broadcaster_id: "200",
          sender_id: "100",
          message: text,
          reply_parent_message_id: "original-parent",
          for_source_only: true,
        },
      ]);
      expect(h.dispatches).toEqual([
        yield* Schema.decodeUnknownEffect(Dispatch)({
          attemptId: `${h.work()?.id}:0`,
          broadcasterId: "200",
          source: h.dispatches[0]?.source,
          replyParentId: "original-parent",
          text,
          deadline: worker + 10000,
        }),
      ]);
      expect(h.f.source.calls).toHaveLength(1);
      expect(h.f.alarm()).toBe(worker + 610000);
    }).pipe(Effect.scoped),
  );

for (const at of [10020, 10021])
  test(
    `signed Twitch admission rejects the original cutoff at Tenant time ${at}`,
    Effect.gen(function* () {
      const h = yield* fixture(20);
      h.clocks.tenant = at;
      expect((yield* h.request()).status).toBe(503);
      expect(h.work()).toBeUndefined();
      expect(h.posts()).toBe(0);
      expect(h.f.source.calls).toHaveLength(0);
      expect(h.a.snapshot().attempts).toEqual({});
    }).pipe(Effect.scoped),
  );

for (const at of [10020, 10021])
  for (const actor of ["tenant", "account"] as const)
    test(
      `signed Twitch starts no POST when ${actor} reaches original cutoff at ${at}`,
      Effect.gen(function* () {
        const h = yield* fixture(20);
        expect((yield* h.request()).status).toBe(204);
        h.clocks[actor] = at;
        yield* h.f.drain;
        expect(h.work()).toMatchObject({
          kind: "terminal",
          outcome: "expired",
          receivedAt: 20,
          deadline: 10020,
        });
        expect(h.posts()).toBe(0);
        expect(h.bodies).toEqual([]);
        expect((yield* h.request(120)).status).toBe(204);
        yield* h.recover();
        expect(h.posts()).toBe(0);
        expect(h.work()?.deadline).toBe(Deadline.make(10020));
      }).pipe(Effect.scoped),
    );

test(
  "signed Twitch safe HTTP retry preserves the frozen payload and cutoff across separate clocks",
  Effect.gen(function* () {
    const h = yield* fixture(20);
    h.clocks.tenant = 40;
    h.a.control.responses.set("POST /chat/messages", async (request) => {
      h.bodies.push(await request.json());

      return h.bodies.length === 1
        ? Response.json({}, { status: 429 })
        : Response.json({
            data: [{ is_sent: true, message_id: "retry-sent" }],
          });
    });
    expect((yield* h.request()).status).toBe(204);
    yield* h.f.drain;
    expect(h.work()).toMatchObject({
      kind: "ready",
      receivedAt: 20,
      deadline: 10020,
      retryAt: 1000,
    });
    expect(h.posts()).toBe(1);
    const frozen = h.dispatches[0];

    if (!frozen) return yield* Effect.die("Missing signed Twitch dispatch");
    expect(EffectRecord.values(h.a.snapshot().attempts)).toMatchObject([
      { kind: "waiting", deadline: 10020, retryAt: 1000 },
    ]);
    expect((yield* h.request(120)).status).toBe(204);
    yield* h.f.drain;
    expect(h.posts()).toBe(1);
    h.clocks.tenant = 1020;
    h.clocks.account = 1000;
    yield* h.recover();
    expect(h.work()).toMatchObject({
      kind: "terminal",
      outcome: "sent",
      receivedAt: 20,
      deadline: 10020,
    });
    expect(h.posts()).toBe(2);
    expect(h.dispatches).toEqual([frozen, frozen]);
    expect(h.bodies[1]).toEqual(h.bodies[0]);
    expect(EffectRecord.values(h.a.snapshot().attempts)).toMatchObject([
      { kind: "terminal", deadline: 10020, outcome: { kind: "sent" } },
    ]);
    expect((yield* h.request(220)).status).toBe(204);
    yield* h.recover();
    expect(h.posts()).toBe(2);
  }).pipe(Effect.scoped),
);

test(
  "signed Twitch still rejects an account configuration mismatch before POST",
  Effect.gen(function* () {
    const h = yield* fixture(20);
    expect((yield* h.request()).status).toBe(204);
    yield* h.a.store.update((state) => {
      state.revision = "other-revision";
    });
    yield* h.f.drain;
    expect(h.work()).toMatchObject({
      kind: "terminal",
      outcome: "rejected",
      receivedAt: 20,
      deadline: 10020,
    });
    expect(h.posts()).toBe(0);
    expect(h.a.snapshot().attempts).toEqual({});
  }).pipe(Effect.scoped),
);

test(
  "account input validation and frozen-attempt fingerprint survive signed Twitch dispatch",
  Effect.gen(function* () {
    const h = yield* fixture(0);
    expect((yield* h.request()).status).toBe(204);
    yield* h.f.drain;
    const input = h.dispatches[0];

    if (!input) return yield* Effect.die("Missing signed Twitch dispatch");
    expect(yield* h.dispatch(input)).toEqual({
      kind: "sent",
      messageId: "clock-sent",
    });

    for (const change of [
      { text: "changed" },
      { replyParentId: ReplyId.make("different-parent") },
      { deadline: Deadline.make(10001) },
    ])
      expect(yield* h.dispatch({ ...input, ...change })).toEqual({
        kind: "rejected",
      });

    for (const invalid of [
      { ...input, text: "" },
      { ...input, text: EffectString.repeat(501)("x") },
      { ...input, attemptId: AttemptId.make(EffectString.repeat(161)("x")) },
    ])
      expect((yield* h.dispatch(invalid).pipe(Effect.flip)).code).toBe("input");
    expect(h.posts()).toBe(1);
    expect(h.work()).toMatchObject({
      kind: "terminal",
      outcome: "sent",
      receivedAt: 0,
      deadline: 10000,
    });
    expect(EffectRecord.values(h.a.snapshot().attempts)).toHaveLength(1);
  }).pipe(Effect.scoped),
);

test(
  "signed unknown and retired subscription IDs allocate no Tenant before exact enabled replacement proof",
  Effect.gen(function* () {
    const h = yield* fixture(0);
    expect((yield* h.request(0, "unowned-subscription")).status).toBe(204);
    expect(h.work()).toBeUndefined();
    expect(h.f.source.calls).toHaveLength(0);
    const record = h.a.snapshot().subscriptions["200"];
    const life = h.a.snapshot().lifecycle["200"];

    if (!record) return yield* Effect.die("Missing original proof");
    const account = yield* h.a.construct("fixture-signing");
    yield* account.service.observeSubscription({
      ...record,
      broadcasterId: Dispatch.fields.broadcasterId.make("200"),
      status: "chat_user_banned",
    });
    expect((yield* account.service.setup("operator")).status.setup).toBe(
      "ready",
    );
    expect(h.a.snapshot().lifecycle["200"]).toMatchObject({
      kind: "installed",
      id: life?.kind === "installed" ? life.id : "missing",
    });
    expect((yield* h.request()).status).toBe(204);
    expect(h.work()).toBeUndefined();
    expect(h.f.source.calls).toHaveLength(0);
    const replacement = h.a.snapshot().subscriptions["200"];

    if (!replacement) return yield* Effect.die("Missing replacement proof");
    expect((yield* h.request(0, replacement.id)).status).toBe(204);
    yield* h.f.drain;
    expect(h.work()).toMatchObject({
      kind: "terminal",
      outcome: "sent",
      source: { subscriptionId: replacement.id },
    });
    expect(h.posts()).toBe(1);
  }).pipe(Effect.scoped),
);
