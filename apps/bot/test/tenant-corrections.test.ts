import { expect } from "bun:test";

import * as Test from "alchemy/Test/Bun";
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";

import { AttemptId, Deadline } from "../src/contracts.js";
import { discordResponse, friendlyFailure } from "../src/presentation.js";
import {
  fixture as accountFixture,
  responseGate,
} from "./subscription-fixture.js";
import {
  discordReceipt,
  tenantFixture,
  twitchReceipt,
} from "./tenant-fixture.js";

const { test: effectTest } = Test.make({ providers: Layer.empty });
const test = <E>(name: string, effect: Effect.Effect<void, E>) =>
  effectTest(name, effect.pipe(Effect.provide(TestClock.layer())));

for (const [activation, at] of [
  ["new", 0],
  ["first", 5000],
  ["first", 602999],
] as const)
  test(
    `fresh Discord admission reconciles eight abandoned claims at ${at} in ${activation} activation`,
    Effect.gen(function* () {
      const f = yield* tenantFixture();
      for (let i = 0; i < 8; i++) {
        const entered = yield* Deferred.make<void>();
        const tenant = yield* f.construct("first", {
          ...f.source.data,
          items: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
            ),
        });
        const running = yield* tenant
          .respondDiscord(discordReceipt(`old-${i}`))
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(running);
      }
      const before = f.snapshot();
      expect(f.alarm()).toBeNull();
      yield* TestClock.setTime(at);
      const tenant = yield* f.construct(activation);
      expect(yield* tenant.respondDiscord(discordReceipt("fresh", at))).toEqual(
        discordResponse("Sensors can be sold for 10 coins each"),
      );
      for (let i = 0; i < 8; i++) {
        const id = `old-${i}`;
        expect(f.snapshot().works[id]).toMatchObject({
          fingerprint: before.works[id]?.fingerprint,
          receivedAt: 0,
          deadline: 3000,
          retainUntil: 603000,
          kind: "terminal",
          response: discordResponse(friendlyFailure, true),
        });
        expect(yield* tenant.respondDiscord(discordReceipt(id, at))).toEqual(
          discordResponse(friendlyFailure, true),
        );
        expect(f.snapshot().works[id]?.retainUntil).toBe(603000);
      }
      expect(Object.keys(f.snapshot().works)).toHaveLength(9);
      expect(f.alarm()).toBeNull();
    }),
  );

test(
  "live unexpired Discord claims keep their capacity and complete without admission cancelling them",
  Effect.gen(function* () {
    const f = yield* tenantFixture();
    const release = yield* Deferred.make<void>();
    const running = [];
    for (let i = 0; i < 8; i++) {
      const entered = yield* Deferred.make<void>();
      const tenant = yield* f.construct("first", {
        ...f.source.data,
        items: (params) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(f.source.data.items(params)),
          ),
      });
      running.push(
        yield* tenant
          .respondDiscord(discordReceipt(`live-${i}`))
          .pipe(Effect.forkChild),
      );
      yield* Deferred.await(entered);
    }
    const tenant = yield* f.construct();
    expect(
      yield* tenant
        .respondDiscord(discordReceipt("overflow"))
        .pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure", failure: { code: "capacity" } });
    expect(
      Object.values(f.snapshot().works).every(
        (work) => work.kind === "computing",
      ),
    ).toBeTrue();
    yield* Deferred.succeed(release, undefined);
    for (const fiber of running)
      expect((yield* Fiber.join(fiber)).data.flags).toBe(0);
  }),
);

for (const retryAt of [100, 200])
  test(
    `safe Twitch retry requested at ${retryAt} and returned at 200 stays useful with the exact frozen attempt`,
    Effect.gen(function* () {
      const f = yield* tenantFixture();
      const tenant = yield* f.construct();
      f.dispatch((input) =>
        Effect.gen(function* () {
          f.sent.push(input);
          yield* TestClock.setTime(200);
          return {
            kind: "retryable",
            retryAt: Deadline.make(retryAt),
          } as const;
        }),
      );
      yield* tenant.acceptTwitch(twitchReceipt());
      yield* f.drain;
      expect(f.snapshot().works.work).toMatchObject({
        kind: "ready",
        deadline: 10000,
        retryAt: 200,
      });
      expect(f.alarm()).toBe(200);
      f.dispatch((input) =>
        Effect.sync(() => {
          f.sent.push(input);
          return { kind: "sent", messageId: "sent" };
        }),
      );
      yield* tenant.recover();
      expect(f.sent).toHaveLength(2);
      expect(f.sent[1]).toEqual(f.sent[0]);
      expect(f.snapshot().works.work).toMatchObject({
        kind: "terminal",
        outcome: "sent",
      });
    }),
  );

