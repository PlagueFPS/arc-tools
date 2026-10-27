/* oxlint-disable effecttsgo/schema-sync -- Fixture builders and native callbacks validate synchronously; Effect programs use Effect decoders. */
import { expect, test } from "bun:test";

import { Schema, String as EffectString } from "effect";

import { Work } from "../../apps/bot/src/tenant-state.js";
import {
  hasUsefulNativeSchedule,
  immutableWork,
  ingressTiming,
} from "./fixture-timing.js";
import { TenantSnapshot } from "./tenant-fixture.js";

const work = Schema.decodeSync(Work)({
  transport: "twitch",
  kind: "computing",
  id: "native",
  fingerprint: EffectString.repeat(64)("f"),
  receivedAt: 1000,
  deadline: 11000,
  retainUntil: 611000,
  source: null,
  invocation: { command: "sell", input: "sensors" },
  broadcasterId: "200",
  replyParentId: "native",
  claim: { generation: 1, activation: "original", until: 5000 },
});

test("ingress timing requires a present finite decimal stamp", () => {
  expect(ingressTiming(new Headers({ "x-arc-ingress-ms": "0" }))).toBe(0);
  expect(ingressTiming(new Headers({ "x-arc-ingress-ms": "125" }))).toBe(125);
  expect(() => ingressTiming(new Headers())).toThrow("timing stamp");

  for (const stamp of [
    "",
    "NaN",
    "Infinity",
    "-1",
    "1.5",
    "1e3",
    EffectString.repeat(400)("9"),
  ])
    expect(() =>
      ingressTiming(new Headers({ "x-arc-ingress-ms": stamp })),
    ).toThrow("timing stamp");
});

test("alarm progress changes phase without changing work identity or the immutable cutoff", () => {
  const terminal = Schema.decodeSync(Work)({
    ...immutableWork(work),
    transport: "twitch",
    kind: "terminal",
    source: null,
    outcome: "sent",
  });

  expect(immutableWork(terminal)).toEqual(immutableWork(work));
  expect(
    immutableWork(Schema.decodeSync(Work)({ ...terminal, deadline: 12000 })),
  ).not.toEqual(immutableWork(work));
});

test("a null native alarm needs evidence from the same activation", () => {
  const snapshot = Schema.decodeSync(TenantSnapshot)({
    instance: "current",
    state: { tenant: "native", generation: 1, works: { native: work } },
    alarm: null,
    alarmRuns: 1,
    lostAccountResponseAt: null,
    alarmActivity: { running: null, completed: null },
  });

  expect(hasUsefulNativeSchedule(snapshot, 11000)).toBeFalse();
  expect(
    hasUsefulNativeSchedule(
      {
        ...snapshot,
        alarmActivity: {
          running: { instance: "current", run: 1 },
          completed: null,
        },
      },
      11000,
    ),
  ).toBeTrue();
  expect(
    hasUsefulNativeSchedule(
      {
        ...snapshot,
        alarmActivity: {
          running: { instance: "old", run: 1 },
          completed: null,
        },
      },
      11000,
    ),
  ).toBeFalse();
  expect(
    hasUsefulNativeSchedule({ ...snapshot, alarm: 5000 }, 11000),
  ).toBeTrue();
  expect(
    hasUsefulNativeSchedule({ ...snapshot, alarm: 11000 }, 11000),
  ).toBeTrue();
  expect(
    hasUsefulNativeSchedule({ ...snapshot, alarm: 11001 }, 11000),
  ).toBeFalse();
});
