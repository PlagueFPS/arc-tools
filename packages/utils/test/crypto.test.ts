/* oxlint-disable effecttsgo/strict-effect-provide -- Tests own their injected runtime layers. */
import { expect, test } from "bun:test";

import { Effect, Layer, String as Str } from "effect";
import { SecureRandom } from "effect/crypto";

import {
  cryptoLayer,
  digest,
  randomCredential,
  randomUUID,
} from "../src/crypto.js";
import { digest as hostDigest, randomUUID as hostUUID } from "../src/http.js";

test("SHA-256 preserves lowercase hex fingerprints", async () => {
  const expected =
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

  expect(
    await Effect.runPromise(digest("abc").pipe(Effect.provide(cryptoLayer))),
  ).toBe(expected);
  expect(await Effect.runPromise(hostDigest("abc"))).toBe(expected);
});

test("credentials retain 32 bytes of randomness and UUIDs retain v4 format", async () => {
  const sizes: number[] = [];

  const random = SecureRandom.make((size) => {
    sizes.push(size);

    return new Uint8Array(size).fill(255);
  });

  const layer = Layer.succeed(SecureRandom.SecureRandom, random);

  const credential = await Effect.runPromise(
    randomCredential.pipe(Effect.provide(layer)),
  );

  expect(credential).toBe(Str.repeat(32)("ff"));
  expect(sizes).toEqual([32]);
  expect(await Effect.runPromise(randomUUID.pipe(Effect.provide(layer)))).toBe(
    "ffffffff-ffff-4fff-bfff-ffffffffffff",
  );

  expect(await Effect.runPromise(hostUUID)).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
});
