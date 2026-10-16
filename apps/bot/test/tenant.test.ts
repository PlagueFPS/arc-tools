import { describe, expect } from "bun:test";
import { makeFixture } from "@arctools/arc-data/testing";
import * as Test from "alchemy/Test/Bun";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { AttemptId, Deadline, WorkId } from "../src/contracts.js";
import {
  discordResponse,
  encodedBytes,
  friendlyFailure,
} from "../src/presentation.js";
import { fits, tenantPolicy } from "../src/tenant-state.js";
import { AccountError } from "../src/twitch-contracts.js";
import {
  discordReceipt,
  tenantFixture,
  twitchReceipt,
} from "./tenant-fixture.js";

const { test: effectTest } = Test.make({ providers: Layer.empty });
const test = <E>(name: string, effect: Effect.Effect<void, E>) =>
  effectTest(name, effect.pipe(Effect.provide(TestClock.layer())));

describe("Tenant durable behavior", () => {
  test(
    "admission persists the original deadline, useful alarm and claim before launch; duplicates cannot change them",
    Effect.gen(function* () {
      const fixture = yield* tenantFixture();
      const tenant = yield* fixture.construct();
      expect(yield* tenant.acceptTwitch(twitchReceipt())).toEqual({
        kind: "accepted",
      });
      expect(fixture.alarm()).toBe(4000);
      expect(fixture.snapshot().works.work).toMatchObject({
        kind: "computing",
        deadline: 10000,
        claim: { activation: "first", until: 4000 },
      });
      yield* TestClock.setTime(500);
      expect(yield* tenant.acceptTwitch(twitchReceipt("work", 500))).toEqual({
        kind: "duplicate",
      });
      expect(fixture.snapshot().works.work?.deadline).toBe(
        Deadline.make(10000),
      );
      expect(fixture.launches).toHaveLength(1);
      const conflict = yield* tenant
        .acceptTwitch({ ...twitchReceipt(), fingerprint: "b".repeat(64) })
        .pipe(Effect.result);
      expect(conflict).toMatchObject({
        _tag: "Failure",
        failure: { code: "conflict" },
      });
      yield* fixture.drain;
      expect(fixture.sent).toHaveLength(1);
      expect(fixture.sent[0]).toMatchObject({
        attemptId: "work:0",
        text: "ARC: Sensors can be sold for 10 coins each",
        deadline: 10000,
        replyParentId: "parent",
      });
      expect(fixture.snapshot().works.work).toEqual({
        transport: "twitch",
        id: WorkId.make("work"),
        fingerprint: "a".repeat(64),
        receivedAt: 0,
        deadline: Deadline.make(10000),
        retainUntil: 610000,
        kind: "terminal",
        outcome: "sent",
      });
      expect(fixture.alarm()).toBeNull();
    }),
  );
  test(
    "reconstruction recomputes interrupted work with a fresh generation and suppresses stale completion",
    Effect.gen(function* () {
      const fixture = yield* tenantFixture();
      const old = yield* fixture.construct();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      fixture.source.respond(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return Response.json({
            data: [{ id: "sensors", name: "Old", value: 1 }],
          });
        }),
      );
      yield* old.acceptTwitch(twitchReceipt());
      const running = yield* fixture.drain.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const fresh = yield* makeFixture();
      fresh.body({ data: [{ id: "sensors", name: "New", value: 20 }] });
      const next = yield* fixture.construct("second", fresh.data);
      yield* next.recover();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);
      expect(fixture.sent.map((send) => send.text)).toEqual([
        "ARC: New can be sold for 20 coins each",
      ]);
      expect(fixture.snapshot().generation).toBe(3);
      expect(fixture.alarm()).toBeNull();
    }),
  );
  test(
    "unknown account RPC completion recovers the exact same attempt and frozen plan",
    Effect.gen(function* () {
      const fixture = yield* tenantFixture();
      const first = yield* fixture.construct();
      let calls = 0;
      fixture.dispatch((input) =>
        Effect.gen(function* () {
          fixture.sent.push(input);
          calls++;
          if (calls === 1) return yield* new AccountError({ code: "provider" });
          return { kind: "sent", messageId: "same" } as const;
        }),
      );
      yield* first.acceptTwitch(twitchReceipt());
      yield* fixture.drain;
      expect(fixture.snapshot().works.work?.kind).toBe("delivering");
      expect(fixture.alarm()).toBe(250);
      const second = yield* fixture.construct("second");
      yield* second.recover();
      expect(fixture.sent).toHaveLength(2);
      expect(fixture.sent[1]).toEqual(fixture.sent[0]);
      expect(fixture.snapshot().works.work).toMatchObject({
        kind: "terminal",
        outcome: "sent",
      });
    }),
  );
  test(
    "safe rate retries use the original cutoff and native wake time; expiry never starts another send",
    Effect.gen(function* () {
      const fixture = yield* tenantFixture();
      const tenant = yield* fixture.construct();
      fixture.dispatch((input) =>
        Effect.sync(() => {
          fixture.sent.push(input);
          return { kind: "retryable", retryAt: Deadline.make(9000) };
        }),
      );
      yield* tenant.acceptTwitch(twitchReceipt());
      yield* fixture.drain;
      expect(fixture.alarm()).toBe(9000);
      yield* TestClock.setTime(8999);
      yield* tenant.recover();
      expect(fixture.sent).toHaveLength(1);
      yield* TestClock.setTime(10000);
      yield* tenant.recover();
      expect(fixture.sent).toHaveLength(1);
      expect(fixture.snapshot().works.work).toMatchObject({
        kind: "terminal",
        outcome: "expired",
        deadline: 10000,
      });
      expect(fixture.alarm()).toBeNull();
    }),
  );
  for (const kind of ["ambiguous", "rejected", "expired"] as const)
    test(
      `${kind} first part stops the remaining frozen parts`,
      Effect.gen(function* () {
        const fixture = yield* tenantFixture();
        const tenant = yield* fixture.construct();
        fixture.source.body({
          data: [{ id: "sensors", name: "x".repeat(1200), value: 10 }],
        });
        fixture.dispatch((input) =>
          Effect.sync(() => {
            fixture.sent.push(input);
            return { kind };
          }),
        );
        yield* tenant.acceptTwitch(twitchReceipt());
        yield* fixture.drain;
        expect(fixture.sent).toHaveLength(1);
        expect(fixture.sent[0]?.text.startsWith("ARC [1/3]: ")).toBeTrue();
        expect(fixture.snapshot().works.work).toMatchObject({
          kind: "terminal",
          outcome: kind,
        });
        expect(JSON.stringify(fixture.snapshot())).not.toContain("parent");
      }),
    );
  test(
    "eight active reservations reject overload without evicting a live replay record",
    Effect.gen(function* () {
      const fixture = yield* tenantFixture();
      const tenant = yield* fixture.construct();
      for (let n = 0; n < 8; n++)
        yield* tenant.acceptTwitch(twitchReceipt(`work-${n}`));
      expect(
        yield* tenant
          .acceptTwitch(twitchReceipt("overflow"))
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { code: "capacity" } });
      expect(Object.keys(fixture.snapshot().works)).toHaveLength(8);
      expect(fits(fixture.snapshot())).toBeTrue();
      expect(
        encodedBytes(fixture.snapshot()) + 8 * tenantPolicy.reservation,
      ).toBeLessThanOrEqual(tenantPolicy.bytes);
    }),
  );
  test(
    "64 live replay tombstones reject new work and expired tombstones alone can be reclaimed",
    Effect.gen(function* () {
      const fixture = yield* tenantFixture();
      const tenant = yield* fixture.construct();
      for (let n = 0; n < 64; n++)
        yield* tenant.respondDiscord(discordReceipt(`work-${n}`));
      expect(
        yield* tenant
          .respondDiscord(discordReceipt("overflow"))
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { code: "capacity" } });
      expect(
        (yield* tenant.respondDiscord(discordReceipt("work-0"))).data.content,
      ).toBe("Sensors can be sold for 10 coins each");
      yield* TestClock.setTime(603000);
      expect(
        (yield* tenant.respondDiscord(discordReceipt("new", 603000))).data
          .flags,
      ).toBe(0);
      expect(Object.keys(fixture.snapshot().works)).toEqual(["new"]);
      expect(fixture.alarm()).toBeNull();
    }),
  );
  test(
    "a healthy duplicate waits beyond 500ms and returns the committed public response",
    Effect.gen(function* () {
      const fixture = yield* tenantFixture();
      const tenant = yield* fixture.construct();
      const entered = yield* Deferred.make<void>();
      fixture.source.respond(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.sleep(1200)),
          Effect.as(
            Response.json({
              data: [{ id: "sensors", name: "Sensors", value: 10 }],
            }),
          ),
        ),
      );
      const first = yield* tenant
        .respondDiscord(discordReceipt())
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const duplicate = yield* tenant
        .respondDiscord(discordReceipt())
        .pipe(Effect.forkChild);
      yield* TestClock.adjust(600);
      expect(fixture.snapshot().works.work?.kind).toBe("computing");
      yield* TestClock.adjust(600);
      const result = yield* Fiber.join(first);
      yield* TestClock.adjust(25);
      expect(yield* Fiber.join(duplicate)).toEqual(result);
      expect(result.data.flags).toBe(0);
      expect(fixture.source.calls).toHaveLength(1);
    }),
  );
  test(
    "Discord reconstruction commits private interruption and stale completion cannot replace it",
    Effect.gen(function* () {
      const fixture = yield* tenantFixture();
      const tenant = yield* fixture.construct();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      fixture.source.respond(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(
            Response.json({
              data: [{ id: "sensors", name: "Sensors", value: 10 }],
            }),
          ),
        ),
      );
      const original = yield* tenant
        .respondDiscord(discordReceipt())
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const reconstructed = yield* fixture.construct("new");
      const interrupted = yield* reconstructed.respondDiscord(
        discordReceipt("work", 100),
      );
      expect(interrupted).toEqual(discordResponse(friendlyFailure, true));
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(original)).toEqual(interrupted);
      expect(fixture.snapshot().works.work).toMatchObject({
        kind: "terminal",
        deadline: 3000,
      });
      expect(fixture.alarm()).toBeNull();
    }),
  );
  test(
    "Discord common timeout occurs only at the first compute cutoff and removes invocation data",
    Effect.gen(function* () {
      const fixture = yield* tenantFixture();
      const tenant = yield* fixture.construct("first", {
        ...fixture.source.data,
        items: () => Effect.never,
      });
      const first = yield* tenant
        .respondDiscord(discordReceipt())
        .pipe(Effect.forkChild);
      yield* TestClock.adjust(2350);
      expect(yield* Fiber.join(first)).toEqual(
        discordResponse(friendlyFailure, true),
      );
      expect(fixture.snapshot().works.work).toMatchObject({
        kind: "terminal",
        deadline: 3000,
      });
      expect(JSON.stringify(fixture.snapshot())).not.toContain("invocation");
    }),
  );
});