for (const [retryAt, completed] of [
  [10000, 200],
  [100, 10000],
] as const)
  test(
    `retry cutoff equality expires at requested ${retryAt} completed ${completed}`,
    Effect.gen(function* () {
      const f = yield* tenantFixture();
      const tenant = yield* f.construct();
      f.dispatch((input) =>
        Effect.gen(function* () {
          f.sent.push(input);
          yield* TestClock.setTime(completed);
          return {
            kind: "retryable",
            retryAt: Deadline.make(retryAt),
          } as const;
        }),
      );
      yield* tenant.acceptTwitch(twitchReceipt());
      yield* f.drain;
      yield* tenant.recover();
      expect(f.sent).toHaveLength(1);
      expect(f.snapshot().works.work).toMatchObject({
        kind: "terminal",
        outcome: "expired",
        deadline: 10000,
      });
      expect(f.alarm()).toBeNull();
    }),
  );

test(
  "a live accepted account POST crossing the delivery lease does not become ambiguous or stop later parts",
  Effect.gen(function* () {
    const start = Date.now();
    yield* TestClock.setTime(start);
    const a = yield* accountFixture();
    const account = yield* a.construct("secret");
    yield* a.grants(account.service);
    yield* account.service.setup("operator");
    const gate = responseGate();
    yield* Effect.addFinalizer(() => Effect.sync(() => gate.release.resolve()));
    const bodies: unknown[] = [];
    a.control.responses.set("POST /chat/messages", async (request) => {
      bodies.push(await request.json());
      if (bodies.length === 1) {
        gate.entered.resolve();
        await gate.release.promise;
      }
      return Response.json({
        data: [{ is_sent: true, message_id: `part-${bodies.length}` }],
      });
    });
    const f = yield* tenantFixture();
    f.source.body({
      data: [{ id: "sensors", name: "x".repeat(650), value: 10 }],
    });
    f.dispatch((input) =>
      Effect.sync(() => {
        f.sent.push(input);
      }).pipe(Effect.andThen(account.service.dispatch(input))),
    );
    const tenant = yield* f.construct();
    yield* tenant.acceptTwitch(twitchReceipt("slow-send", start));
    const running = yield* f.drain.pipe(Effect.forkChild);
    yield* Effect.promise(() => gate.entered.promise);
    yield* TestClock.adjust(1500);
    const recovery = yield* tenant.recover().pipe(Effect.forkChild);
    yield* TestClock.adjust(0);
    expect(a.snapshot().attempts["slow-send:0"]?.kind).toBe("sending");
    expect(f.snapshot().works["slow-send"]?.kind).toBe("delivering");
    expect(f.sent).toHaveLength(1);
    gate.release.resolve();
    yield* Fiber.join(running);
    yield* Fiber.join(recovery);
    expect(f.snapshot().works["slow-send"]).toMatchObject({
      kind: "terminal",
      outcome: "sent",
      deadline: start + 10000,
    });
    expect(bodies).toHaveLength(2);
    expect(f.sent.map((send) => send.attemptId)).toEqual([
      AttemptId.make("slow-send:0"),
      AttemptId.make("slow-send:1"),
    ]);
    expect(f.alarm()).toBeNull();
  }).pipe(Effect.scoped),
);

for (const transport of ["discord", "twitch"] as const)
  test(
    `unexpected ${transport} command defect stores a friendly terminal result and frees capacity`,
    Effect.gen(function* () {
      const f = yield* tenantFixture();
      const tenant = yield* f.construct("first", {
        ...f.source.data,
        items: () => Effect.die("CANARY-RAW-CAUSE"),
      });
      if (transport === "discord") {
        expect(yield* tenant.respondDiscord(discordReceipt())).toEqual(
          discordResponse(friendlyFailure, true),
        );
      } else {
        yield* tenant.acceptTwitch(twitchReceipt());
        yield* f.drain;
        expect(f.sent.map((send) => send.text)).toEqual([friendlyFailure]);
      }
      expect(f.snapshot().works.work?.kind).toBe("terminal");
      expect(JSON.stringify(f.snapshot())).not.toContain("CANARY");
      const next = yield* f.construct();
      if (transport === "discord")
        expect(
          (yield* next.respondDiscord(discordReceipt("fresh"))).data.flags,
        ).toBe(0);
      else {
        yield* next.acceptTwitch(twitchReceipt("fresh"));
        yield* f.drain;
        expect(f.sent).toHaveLength(2);
      }
      expect(f.alarm()).toBeNull();
    }),
  );

test(
  "more than four due Twitch items progress in bounded batches and leave no idle alarm",
  Effect.gen(function* () {
    const f = yield* tenantFixture();
    const first = yield* f.construct();
    for (let i = 0; i < 8; i++)
      yield* first.acceptTwitch(twitchReceipt(`batch-${i}`));
    const restored = yield* f.construct("new");
    yield* restored.recover();
    expect(f.sent).toHaveLength(4);
    expect(f.alarm()).not.toBeNull();
    yield* restored.recover();
    expect(f.sent).toHaveLength(8);
    expect(
      Object.values(f.snapshot().works).every(
        (work) => work.kind === "terminal",
      ),
    ).toBeTrue();
    expect(f.alarm()).toBeNull();
    yield* restored.recover();
    expect(f.sent).toHaveLength(8);
    expect(f.alarm()).toBeNull();
  }),
);

