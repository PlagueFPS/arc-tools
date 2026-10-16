import { describe, expect } from "bun:test";
import { makeFixture } from "@arctools/arc-data/testing";
import * as Test from "alchemy/Test/Bun";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { Deadline, WorkId } from "../src/contracts.js";
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