test(
  "an expired computation lease leaves useful original budget for a new generation",
  Effect.gen(function* () {
    const fixture = yield* tenantFixture();
    const entered = yield* Deferred.make<void>();
    const slow = yield* fixture.construct("first", {
      ...fixture.source.data,
      items: (params) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.sleep(4500)),
          Effect.andThen(fixture.source.data.items(params)),
        ),
    });
    yield* slow.acceptTwitch(twitchReceipt());
    const running = yield* fixture.drain.pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust(4500);
    yield* Fiber.join(running);
    expect(fixture.snapshot().works.work).toMatchObject({
      kind: "computing",
      deadline: 10000,
    });
    expect(fixture.sent).toHaveLength(0);
    expect(fixture.alarm()).toBe(4000);
    const recovered = yield* fixture.construct("second");
    yield* recovered.recover();
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]?.deadline).toBe(Deadline.make(10000));
    expect(fixture.sent[0]?.attemptId).toBe(AttemptId.make("work:0"));
  }),
);

test(
  "encoded bytes and outstanding reservations cap admission before 64 large Discord replay records",
  Effect.gen(function* () {
    const fixture = yield* tenantFixture();
    const tenant = yield* fixture.construct();
    fixture.source.body({
      data: [{ id: "sensors", name: "😀".repeat(900), value: 10 }],
    });
    let admitted = 0;
    for (let n = 0; n < 64; n++) {
      const result = yield* tenant
        .respondDiscord(discordReceipt(`large-${n}`))
        .pipe(Effect.result);
      if (result._tag === "Failure") {
        expect(result.failure.code).toBe("capacity");
        break;
      }
      expect(result.success.data.flags).toBe(0);
      admitted++;
    }
    expect(admitted).toBeGreaterThan(8);
    expect(admitted).toBeLessThan(64);
    expect(fits(fixture.snapshot())).toBeTrue();
    expect(encodedBytes(fixture.snapshot())).toBeLessThanOrEqual(
      tenantPolicy.bytes,
    );
    expect(
      (yield* tenant.respondDiscord(discordReceipt("large-0"))).data.flags,
    ).toBe(0);
    expect(Object.keys(fixture.snapshot().works)).toHaveLength(admitted);
  }),
);

