import { describe, expect } from "bun:test";
import { createMockHttpClientLayer } from "@arctools/testing";
import * as Test from "alchemy/Test/Bun";
import { Effect, Layer } from "effect";
import { handleMessageCreate } from "../src/events.js";
import { createMockMessage, createMockReply } from "./fixtures.js";

const mockLayer = createMockHttpClientLayer({
  traders: {
    Apollo: [{ id: "item", name: "Item", trader_price: 100 }],
    Celeste: [],
    Lance: [],
    Shani: [{ id: "sensors", name: "Sensors", trader_price: 100 }],
    TianWen: [],
  },
});

const { test } = Test.make({ providers: Layer.empty });

describe("handleMessageCreate", () => {
  test(
    "ignores bot authors",
    Effect.gen(function* () {
      const reply = createMockReply();
      const message = createMockMessage({
        author: { bot: true },
        content: "!buy sensors",
        reply,
      });
      yield* handleMessageCreate(message);
      expect(reply.calls.length).toBe(0);
    }).pipe(Effect.provide(mockLayer)),
  );

  test(
    "ignores non-prefixed messages",
    Effect.gen(function* () {
      const reply = createMockReply();
      const message = createMockMessage({
        content: "hello",
        reply,
      });
      yield* handleMessageCreate(message);
      expect(reply.calls.length).toBe(0);
    }).pipe(Effect.provide(mockLayer)),
  );

  test(
    "ignores bare exclamation",
    Effect.gen(function* () {
      const reply = createMockReply();
      const message = createMockMessage({
        content: "!",
        reply,
      });
      yield* handleMessageCreate(message);
      expect(reply.calls.length).toBe(0);
    }).pipe(Effect.provide(mockLayer)),
  );

  test(
    "ignores unknown commands",
    Effect.gen(function* () {
      const reply = createMockReply();
      const message = createMockMessage({
        content: "!unknowncmd foo",
        reply,
      });
      yield* handleMessageCreate(message);
      expect(reply.calls.length).toBe(0);
    }).pipe(Effect.provide(mockLayer)),
  );

  test(
    "lowercases command name for lookup",
    Effect.gen(function* () {
      const reply = createMockReply();
      const message = createMockMessage({
        content: "!BUY item",
        reply,
      });
      yield* handleMessageCreate(message);
      expect(reply.calls.length).toBe(1);
      const first = reply.calls[0];
      expect(first).toBeDefined();
      expect(first?.content).toContain("Item");
      expect(first?.content).toContain("coin");
    }).pipe(Effect.provide(mockLayer)),
  );

  test(
    "replies with handler output for known command",
    Effect.gen(function* () {
      const reply = createMockReply();
      const message = createMockMessage({
        content: "!buy sensors",
        reply,
      });
      yield* handleMessageCreate(message);
      expect(reply.calls.length).toBe(1);
      const first = reply.calls[0];
      expect(first).toBeDefined();
      expect(first?.content).toContain("Sensors");
      expect(first?.content).toContain("cred");
    }).pipe(Effect.provide(mockLayer)),
  );
});
