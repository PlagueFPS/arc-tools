import { expect, test } from "bun:test";

import {
  type DiscordFailureObservation,
  expectDataFailure,
} from "./discord-failure.js";

const capturedSlowSourceError = {
  reply: {
    type: 4,
    data: {
      content:
        "Game data is temporarily unavailable. Please try again shortly.",
      flags: 64,
      allowed_mentions: { parse: [], replied_user: false },
    },
  },
  tenantPhase: "committed",
  tenantCode: "command-error",
  fallback: null,
  fallbackCode: null,
} satisfies DiscordFailureObservation;

const capturedSlowTimeout = {
  ...capturedSlowSourceError,
  tenantCode: "timeout",
  reply: {
    ...capturedSlowSourceError.reply,
    data: {
      ...capturedSlowSourceError.reply.data,
      content: "I couldn't finish that command in time. Please try again.",
    },
  },
} satisfies DiscordFailureObservation;

test("accepts the captured slow source-error outcome", () => {
  expectDataFailure("slow", capturedSlowSourceError);
});

test("accepts the captured slow committed timeout outcome", () => {
  expectDataFailure("slow", capturedSlowTimeout);
});

test.each(["missing", "malformed"] as const)(
  "%s requires the exact source-error outcome",
  (scenario) => {
    expectDataFailure(scenario, capturedSlowSourceError);
    expect(() => expectDataFailure(scenario, capturedSlowTimeout)).toThrow();
  },
);

test.each([
  [
    "source-error code with timeout content",
    { ...capturedSlowTimeout, tenantCode: "command-error" },
  ],
  [
    "timeout code with source-error content",
    { ...capturedSlowSourceError, tenantCode: "timeout" },
  ],
  ["unknown error code", { ...capturedSlowSourceError, tenantCode: "unknown" }],
  [
    "unknown error content",
    {
      ...capturedSlowSourceError,
      reply: {
        ...capturedSlowSourceError.reply,
        data: {
          ...capturedSlowSourceError.reply.data,
          content: "Unexpected error",
        },
      },
    },
  ],
  ["uncommitted outcome", { ...capturedSlowTimeout, tenantPhase: "admission" }],
  [
    "public reply",
    {
      ...capturedSlowTimeout,
      reply: {
        ...capturedSlowTimeout.reply,
        data: { ...capturedSlowTimeout.reply.data, flags: 0 },
      },
    },
  ],
  [
    "deferred reply",
    {
      ...capturedSlowTimeout,
      reply: { ...capturedSlowTimeout.reply, type: 5 },
    },
  ],
  [
    "enabled mentions",
    {
      ...capturedSlowTimeout,
      reply: {
        ...capturedSlowTimeout.reply,
        data: {
          ...capturedSlowTimeout.reply.data,
          allowed_mentions: { parse: ["everyone"], replied_user: false },
        },
      },
    },
  ],
  [
    "reply mention",
    {
      ...capturedSlowTimeout,
      reply: {
        ...capturedSlowTimeout.reply,
        data: {
          ...capturedSlowTimeout.reply.data,
          allowed_mentions: { parse: [], replied_user: true },
        },
      },
    },
  ],
  ["Worker fallback", { ...capturedSlowTimeout, fallback: "worker" }],
  ["Worker fallback code", { ...capturedSlowTimeout, fallbackCode: "timeout" }],
  ["missing reply", { ...capturedSlowTimeout, reply: null }],
] satisfies [string, DiscordFailureObservation][])(
  "rejects %s",
  (_name, observed) => {
    expect(() => expectDataFailure("slow", observed)).toThrow();
  },
);