test(
  "Tenant preserves stale metadata provenance and rejects fully expired metadata and schedules through the real cache",
  Effect.gen(function* () {
    const fixture = yield* tenantFixture();
    const tenant = yield* fixture.construct();
    yield* fixture.source.data.items({ id: "sensors", minimal: true });
    fixture.source.body({}, 503);
    yield* TestClock.setTime(86400000);
    expect(
      (yield* tenant.respondDiscord(discordReceipt("stale", 86400000))).data,
    ).toMatchObject({
      flags: 0,
      content: "Sensors can be sold for 10 coins each [Using cached data]",
    });
    yield* TestClock.setTime(604800001);
    expect(
      (yield* tenant.respondDiscord(discordReceipt("expired", 604800001))).data,
    ).toMatchObject({
      flags: 64,
      content:
        "Game data is temporarily unavailable. Please try again shortly.",
    });
    fixture.source.body({ data: [] });
    expect(
      (yield* tenant.respondDiscord({
        ...discordReceipt("schedule", 604800001),
        invocation: { command: "active", input: "" },
      })).data.content,
    ).toBe("No active events");
    fixture.source.body({}, 503);
    yield* TestClock.setTime(604860001);
    expect(
      (yield* tenant.respondDiscord({
        ...discordReceipt("schedule-expired", 604860001),
        invocation: { command: "active", input: "" },
      })).data.flags,
    ).toBe(64);
  }),
);

