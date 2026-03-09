import { createMockHttpClientLayer } from "@arctools/testing";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";
import { handleMessageCreate } from "../src/events.js";
import { createMockMessage, createMockReply } from "./fixtures.js";

const emptyMockLayer = createMockHttpClientLayer({});

describe("handleMessageCreate", () => {
  layer(emptyMockLayer)((it) => {
    it.effect("ignores bot authors", () =>
      Effect.gen(function* () {
        const reply = createMockReply();
        const message = createMockMessage({
          author: { bot: true },
          content: "!buy sensors",
          reply,
        });
        yield* handleMessageCreate(message);
        assert.strictEqual(reply.calls.length, 0);
      }),
    );

    it.effect("ignores non-prefixed messages", () =>
      Effect.gen(function* () {
        const reply = createMockReply();
        const message = createMockMessage({
          content: "hello",
          reply,
        });
        yield* handleMessageCreate(message);
        assert.strictEqual(reply.calls.length, 0);
      }),
    );

    it.effect("ignores bare exclamation", () =>
      Effect.gen(function* () {
        const reply = createMockReply();
        const message = createMockMessage({
          content: "!",
          reply,
        });
        yield* handleMessageCreate(message);
        assert.strictEqual(reply.calls.length, 0);
      }),
    );

    it.effect("ignores unknown commands", () =>
      Effect.gen(function* () {
        const reply = createMockReply();
        const message = createMockMessage({
          content: "!unknowncmd foo",
          reply,
        });
        yield* handleMessageCreate(message);
        assert.strictEqual(reply.calls.length, 0);
      }),
    );

    it.effect("lowercases command name for lookup", () =>
      Effect.gen(function* () {
        const reply = createMockReply();
        const message = createMockMessage({
          content: "!BUY item",
          reply,
        });
        yield* handleMessageCreate(message);
        assert.strictEqual(reply.calls.length, 1);
        const first = reply.calls[0];
        assert.isDefined(first);
        assert.match(first?.content, /No trader sells|cred|coins|seeds/);
      }),
    );
  });

  it.effect("replies with handler output for known command", () =>
    Effect.gen(function* () {
      const reply = createMockReply();
      const message = createMockMessage({
        content: "!buy sensors",
        reply,
      });
      yield* handleMessageCreate(message).pipe(
        Effect.provide(
          createMockHttpClientLayer({
            traders: {
              Apollo: [],
              Celeste: [],
              Lance: [],
              Shani: [{ id: "sensors", name: "Sensors", trader_price: 100 }],
              TianWen: [],
            },
          }),
        ),
      );
      assert.strictEqual(reply.calls.length, 1);
      const first = reply.calls[0];
      assert.isDefined(first);
      assert.include(first?.content, "Sensors");
      assert.include(first?.content, "cred");
    }),
  );
});