test(
  "cancelling command execution does not commit a result or resurrect it after reconstruction",
  Effect.gen(function* () {
    const f = yield* tenantFixture();
    const entered = yield* Deferred.make<void>();
    const tenant = yield* f.construct("first", {
      ...f.source.data,
      items: () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    const running = yield* tenant
      .respondDiscord(discordReceipt())
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(running);
    expect(f.snapshot().works.work?.kind).toBe("computing");
    const next = yield* f.construct("next");
    expect(yield* next.respondDiscord(discordReceipt())).toEqual(
      discordResponse(friendlyFailure, true),
    );
    expect(f.snapshot().works.work).toMatchObject({
      kind: "terminal",
      deadline: 3000,
      retainUntil: 603000,
    });
    expect(f.source.calls).toHaveLength(0);
  }),
);

test(
  "a late computation returns the terminal timeout that won the transaction",
  Effect.gen(function* () {
    const f = yield* tenantFixture();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const tenant = yield* f.construct("first", {
      ...f.source.data,
      items: (params) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(f.source.data.items(params)),
          Effect.uninterruptible,
        ),
    });
    const original = yield* tenant
      .respondDiscord(discordReceipt())
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust(2350);
    const timeout = yield* tenant.respondDiscord(discordReceipt());
    expect(timeout).toEqual(discordResponse(friendlyFailure, true));
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(original)).toEqual(timeout);
    expect(f.snapshot().works.work).toMatchObject({
      kind: "terminal",
      response: timeout,
      deadline: 3000,
    });
  }),
);

test(
  "storage and dispatch defects remain observable outside the command boundary",
  Effect.gen(function* () {
    const f = yield* tenantFixture();
    let writes = 0;
    const storage = {
      read: f.store.read,
      update: <A>(change: Parameters<typeof f.store.update<A>>[0]) =>
        Effect.suspend(() =>
          ++writes === 2
            ? Effect.die("STORAGE-DEFECT")
            : f.store.update(change),
        ),
    };
    const discord = yield* f.construct("first", f.source.data, storage);
    const brokenWrite = yield* discord
      .respondDiscord(discordReceipt())
      .pipe(Effect.exit);
    expect(
      Exit.isFailure(brokenWrite) && Cause.hasDies(brokenWrite.cause),
    ).toBeTrue();
    expect(f.snapshot().works.work?.kind).toBe("computing");
    const t = yield* tenantFixture();
    t.dispatch(() => Effect.die("DISPATCH-DEFECT"));
    const twitch = yield* t.construct();
    yield* twitch.acceptTwitch(twitchReceipt());
    const brokenDispatch = yield* t.drain.pipe(Effect.exit);
    expect(
      Exit.isFailure(brokenDispatch) && Cause.hasDies(brokenDispatch.cause),
    ).toBeTrue();
    expect(t.snapshot().works.work?.kind).toBe("delivering");
  }),
);

test(
  "an actual safe HTTP rate rejection whose RPC completion is late retries the same payload once",
  Effect.gen(function* () {
    const start = Date.now();
    yield* TestClock.setTime(start);
    const a = yield* accountFixture();
    const account = yield* a.construct("secret");
    yield* a.grants(account.service);
    yield* account.service.setup("operator");
    const bodies: unknown[] = [];
    a.control.responses.set("POST /chat/messages", async (request) => {
      bodies.push(await request.json());
      return bodies.length === 1
        ? Response.json({}, { status: 429 })
        : Response.json({
            data: [{ is_sent: true, message_id: "safe-success" }],
          });
    });
    const f = yield* tenantFixture();
    f.dispatch((input) =>
      Effect.gen(function* () {
        f.sent.push(input);
        const outcome = yield* account.service.dispatch(input);
        if (outcome.kind === "retryable")
          yield* TestClock.setTime(start + 1500);
        return outcome;
      }),
    );
    const tenant = yield* f.construct();
    yield* tenant.acceptTwitch(twitchReceipt("late-safe", start));
    yield* f.drain;
    expect(f.snapshot().works["late-safe"]).toMatchObject({
      kind: "ready",
      retryAt: start + 1500,
      deadline: start + 10000,
    });
    expect(bodies).toHaveLength(1);
    yield* tenant.recover();
    expect(f.snapshot().works["late-safe"]).toMatchObject({
      kind: "terminal",
      outcome: "sent",
    });
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toEqual(f.sent[0]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    yield* tenant.recover();
    expect(bodies).toHaveLength(2);
  }).pipe(Effect.scoped),
);
