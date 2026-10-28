import { expect } from "bun:test";

import * as Test from "alchemy/Test/Bun";
import { Effect, Layer, Result, String as Str } from "effect";
import { HttpServerRequest } from "effect/http";

import { OperatorBodyTooLarge, readOperatorBody } from "../src/operator.js";

const { test } = Test.make({ providers: Layer.empty });

const request = (bytes: Uint8Array) =>
  HttpServerRequest.fromWeb(
    new Request("https://bot.invalid/ops/status", {
      method: "POST",
      body: new Uint8Array(bytes),
    }),
  );

test(
  "operator accepts exactly 4096 bytes with a UTF-8 BOM split across chunks",
  Effect.gen(function* () {
    const valid = '\uFEFF{"stage":"local-probe","extra":"雪🙂"}';
    const encoded = new TextEncoder().encode(valid);

    const bytes = new TextEncoder().encode(
      valid + Str.repeat(4096 - encoded.byteLength)(" "),
    );

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 1));
        controller.enqueue(bytes.slice(1, 2));

        for (const byte of bytes.slice(2))
          controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });

    const chunked = HttpServerRequest.fromWeb(
      new Request("https://bot.invalid/ops/status", { method: "POST", body }),
    );

    expect(bytes.byteLength).toBe(4096);
    expect(yield* readOperatorBody(chunked)).toEqual({ stage: "local-probe" });
  }),
);

test(
  "operator rejects malformed JSON and invalid stages in the failure channel",
  Effect.gen(function* () {
    for (const text of ["{", '{"stage":"local-雪🙂"}']) {
      const result = yield* readOperatorBody(
        request(new TextEncoder().encode(text)),
      ).pipe(Effect.result);

      expect(Result.isFailure(result)).toBeTrue();
    }
  }),
);

test(
  "operator overflow is a typed failure and cancels the unread body",
  Effect.gen(function* () {
    let canceled = false;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4096));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        canceled = true;
      },
    });

    const input = HttpServerRequest.fromWeb(
      new Request("https://bot.invalid/ops/status", { method: "POST", body }),
    );

    const result = yield* readOperatorBody(input).pipe(Effect.result);

    expect(result).toMatchObject(Result.fail(new OperatorBodyTooLarge()));
    expect(canceled).toBeTrue();
  }),
);