test(
  "all ten commands render exact public Discord and Twitch outputs through one real shared cache",
  Effect.gen(function* () {
    const fixture = yield* tenantFixture();
    const tenant = yield* fixture.construct();
    fixture.source.respond((url) =>
      Effect.succeed(
        Response.json({
          data: url.pathname.endsWith("/traders")
            ? {
                Apollo: [],
                Celeste: [],
                Lance: [],
                Shani: [{ id: "sensors", name: "Sensors", trader_price: 100 }],
                TianWen: [],
              }
            : url.pathname.endsWith("/arcs")
              ? [
                  {
                    id: "bastion",
                    name: "Bastion",
                    loot: [{ item: { id: "sensors", name: "Sensors" } }],
                  },
                ]
              : url.pathname.endsWith("/events-schedule")
                ? [
                    {
                      name: "Harvester",
                      map: "Dam",
                      startTime: 0,
                      endTime: 120000,
                    },
                    {
                      name: "Harvester",
                      map: "Spaceport",
                      startTime: 120000,
                      endTime: 240000,
                    },
                  ]
                : [
                    {
                      id: "sensors",
                      name: "Sensors",
                      value: 10,
                      loot_area: "Industrial",
                      recycle_components: [],
                      recycle_from: [],
                    },
                  ],
        }),
      ),
    );
    const cases = [
      ["buy", "sensors", "Sensors can be purchased from Shani for 100 cred."],
      ["loot", "bastion", "Bastions drop the following items: Sensors"],
      ["craft", "sensors", "Sensors cannot be crafted."],
      ["find", "sensors", "Sensors can be found in Industrial areas."],
      ["sell", "sensors", "Sensors can be sold for 10 coins each"],
      ["recycle", "sensors", "No items granted for recycling Sensors"],
      ["recycleto", "sensors", "No items recycle to Sensors"],
      ["event", "queen", "Harvester on Dam is active now (ends in 2m)"],
      ["active", "", "Harvester on Dam (ends in 2m)"],
      ["upcoming", "", "Harvester on Spaceport (starts in 2m)"],
    ] as const;
    for (const [command, input, text] of cases)
      expect(
        yield* tenant.respondDiscord({
          ...discordReceipt(command),
          invocation: { command, input },
        }),
      ).toEqual(discordResponse(text));
    expect(fixture.source.calls).toHaveLength(5);
    const twitchFixture = yield* tenantFixture();
    const twitch = yield* twitchFixture.construct(
      "twitch",
      fixture.source.data,
    );
    for (const [command, input] of cases) {
      yield* twitch.acceptTwitch({
        ...twitchReceipt(`twitch-${command}`),
        invocation: { command, input },
      });
      yield* twitchFixture.drain;
    }
    expect(twitchFixture.sent.map((message) => message.text)).toEqual(
      cases.map(([, , text]) => `ARC: ${text}`),
    );
    expect(fixture.source.calls).toHaveLength(5);
  }),
);
